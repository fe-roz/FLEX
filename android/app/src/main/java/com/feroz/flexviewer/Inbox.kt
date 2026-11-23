package com.feroz.flexviewer

import android.content.Context
import android.net.LocalServerSocket
import android.net.LocalSocket
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream

/**
 * Maps sent from the PC that runs FLEX ("Send to phone", phone_api.js), over the USB cable. They wait here until
 * the map list imports them through the normal import (name match, update) or the user discards them.
 *
 * Two ways in, neither needs a permission and neither is the network:
 *  - a local socket ([SOCKET], a unix socket of this app, not an internet one): adb on the PC connects to it
 *    (`adb forward … localabstract:flexfield_inbox`) and streams the zip, which is kept in the app's own files.
 *    Only adb (the shell user, or root) is answered.
 *        PC: "PING\n"                 app: "FLEXFIELD 1\n"
 *        PC: "SEND <bytes> <name>\n"  app: "READY\n" or "ERR <why>\n"; then <bytes> of zip; app: "OK\n" or "ERR <why>\n"
 *  - a folder of the app on the shared storage (Android/data/<app>/files/inbox) that adb can push into. Whether
 *    the app can read what adb put there differs between phones, so each time the list is asked for, what was
 *    found and whether it could be read is written to inbox_status.json beside it, where the PC reads it.
 */
class Inbox(private val ctx: Context) {
    companion object {
        const val SOCKET = "flexfield_inbox"
        private const val PROTOCOL = 1
        private val NAME_RE = Regex("^[A-Za-z0-9._-]{1,80}\\.zip$")
        fun validName(n: String?): Boolean = n != null && NAME_RE.matches(n) && !n.startsWith(".") && !n.contains("..")
        private const val UID_ROOT = 0
        private const val UID_SHELL = 2000
        @Volatile private var serving = false
        /** Called (on the socket's thread) when a map has arrived. */
        @Volatile var onArrived: (() -> Unit)? = null
    }

    private val own: File get() = File(ctx.filesDir, "inbox").apply { mkdirs() }
    private val shared: File? get() = try { ctx.getExternalFilesDir("inbox") } catch (_: Exception) { null }
    private val statusFile: File? get() = try { ctx.getExternalFilesDir(null)?.let { File(it, "inbox_status.json") } } catch (_: Exception) { null }
    private val imported = ArrayList<String>()

    private fun zips(dir: File?): List<File> = dir?.listFiles { f -> f.isFile && validName(f.name) }?.sortedBy { it.name } ?: emptyList()
    private fun readable(f: File): Boolean = try { FileInputStream(f).use { it.read() >= 0 } } catch (_: Exception) { false }

    /** What is waiting: [{ name, bytes, readable }]; a name in both places is listed once (the app's own copy). */
    @Synchronized fun list(): JSONArray {
        val out = JSONArray(); val seen = HashSet<String>(); val forPc = JSONArray()
        for (f in zips(own)) { seen.add(f.name); out.put(JSONObject().put("name", f.name).put("bytes", f.length()).put("readable", true)) }
        for (f in zips(shared)) {
            val ok = readable(f)
            forPc.put(JSONObject().put("name", f.name).put("readable", ok))
            if (seen.add(f.name)) out.put(JSONObject().put("name", f.name).put("bytes", f.length()).put("readable", ok))
        }
        writeStatus(forPc)
        return out
    }
    private fun writeStatus(files: JSONArray) {
        try {
            statusFile?.writeText(JSONObject().put("t", System.currentTimeMillis()).put("protocol", PROTOCOL)
                .put("files", files).put("imported", JSONArray(imported)).toString())
        } catch (_: Exception) {}
    }
    /** The waiting file of that name, the app's own copy first. */
    fun file(name: String): File? {
        if (!validName(name)) return null
        return zips(own).firstOrNull { it.name == name } ?: zips(shared).firstOrNull { it.name == name }
    }
    /** After it was imported (or to throw it away): every copy of that name goes. */
    @Synchronized fun remove(name: String, wasImported: Boolean): Boolean {
        if (!validName(name)) return false
        var any = false
        for (f in zips(own) + zips(shared)) if (f.name == name) any = f.delete() || any
        if (wasImported) { imported.add(name); while (imported.size > 20) imported.removeAt(0) }
        list()
        return any
    }

    /** Listen for the PC. One listener for the whole process; a second call does nothing. */
    fun startServer() {
        synchronized(Inbox::class.java) { if (serving) return; serving = true }
        Thread({
            try {
                val srv = LocalServerSocket(SOCKET)
                while (true) {
                    val s = srv.accept()
                    try { serve(s) } catch (_: Exception) {} finally { try { s.close() } catch (_: Exception) {} }
                }
            } catch (_: Exception) { serving = false }
        }, "ff-inbox").apply { isDaemon = true }.start()
    }

    private fun readLine(input: InputStream): String? {
        val sb = StringBuilder()
        while (sb.length < 300) {
            val b = input.read()
            if (b < 0) return if (sb.isEmpty()) null else sb.toString()
            if (b == '\n'.code) return sb.toString().trim()
            sb.append(b.toChar())
        }
        return null
    }

    private fun serve(s: LocalSocket) {
        val uid = try { s.peerCredentials.uid } catch (_: Exception) { -1 }
        if (uid != UID_SHELL && uid != UID_ROOT) return                 // only adb
        s.soTimeout = 30000
        val input = s.inputStream; val out = s.outputStream
        fun say(t: String) { out.write((t + "\n").toByteArray(Charsets.US_ASCII)); out.flush() }
        while (true) {
            val line = readLine(input) ?: return
            if (line == "PING") { say("FLEXFIELD $PROTOCOL"); continue }
            val m = Regex("^SEND (\\d{1,12}) (\\S+)$").matchEntire(line)
            if (m == null) { say("ERR unknown request"); return }
            val bytes = m.groupValues[1].toLong(); val name = m.groupValues[2]
            if (!validName(name) || bytes <= 0) { say("ERR bad name or size"); return }
            val dir = own
            if (dir.usableSpace < bytes + 64L * 1024 * 1024) { say("ERR not enough room on the phone"); return }
            val part = File(dir, "$name.part")
            say("READY")
            var got = 0L
            try {
                FileOutputStream(part).use { o ->
                    val buf = ByteArray(256 * 1024)
                    while (got < bytes) {
                        val n = input.read(buf, 0, minOf(buf.size.toLong(), bytes - got).toInt())
                        if (n < 0) break
                        o.write(buf, 0, n); got += n
                    }
                }
            } catch (e: Exception) { part.delete(); throw e }
            if (got != bytes) { part.delete(); return }                 // the PC stopped (cancel, cable pulled)
            val dst = File(dir, name)
            dst.delete()
            if (!part.renameTo(dst)) { part.delete(); say("ERR could not keep the file"); return }
            say("OK")
            try { onArrived?.invoke() } catch (_: Exception) {}
        }
    }
}
