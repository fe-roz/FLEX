"""The viewer in a plain browser (IndexedDB storage): project and cave
linking, notes, leads (export lead adopted, new lead, active/closed, a
conflict), documents (photo + multi-page TIFF, tags, rotation, inbox), field
survey (tie-in, declination, closure, ledge LRUD, flags, undo), sync files
between two "devices" (two browser profiles) both ways, and an edit conflict
merged from a sync file. Synthetic export only (run_all.py makes it)."""
import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _work import WORK
import asyncio, json, math, subprocess, time, zipfile, io
from playwright.async_api import async_playwright

EXPORT = os.path.join(WORK, 'export')
SHOTS = os.path.join(WORK, 'shots'); os.makedirs(SHOTS, exist_ok=True)
PORT = 8765
srv = subprocess.Popen([sys.executable, '-m', 'http.server', str(PORT), '-d', EXPORT],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(0.8)
fails, passes = [], 0
def ok(label, cond, info=''):
    global passes
    if cond: passes += 1
    else: fails.append(f'{label} {info}'); print('FAIL', label, info)

def make_images():
    from PIL import Image, ImageDraw
    png = os.path.join(WORK, 'notepage.png')
    if not os.path.exists(png):
        im = Image.new('RGB', (900, 1200), 'white'); d = ImageDraw.Draw(im)
        for k in range(12): d.line([(40, 100 + 80 * k), (860, 100 + 80 * k)], fill='black', width=2)
        im.save(png)
    tif = os.path.join(WORK, 'scan2.tif')
    pages = []
    for k in range(2):
        im = Image.new('L', (600 + 100 * k, 800), 255); d = ImageDraw.Draw(im)
        d.rectangle([50, 50, 300, 200 + 100 * k], fill=0)
        pages.append(im)
    pages[0].save(tif, save_all=True, append_images=pages[1:], compression='tiff_lzw')
    return png, tif

async def modal_text(page):
    return await page.evaluate('[...document.querySelectorAll(".ff-modal")].map(m => m.innerText).join("\\n")')
async def click_modal(page, text):
    await page.click(f'.ff-modal button:has-text("{text}") >> nth=0')
    await page.wait_for_timeout(250)

async def open_viewer(ctx):
    page = await ctx.new_page()
    errs = []
    page.on('pageerror', lambda e: errs.append(str(e)))
    page.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
    await page.goto(f'http://localhost:{PORT}/viewer.html')
    await page.wait_for_function('typeof stationMap !== "undefined" && stationMap.size > 5', timeout=60000)
    await page.wait_for_timeout(800)
    return page, errs

async def main():
    png, tif = make_images()
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
        ctxA = await b.new_context(viewport={'width': 412, 'height': 860}, device_scale_factor=1, has_touch=True, accept_downloads=True)
        page, errs = await open_viewer(ctxA)
        # 1) Project: asked at load; new project; the export's cave becomes a project cave.
        t = await modal_text(page)
        ok('asks which project', 'Which project is this map part of?' in t, t)
        await click_modal(page, 'New project')
        await page.fill('.ff-modal input', 'Cave Ridge area')
        await click_modal(page, 'Create')
        await page.wait_for_function('ffReady', timeout=10000)
        ok('project created', await page.evaluate('ffP.name') == 'Cave Ridge area')
        caves = await page.evaluate('FL.liveCaves(ffP).map(c => c.name)')
        ok('export cave linked as a new cave (nothing to ask)', caves == ['Cave Ridge'], caves)
        ok('linked by alias', await page.evaluate('ffLinks.byName["Cave Ridge"] && ffP.aliases["Cave Ridge"] === ffLinks.byName["Cave Ridge"]'))
        await page.evaluate('ffSetAuthor("Tester One")')

        # 2) Station card: notes
        await page.evaluate('selectStation(stationMap.get("Cave Ridge|A8"))')
        await page.wait_for_timeout(300)
        txt = await page.inner_text('#info-rows')
        for b_ in ['Note', 'Lead', 'Documents', 'Survey from here']:
            ok('card button ' + b_, b_ in txt, txt[:300])
        await page.click('#info-rows .ff-card button:has-text("Note")')
        await page.fill('.ff-modal textarea', 'Water drips here; cold air from the left.')
        await click_modal(page, 'Save')
        await page.click('#info-rows .ff-card button:has-text("Note")')
        await page.fill('.ff-modal textarea', 'Second note: flagging tape on the wall.')
        await click_modal(page, 'Save')
        txt = await page.inner_text('#info-rows')
        ok('two notes on the card', 'Water drips' in txt and 'flagging tape' in txt, txt[:300])
        ok('note logged with author and cave id', await page.evaluate(
            'ffEntries.proj.filter(e => e.op === "note.set").every(e => e.who === "Tester One" && e.target === FL.T.station(ffLinks.byName["Cave Ridge"], "A8"))'))
        await page.screenshot(path=f'{SHOTS}/01_card_notes.png')

        # 3) Leads: the export lead at B3 shows; adopt it (dead end → closed); a new lead at A8
        lead_st = await page.evaluate('[...stationMap.values()].find(s => s.leads && s.leads.length).name')
        n_active = await page.evaluate('[...stationMap.values()].reduce((a, s) => a + ffLeadsAt(s).filter(x => x.active).length, 0)')
        ok('export lead active', n_active == 1, n_active)
        await page.evaluate(f'selectStation(stationMap.get("Cave Ridge|{lead_st}"))')
        await page.wait_for_timeout(200)
        await page.click('#info-rows .ff-lead')
        await page.click('.ff-modal .ff-lf:has-text("Status") button:has-text("Dead end")')
        await page.click('.ff-modal .ff-lf:has-text("What it needs") button:has-text("Sediment dig")')
        await page.fill('.ff-modal .ff-lf:has-text("Width") input', '0.4')
        await click_modal(page, 'Save')
        L = await page.evaluate('Object.values(ffP.leads)[0]')
        ok('export lead adopted: status, type, size, kept description', L and L['fields']['status'] == 'deadend' and L['fields']['types'] == ['Sediment dig']
           and L['fields']['w'] == 0.4 and L['fields'].get('desc'), L)
        ok('adopted id from the export lead', L and L['id'].startswith('x'))
        ok('dead end: out of the active list', await page.evaluate('[...stationMap.values()].reduce((a, s) => a + ffLeadsAt(s).filter(x => x.active).length, 0)') == 0)
        await page.evaluate('selectStation(stationMap.get("Cave Ridge|A8"))')
        await page.wait_for_timeout(200)
        await page.click('#info-rows .ff-card button:has-text("Lead")')
        await page.click('.ff-modal .ff-lf:has-text("What it needs") button:has-text("Aid climb")')
        await page.click('.ff-modal .ff-lf:has-text("Priority") button:has-text("1")')
        await page.fill('.ff-modal .ff-lf:has-text("Description") textarea', 'Aven with a draft, 8 m up')
        await page.click('.ff-modal .ff-lf:has-text("Air") button:has-text("Blowing out")')
        await click_modal(page, 'Save')
        ok('new lead at A8 shows on the card', 'Aven with a draft' in await page.inner_text('#info-rows'))
        ok('lead sprite added at A8', await page.evaluate('!!stationMap.get("Cave Ridge|A8")._leadSprite && stationMap.get("Cave Ridge|A8")._leadSprite.visible'))
        # Leads list: active / closed
        await page.evaluate('openFind ? openFind("leads") : null') if await page.evaluate('typeof openFind === "function"') else None
        await page.evaluate('leadShow = "active"; leadsRender()')
        act = await page.inner_text('#fp-lead-list')
        await page.evaluate('leadShow = "closed"; leadsRender()')
        clo = await page.inner_text('#fp-lead-list')
        ok('leads list: active has the new lead only', 'Aven' in act and 'Dead end' not in act, act)
        ok('leads list: closed has the dead end', 'Dead end' in clo, clo)
        # A custom type added to the project list
        await page.evaluate('selectStation(stationMap.get("Cave Ridge|A8"))')
        await page.wait_for_timeout(200)
        await page.click('#info-rows .ff-lead >> nth=0')
        await page.click('.ff-modal .ff-lf:has-text("What it needs") button:has-text("＋")')
        await page.fill('.ff-modal >> nth=1 >> input', 'Needs a ladder')
        await page.click('.ff-modal >> nth=1 >> button:has-text("Add")')
        await page.wait_for_timeout(200)
        await click_modal(page, 'Save')
        ok('project list extended', 'Needs a ladder' in await page.evaluate('ffP.lists.types || []'))
        ok('…and on the lead', await page.evaluate('Object.values(ffP.leads).some(l => (l.fields.types || []).includes("Needs a ladder"))'))

        # 4) Documents: a photo and a 2-page TIFF from the station card → one document, tagged to A8
        await page.evaluate('selectStation(stationMap.get("Cave Ridge|A8"))')
        await page.wait_for_timeout(200)
        await page.click('#info-rows .ff-card button:has-text("Documents")')
        await page.wait_for_timeout(200)
        async with page.expect_file_chooser() as fc:
            await page.click('#ff-panel button:has-text("Add pages")')
        await (await fc.value).set_files([png, tif])
        await page.wait_for_function('Object.keys(ffD.docs).length === 1', timeout=10000)
        await page.wait_for_timeout(500)
        d = await page.evaluate('Object.values(ffD.docs)[0]')
        ok('one document, 3 pages (photo + 2 TIFF pages)', len(d['pages']) == 3, [x.get('name') for x in d['pages']])
        ok('TIFF pages decoded to JPEG at their size', d['pages'][1]['ext'] == 'jpg' and d['pages'][1]['w'] == 600 and d['pages'][2]['w'] == 700, d['pages'])
        st_t = await page.evaluate('FL.T.station(ffLinks.byName["Cave Ridge"], "A8")')
        ok('tagged to the project and the station', set(d['tagList']) == {f'project:{await page.evaluate("ffPid")}', st_t}, d['tagList'])
        ok('gallery shows page 1', await page.evaluate('document.getElementById("ff-gallery").classList.contains("open") && document.querySelector("#ff-gallery .ffg-img").src.startsWith("blob:")'))
        await page.click('#ff-gallery .ffg-next')
        await page.wait_for_timeout(300)
        await page.click('#ff-gallery .ffg-rr')
        await page.wait_for_timeout(200)
        ok('page turned 90°', await page.evaluate('Object.values(ffD.docs)[0].pages[1].rot') == 90)
        ok('turn shown', 'rotate(90deg)' in await page.evaluate('document.querySelector("#ff-gallery .ffg-img").style.transform'))
        await page.screenshot(path=f'{SHOTS}/02_gallery_tiff.png')
        # Tags: add the survey of the selected station, remove the station
        await page.click('#ff-gallery .ffg-tag')
        await page.click('.ff-modal button:has-text("survey")')
        await page.click(f'.ff-modal .ff-chip:has-text("A8")')
        await click_modal(page, 'Done')
        d = await page.evaluate('Object.values(ffD.docs)[0]')
        ok('survey tag added, station tag removed', any(t.startswith('survey:') for t in d['tagList']) and st_t not in d['tagList'], d['tagList'])
        fs = await page.evaluate(f'FL.docsForStation(ffD, ffP, ffLinks.byName["Cave Ridge"], "A8", ffStCodes(stationMap.get("Cave Ridge|A8")))')
        ok('station shows it under its survey', len(fs['survey']) == 1 and not fs['station'], fs)
        await page.click('#ff-gallery .ffg-x')
        # A second document into the inbox (no station)
        await page.evaluate('ffOpenDocs(null, "all")')
        await page.evaluate('_selMesh = null')
        async with page.expect_file_chooser() as fc:
            await page.evaluate('ffAddPages(null)')
        await (await fc.value).set_files([png])
        await page.wait_for_function('Object.keys(ffD.docs).length === 2', timeout=10000)
        await page.click('#ff-gallery .ffg-x')
        await page.evaluate('ffOpenDocs(null, "inbox")')
        txt = await page.inner_text('#ff-panel')
        ok('inbox lists the untagged one', 'Inbox (1)' in txt and 'notepage' in txt, txt[:300])
        await page.screenshot(path=f'{SHOTS}/03_docs_inbox.png')
        await page.evaluate('ffClosePanel()')

        # 5) Field survey from A8 (as before: tie-in, grid north, closure, ledge, flags)
        a8 = await page.evaluate('stationMap.get("Cave Ridge|A8").pos.toArray()')
        a10 = await page.evaluate('stationMap.get("Cave Ridge|A10").pos.toArray()')
        await page.evaluate('selectStation(stationMap.get("Cave Ridge|A8"))')
        await page.click('#info-rows .ff-card button:has-text("Survey from here")')
        await page.fill('.ff-modal input', 'Test survey')
        await click_modal(page, 'Start')
        ok('panel open', await page.evaluate('ffPanelOpen && !!ffPanelSurvey'))
        decl = await page.evaluate('ffDeclination(ffState.surveys[ffPanelSurvey], stationMap.get("Cave Ridge|A8").pos).v')
        conv = await page.evaluate('ffConvergence(stationMap.get("Cave Ridge|A8").pos)')
        maz = (0 - decl + conv) % 360
        inputs = '#ff-panel .ff-form input'
        async def shot(fr, to, ln, az, inc, l='', r='', u='', d=''):
            vals = [fr, to, ln, az, inc, '', '', l, r, u, d]
            ins = await page.query_selector_all(inputs)
            for el_, v in zip(ins, vals): await el_.evaluate('(e, v) => { e.value = v; e.dispatchEvent(new Event("input")); }', str(v))
            await page.click('#ff-panel button:has-text("Add shot")')
            await page.wait_for_timeout(400)
        await shot('A8', 'F1', 30, f'{maz:.4f}', 0, '3/5', '2', '4', '1')
        f1 = await page.evaluate('stationMap.get("Cave Ridge|F1") && stationMap.get("Cave Ridge|F1").pos.toArray()')
        ok('F1 placed 30 ft grid-north of A8', f1 and abs(f1[1] - a8[1] - 30 * 0.3048) < 0.01 and abs(f1[0] - a8[0]) < 0.01, f1)
        lr = await page.evaluate('stationMap.get("Cave Ridge|A8").lrud')
        ok('ledge 3/5 → 5 ft', lr and abs(lr[0] - 5 * 0.3048) < 1e-6, lr)
        dx, dy, dz = a10[0] - f1[0], a10[1] - f1[1], a10[2] - f1[2]
        hz = math.hypot(dx, dy); Ld = math.sqrt(dx * dx + dy * dy + dz * dz)
        gaz = math.degrees(math.atan2(dx, dy)) % 360
        await shot('F1', 'A10', f'{Ld/0.3048:.4f}', f'{(gaz - decl + conv) % 360:.4f}', f'{math.degrees(math.atan2(dz, hz)):.4f}')
        clos = await page.evaluate('ffBuiltInfo[ffPanelSurvey].closures')
        ok('closure onto A10', clos and clos[0]['at'] == 'A10' and clos[0]['err'] < 0.01, clos)
        await shot('F1', 'F2', 12, 400, -10, '3-5')
        txt = await page.inner_text('#ff-panel')
        ok('bad azimuth + ambiguous LRUD flagged', 'azimuth outside 0–360' in txt and 'two numbers' in txt)
        ok('survey stored with the cave id', await page.evaluate('Object.values(ffP.surveys)[0].cave === ffLinks.byName["Cave Ridge"]'))
        ok('field walls built', await page.evaluate('ffWallGroup.children.length >= 2'))
        n_before = await page.evaluate('ffState.surveys[ffPanelSurvey].shots.length')
        await page.evaluate('ffOpenLog()')
        await page.click('#ff-panel .ff-logrow button:has-text("Undo") >> nth=0')
        await page.wait_for_timeout(400)
        ok('undo removed the last shot', await page.evaluate('Object.values(ffState.surveys)[0].shots.length') == n_before - 1)
        await page.evaluate('ffClosePanel()')

        # 6) Reload: everything from storage, no question asked again
        await page.reload()
        await page.wait_for_function('typeof stationMap !== "undefined" && stationMap.has("Cave Ridge|F1") && ffReady', timeout=60000)
        ok('after reload: no project question', '.ff-modal' not in await page.content() or not await modal_text(page))
        ok('after reload: notes, leads, documents back', await page.evaluate(
            'FL.notesOn(ffP, FL.T.station(ffLinks.byName["Cave Ridge"], "A8")).length === 2 && Object.keys(ffP.leads).length === 2 && Object.keys(ffD.docs).length === 2'))

        # 7) Sync file from device A
        async with page.expect_download() as dl:
            await page.evaluate('ffMakeSyncFile("since")')
        path = await (await dl.value).path()
        z = zipfile.ZipFile(path)
        names = z.namelist()
        man = json.loads(z.read('manifest.json'))
        ok('sync file: manifest, project log, docs log, 4 page images', man['format'] == 'flex-sync' and any(n.startswith('logs/p-') for n in names)
           and any(n.startswith('logs/docs/') for n in names) and len([n for n in names if n.startswith('blobs/')]) == 4, names)
        syncA1 = os.path.join(WORK, 'syncA1.zip'); open(syncA1, 'wb').write(open(path, 'rb').read())
        # Nothing new since: no file, a toast says so.
        await page.evaluate('ffMakeSyncFile("since")')
        await page.wait_for_timeout(300)
        ok('nothing new → no second file', 'Nothing new' in await page.evaluate('document.getElementById("mode-toast").innerText'))

        # 8) Device B: fresh browser profile; import A's file from the project question
        ctxB = await b.new_context(viewport={'width': 412, 'height': 860}, has_touch=True, accept_downloads=True)
        pageB, errsB = await open_viewer(ctxB)
        async with pageB.expect_file_chooser() as fc:
            await click_modal(pageB, 'Import a sync file')
        await (await fc.value).set_files([syncA1])
        await pageB.wait_for_function('ffPid && Object.keys(ffD.docs).length === 2', timeout=15000)
        await pageB.wait_for_timeout(500)
        t = await modal_text(pageB)
        ok('B: import summary', 'Sync file imported' in t and 'Tester One' in t, t)
        await click_modal(pageB, 'OK')
        ok('B: same project and cave link, nothing asked', await pageB.evaluate('ffP.name') == 'Cave Ridge area' and
           await pageB.evaluate('ffLinks.byName["Cave Ridge"]') == await page.evaluate('ffLinks.byName["Cave Ridge"]'))
        ok('B: field survey drawn', await pageB.evaluate('stationMap.has("Cave Ridge|F1")'))
        ok('B: notes, leads', await pageB.evaluate('FL.notesOn(ffP, FL.T.station(ffLinks.byName["Cave Ridge"], "A8")).length') == 2
           and await pageB.evaluate('Object.keys(ffP.leads).length') == 2)
        ok('B: page images arrived', await pageB.evaluate('(async () => !!(await ffHost.blobUrl(Object.values(ffD.docs)[0].pages[1].h)))()'))
        await pageB.evaluate('ffSetAuthor("Tester Two")')
        # Both devices edit the same note before syncing → conflict after merging
        nid = await page.evaluate('FL.notesOn(ffP, FL.T.station(ffLinks.byName["Cave Ridge"], "A8")).find(n => n.text.startsWith("Water")).id')
        await page.evaluate(f'(() => {{ const n = ffP.notes["{nid}"]; ffRecord("note.set", {{ note: n.id, text: "Water drips; mud floor", prev: n.text, base: n.heads }}); }})()')
        await pageB.evaluate(f'(() => {{ const n = ffP.notes["{nid}"]; ffRecord("note.set", {{ note: n.id, text: "Water drips; strong air out", prev: n.text, base: n.heads }}); }})()')
        # B also closes the aid-climb lead and tags the inbox document
        await pageB.evaluate('(() => { const L = Object.values(ffP.leads).find(l => (l.fields.types || []).includes("Aid climb")); ffRecord("lead.set", { lead: L.id, fields: { status: "surveyed", into: "Q" }, prev: { status: L.fields.status || null }, base: L.heads }); })()')
        await pageB.evaluate('(() => { const d = Object.values(ffD.docs).find(d => FL.docInbox(d, ffP)); ffRecord("doc.tag", { doc: d.id, target: FL.T.cave(ffLinks.byName["Cave Ridge"]) }, null, "docs"); })()')
        async with pageB.expect_download() as dl:
            await pageB.evaluate('ffMakeSyncFile("since")')
        pathB = await (await dl.value).path()
        zb = zipfile.ZipFile(pathB)
        # B's first sync file is everything B has (A's entries too: a sync file isn't
        # addressed to anyone); A skips what it already has.
        ok('B: first sync file carries everything B has', len([n for n in zb.namelist() if n.startswith('blobs/')]) == 4, zb.namelist())
        syncB1 = os.path.join(WORK, 'syncB1.zip'); open(syncB1, 'wb').write(open(pathB, 'rb').read())
        # A imports B's file
        async with page.expect_file_chooser() as fc:
            await page.evaluate('ffHost.syncImport()')
        await (await fc.value).set_files([syncB1])
        await page.wait_for_function('document.querySelector(".ff-modal") && document.querySelector(".ff-modal").innerText.includes("Sync file imported")', timeout=10000)
        await click_modal(page, 'OK')
        n = await page.evaluate(f'ffP.notes["{nid}"]')
        ok('A: note conflict flagged, both versions kept', n.get('conflict') and len(n['conflict']) == 2 and {c['text'] for c in n['conflict']} == {'Water drips; mud floor', 'Water drips; strong air out'}, n)
        ok('A: lead closed by B (surveyed into Q)', await page.evaluate('Object.values(ffP.leads).some(l => l.fields.status === "surveyed" && l.fields.into === "Q")'))
        ok('A: inbox document now tagged to the cave', await page.evaluate('FL.docsOf(ffD, ffP).filter(d => FL.docInbox(d, ffP)).length') == 0)
        imp = await page.evaluate('ffLog.filter(e => e.dev !== ffDev).length')
        ok('A: only B’s 3 changes were new', imp == 3, imp)
        ok('A: change log shows the other device', 'other device' in (await page.evaluate('(ffOpenLog(), document.getElementById("ff-panel").innerText)')))
        await page.evaluate('ffClosePanel()')
        await page.evaluate('selectStation(stationMap.get("Cave Ridge|A8"))')
        await page.wait_for_timeout(200)
        ok('A: card marks the conflict', 'edited on two devices' in await page.inner_text('#info-rows'))
        await page.screenshot(path=f'{SHOTS}/04_conflict.png')
        # Resolve on A: saving builds on both
        await page.click('#info-rows .ff-note.conflict')
        await page.fill('.ff-modal textarea', 'Water drips; mud floor; strong air out')
        await click_modal(page, 'Save')
        ok('A: conflict resolved by saving', await page.evaluate(f'!ffP.notes["{nid}"].conflict && ffP.notes["{nid}"].text.includes("mud floor; strong")'))
        # B's next sync file: only what changed since its last one, no pages.
        await pageB.evaluate('(() => { const st = FL.T.station(ffLinks.byName["Cave Ridge"], "A9"); ffRecord("note.set", { note: FL.uid(), target: st, text: "Bats roosting", prev: "", base: [] }); })()')
        async with pageB.expect_download() as dl:
            await pageB.evaluate('ffMakeSyncFile("since")')
        zb2 = zipfile.ZipFile(await (await dl.value).path())
        lines = sum(len(zb2.read(n).decode().strip().splitlines()) for n in zb2.namelist() if n.endswith('.jsonl'))
        ok('B: next sync file = 1 change, no pages', lines == 1 and not [n for n in zb2.namelist() if n.startswith('blobs/') and n != 'blobs/'], zb2.namelist())
        # Export project data
        async with page.expect_download() as dl:
            await page.evaluate('ffExportData()')
        data = json.load(open(await (await dl.value).path()))
        ok('project data export: notes, leads, documents, surveys, log', data['notes'] and data['leads'] and data['documents'] and data['surveys'] and len(data['log']) > 10, list(data.keys()))
        ok('no page errors (A)', not errs, errs[:5])
        ok('no page errors (B)', not errsB, errsB[:5])
        await b.close()

asyncio.run(main())
srv.terminate()
print(f'{passes} passed, {len(fails)} failed')
sys.exit(1 if fails else 0)
