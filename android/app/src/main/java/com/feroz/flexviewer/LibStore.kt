package com.feroz.flexviewer

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.ImageDecoder
import android.graphics.pdf.PdfRenderer
import android.net.Uri
import android.os.Build
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream
import java.security.MessageDigest
import java.util.Base64
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream
import java.util.zip.ZipOutputStream

/**
 * The project library: what people add to a project (caves, documents,
 * notes, leads, field survey), shared by every map of that project and
 * synced by sync files. The rules (replay, merge, conflicts) are in the
 * page's flexlib.js; this class only keeps the files.
 *
 *   files/library/device.json                 this phone's device id
 *   files/library/blobs/<sha256>.<ext>        document pages, stored once
 *   files/library/<scope>/log-<dev>.jsonl     one append-only log per device and scope
 *   files/library/projects.json               project ids and names (for the lists)
 *   files/library/kv.json                     small page settings (what the last sync file had)
 *   files/library/tmp/<token>.tif             TIFFs waiting for the page to decode them
 *
 * Scopes: "p-<project id>" (a project) and "docs" (documents). This phone
 * only ever writes its own log files; entries from sync files go to the
 * sending devices' files, and only when this phone doesn't have them yet.
 */
class LibStore(private val ctx: Context, private val maps: MapStore) {

    val root: File = File(ctx.filesDir, "library").apply { mkdirs() }
    private val blobs = File(root, "blobs").apply { mkdirs() }
    private val tmp = File(root, "tmp").apply { mkdirs() }
    private val lock = Any()

    companion object {
        val SCOPE_RE = Regex("^(docs|p-[A-Za-z0-9_-]{1,40})$")
        val DEV_RE = Regex("^[A-Za-z0-9_-]{1,40}$")
        val HASH_RE = Regex("^[0-9a-f]{64}$")
        val TOKEN_RE = Regex("^[0-9a-f]{12}$")
        val EXTS = setOf("jpg", "png", "webp", "pdf", "plt")   // plt: a project's survey files
        /** Pages are kept at most this long on the long side: readable pencil, a sync file that fits in an email. */
        const val PAGE_PX = 2400
        private const val MAX_BLOB = 40L shl 20
        private const val MAX_LOG = 64L shl 20

        fun sha256(b: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(b).joinToString("") { "%02x".format(it) }
    }

    // ── Device ──────────────────────────────────────────────────────────────
    val device: String by lazy {
        synchronized(lock) {
            val f = File(root, "device.json")
            val cur = try { JSONObject(f.readText()).optString("id") } catch (_: Exception) { "" }
            if (DEV_RE.matches(cur)) cur
            else {
                val id = "a" + MapStore.newId()
                f.writeText(JSONObject().put("id", id).put("created", System.currentTimeMillis()).toString())
                id
            }
        }
    }

    // ── Logs ────────────────────────────────────────────────────────────────
    private fun scopeDir(scope: String): File? = if (SCOPE_RE.matches(scope)) File(root, scope).apply { mkdirs() } else null

    /** Every device's entries of a scope, as JSON lines. */
    fun read(scope: String): String = synchronized(lock) {
        val d = scopeDir(scope) ?: return ""
        val sb = StringBuilder()
        d.listFiles()?.filter { it.isFile && it.name.startsWith("log-") && it.name.endsWith(".jsonl") }?.sortedBy { it.name }?.forEach {
            val t = it.readText(Charsets.UTF_8)
            sb.append(t); if (t.isNotEmpty() && !t.endsWith("\n")) sb.append('\n')
        }
        sb.toString()
    }

    /** An entry this phone made: its own device, its id = "<dev>.<seq>". */
    fun append(scope: String, line: String): Boolean = synchronized(lock) {
        val d = scopeDir(scope) ?: return false
        val clean = line.replace("\n", " ").replace("\r", " ")
        val e = try { JSONObject(clean) } catch (_: Exception) { return false }
        if (e.optString("dev") != device || e.optString("id") != "$device.${e.optLong("seq")}" || e.optLong("seq") <= 0) return false
        FileOutputStream(File(d, "log-$device.jsonl"), true).use { it.write((clean + "\n").toByteArray(Charsets.UTF_8)) }
        true
    }

    private fun knownIds(d: File): HashSet<String> {
        val ids = HashSet<String>()
        d.listFiles()?.filter { it.isFile && it.name.startsWith("log-") }?.forEach { f ->
            f.forEachLine(Charsets.UTF_8) { l -> if (l.isNotBlank()) try { ids.add(JSONObject(l).optString("id")) } catch (_: Exception) {} }
        }
        return ids
    }

    // ── Pages ───────────────────────────────────────────────────────────────
    fun blobFile(name: String): File? {
        val h = name.substringBefore('.'); val ext = name.substringAfter('.', "")
        if (!HASH_RE.matches(h) || ext !in EXTS) return null
        return File(blobs, "$h.$ext").takeIf { it.isFile }
    }

    private fun putBlob(bytes: ByteArray, ext: String): JSONObject {
        require(ext in EXTS) { "bad type" }
        val h = sha256(bytes)
        val f = File(blobs, "$h.$ext")
        if (!f.isFile) {
            val t = File(blobs, "$h.$ext.part")
            t.writeBytes(bytes)
            t.renameTo(f)
        }
        return JSONObject().put("h", h).put("ext", ext)
    }

    /** A page the page made itself (a decoded TIFF), as base64. */
    fun putBlobB64(b64: String, ext: String): String = try {
        putBlob(Base64.getDecoder().decode(b64), ext).toString()
    } catch (_: Exception) { "null" }

    private fun jpeg(bmp: Bitmap): ByteArray = ByteArrayOutputStream().also { bmp.compress(Bitmap.CompressFormat.JPEG, 85, it) }.toByteArray()

    /** Picked files → pages. Photos and scans are scaled to PAGE_PX and kept
     *  as JPEG; PDFs become one page per sheet; TIFFs (which Android can't
     *  decode) are parked for the page to decode. */
    fun addPages(uris: List<Uri>, progress: (String) -> Unit): JSONObject {
        val pages = JSONArray(); val tiffs = JSONArray(); val failed = JSONArray()
        val cr = ctx.contentResolver
        for (uri in uris) {
            val name = displayName(uri) ?: "page"
            val mime = cr.getType(uri) ?: ""
            try {
                when {
                    mime == "application/pdf" || name.endsWith(".pdf", true) -> {
                        progress("Rendering $name")
                        pdfPages(uri, name).forEach { pages.put(it) }
                    }
                    mime == "image/tiff" || name.matches(Regex("(?i).*\\.tiff?$")) -> {
                        val token = MapStore.newId()
                        val f = File(tmp, "$token.tif")
                        cr.openInputStream(uri)?.use { i -> FileOutputStream(f).use { o -> i.copyTo(o) } }
                        tiffs.put(JSONObject().put("token", token).put("name", name))
                    }
                    else -> {
                        progress("Adding $name")
                        val bmp = decodeScaled(uri) ?: throw IllegalArgumentException("not an image this phone can read")
                        val o = putBlob(jpeg(bmp), "jpg").put("w", bmp.width).put("ht", bmp.height).put("name", name)
                        bmp.recycle()
                        pages.put(o)
                    }
                }
            } catch (e: Exception) { failed.put(name) }
        }
        return JSONObject().put("pages", pages).put("tiffs", tiffs).put("failed", failed)
    }

    private fun pdfPages(uri: Uri, name: String): List<JSONObject> {
        val out = mutableListOf<JSONObject>()
        val pfd = ctx.contentResolver.openFileDescriptor(uri, "r") ?: return out
        pfd.use {
            PdfRenderer(it).use { pdf ->
                for (i in 0 until pdf.pageCount) {
                    pdf.openPage(i).use { page ->
                        val scale = PAGE_PX.toFloat() / maxOf(page.width, page.height)
                        val w = maxOf(1, (page.width * scale).toInt()); val h = maxOf(1, (page.height * scale).toInt())
                        val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
                        bmp.eraseColor(Color.WHITE)
                        page.render(bmp, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                        out += putBlob(jpeg(bmp), "jpg").put("w", w).put("ht", h).put("name", "$name (${i + 1})")
                        bmp.recycle()
                    }
                }
            }
        }
        return out
    }

    /** Any image Android reads (JPEG, PNG, WebP, HEIC…), EXIF-turned, ≤ PAGE_PX. */
    private fun decodeScaled(uri: Uri): Bitmap? = try {
        if (Build.VERSION.SDK_INT >= 28) {
            ImageDecoder.decodeBitmap(ImageDecoder.createSource(ctx.contentResolver, uri)) { dec, info, _ ->
                dec.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
                val s = info.size; val m = maxOf(s.width, s.height)
                if (m > PAGE_PX) dec.setTargetSize(maxOf(1, s.width * PAGE_PX / m), maxOf(1, s.height * PAGE_PX / m))
            }
        } else {
            val cr = ctx.contentResolver
            val o = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            cr.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, o) }
            var sample = 1
            while (maxOf(o.outWidth, o.outHeight) / (sample * 2) >= PAGE_PX) sample *= 2
            val b = cr.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = sample }) }
            if (b != null && maxOf(b.width, b.height) > PAGE_PX) {
                val k = PAGE_PX.toFloat() / maxOf(b.width, b.height)
                Bitmap.createScaledBitmap(b, maxOf(1, (b.width * k).toInt()), maxOf(1, (b.height * k).toInt()), true).also { if (it !== b) b.recycle() }
            } else b
        }
    } catch (_: Exception) { null }

    fun tmpFile(token: String): File? = if (TOKEN_RE.matches(token)) File(tmp, "$token.tif").takeIf { it.isFile } else null
    fun tmpDone(token: String) { tmpFile(token)?.delete() }
    fun clearTmp() { tmp.listFiles()?.forEach { it.delete() } }

    private fun displayName(uri: Uri): String? {
        val q = try {
            ctx.contentResolver.query(uri, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                if (c.moveToFirst()) c.getString(0) else null
            }
        } catch (_: Exception) { null }
        return (q ?: uri.lastPathSegment)?.replace(Regex("[\\u0000-\\u001f]"), " ")?.take(120)
    }

    // ── Projects, settings, map → project ───────────────────────────────────
    fun projects(): JSONArray = synchronized(lock) {
        try { JSONArray(File(root, "projects.json").readText()) } catch (_: Exception) { JSONArray() }
    }
    fun setProject(id: String, name: String): Boolean = synchronized(lock) {
        if (!Regex("^[A-Za-z0-9_-]{1,40}$").matches(id)) return false
        val list = projects()
        var found = false
        for (i in 0 until list.length()) {
            val p = list.getJSONObject(i)
            if (p.optString("id") == id) { if (name.isNotBlank()) p.put("name", name.trim().take(60)); found = true }
        }
        if (!found) list.put(JSONObject().put("id", id).put("name", name.trim().take(60)))
        File(root, "projects.json").writeText(list.toString())
        true
    }
    fun projectName(id: String): String {
        val l = projects()
        for (i in 0 until l.length()) if (l.getJSONObject(i).optString("id") == id) return l.getJSONObject(i).optString("name")
        return ""
    }
    private fun kv(): JSONObject = try { JSONObject(File(root, "kv.json").readText()) } catch (_: Exception) { JSONObject() }
    fun kvGet(k: String): String = synchronized(lock) { kv().optString(k, "") }
    fun kvSet(k: String, v: String): Boolean = synchronized(lock) {
        if (k.length > 200 || v.length > 200_000) return false
        val o = kv().put(k, v)
        File(root, "kv.json").writeText(o.toString())
        true
    }
    fun mapProject(mapId: String): String = maps.readInfo(mapId)?.optString("project", "") ?: ""
    fun setMapProject(mapId: String, pid: String): Boolean =
        if (Regex("^[A-Za-z0-9_-]{1,40}$").matches(pid)) maps.updateInfo(mapId) { it.put("project", pid) } else false

    // ── Sync files ──────────────────────────────────────────────────────────
    /** Write a sync file: the manifest, the entries the page chose (grouped
     *  into one log per scope and device) and the pages they reference. */
    fun writeSync(out: File, manifest: String, entriesJson: String, blobsJson: String) {
        JSONObject(manifest)                                   // must parse
        val entries = JSONObject(entriesJson)
        val names = JSONArray(blobsJson)
        ZipOutputStream(FileOutputStream(out)).use { z ->
            z.putNextEntry(ZipEntry("manifest.json")); z.write(manifest.toByteArray(Charsets.UTF_8)); z.closeEntry()
            entries.keys().forEach { scope ->
                if (!SCOPE_RE.matches(scope)) return@forEach
                val arr = entries.getJSONArray(scope)
                val byDev = LinkedHashMap<String, StringBuilder>()
                for (i in 0 until arr.length()) {
                    val e = arr.getJSONObject(i)
                    val dev = e.optString("dev")
                    if (!DEV_RE.matches(dev)) continue
                    byDev.getOrPut(dev) { StringBuilder() }.append(e.toString()).append('\n')
                }
                byDev.forEach { (dev, sb) ->
                    z.putNextEntry(ZipEntry("logs/$scope/log-$dev.jsonl")); z.write(sb.toString().toByteArray(Charsets.UTF_8)); z.closeEntry()
                }
            }
            for (i in 0 until names.length()) {
                val f = blobFile(names.getString(i)) ?: continue
                z.putNextEntry(ZipEntry("blobs/" + f.name).apply { method = ZipEntry.STORED; size = f.length(); compressedSize = f.length(); crc = crc32(f) })
                FileInputStream(f).use { it.copyTo(z) }
                z.closeEntry()
            }
        }
    }

    private fun crc32(f: File): Long {
        val c = java.util.zip.CRC32()
        FileInputStream(f).use { i -> val b = ByteArray(1 shl 16); while (true) { val n = i.read(b); if (n < 0) break; c.update(b, 0, n) } }
        return c.value
    }

    /** Merge a sync file: entries this phone lacks go into the sending
     *  devices' logs, pages it lacks into blobs (checked against their hash).
     *  → { ok, project, from, entries, pages } or { ok: false, error }. */
    fun importSync(input: InputStream): JSONObject {
        var manifest: JSONObject? = null
        val logs = HashMap<String, MutableList<JSONObject>>()
        var logBytes = 0L
        var pages = 0
        ZipInputStream(BufferedInputStream(input, 1 shl 16)).use { zin ->
            var e: ZipEntry? = zin.nextEntry
            while (e != null) {
                val n = e.name
                if (!e.isDirectory) when {
                    n == "manifest.json" -> manifest = JSONObject(String(zin.readBytes(), Charsets.UTF_8))
                    n.startsWith("logs/") -> {
                        val m = Regex("^logs/([^/]+)/log-([^/]+)\\.jsonl$").find(n)
                        if (m != null && SCOPE_RE.matches(m.groupValues[1]) && DEV_RE.matches(m.groupValues[2])) {
                            val b = zin.readBytes()
                            logBytes += b.size
                            require(logBytes < MAX_LOG) { "sync file logs too large" }
                            val list = logs.getOrPut(m.groupValues[1]) { mutableListOf() }
                            String(b, Charsets.UTF_8).split('\n').forEach { l -> if (l.isNotBlank()) try { list.add(JSONObject(l)) } catch (_: Exception) {} }
                        }
                    }
                    n.startsWith("blobs/") -> {
                        val m = Regex("^blobs/([0-9a-f]{64})\\.([a-z]{2,4})$").find(n)
                        if (m != null && m.groupValues[2] in EXTS && !File(blobs, "${m.groupValues[1]}.${m.groupValues[2]}").isFile) {
                            val b = readCapped(zin, MAX_BLOB)
                            if (sha256(b) == m.groupValues[1]) { putBlob(b, m.groupValues[2]); pages++ }
                        }
                    }
                }
                zin.closeEntry()
                e = zin.nextEntry
            }
        }
        val mf = manifest ?: return JSONObject().put("ok", false).put("error", "Not a FLEX sync file (no manifest).")
        if (mf.optString("format") != "flex-sync") return JSONObject().put("ok", false).put("error", "Not a FLEX sync file.")
        var added = 0
        synchronized(lock) {
            logs.forEach { (scope, list) ->
                val d = scopeDir(scope) ?: return@forEach
                val known = knownIds(d)
                list.filter { it.optString("id") == "${it.optString("dev")}.${it.optLong("seq")}" && it.optLong("seq") > 0 && known.add(it.optString("id")) }
                    .sortedWith(compareBy({ it.optString("dev") }, { it.optLong("seq") }))
                    .groupBy { it.optString("dev") }
                    .forEach { (dev, es) ->
                        FileOutputStream(File(d, "log-$dev.jsonl"), true).use { o -> es.forEach { o.write((it.toString() + "\n").toByteArray(Charsets.UTF_8)) } }
                        added += es.size
                    }
            }
        }
        val p = mf.optJSONObject("project")
        if (p != null && p.optString("id").isNotBlank()) setProject(p.optString("id"), p.optString("name"))
        return JSONObject().put("ok", true).put("project", p).put("from", mf.optJSONObject("from"))
            .put("entries", added).put("pages", pages)
    }

    private fun readCapped(i: InputStream, max: Long): ByteArray {
        val o = ByteArrayOutputStream(); val b = ByteArray(1 shl 16); var total = 0L
        while (true) { val n = i.read(b); if (n < 0) break; total += n; require(total <= max) { "page too large" }; o.write(b, 0, n) }
        return o.toByteArray()
    }
}
