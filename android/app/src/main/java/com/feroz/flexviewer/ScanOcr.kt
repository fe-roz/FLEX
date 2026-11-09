package com.feroz.flexviewer

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.graphics.Rect
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.TextRecognizer
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors

/**
 * Reads the text on a document page, on the phone and offline: ML Kit Text
 * Recognition v2 (Latin) with its bundled model. For "Import shots from scan":
 * the page's libs/scan-import.js turns the words and their boxes into a table
 * of shots for the user to check.
 *
 * ref: "<sha256>.<ext>" (or the bare sha256) of a page in the library
 * (blobs/) or of a page carried by the open map's export (docs_<sha256>.<ext>,
 * ctx.map); or the 12-hex token of a file parked in the library's tmp/.
 * ctx: { req, map, rot } -- rot is the page's turn (0/90/180/270 clockwise),
 * applied before reading so the text is upright and the boxes match the page
 * as shown.
 *
 * Result: { ok, engine, width, height, rot, blocks: [{ text, box, lines: [{ text,
 * box, conf, angle, words: [{ text, box, conf, angle, chars: [{ text, box, conf }] }] }] }] }
 * with boxes [x0, y0, x1, y1] in pixels of the image that was read (width x
 * height, after the turn); or { ok: false, error }.
 */
class ScanOcr(private val lib: LibStore, private val maps: MapStore) {

    private val worker = Executors.newSingleThreadExecutor()
    /** Made on first use (on the worker thread), so opening the app costs nothing. */
    @Volatile private var reader: TextRecognizer? = null
    private fun reader(): TextRecognizer = reader ?: TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS).also { reader = it }

    companion object {
        /** Long side a page is read at, at most: plenty for pencil digits, light on memory. */
        const val MAX_PX = 3000
        private val IMAGE_EXTS = listOf("jpg", "png", "webp")
    }

    /** Read a page off the UI thread; `done` gets the result (on the worker thread). */
    fun read(ref: String, ctxJson: String, done: (JSONObject) -> Unit) {
        worker.execute {
            val res = try { run(ref, ctxJson) }
                      catch (e: Throwable) { fail(e.message ?: e.toString()) }
            done(res)
        }
    }

    fun close() {
        worker.shutdown()
        try { reader?.close() } catch (_: Exception) {}
    }

    private fun run(ref: String, ctxJson: String): JSONObject {
        val ctx = try { JSONObject(ctxJson) } catch (_: Exception) { JSONObject() }
        val f = find(ref.trim(), ctx.optString("map")) ?: return fail("That page is not on this phone")
        val rot = ((ctx.optInt("rot", 0) % 360 + 360) % 360) / 90 * 90
        var bmp = decode(f) ?: return fail("Could not read that image")
        if (rot != 0) {
            val turned = Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, Matrix().apply { postRotate(rot.toFloat()) }, true)
            if (turned !== bmp) bmp.recycle()
            bmp = turned
        }
        val w = bmp.width
        val h = bmp.height
        val text = try { Tasks.await(reader().process(InputImage.fromBitmap(bmp, 0))) } finally { bmp.recycle() }

        val blocks = JSONArray()
        for (b in text.textBlocks) {
            val lines = JSONArray()
            for (l in b.lines) {
                val words = JSONArray()
                for (e in l.elements) {
                    val chars = JSONArray()
                    for (s in e.symbols) chars.put(num(JSONObject().put("text", s.text).put("box", box(s.boundingBox)), "conf", s.confidence))
                    val wo = JSONObject().put("text", e.text).put("box", box(e.boundingBox)).put("chars", chars)
                    num(wo, "conf", e.confidence); num(wo, "angle", e.angle)
                    words.put(wo)
                }
                val lo = JSONObject().put("text", l.text).put("box", box(l.boundingBox)).put("words", words)
                num(lo, "conf", l.confidence); num(lo, "angle", l.angle)
                lines.put(lo)
            }
            blocks.put(JSONObject().put("text", b.text).put("box", box(b.boundingBox)).put("lines", lines))
        }
        return JSONObject().put("ok", true).put("engine", "mlkit-text-latin").put("width", w).put("height", h)
            .put("rot", rot).put("blocks", blocks)
    }

    /** The page's file: library page, then the map's own export page, or a parked tmp file. */
    private fun find(ref: String, mapId: String): File? {
        val h = ref.substringBefore('.').lowercase()
        val ext = ref.substringAfter('.', "").lowercase().let { if (it == "jpeg") "jpg" else it }
        if (LibStore.TOKEN_RE.matches(h)) return lib.tmpAny(h)
        if (!LibStore.HASH_RE.matches(h)) return null
        val exts = if (ext in IMAGE_EXTS) listOf(ext) else IMAGE_EXTS
        val export = maps.exportDir(mapId)
        for (x in exts) {
            lib.blobFile("$h.$x")?.let { return it }
            if (export != null) File(export, "docs_$h.$x").takeIf { it.isFile }?.let { return it }
        }
        return null
    }

    private fun decode(f: File): Bitmap? {
        val o = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(f.path, o)
        if (o.outWidth <= 0 || o.outHeight <= 0) return null
        var sample = 1
        while (maxOf(o.outWidth, o.outHeight) / (sample * 2) >= MAX_PX) sample *= 2
        return BitmapFactory.decodeFile(f.path, BitmapFactory.Options().apply { inSampleSize = sample })
    }

    private fun box(r: Rect?): Any = if (r == null) JSONObject.NULL else JSONArray().put(r.left).put(r.top).put(r.right).put(r.bottom)

    /** A float rounded to 3 places; left out when ML Kit has none (NaN). */
    private fun num(o: JSONObject, k: String, v: Float): JSONObject =
        if (v.isNaN() || v.isInfinite()) o else o.put(k, Math.round(v * 1000.0) / 1000.0)

    private fun fail(msg: String): JSONObject = JSONObject().put("ok", false).put("error", msg)
}
