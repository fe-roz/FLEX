package com.feroz.flexviewer

import java.io.BufferedInputStream
import java.io.File
import java.io.FileInputStream
import java.io.InputStream
import java.nio.file.Files
import java.security.MessageDigest
import java.util.zip.ZipInputStream

/**
 * Updating a map with only what changed (the PC side is export_update.py; its apply_update() is the same rules).
 *
 * A map's export folder holds manifest.json: every data file with its size and sha256, and `files_hash`, the
 * identity of that exact set. An update package holds update.json (the files_hash of the map it was made against,
 * the full new manifest, what to add / replace / remove) and the files that changed.
 *
 * apply() builds the new set in a folder beside the export (the changed files from the update, the others as hard
 * links to the ones already here, so nothing big is copied), checks every file against the new manifest, and only
 * then swaps the folders. Until the swap the old map is whole; recover() tidies up after a stop in between.
 *
 * Plain Kotlin on purpose (java.* only, its own small JSON reader): tools/test_map_update_kt.py compiles this file
 * alone and runs it on a PC against packages made by export_update.py.
 */
object MapUpdate {
    const val FORMAT = 1
    const val MANIFEST = "manifest.json"
    const val UPDATE = "update.json"
    /** What the update did, kept beside the data for the "About this map" card. */
    const val VERSION_FILE = "map_version.json"
    private val NOT_DATA = setOf("viewer.html", "serve.bat", "serve.sh", MANIFEST, UPDATE)

    const val NEEDS_FULL = "This update needs the full map once: the map here was made before updates existed. Send the full map, then updates will work."
    const val NO_MAP = "This update is for the map \"%s\", which is not on this phone. Send the full map."
    const val WRONG_BASE = "This update was made for another version of this map (%s); the map here is %s. Send the full map, or the update made for this version."
    const val CORRUPT = "The update is damaged (%s). Nothing was changed: send it again."

    class Refused(message: String) : Exception(message)
    class FileInfo(val size: Long, val sha256: String)
    class Manifest(val files: Map<String, FileInfo>, val filesHash: String, val exported: String, val mapId: String, val name: String, val json: Map<String, Any?>)
    class Update(val mapId: String, val name: String, val baseHash: String, val baseExported: String, val manifest: Manifest,
                 val add: List<String>, val replace: List<String>, val remove: List<String>, val bytes: Long)
    class Result(val from: String, val to: String, val added: Int, val replaced: Int, val removed: Int, val bytes: Long)

    fun isData(name: String): Boolean = name.isNotEmpty() && !name.contains('/') && !name.contains('\\') && name !in NOT_DATA && !name.startsWith(".")

    fun filesHash(files: Map<String, FileInfo>): String {
        val md = MessageDigest.getInstance("SHA-256")
        for (name in files.keys.sorted()) md.update("$name\t${files[name]!!.size}\t${files[name]!!.sha256}\n".toByteArray(Charsets.UTF_8))
        return hex(md.digest())
    }

    private fun hex(b: ByteArray): String = b.joinToString("") { "%02x".format(it) }

    fun sha256(f: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        FileInputStream(f).use { s -> val buf = ByteArray(1 shl 20); while (true) { val n = s.read(buf); if (n < 0) break; md.update(buf, 0, n) } }
        return hex(md.digest())
    }

    /** A manifest from its JSON text, or null when it is not one (wrong format, a bad name, a hash that does not match its list). */
    fun parseManifest(text: String): Manifest? = try { manifestOf(Json.parse(text)) } catch (_: Exception) { null }

    @Suppress("UNCHECKED_CAST")
    private fun manifestOf(v: Any?): Manifest? {
        val m = v as? Map<String, Any?> ?: return null
        if ((m["format"] as? Number)?.toInt() != FORMAT) return null
        val fs = m["files"] as? Map<String, Any?> ?: return null
        if (fs.isEmpty()) return null
        val files = LinkedHashMap<String, FileInfo>()
        for ((name, f) in fs) {
            val o = f as? Map<String, Any?> ?: return null
            val size = (o["size"] as? Number)?.toLong() ?: return null
            val sha = o["sha256"] as? String ?: return null
            if (!isData(name) || size < 0 || !Regex("^[0-9a-f]{64}$").matches(sha)) return null
            files[name] = FileInfo(size, sha)
        }
        val h = filesHash(files)
        if (m["files_hash"] != h) return null
        return Manifest(files, h, m["exported"] as? String ?: "", m["map_id"] as? String ?: "", m["name"] as? String ?: "", m)
    }

    /** update.json. Throws Refused when it cannot be read as one. */
    @Suppress("UNCHECKED_CAST")
    fun parseUpdate(text: String): Update {
        val bad = Refused(CORRUPT.format("its description cannot be read"))
        val u = try { Json.parse(text) as? Map<String, Any?> } catch (_: Exception) { null } ?: throw bad
        if ((u["format"] as? Number)?.toInt() != FORMAT || u["kind"] != "update") throw bad
        val man = manifestOf(u["manifest"]) ?: throw bad
        val base = u["base"] as? Map<String, Any?> ?: throw bad
        fun names(k: String): List<String> { val l = u[k] as? List<Any?> ?: throw bad; return l.map { (it as? String)?.takeIf(::isData) ?: throw bad } }
        val add = names("add"); val rep = names("replace"); val rem = names("remove")
        if ((add + rep).any { it !in man.files } || rem.any { it in man.files }) throw bad
        return Update(u["map_id"] as? String ?: "", u["name"] as? String ?: "", base["files_hash"] as? String ?: throw bad, base["exported"] as? String ?: "", man, add, rep, rem,
            (u["bytes"] as? Number)?.toLong() ?: 0L)
    }

    /** The manifest of the map in this export folder, or null (a map from before manifests). */
    fun readManifest(exportDir: File): Manifest? = try { parseManifest(File(exportDir, MANIFEST).readText(Charsets.UTF_8)) } catch (_: Exception) { null }

    /** update.json when it is the zip's first entry (an update package always has it first), else null. Reads no further. */
    fun peek(input: InputStream): Update? = try {
        ZipInputStream(BufferedInputStream(input, 1 shl 16)).use { z ->
            val e = z.nextEntry
            if (e != null && e.name == UPDATE) parseUpdate(String(z.readBytes(), Charsets.UTF_8)) else null
        }
    } catch (_: Exception) { null }

    /** Throws Refused unless the map in exportDir is the one the update was made against. */
    fun check(exportDir: File, u: Update): Manifest {
        val cur = readManifest(exportDir) ?: throw Refused(NEEDS_FULL)
        if (cur.filesHash != u.baseHash) throw Refused(WRONG_BASE.format(u.baseExported.ifBlank { "unknown" }, cur.exported.ifBlank { "unknown" }))
        return cur
    }

    /**
     * Turn the map in [exportDir] into the update's map. [staged] holds the update's files (unpacked). Nothing in
     * exportDir changes unless everything checks; then the folders are swapped. Throws Refused with a plain message.
     * failAfter (tests): stop after that many files, as a phone switched off half way would.
     */
    fun apply(exportDir: File, staged: File, u: Update, failAfter: Int = -1): Result {
        val cur = check(exportDir, u)
        val parent = exportDir.parentFile ?: throw Refused(CORRUPT.format("no place to work"))
        val work = File(parent, exportDir.name + ".new"); val old = File(parent, exportDir.name + ".old")
        work.deleteRecursively(); work.mkdirs()
        val changed = (u.add + u.replace).toSet()
        try {
            var done = 0
            for (name in u.manifest.files.keys.sorted()) {
                val want = u.manifest.files[name]!!
                val dst = File(work, name)
                if (name in changed) {
                    val src = File(staged, name)
                    if (!src.isFile) throw Refused(CORRUPT.format("$name is missing"))
                    if (!src.renameTo(dst)) src.copyTo(dst, true)
                    if (dst.length() != want.size || sha256(dst) != want.sha256) throw Refused(CORRUPT.format("$name is not what the update says"))
                } else {
                    val src = File(exportDir, name)
                    if (!src.isFile) throw Refused(WRONG_BASE.format(u.baseExported.ifBlank { "unknown" }, "missing $name"))
                    try { Files.createLink(dst.toPath(), src.toPath()) } catch (_: Throwable) { src.copyTo(dst, true) }      // the same bytes under a second name: no copy
                    if (dst.length() != want.size || sha256(dst) != want.sha256) throw Refused(WRONG_BASE.format(u.baseExported.ifBlank { "unknown" }, "changed: $name"))
                }
                done++
                if (failAfter in 0..done) throw InterruptedException("stopped half way (a test)")
            }
            File(work, MANIFEST).writeText(Json.write(u.manifest.json), Charsets.UTF_8)
            // what this update did, for the About card; an earlier update's "first" time is kept
            val before = try { Json.parse(File(exportDir, VERSION_FILE).readText(Charsets.UTF_8)) as? Map<*, *> } catch (_: Exception) { null }
            val count = ((before?.get("updates") as? Number)?.toInt() ?: 0) + 1
            File(work, VERSION_FILE).writeText(Json.write(mapOf("exported" to u.manifest.exported, "updated_from" to cur.exported, "updates" to count,
                "first" to ((before?.get("first") as? String) ?: cur.exported))), Charsets.UTF_8)
        } catch (e: Refused) {
            work.deleteRecursively(); throw e
        }
        old.deleteRecursively()
        if (!exportDir.renameTo(old)) { work.deleteRecursively(); throw Refused(CORRUPT.format("the old map could not be set aside")) }
        if (!work.renameTo(exportDir)) { old.renameTo(exportDir); work.deleteRecursively(); throw Refused(CORRUPT.format("the new map could not be moved in")) }
        old.deleteRecursively()
        return Result(cur.exported, u.manifest.exported, u.add.size, u.replace.size, u.remove.size, u.bytes)
    }

    /** After a stop in the middle of an update (or of a full replace): the half-built set goes; a map caught between
     *  the two renames gets its old files back. */
    fun recover(exportDir: File) {
        val parent = exportDir.parentFile ?: return
        val work = File(parent, exportDir.name + ".new"); val old = File(parent, exportDir.name + ".old")
        if (!exportDir.isDirectory && old.isDirectory) old.renameTo(exportDir)
        work.deleteRecursively(); old.deleteRecursively()
    }

    /** A small JSON reader and writer: objects as LinkedHashMap, arrays as List, numbers as Long or Double. */
    object Json {
        fun parse(s: String): Any? { val p = P(s); p.ws(); val v = p.value(); p.ws(); require(p.i == s.length) { "trailing text" }; return v }
        private class P(val s: String) {
            var i = 0
            fun ws() { while (i < s.length && s[i].isWhitespace()) i++ }
            fun value(): Any? {
                require(i < s.length) { "end" }
                return when (val c = s[i]) {
                    '{' -> { i++; val m = LinkedHashMap<String, Any?>(); ws(); if (s[i] == '}') { i++; return m }
                        while (true) { ws(); val k = str(); ws(); require(s[i] == ':'); i++; ws(); m[k] = value(); ws(); if (s[i] == ',') { i++; continue }; require(s[i] == '}'); i++; return m } }
                    '[' -> { i++; val l = ArrayList<Any?>(); ws(); if (s[i] == ']') { i++; return l }
                        while (true) { ws(); l.add(value()); ws(); if (s[i] == ',') { i++; continue }; require(s[i] == ']'); i++; return l } }
                    '"' -> str()
                    't' -> { require(s.startsWith("true", i)); i += 4; true }
                    'f' -> { require(s.startsWith("false", i)); i += 5; false }
                    'n' -> { require(s.startsWith("null", i)); i += 4; null }
                    else -> { val j = i; require(c == '-' || c.isDigit()); while (i < s.length && (s[i].isDigit() || s[i] in "+-.eE")) i++
                        val t = s.substring(j, i); t.toLongOrNull() ?: t.toDouble() }
                }
            }
            fun str(): String {
                require(s[i] == '"'); i++
                val sb = StringBuilder()
                while (true) {
                    val c = s[i++]
                    if (c == '"') return sb.toString()
                    if (c != '\\') { sb.append(c); continue }
                    when (val e = s[i++]) {
                        'n' -> sb.append('\n'); 't' -> sb.append('\t'); 'r' -> sb.append('\r'); 'b' -> sb.append('\b'); 'f' -> sb.append('\u000c')
                        'u' -> { sb.append(s.substring(i, i + 4).toInt(16).toChar()); i += 4 }
                        else -> sb.append(e)
                    }
                }
            }
        }
        fun write(v: Any?): String = StringBuilder().also { w(it, v) }.toString()
        private fun w(sb: StringBuilder, v: Any?) {
            when (v) {
                null -> sb.append("null")
                is String -> { sb.append('"'); for (c in v) when { c == '"' -> sb.append("\\\""); c == '\\' -> sb.append("\\\\"); c == '\n' -> sb.append("\\n"); c == '\r' -> sb.append("\\r"); c == '\t' -> sb.append("\\t")
                    c < ' ' -> sb.append("\\u%04x".format(c.code)); else -> sb.append(c) }; sb.append('"') }
                is Map<*, *> -> { sb.append('{'); var first = true; for ((k, x) in v) { if (!first) sb.append(','); first = false; w(sb, k.toString()); sb.append(':'); w(sb, x) }; sb.append('}') }
                is List<*> -> { sb.append('['); var first = true; for (x in v) { if (!first) sb.append(','); first = false; w(sb, x) }; sb.append(']') }
                else -> sb.append(v.toString())
            }
        }
    }
}
