"""The map list and the viewer in app mode, against app_sim.py (a stand-in for
the Kotlin side): import, the project question, notes / field survey / pages
going to the project library (not the map), TIFF pages decoded by the page,
update and a second map of the same project keeping everything, sync file
written through the share sheet and read into an empty library, delete."""
import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _work import WORK
import asyncio, json, os, shutil, sys, time, zipfile
os.environ.setdefault('FF_STORE', os.path.join(WORK, 'appstore'))
shutil.rmtree(os.environ['FF_STORE'], ignore_errors=True)
import app_sim
from playwright.async_api import async_playwright

PORT = 8766
SHOTS = os.path.join(WORK, 'shots_app'); os.makedirs(SHOTS, exist_ok=True)
srv = app_sim.serve(PORT)
fails, passes = [], 0
def ok(label, cond, info=''):
    global passes
    if cond: passes += 1
    else: fails.append(label); print('FAIL', label, info)
MAPS, LIB = app_sim.MAPS, app_sim.LIB

def images():
    from PIL import Image, ImageDraw
    png = os.path.join(WORK, 'notepage.png')
    if not os.path.exists(png):
        im = Image.new('RGB', (900, 1200), 'white'); d = ImageDraw.Draw(im)
        for k in range(12): d.line([(40, 100 + 80 * k), (860, 100 + 80 * k)], fill='black', width=2)
        im.save(png)
    big = os.path.join(WORK, 'bigphoto.jpg')
    if not os.path.exists(big):
        Image.new('RGB', (4000, 3000), (200, 190, 170)).save(big, quality=80)
    tif = os.path.join(WORK, 'scan2.tif')
    if not os.path.exists(tif):
        pages = []
        for k in range(2):
            im = Image.new('L', (600 + 100 * k, 800), 255); ImageDraw.Draw(im).rectangle([50, 50, 300, 200 + 100 * k], fill=0)
            pages.append(im)
        pages[0].save(tif, save_all=True, append_images=pages[1:], compression='tiff_lzw')
    return png, big, tif

def lib_entries(pid, lib=None):
    out = []
    for f in ((lib or LIB) / ('p-' + pid)).glob('log-*.jsonl'):
        out += [json.loads(l) for l in f.read_text().splitlines() if l.strip()]
    return out

async def modal_text(page):
    return await page.evaluate('[...document.querySelectorAll(".ff-modal")].map(m => m.innerText).join("\\n")')
async def click_modal(page, text):
    await page.click(f'.ff-modal button:has-text("{text}") >> nth=0')
    await page.wait_for_timeout(250)

async def wait_viewer(page):
    await page.wait_for_function('typeof stationMap !== "undefined" && stationMap.size > 5', timeout=60000)
    await page.wait_for_timeout(1200)

async def main():
    png, big, tif = images()
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
        ctx = await b.new_context(viewport={'width': 412, 'height': 860}, has_touch=True)
        await ctx.add_init_script(app_sim.MOCK)
        page = await ctx.new_page()
        errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        page.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
        base = f'http://127.0.0.1:{PORT}'
        await page.goto(base + '/assets/flexfield/index.html')
        await page.wait_for_timeout(300)
        ok('home: empty state', 'No maps yet' in await page.inner_text('#maps'))
        await page.screenshot(path=f'{SHOTS}/01_home_empty.png')
        # Import: asks for a name first
        await page.click('#import')
        await page.fill('.modal input', 'Tester Two')
        await page.click('.modal button:has-text("Use this name")')
        await page.wait_for_selector('.map', timeout=10000)
        ok('home: map listed after import', await page.locator('.map').count() == 1)
        ok('home: map name from meta', 'Cave Ridge' in await page.inner_text('#maps'))
        mid = [d.name for d in MAPS.iterdir()][0]
        log = [json.loads(l) for l in (MAPS / mid / 'user' / 'log.jsonl').read_text().splitlines()]
        ok('import logged with author', log[0]['op'] == 'map.import' and log[0]['who'] == 'Tester Two', log)

        # Open → the project question → new project
        await page.click('.map')
        await wait_viewer(page)
        ok('viewer: app mode', await page.evaluate('FF_APP === true && MAP_KEY === "map:" + FF_MAP_ID'))
        ok('viewer: walls from walls.bin', await page.evaluate('!!passageMesh'))
        ok('viewer: author shared with the list', await page.evaluate('ffWho()') == 'Tester Two')
        t = await modal_text(page)
        ok('asks which project', 'Which project is this map part of?' in t, t)
        await click_modal(page, 'New project')
        await page.fill('.ff-modal input', 'Cave Ridge area')
        await click_modal(page, 'Create')
        await page.wait_for_function('ffReady', timeout=10000)
        pid = await page.evaluate('ffPid')
        ok('map.json has the project', app_sim.info(mid).get('project') == pid)
        ok('projects.json has its name', app_sim.project_name(pid) == 'Cave Ridge area')
        dev = json.loads((LIB / 'device.json').read_text())['id']
        ok('device id shared with the page', await page.evaluate('ffDev') == dev)
        await page.screenshot(path=f'{SHOTS}/03_viewer.png')

        # Note + field survey shot → the project library, in this device's log
        await page.evaluate('selectStation(stationMap.get("Cave Ridge|A4"))')
        await page.click('#info-rows .ff-card button:has-text("Note")')
        await page.fill('.ff-modal textarea', 'Junction with the north branch')
        await click_modal(page, 'Save')
        await page.evaluate('selectStation(stationMap.get("Cave Ridge|B3"))')
        await page.click('#info-rows .ff-card button:has-text("Survey from here")')
        await click_modal(page, 'Start')
        ins = await page.query_selector_all('#ff-panel .ff-form input')
        for e, v in zip(ins, ['B3', 'C1', '25.5', '10', '-3', '', '', '2', '2', '3', '1']):
            await e.evaluate('(e, v) => { e.value = v; e.dispatchEvent(new Event("input")); }', v)
        await page.click('#ff-panel button:has-text("Add shot")')
        await page.wait_for_timeout(400)
        ok('field station placed in app mode', await page.evaluate('stationMap.has("Cave Ridge|C1")'))
        ops = [e['op'] for e in sorted(lib_entries(pid), key=lambda e: e['seq'])]
        ok('library log: project, cave, note, survey, shot', ops == ['project.set', 'cave.set', 'cave.alias', 'note.set', 'survey.add', 'shot.add'], ops)
        ok('only this device\'s log file', [f.name for f in (LIB / ('p-' + pid)).glob('*.jsonl')] == [f'log-{dev}.jsonl'])
        ok('ids are dev.seq', all(e['id'] == f"{dev}.{e['seq']}" for e in lib_entries(pid)))
        ops = [json.loads(l)['op'] for l in (MAPS / mid / 'user' / 'log.jsonl').read_text().splitlines()]
        ok('map log keeps map events only', ops == ['map.import'], ops)
        await page.evaluate('ffClosePanel()')

        # Pages through the app picker: a big photo (scaled), a 2-page TIFF (decoded by the page)
        await page.evaluate('selectStation(stationMap.get("Cave Ridge|B3"))')
        await page.wait_for_timeout(200)
        await page.click('#info-rows .ff-card button:has-text("Documents")')
        await page.wait_for_timeout(200)
        app_sim.pick_pages.append([big, tif])
        await page.click('#ff-panel button:has-text("Add pages")')
        await page.wait_for_function('Object.keys(ffD.docs).length === 1', timeout=10000)
        await page.wait_for_timeout(500)
        d = await page.evaluate('Object.values(ffD.docs)[0]')
        ok('one document, 3 pages', len(d['pages']) == 3, d['pages'])
        ok('photo scaled to 2400 px', d['pages'][0]['w'] == 2400 and d['pages'][0]['ht'] == 1800, d['pages'][0])
        ok('TIFF pages decoded at their size', [x['w'] for x in d['pages'][1:]] == [600, 700], d['pages'])
        ok('pages stored by hash', all((LIB / 'blobs' / f"{x['h']}.{x['ext']}").is_file() for x in d['pages']))
        ok('TIFF parking cleared', not list((LIB / 'tmp').glob('*')))
        ok('document in the docs scope', any(json.loads(l)['op'] == 'doc.add' for f in (LIB / 'docs').glob('*.jsonl') for l in f.read_text().splitlines()))
        src = await page.evaluate('document.querySelector("#ff-gallery .ffg-img").src')
        ok('page served from /lib/blob/', '/lib/blob/' in src, src)
        try:
            await page.wait_for_function('document.querySelector("#ff-gallery .ffg-img").naturalWidth > 0', timeout=5000)
            ok('page image loads', True)
        except Exception as e:
            ok('page image loads', False, e)
        await page.screenshot(path=f'{SHOTS}/04_gallery.png')
        await page.click('#ff-gallery .ffg-x')
        await page.evaluate('ffClosePanel()')

        # Back to Maps: project name on the row
        await page.click('#tb-more')
        await page.click('#ui-sheet .sh-row:has-text("Maps")')
        await page.wait_for_selector('.map', timeout=10000)
        txt = await page.inner_text('#maps')
        ok('list shows the project', 'Cave Ridge area' in txt, txt)
        await page.screenshot(path=f'{SHOTS}/02_home_one.png')

        # Update with the same export: everything comes back from the project
        await page.click('#import')
        await page.wait_for_selector('.modal:has-text("already on this phone")', timeout=10000)
        await page.screenshot(path=f'{SHOTS}/05_ask.png')
        await page.click('.modal button:has-text("Update")')
        await page.wait_for_timeout(600)
        ok('update keeps one map', await page.locator('.map').count() == 1)
        await page.click('.map')
        await wait_viewer(page)
        await page.wait_for_function('ffReady', timeout=10000)
        ok('no project question after update', 'Which project' not in await modal_text(page))
        ok('field survey survives the update', await page.evaluate('stationMap.has("Cave Ridge|C1")'))
        ok('note survives the update', await page.evaluate('FL.notesOn(ffP, FL.T.station(ffLinks.byName["Cave Ridge"], "A4")).length') == 1)
        await page.go_back()
        await page.wait_for_selector('.map', timeout=10000)

        # A separate map of the same area: pick the existing project → same data
        await page.click('#import')
        await page.wait_for_selector('.modal:has-text("already on this phone")', timeout=10000)
        await page.click('.modal button:has-text("separate")')
        await page.wait_for_timeout(600)
        ok('separate import → two maps', await page.locator('.map').count() == 2)
        mid2 = next(d.name for d in MAPS.iterdir() if d.name != mid)
        await page.evaluate(f'AndroidHost.openMap("{mid2}")')
        await wait_viewer(page)
        t = await modal_text(page)
        ok('second map asks, listing the project', 'Cave Ridge area' in t, t)
        await click_modal(page, 'Cave Ridge area')
        await page.wait_for_function('ffReady', timeout=10000)
        ok('second map: same project', app_sim.info(mid2).get('project') == pid)
        ok('second map: the note is there', await page.evaluate('FL.notesOn(ffP, FL.T.station(ffLinks.byName["Cave Ridge"], "A4")).length') == 1)
        ok('second map: the document is there', await page.evaluate('Object.keys(ffD.docs).length') == 1)

        # Sync file through the share sheet
        await page.evaluate('ffMakeSyncFile("since")')
        await page.wait_for_timeout(400)
        ok('sync file shared', len(app_sim.shared) == 1, app_sim.shared)
        zf = app_sim.shared[-1]
        with zipfile.ZipFile(zf) as z:
            names = z.namelist()
            man = json.loads(z.read('manifest.json'))
            blobs = [i for i in z.infolist() if i.filename.startswith('blobs/')]
        ok('sync file name', zf.name.startswith('FLEX-sync-cave-ridge-area-'), zf.name)
        ok('sync file: manifest, both scopes, 3 pages', man['format'] == 'flex-sync' and man['project']['id'] == pid
           and f'logs/p-{pid}/log-{dev}.jsonl' in names and f'logs/docs/log-{dev}.jsonl' in names and len(blobs) == 3, names)
        ok('pages stored, not deflated', all(i.compress_type == zipfile.ZIP_STORED for i in blobs))
        await page.evaluate('ffMakeSyncFile("since")')
        await page.wait_for_timeout(300)
        ok('nothing new → no second file', len(app_sim.shared) == 1)
        keep = os.path.join(WORK, 'sync-from-app.zip'); shutil.copyfile(zf, keep)

        # Another phone: an empty library, the same map. Import the sync file.
        await page.go_back()
        await page.wait_for_selector('.map', timeout=10000)
        libA = Path_(str(LIB) + '-phoneA')
        shutil.rmtree(libA, ignore_errors=True); shutil.move(str(LIB), str(libA))
        for m in (mid, mid2):
            inf = app_sim.info(m); inf.pop('project', None); (MAPS / m / 'map.json').write_text(json.dumps(inf))
        await page.evaluate(f'AndroidHost.openMap("{mid}")')
        await wait_viewer(page)
        t = await modal_text(page)
        ok('fresh phone: asks, offers import', 'Import a sync file' in t, t)
        app_sim.pick_sync.append(keep)
        await click_modal(page, 'Import a sync file')
        try:
            await page.wait_for_function('[...document.querySelectorAll(".ff-modal")].some(m => m.innerText.includes("Sync file imported"))', timeout=10000)
        except Exception: pass
        t = await modal_text(page)
        ok('import reports changes and pages', '3 new page(s)' in t and 'Tester Two' in t and 'Cave Ridge area' in t, t)
        await click_modal(page, 'OK')
        ok('map takes the file\'s project', await page.evaluate('ffPid') == pid and app_sim.info(mid).get('project') == pid)
        ok('fresh phone: note, survey, document', await page.evaluate(
            'FL.notesOn(ffP, FL.T.station(ffLinks.byName["Cave Ridge"], "A4")).length === 1 && stationMap.has("Cave Ridge|C1") && Object.keys(ffD.docs).length === 1'))
        dev2 = json.loads((LIB / 'device.json').read_text())['id']
        ok('a new device id', dev2 != dev)
        ok('entries kept in the sender\'s log file', (LIB / ('p-' + pid) / f'log-{dev}.jsonl').is_file()
           and len(lib_entries(pid)) == len(lib_entries(pid, libA)))
        r = app_sim.import_sync(keep)
        ok('same file again: nothing new', r['ok'] and r['entries'] == 0 and r['pages'] == 0, r)
        await page.go_back()
        await page.wait_for_selector('.map', timeout=10000)

        # Delete: the project stays
        await page.click('.map >> nth=0 >> .more')
        await page.click('.modal button:has-text("Delete")')
        await page.wait_for_selector('.modal:has-text("can’t be undone")')
        t = await page.inner_text('.modal:has-text("can’t be undone")')
        ok('delete says the project stays', 'stay on this phone' in t, t)
        await page.screenshot(path=f'{SHOTS}/06_delete.png')
        await page.click('.modal button:has-text("🗑 Delete")')
        await page.wait_for_timeout(300)
        ok('deleted → one map', await page.locator('.map').count() == 1)
        ok('project library untouched', len(lib_entries(pid)) >= 5)
        ok('no page errors', not errs, errs[:5])
        await b.close()

from pathlib import Path as Path_
asyncio.run(main())
srv.shutdown()
print(f'{passes} passed, {len(fails)} failed')
sys.exit(1 if fails else 0)
