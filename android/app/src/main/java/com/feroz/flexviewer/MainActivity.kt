package com.feroz.flexviewer

import android.Manifest
import android.annotation.SuppressLint
import android.content.ClipData
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.WindowManager
import android.webkit.GeolocationPermissions
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.webkit.WebViewAssetLoader
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.File
import java.io.FileInputStream
import java.util.concurrent.Executors

/**
 * FLEX Field: one app that opens FLEX map exports (zips), with a project
 * library for what people add (notes, documents, leads, field survey) and
 * sync files to share it with other phones and with FLEX.
 *
 * Pages are served by WebViewAssetLoader over https://appassets.androidplatform.net/,
 * which Chrome treats as a trustworthy origin -- the reason this app exists:
 * file://, content:// and LAN origins never get geolocation or the compass.
 *
 *   /assets/flexfield/index.html     the map list (bundled)
 *   /map/<id>/viewer.html            the bundled viewer, filled in for that map
 *   /map/<id>/libs/<lib>.js          the bundled three.js
 *   /map/<id>/<data file>            that map's export (terrain.glb, caves.json, …)
 *   /lib/blob/<sha256>.<ext>         a document page from the library
 *   /lib/tmp/<token>                 a picked TIFF, for the page to decode
 *
 * Nothing is served over a socket, and the app declares no INTERNET permission.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var store: MapStore
    private lateinit var lib: LibStore
    private lateinit var ocr: ScanOcr
    private val io = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())

    private val home = "https://appassets.androidplatform.net/assets/flexfield/index.html"

    /** Geolocation request parked while we ask Android for the OS permission. */
    private var pendingGeoOrigin: String? = null
    private var pendingGeoCallback: GeolocationPermissions.Callback? = null

    /** What the next file picker result is for. */
    private var pickTarget: String? = null        // map id for "Update from zip…", else null
    private var pickAuthor: String = ""
    private var pagesCtx: String? = null                  // the page's context for picked pages (JSON)

    /** A zip handed to us ("Open with", share) before the map list was ready. */
    private var pendingZip: Uri? = null
    private var homeReady = false

    /** Imports waiting for the user to choose update / separate / cancel. */
    private val staged = HashMap<String, MapStore.Staged>()

    private val locationPermissionRequest = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { grants ->
        val granted = grants[Manifest.permission.ACCESS_FINE_LOCATION] == true ||
                      grants[Manifest.permission.ACCESS_COARSE_LOCATION] == true
        pendingGeoCallback?.invoke(pendingGeoOrigin, granted, false)
        pendingGeoOrigin = null
        pendingGeoCallback = null
        if (!granted) toast("Location denied - the position marker will stay off")
    }

    private val zipPicker = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) startImport(uri, pickTarget, pickAuthor) else js("window.ffImportCancelled && ffImportCancelled()")
        pickTarget = null
    }

    /** <input type="file"> in the pages (KML import, a PLT to update a cave): a
     *  WebView shows no picker unless the app opens one and hands back the URIs. */
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private val pagePicker = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        val cb = fileCallback
        fileCallback = null
        val data = r.data
        val uris = mutableListOf<Uri>()
        if (r.resultCode == RESULT_OK && data != null) {
            val clip = data.clipData
            if (clip != null) for (k in 0 until clip.itemCount) clip.getItemAt(k).uri?.let { uris.add(it) }
            else data.data?.let { uris.add(it) }
        }
        cb?.onReceiveValue(if (uris.isEmpty()) null else uris.toTypedArray())
    }

    /** Documents: picked files → pages in the library; the page makes the document. */
    private val pagesPicker = registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        val ctx = pagesCtx ?: "{}"
        pagesCtx = null
        if (uris.isNullOrEmpty()) return@registerForActivityResult
        toast("Adding ${uris.size} file${if (uris.size > 1) "s" else ""}…")
        io.execute {
            val res = try { lib.addPages(uris) { msg -> main.post { toast(msg) } } }
                      catch (e: Exception) { main.post { toast("Could not add: ${e.message}") }; JSONObject().put("pages", org.json.JSONArray()) }
            js("window.ffPagesPicked && ffPagesPicked(${q(ctx)}, ${q(res.toString())})")
        }
    }

    /** "Photograph a page" (scan import): the phone's camera app writes the
     *  photo into cache/camera/ (no CAMERA permission needed, none declared);
     *  it becomes a page in the library, and the page collects it with
     *  photoResult() when told (ffPhotoReady) or when it loads again -- the
     *  activity may have been recreated while the camera was in front. */
    private var photoPath: String? = null
    private var photoCtx: String? = null
    private val photoLock = Any()
    private var photoDone: String? = null
    private val photoTaker = registerForActivityResult(ActivityResultContracts.TakePicture()) { _ ->
        // The photo counts if the camera app wrote it (a few report "cancelled" even so).
        val f = photoPath?.let { File(it) }
        val ctx = photoCtx ?: "{}"
        photoPath = null
        photoCtx = null
        if (f == null || !f.isFile || f.length() == 0L) {
            f?.delete()
            photoReady(ctx, JSONObject().put("pages", JSONArray()).put("cancelled", true))
            return@registerForActivityResult
        }
        toast("Saving the page…")
        io.execute {
            val res = try { lib.addPages(listOf(FileProvider.getUriForFile(this, "$packageName.fileprovider", f))) { } }
                      catch (e: Exception) { JSONObject().put("pages", JSONArray()).put("error", e.message ?: e.toString()) }
            f.delete()
            photoReady(ctx, res)
        }
    }
    private fun photoReady(ctx: String, res: JSONObject) {
        synchronized(photoLock) { photoDone = JSONObject().put("ctx", ctx).put("res", res).toString() }
        js("window.ffPhotoReady && ffPhotoReady()")
    }

    /** Sync files: a zip someone made in FLEX Field or FLEX. */
    private val syncPicker = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri == null) return@registerForActivityResult
        toast("Reading the sync file…")
        io.execute {
            val res = try { contentResolver.openInputStream(uri)?.use { lib.importSync(it) } ?: JSONObject().put("ok", false).put("error", "Could not read that file") }
                      catch (e: Exception) { JSONObject().put("ok", false).put("error", e.message ?: e.toString()) }
            js("window.ffSyncImported && ffSyncImported(${q(res.toString())})")
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = MapStore(this)
        lib = LibStore(this, store)
        ocr = ScanOcr(lib, store)
        photoPath = savedInstanceState?.getString("photoPath")
        photoCtx = savedInstanceState?.getString("photoCtx")

        // Draw behind the cutout and system bars; the viewer is a full-bleed canvas.
        WindowCompat.setDecorFitsSystemWindows(window, false)
        // Only while in the foreground: put the phone in a pack and the activity stops.
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .addPathHandler("/map/", MapPathHandler())
            .addPathHandler("/lib/", LibPathHandler())
            .build()

        webView = WebView(this).apply {
            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                    assetLoader.shouldInterceptRequest(request.url)

                // Everything is local; refuse to navigate anywhere else.
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                    request.url.host != "appassets.androidplatform.net"

                override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
                    homeReady = false
                }
            }

            webChromeClient = object : WebChromeClient() {
                override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>,
                                               params: FileChooserParams): Boolean {
                    fileCallback?.onReceiveValue(null)
                    fileCallback = callback
                    // Any file: the accept list is extensions (.kml, .plt) that
                    // Android's picker can't filter on; the page checks the name.
                    val i = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                        addCategory(Intent.CATEGORY_OPENABLE)
                        type = "*/*"
                        if (params.mode == FileChooserParams.MODE_OPEN_MULTIPLE) putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                    }
                    return try { pagePicker.launch(i); true }
                           catch (_: Exception) { fileCallback = null; false }
                }

                override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) {
                    val fine = ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
                    val coarse = ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
                    if (fine || coarse) callback.invoke(origin, true, true)
                    else {
                        pendingGeoOrigin = origin
                        pendingGeoCallback = callback
                        locationPermissionRequest.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
                    }
                }
            }

            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                setGeolocationEnabled(true)
                allowFileAccess = false
                allowContentAccess = false
                mediaPlaybackRequiresUserGesture = false
                useWideViewPort = true
                loadWithOverviewMode = false
            }

            addJavascriptInterface(AndroidHost(), "AndroidHost")
            setBackgroundColor(0xFF0A0A0F.toInt())
            isVerticalScrollBarEnabled = false
            isHorizontalScrollBarEnabled = false
        }

        if (0 != (applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE)) {
            WebView.setWebContentsDebuggingEnabled(true)
        }

        setContentView(webView)
        enterImmersive()

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                when {
                    webView.canGoBack() -> webView.goBack()
                    webView.url?.startsWith(home) == false -> webView.loadUrl(home)
                    else -> finish()
                }
            }
        })

        // Old exports' leftovers from an interrupted import.
        io.execute { File(store.root, ".staging").listFiles()?.forEach { it.deleteRecursively() }; lib.clearTmp() }

        if (savedInstanceState == null) webView.loadUrl(home)
        takeZipIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        takeZipIntent(intent)
    }

    /** "Open with" and share sheet: a zip to import. */
    private fun takeZipIntent(i: Intent?) {
        if (i == null) return
        val uri: Uri = when (i.action) {
            Intent.ACTION_VIEW -> i.data
            Intent.ACTION_SEND -> streamExtra(i)
            else -> null
        } ?: return
        i.action = null                       // don't import it again on a recreate
        pendingZip = uri
        if (homeReady) runPendingZip() else if (webView.url?.startsWith(home) != true) webView.loadUrl(home)
    }

    @Suppress("DEPRECATION")
    private fun streamExtra(i: Intent): Uri? =
        if (android.os.Build.VERSION.SDK_INT >= 33) i.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
        else i.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)

    private fun runPendingZip() {
        val uri = pendingZip ?: return
        pendingZip = null
        // The map list asks for a name first if it doesn't have one, then calls back.
        js("window.ffIncomingZip ? ffIncomingZip() : AndroidHost.importIncoming('')")
        incoming = uri
    }
    private var incoming: Uri? = null

    // ── Import ──────────────────────────────────────────────────────────────
    private fun startImport(uri: Uri, targetId: String?, author: String) {
        js("window.ffImportProgress && ffImportProgress(${q("Opening the zip…")})")
        io.execute {
            try {
                val s = contentResolver.openInputStream(uri)?.use { input ->
                    store.stage(input) { msg, _ -> js("window.ffImportProgress && ffImportProgress(${q(msg)})") }
                } ?: throw IllegalStateException("Could not read that file")
                if (targetId != null) {
                    val id = store.commit(s.dir, s.name, s.formatVersion, targetId, author)
                    done(id, true)
                    return@execute
                }
                val matches = store.matches(s.name)
                if (matches.length() == 0) {
                    val id = store.commit(s.dir, s.name, s.formatVersion, null, author)
                    done(id, false)
                } else {
                    synchronized(staged) { staged[s.token] = s }
                    val ask = JSONObject().put("token", s.token).put("name", s.name).put("bytes", s.bytes).put("matches", matches)
                    js("window.ffImportAsk && ffImportAsk(${q(ask.toString())})")
                }
            } catch (e: Exception) {
                js("window.ffImportFailed && ffImportFailed(${q(e.message ?: e.toString())})")
            }
        }
    }

    private fun done(id: String, updated: Boolean) {
        val info = store.readInfo(id) ?: JSONObject().put("id", id)
        info.put("updated", updated)
        js("window.ffImportDone && ffImportDone(${q(info.toString())})")
    }

    // ── JS bridge ───────────────────────────────────────────────────────────
    /** The surface the pages call into. Every map id and file name is checked in MapStore. */
    inner class AndroidHost {
        @JavascriptInterface fun isNativeHost(): Boolean = true
        @JavascriptInterface fun appVersion(): String = try { packageManager.getPackageInfo(packageName, 0).versionName ?: "" } catch (_: Exception) { "" }

        @JavascriptInterface
        fun setKeepAwake(on: Boolean) {
            runOnUiThread {
                if (on) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
        }

        /** Hands a text file the page made (GPX, KML, JSON) to the share sheet. */
        @JavascriptInterface
        fun shareFile(name: String, mime: String, content: String): Boolean = try {
            val safe = name.replace(Regex("[^A-Za-z0-9._-]"), "_").take(100).ifEmpty { "flex-export.txt" }
            val file = File(File(cacheDir, "shared").apply { mkdirs() }, safe)
            file.writeText(content, Charsets.UTF_8)
            share(file, mime)
            true
        } catch (e: Exception) { runOnUiThread { toast("Could not share: ${e.message}") }; false }

        // map list
        @JavascriptInterface fun homeReady() { runOnUiThread { homeReady = true; runPendingZip() } }
        @JavascriptInterface fun listMaps(): String {
            val a = store.listMaps()
            for (i in 0 until a.length()) { val m = a.getJSONObject(i); val p = m.optString("project"); if (p.isNotBlank()) m.put("projectName", lib.projectName(p)) }
            return a.toString()
        }
        @JavascriptInterface fun openMap(id: String) {
            if (store.mapDir(id) == null) return
            io.execute { store.touchOpened(id) }
            runOnUiThread { webView.loadUrl("https://appassets.androidplatform.net/map/$id/viewer.html") }
        }
        @JavascriptInterface fun renameMap(id: String, name: String): Boolean = store.rename(id, name)
        @JavascriptInterface fun deleteMap(id: String): Boolean = store.delete(id)

        /** Pick a zip: a new map, or (targetId) a newer export of that map. */
        @JavascriptInterface fun importZip(targetId: String, author: String) {
            runOnUiThread {
                pickTarget = targetId.ifBlank { null }?.takeIf { store.mapDir(it) != null }
                pickAuthor = author
                zipPicker.launch(arrayOf("application/zip", "application/x-zip-compressed", "application/octet-stream"))
            }
        }
        /** The zip handed to the app from outside, once the page has a name to log. */
        @JavascriptInterface fun importIncoming(author: String) {
            runOnUiThread { val u = incoming; incoming = null; if (u != null) startImport(u, null, author) }
        }
        /** The answer to ffImportAsk: "update" (into targetId), "new" or "cancel". */
        @JavascriptInterface fun resolveImport(token: String, action: String, targetId: String, author: String) {
            val s = synchronized(staged) { staged.remove(token) } ?: return
            io.execute {
                try {
                    when (action) {
                        "update" -> done(store.commit(s.dir, s.name, s.formatVersion, targetId, author), true)
                        "new" -> done(store.commit(s.dir, s.name, s.formatVersion, null, author), false)
                        else -> { store.discard(token); js("window.ffImportCancelled && ffImportCancelled()") }
                    }
                } catch (e: Exception) {
                    store.discard(token)
                    js("window.ffImportFailed && ffImportFailed(${q(e.message ?: e.toString())})")
                }
            }
        }
        /** Zip a map's log (plus what the page adds: tracks and pins) and share it. */
        @JavascriptInterface fun shareMapData(id: String, extrasJson: String): Boolean {
            val info = store.readInfo(id) ?: return false
            io.execute {
                try {
                    val extras = HashMap<String, String>()
                    try { val o = JSONObject(extrasJson); o.keys().forEach { k -> extras[k] = o.getString(k) } } catch (_: Exception) {}
                    val slug = info.optString("name", "map").replace(Regex("[^A-Za-z0-9]+"), "-").trim('-').ifEmpty { "map" }
                    val f = File(File(cacheDir, "shared").apply { mkdirs() }, "$slug-field-data.zip")
                    store.zipUserData(id, extras, f)
                    share(f, "application/zip")
                } catch (e: Exception) { main.post { toast("Could not share: ${e.message}") } }
            }
            return true
        }

        // change log
        @JavascriptInterface fun logRead(id: String): String = store.readLog(id)
        @JavascriptInterface fun logAppend(id: String, line: String): Boolean = store.appendLogLine(id, line)

        // the project library (flexlib.js in the page does the rest)
        @JavascriptInterface fun libDevice(): String = lib.device
        @JavascriptInterface fun libRead(scope: String): String = lib.read(scope)
        @JavascriptInterface fun libAppend(scope: String, line: String): Boolean = lib.append(scope, line)
        @JavascriptInterface fun libPutBlob(b64: String, ext: String): String = lib.putBlobB64(b64, ext)
        @JavascriptInterface fun libProjects(): String = lib.projects().toString()
        @JavascriptInterface fun libSetProject(id: String, name: String): Boolean = lib.setProject(id, name)
        @JavascriptInterface fun libMapProject(mapId: String): String = lib.mapProject(mapId)
        @JavascriptInterface fun libSetMapProject(mapId: String, pid: String): Boolean = lib.setMapProject(mapId, pid)
        @JavascriptInterface fun libKvGet(k: String): String = lib.kvGet(k)
        @JavascriptInterface fun libKvSet(k: String, v: String): Boolean = lib.kvSet(k, v)
        @JavascriptInterface fun libTmpDone(token: String) { lib.tmpDone(token) }
        @JavascriptInterface fun libPickPages(ctxJson: String) {
            runOnUiThread { pagesCtx = ctxJson; pagesPicker.launch(arrayOf("image/*", "application/pdf")) }
        }
        @JavascriptInterface fun libSyncImport() {
            runOnUiThread { syncPicker.launch(arrayOf("application/zip", "application/x-zip-compressed", "application/octet-stream")) }
        }
        /** Write a sync file and hand it to the share sheet. */
        @JavascriptInterface fun libSyncWrite(name: String, manifest: String, entriesJson: String, blobsJson: String): Boolean = try {
            val safe = name.replace(Regex("[^A-Za-z0-9._-]"), "_").take(100).let { if (it.endsWith(".zip")) it else "$it.zip" }
            val dir = File(cacheDir, "shared").apply { mkdirs() }
            dir.listFiles()?.filter { it.name.startsWith("FLEX-sync-") }?.forEach { it.delete() }
            val f = File(dir, safe)
            lib.writeSync(f, manifest, entriesJson, blobsJson)
            share(f, "application/zip")
            true
        } catch (e: Exception) { runOnUiThread { toast("Could not write the sync file: ${e.message}") }; false }

        // scan import ("Import shots from scan", libs/scan-import.js)
        /** Read a page's text on the phone (ML Kit, offline) → ffOcrDone(ctx, result). See ScanOcr. */
        @JavascriptInterface fun ocrImage(ref: String, ctxJson: String) {
            ocr.read(ref, ctxJson) { res -> js("window.ffOcrDone && ffOcrDone(${q(ctxJson)}, ${q(res.toString())})") }
        }
        /** Photograph a page with the camera app → a page in the library → ffPhotoReady(); then photoResult(). */
        @JavascriptInterface fun takePhoto(ctxJson: String) {
            runOnUiThread {
                try {
                    val dir = File(cacheDir, "camera").apply { mkdirs() }
                    dir.listFiles()?.forEach { it.delete() }
                    val stamp = java.text.SimpleDateFormat("yyyy-MM-dd HHmm", java.util.Locale.US).format(java.util.Date())
                    val f = File(dir, "Scan $stamp.jpg")
                    photoPath = f.absolutePath
                    photoCtx = ctxJson
                    photoTaker.launch(FileProvider.getUriForFile(this@MainActivity, "$packageName.fileprovider", f))
                } catch (e: Exception) {
                    photoPath = null
                    photoCtx = null
                    photoReady(ctxJson, JSONObject().put("pages", JSONArray()).put("error", "No camera app on this phone"))
                }
            }
        }
        /** The last photographed page, once: { ctx, res: { pages, … } } as JSON, or "". */
        @JavascriptInterface fun photoResult(): String = synchronized(photoLock) { val s = photoDone ?: ""; photoDone = null; s }
    }

    // ── /lib/… ──────────────────────────────────────────────────────────────
    private inner class LibPathHandler : WebViewAssetLoader.PathHandler {
        override fun handle(path: String): WebResourceResponse? {
            val parts = path.split('/')
            val f: File? = when {
                parts.size == 2 && parts[0] == "blob" -> lib.blobFile(parts[1])
                parts.size == 2 && parts[0] == "tmp" -> lib.tmpFile(parts[1])
                else -> null
            }
            if (f == null) return WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), ByteArrayInputStream(ByteArray(0)))
            val mime = when (f.extension.lowercase()) { "jpg" -> "image/jpeg"; "png" -> "image/png"; "webp" -> "image/webp"; "pdf" -> "application/pdf"; else -> "application/octet-stream" }
            return WebResourceResponse(mime, null, FileInputStream(f)).apply { responseHeaders = mapOf("Cache-Control" to "max-age=31536000, immutable") }
        }
    }

    // ── /map/<id>/… ─────────────────────────────────────────────────────────
    private inner class MapPathHandler : WebViewAssetLoader.PathHandler {
        @Volatile private var template: String? = null

        override fun handle(path: String): WebResourceResponse? {
            val parts = path.split('/')
            if (parts.size < 2) return notFound()
            val id = parts[0]
            val dir = store.mapDir(id) ?: return notFound()
            val rest = parts.drop(1)
            return try {
                when {
                    rest == listOf("viewer.html") -> html(viewerFor(id))
                    rest.size == 2 && rest[0] == "libs" && MapStore.safeName(rest[1]) ->
                        WebResourceResponse("application/javascript", "utf-8", assets.open("libs/" + rest[1]))
                    rest.size == 1 && MapStore.isDataFile(rest[0]) -> file(File(dir, "export/" + rest[0]))
                    else -> notFound()
                }
            } catch (_: Exception) { notFound() }
        }

        /** The bundled viewer with this map's file names in place of the inline
         *  payloads, and its survey data read from caves.json. */
        private fun viewerFor(id: String): String {
            val t = template ?: assets.open("viewer.html").bufferedReader(Charsets.UTF_8).use { it.readText() }.also { template = it }
            val has = { f: String -> store.has(id, f) }
            return t.replace("\"PLACEHOLDER_GLB_B64\"", "\"terrain.glb\"")
                .replace("\"PLACEHOLDER_TEX_B64\"", if (has("tex_sat.jpg")) "\"tex_sat.jpg\"" else "\"PLACEHOLDER_TEX_B64\"")
                .replace("\"PLACEHOLDER_HS_B64\"", if (has("tex_hs.jpg")) "\"tex_hs.jpg\"" else "\"PLACEHOLDER_HS_B64\"")
                .replace("\"PLACEHOLDER_WALLS_B64\"", if (has("walls.bin")) "\"walls.bin\"" else "\"PLACEHOLDER_WALLS_B64\"")
                .replace("PLACEHOLDER_CAVES_JSON", "ffSidecarJson(\"caves.json\")")
        }

        private fun html(s: String) = WebResourceResponse("text/html", "utf-8", ByteArrayInputStream(s.toByteArray(Charsets.UTF_8))).apply {
            responseHeaders = mapOf("Cache-Control" to "no-store")
        }

        private fun file(f: File): WebResourceResponse? {
            if (!f.isFile) return notFound()
            val mime = when (f.extension.lowercase()) {
                "glb" -> "model/gltf-binary"; "jpg", "jpeg" -> "image/jpeg"; "png" -> "image/png"; "webp" -> "image/webp"
                "json" -> "application/json"; "pdf" -> "application/pdf"; else -> "application/octet-stream"
            }
            return WebResourceResponse(mime, if (mime == "application/json") "utf-8" else null, FileInputStream(f))
        }

        private fun notFound() = WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), ByteArrayInputStream(ByteArray(0)))
    }

    // ── helpers ─────────────────────────────────────────────────────────────
    private fun share(f: File, mime: String) {
        val uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", f)
        val send = Intent(Intent.ACTION_SEND).apply {
            type = mime
            putExtra(Intent.EXTRA_STREAM, uri)
            putExtra(Intent.EXTRA_SUBJECT, f.name)
            clipData = ClipData.newRawUri(f.name, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        runOnUiThread { startActivity(Intent.createChooser(send, f.name)) }
    }

    /** Run JS on the current page (any thread). */
    private fun js(code: String) { main.post { webView.evaluateJavascript(code, null) } }

    /** A JS string literal. */
    private fun q(s: String) = JSONObject.quote(s)

    private fun toast(s: String) = Toast.makeText(this, s, Toast.LENGTH_LONG).show()

    private fun enterImmersive() {
        WindowInsetsControllerCompat(window, webView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) enterImmersive()
    }

    // Stop the render loop, timers and GPS work while not visible.
    override fun onPause() { super.onPause(); webView.onPause(); webView.pauseTimers() }
    override fun onResume() { super.onResume(); webView.onResume(); webView.resumeTimers() }

    override fun onDestroy() {
        io.shutdown()
        ocr.close()
        webView.destroy()
        super.onDestroy()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
        photoPath?.let { outState.putString("photoPath", it) }
        photoCtx?.let { outState.putString("photoCtx", it) }
    }

    override fun onRestoreInstanceState(savedInstanceState: Bundle) {
        super.onRestoreInstanceState(savedInstanceState)
        webView.restoreState(savedInstanceState)
    }
}
