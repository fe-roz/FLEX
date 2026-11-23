// The PC-side driver for android/.../MapUpdate.kt (tools/test_map_update_kt.py compiles both and runs this).
//   apply EXPORT_DIR UPDATE.zip [failAfter]   → "OK <from> <to> <added> <replaced> <removed>" | "REFUSED <message>" | "STOPPED"
//   recover EXPORT_DIR                        → "OK"
//   peek FILE.zip                             → "UPDATE <map id> <name>" | "NOT"
import com.feroz.flexviewer.MapUpdate
import java.io.File
import java.io.FileInputStream
import java.util.zip.ZipInputStream

fun main(a: Array<String>) {
    when (a[0]) {
        "recover" -> { MapUpdate.recover(File(a[1])); println("OK") }
        "peek" -> { val u = FileInputStream(a[1]).use { MapUpdate.peek(it) }; println(if (u == null) "NOT" else "UPDATE ${u.mapId} ${u.name}") }
        "apply" -> {
            val export = File(a[1]); val staged = File(export.parentFile, "staged-test").apply { deleteRecursively(); mkdirs() }
            try {
                ZipInputStream(FileInputStream(a[2])).use { z ->          // as MapStore.stage(): only known names, flat
                    while (true) { val e = z.nextEntry ?: break
                        if (!e.isDirectory && (MapUpdate.isData(e.name) || e.name == MapUpdate.UPDATE)) File(staged, e.name).outputStream().use { z.copyTo(it) } }
                }
                val uf = File(staged, MapUpdate.UPDATE)
                if (!uf.isFile) { println("REFUSED This zip is not an update."); return }
                val u = MapUpdate.parseUpdate(uf.readText(Charsets.UTF_8))
                val r = MapUpdate.apply(export, staged, u, if (a.size > 3) a[3].toInt() else -1)
                println("OK ${r.from} ${r.to} ${r.added} ${r.replaced} ${r.removed}")
            } catch (e: MapUpdate.Refused) { println("REFUSED " + e.message)
            } catch (e: InterruptedException) { println("STOPPED")
            } catch (e: Exception) { println("REFUSED " + MapUpdate.CORRUPT.format("the zip cannot be read"))
            } finally { staged.deleteRecursively() }
        }
    }
}
