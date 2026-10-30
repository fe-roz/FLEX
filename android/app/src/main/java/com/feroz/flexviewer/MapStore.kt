package com.feroz.flexviewer

import android.content.Context
import android.util.JsonReader
import android.util.JsonToken
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.BufferedReader
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream
import java.io.InputStreamReader
import java.io.Reader
import java.security.SecureRandom
import java.util.Base64
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream
import java.util.zip.ZipOutputStream

/**
 * Where FLEX Field keeps maps, and everything that reads or writes them.
 *
 *   files/maps/<id>/map.json          name, dates, size (this file)
 *   files/maps/<id>/export/...        the export's data files, replaced on update
 *   files/maps/<id>/user/log.jsonl    the map's own log (imported, updated), one JSON entry per line
 *
 * What people add (notes, documents, leads, field survey) belongs to the
 * map's project and lives in the library (LibStore), not here.
 * `export/` is the only part an update replaces; `user/` is the user's and is
 * never touched by an import. All of it is app-private storage.
 */
class MapStore(private val ctx: Context) {

    val root: File = File(ctx.filesDir, "maps").apply { mkdirs() }
    private val staging: File = File(root, ".staging").apply { mkdirs() }

    companion object {
        /** The data files an export carries. Nothing else is extracted. */
        val DATA_FILES = setOf("terrain.glb", "tex_sat.jpg", "tex_hs.jpg", "walls.bin", "caves.json")
        private val ID_RE = Regex("^[A-Za-z0-9_-]{1,64}$")
        private val SAFE_RE = Regex("^[A-Za-z0-9._ -]{1,120}$")
        fun validId(id: String?): Boolean = id != null && ID_RE.matches(id)
        fun safeName(s: String?): Boolean = s != null && SAFE_RE.matches(s) && !s.startsWith(".") && !s.contains("..")
        private val rng = SecureRandom()
        fun newId(): String {
            val b = ByteArray(6); rng.nextBytes(b)
            return b.joinToString("") { "%02x".format(it) }
        }
    }

    fun mapDir(id: String): File? = if (validId(id)) File(root, id).takeIf { it.isDirectory } else null
    fun exportDir(id: String): File? = mapDir(id)?.let { File(it, "export") }
    fun userDir(id: String): File? = mapDir(id)?.let { File(it, "user").apply { mkdirs() } }

    // ── Map list ────────────────────────────────────────────────────────────
    fun readInfo(id: String): JSONObject? = mapDir(id)?.let { d ->
        val f = File(d, "map.json")
        try { JSONObject(f.readText()) } catch (_: Exception) { null }
    }

    /** Change map.json (e.g. its project). */
    fun updateInfo(id: String, change: (JSONObject) -> Unit): Boolean = synchronized(this) {
        val info = readInfo(id) ?: return false
        change(info)
        writeInfo(id, info)
        true
    }

    private fun writeInfo(id: String, info: JSONObject) {
        val d = mapDir(id) ?: return
        val tmp = File(d, "map.json.tmp")
        tmp.writeText(info.toString())
        tmp.renameTo(File(d, "map.json"))
    }

    fun listMaps(): JSONArray {
        val out = mutableListOf<JSONObject>()
        root.listFiles()?.forEach { d ->
            if (!d.isDirectory || d.name.startsWith(".")) return@forEach
            val info = readInfo(d.name) ?: return@forEach
            info.put("size", dirSize(File(d, "export")))
            info.put("userSize", dirSize(File(d, "user")))
            info.put("logCount", countLines(File(d, "user/log.jsonl")))
            out.add(info)
        }
        out.sortByDescending { it.optLong("lastOpened", it.optLong("updatedAt", 0)) }
        return JSONArray(out)
    }

    fun touchOpened(id: String) {
        val info = readInfo(id) ?: return
        info.put("lastOpened", System.currentTimeMillis())
        writeInfo(id, info)
    }

    fun rename(id: String, name: String): Boolean {
        val info = readInfo(id) ?: return false
        info.put("name", name.trim().take(60))
        writeInfo(id, info)
        return true
    }

    fun delete(id: String): Boolean = mapDir(id)?.deleteRecursively() ?: false

    fun has(id: String, file: String): Boolean = exportDir(id)?.let { File(it, file).isFile } ?: false

    // ── Import ──────────────────────────────────────────────────────────────
    class Staged(val token: String, val dir: File, val name: String, val formatVersion: Int, val bytes: Long)

    /** Unzip the data files of an export into a staging folder. Legacy exports
     *  that only carry the single-file viewer.html are unpacked from it. */
    fun stage(input: InputStream, progress: (String, Int) -> Unit): Staged {
        val token = newId()
        val dir = File(staging, token).apply { deleteRecursively(); mkdirs() }
        val canonical = dir.canonicalPath + File.separator
        val seen = mutableSetOf<String>()
        var gotViewer = false
        ZipInputStream(BufferedInputStream(input, 1 shl 16)).use { zin ->
            var e: ZipEntry? = zin.nextEntry
            while (e != null) {
                if (!e.isDirectory) {
                    val base = e.name.replace('\\', '/').substringAfterLast('/')
                    val wanted = base in DATA_FILES && base !in seen
                    // viewer.html only when the sidecars it would stand in for
                    // have not turned up yet (exports before sidecars existed).
                    val legacy = base == "viewer.html" && !gotViewer &&
                            !("tex_sat.jpg" in seen && "caves.json" in seen && "terrain.glb" in seen)
                    if (wanted || legacy) {
                        val out = File(dir, base)
                        // Only known basenames are written, but check anyway (zip-slip).
                        require(out.canonicalPath.startsWith(canonical)) { "bad entry ${e.name}" }
                        progress("Unpacking $base", -1)
                        FileOutputStream(out).use { zin.copyTo(it, 1 shl 16) }
                        if (wanted) seen.add(base) else gotViewer = true
                    }
                }
                zin.closeEntry()
                e = zin.nextEntry
            }
        }
        val viewer = File(dir, "viewer.html")
        if (viewer.isFile) {
            val missing = listOf("terrain.glb", "tex_sat.jpg", "caves.json").filter { it !in seen }
            if (missing.isNotEmpty()) {
                progress("Unpacking an older export (${missing.joinToString()})", -1)
                LegacyUnpack.unpack(viewer, dir, seen)
            }
            viewer.delete()
        }
        if (!File(dir, "terrain.glb").isFile && !File(dir, "caves.json").isFile) {
            dir.deleteRecursively()
            throw IllegalArgumentException("This zip is not a FLEX export (no terrain.glb or caves.json).")
        }
        if (!File(dir, "caves.json").isFile) File(dir, "caves.json").writeText("{\"surveys\":[]}")
        val (name, fv) = readMeta(File(dir, "caves.json"))
        return Staged(token, dir, name, fv, dirSize(dir))
    }

    fun stagedDir(token: String): File? = if (validId(token)) File(staging, token).takeIf { it.isDirectory } else null
    fun discard(token: String) { stagedDir(token)?.deleteRecursively() }

    /** Maps already on the phone with this export name. */
    fun matches(name: String): JSONArray {
        val out = JSONArray()
        if (name.isBlank()) return out
        root.listFiles()?.forEach { d ->
            if (!d.isDirectory || d.name.startsWith(".")) return@forEach
            val info = readInfo(d.name) ?: return@forEach
            if (info.optString("exportName").equals(name, ignoreCase = true) ||
                info.optString("name").equals(name, ignoreCase = true)) out.put(info)
        }
        return out
    }

    /** Move a staged export in: as a new map, or over an existing one's export
     *  (its notes, log and field surveys are kept). Returns the map id. */
    fun commit(staged: File, name: String, fv: Int, targetId: String?, author: String): String {
        val now = System.currentTimeMillis()
        val (exportName, _) = readMeta(File(staged, "caves.json"))
        if (targetId != null && mapDir(targetId) != null) {
            val ex = File(mapDir(targetId), "export")
            val old = File(mapDir(targetId), "export.old")
            old.deleteRecursively()
            if (ex.exists() && !ex.renameTo(old)) throw IllegalStateException("could not replace the old export")
            if (!staged.renameTo(ex)) { old.renameTo(ex); throw IllegalStateException("could not move the new export in") }
            old.deleteRecursively()
            val info = readInfo(targetId) ?: JSONObject().put("id", targetId).put("name", name)
            info.put("exportName", exportName).put("formatVersion", fv).put("updatedAt", now)
            writeInfo(targetId, info)
            appendLog(targetId, logEntry("map.update", author, JSONObject().put("export", exportName)))
            return targetId
        }
        var id = newId()
        while (File(root, id).exists()) id = newId()
        val d = File(root, id).apply { mkdirs() }
        if (!staged.renameTo(File(d, "export"))) { d.deleteRecursively(); throw IllegalStateException("could not move the export in") }
        File(d, "user").mkdirs()
        writeInfo(id, JSONObject().put("id", id).put("name", name.ifBlank { "Map" })
            .put("exportName", exportName).put("formatVersion", fv)
            .put("importedAt", now).put("updatedAt", now))
        appendLog(id, logEntry("map.import", author, JSONObject().put("export", exportName)))
        return id
    }

    /** meta.name and meta.format_version from caves.json, read as a stream: a
     *  big cave set's caves.json is tens of MB, and meta is all we need. */
    fun readMeta(f: File): Pair<String, Int> {
        var name = ""; var fv = 1
        try {
            JsonReader(InputStreamReader(FileInputStream(f), Charsets.UTF_8)).use { r ->
                r.beginObject()
                while (r.hasNext()) {
                    if (r.nextName() == "meta" && r.peek() == JsonToken.BEGIN_OBJECT) {
                        r.beginObject()
                        while (r.hasNext()) {
                            when (r.nextName()) {
                                "name" -> if (r.peek() == JsonToken.STRING) name = r.nextString() else r.skipValue()
                                "format_version" -> if (r.peek() == JsonToken.NUMBER) fv = r.nextInt() else r.skipValue()
                                else -> r.skipValue()
                            }
                        }
                        r.endObject()
                    } else r.skipValue()
                }
            }
        } catch (_: Exception) { /* a name is a nicety */ }
        return name.trim() to fv
    }

    // ── Change log ──────────────────────────────────────────────────────────
    private val logLock = Any()

    fun logEntry(op: String, who: String, extra: JSONObject): JSONObject {
        extra.put("id", newId()).put("t", java.time.Instant.now().toString())
            .put("who", who.ifBlank { "?" }).put("op", op)
        return extra
    }

    fun appendLog(id: String, entry: JSONObject): Boolean = appendLogLine(id, entry.toString())

    fun appendLogLine(id: String, line: String): Boolean = synchronized(logLock) {
        val u = userDir(id) ?: return false
        // One entry per line: refuse anything that would break that.
        val clean = line.replace("\n", " ").replace("\r", " ")
        try { JSONObject(clean) } catch (_: Exception) { return false }
        FileOutputStream(File(u, "log.jsonl"), true).use { it.write((clean + "\n").toByteArray(Charsets.UTF_8)) }
        true
    }

    fun readLog(id: String): String = synchronized(logLock) {
        val f = userDir(id)?.let { File(it, "log.jsonl") } ?: return ""
        if (f.isFile) f.readText(Charsets.UTF_8) else ""
    }

    // ── Sharing a map's log, tracks and pins ────────────────────────────────
    /** Zip the user part of a map (its log) plus map.json and anything the
     *  page passes in (tracks and pins live in the page's storage). */
    fun zipUserData(id: String, extras: Map<String, String>, out: File) {
        val d = mapDir(id) ?: throw IllegalArgumentException("no such map")
        ZipOutputStream(FileOutputStream(out)).use { z ->
            fun put(name: String, f: File) { z.putNextEntry(ZipEntry(name)); FileInputStream(f).use { it.copyTo(z) }; z.closeEntry() }
            File(d, "map.json").takeIf { it.isFile }?.let { put("map.json", it) }
            val u = File(d, "user")
            u.walkTopDown().filter { it.isFile }.forEach { put("user/" + it.relativeTo(u).path.replace('\\', '/'), it) }
            extras.forEach { (name, text) ->
                if (safeName(name)) { z.putNextEntry(ZipEntry(name)); z.write(text.toByteArray(Charsets.UTF_8)); z.closeEntry() }
            }
        }
    }

    // ── helpers ─────────────────────────────────────────────────────────────
    fun dirSize(d: File): Long = if (!d.exists()) 0 else d.walkTopDown().filter { it.isFile }.sumOf { it.length() }
    private fun countLines(f: File): Int = if (!f.isFile) 0 else f.useLines { s -> s.count { it.isNotBlank() } }
}

/**
 * Exports made before the sidecar files existed carry everything inside the
 * single-file viewer.html: terrain, textures and walls as base64 string
 * constants, the survey data as a JSON literal. Read it once, as a stream (it
 * can be ~200 MB), and write each payload out as the file it stands for.
 */
object LegacyUnpack {
    private val B64 = linkedMapOf(
        "const TERRAIN_GLB_B64 = \"" to "terrain.glb",
        "const TERRAIN_TEX_B64 = \"" to "tex_sat.jpg",
        "const TERRAIN_HS_B64  = \"" to "tex_hs.jpg",
        "const TERRAIN_HS_B64 = \"" to "tex_hs.jpg",
        "const TERRAIN_WALLS_B64 = \"" to "walls.bin",
    )
    private val CAVES = listOf("window.CAVES_DATA = ", "const CAVES_DATA = ")

    fun unpack(viewer: File, outDir: File, have: Set<String>) {
        val markers = (B64.keys + CAVES).toList()
        val pos = IntArray(markers.size)
        // The first of each wins: the template's catch block assigns an empty
        // CAVES_DATA again further down, which must not overwrite the real one.
        val done = have.toMutableSet()
        BufferedReader(InputStreamReader(FileInputStream(viewer), Charsets.UTF_8), 1 shl 16).use { r ->
            while (true) {
                val c = r.read()
                if (c < 0) break
                for (k in markers.indices) {
                    val m = markers[k]
                    pos[k] = if (m[pos[k]].code == c) pos[k] + 1 else if (m[0].code == c) 1 else 0
                    if (pos[k] == m.length) {
                        pos.fill(0)
                        val target = B64[m] ?: "caves.json"
                        if (target in done) { if (target != "caves.json") skipTo(r, '"') }
                        else if (target == "caves.json") copyJson(r, File(outDir, target))
                        else decodeB64(r, File(outDir, target))
                        if (File(outDir, target).isFile) done.add(target)
                        break
                    }
                }
            }
        }
    }

    private fun skipTo(r: Reader, end: Char) { while (true) { val c = r.read(); if (c < 0 || c == end.code) return } }

    /** Base64 up to the closing quote → bytes. A "PLACEHOLDER_..." value means none. */
    private fun decodeB64(r: Reader, out: File) {
        val head = StringBuilder()
        while (head.length < 11) { val c = r.read(); if (c < 0 || c == '"'.code) break; head.append(c.toChar()) }
        if (head.startsWith("PLACEHOLDER") || head.length < 4) { if (head.length == 11) skipTo(r, '"'); return }
        val src = object : InputStream() {
            var i = 0; var done = false
            override fun read(): Int {
                if (i < head.length) return head[i++].code
                if (done) return -1
                val c = r.read()
                if (c < 0 || c == '"'.code) { done = true; return -1 }
                return c
            }
        }
        FileOutputStream(out).use { o -> Base64.getDecoder().wrap(src).copyTo(o, 1 shl 16) }
    }

    /** The JSON literal: everything up to "; }" at the end of its line (JSON
     *  can't hold a raw line break, so that can't occur inside it). */
    private fun copyJson(r: Reader, out: File) {
        FileOutputStream(out).bufferedWriter(Charsets.UTF_8).use { w ->
            val pend = StringBuilder()
            while (true) {
                val c = r.read()
                if (c < 0) { w.write(pend.toString()); return }
                pend.append(c.toChar())
                val n = pend.length
                if (n >= 4 && (c == '\n'.code || c == '\r'.code) && pend[n - 2] == '}' && pend[n - 3] == ' ' && pend[n - 4] == ';') {
                    w.write(pend.substring(0, n - 4)); return
                }
                if (n > 4096) { w.write(pend.substring(0, n - 4)); pend.delete(0, n - 4) }
            }
        }
    }
}
