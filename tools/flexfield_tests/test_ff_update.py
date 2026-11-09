import os, sys; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _work import WORK
import asyncio, json, math, os, sys, subprocess, time
from playwright.async_api import async_playwright

EXPORT = os.path.join(WORK, 'export')
PORT = 8767
srv = subprocess.Popen([sys.executable, '-m', 'http.server', str(PORT), '-d', EXPORT], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(0.8)
fails, passes = [], 0
def ok(label, cond, info=''):
    global passes
    if cond: passes += 1
    else: fails.append(label); print('FAIL', label, info)

# A PLT of the synthetic cave in its own frame: turned 3°, shifted, two new
# stations past A10, and A5 moved 2 m (a disagreement the fit should report).
caves = json.load(open(f'{EXPORT}/caves.json'))
TH, SH, SZ = math.radians(3.0), (-1234.0, 567.0), -88.0
def to_plt(x, y, z):        # inverse of the fit we expect the viewer to find
    x0, y0 = x - SH[0], y - SH[1]
    c, s = math.cos(-TH), math.sin(-TH)
    return c * x0 - s * y0, s * x0 + c * y0, z - SZ
lines = ['Z 0 0 0 0 0 0']
for sv in caves['surveys']:
    lines.append(f'N{sv["name"].split()[0].upper()} D 10 1 2026 C{sv["name"]}')
    lrud = {s['name']: s.get('lrud') for s in sv['stations']}
    first = True
    for sh in sv['shots']:
        for name, xyz, cmd in ((sh['from_name'], sh['from_xyz'], 'M' if first else None), (sh['to_name'], sh['to_xyz'], 'D')):
            if cmd is None: continue
            x, y, z = xyz
            if name == 'A5': x += 2.0
            e, n, v = to_plt(x, y, z)
            lr = lrud.get(name)
            P = ' P %.2f %.2f %.2f %.2f' % ((lr[0] / 0.3048, lr[2] / 0.3048, lr[3] / 0.3048, lr[1] / 0.3048) if lr else (-9, -9, -9, -9))
            lines.append(f'{cmd} {n / 0.3048:.3f} {e / 0.3048:.3f} {v / 0.3048:.3f} S{name}{P} I 0.0')
            first = False
a10 = next(s['xyz'] for sv in caves['surveys'] for s in sv['stations'] if s['name'] == 'A10')
new = [('A11', [a10[0] + 12, a10[1] + 2, a10[2] - 1]), ('A12', [a10[0] + 25, a10[1] + 6, a10[2] - 3])]
for name, xyz in new:
    e, n, v = to_plt(*xyz)
    lines.append(f'D {n / 0.3048:.3f} {e / 0.3048:.3f} {v / 0.3048:.3f} S{name} P 3 4 1 3 I 0.0')
lines.append(';LEAD\tA12\t{"d":"Continues east, walking passage","w":2,"h":2}')
plt = '\r\n'.join(lines) + '\r\n'
open(os.path.join(WORK, 'test_cave.plt'), 'w').write(plt)

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
        ctx = await b.new_context(viewport={'width': 412, 'height': 860})
        page = await ctx.new_page()
        errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        await page.goto(f'http://localhost:{PORT}/viewer.html')
        await page.wait_for_function('typeof stationMap !== "undefined" && stationMap.size > 5 && !!passageMesh', timeout=60000)
        # A fresh browser profile: the project question first
        await page.wait_for_selector('.ff-modal:has-text("Which project")', timeout=10000)
        await page.click('.ff-modal button:has-text("New project")')
        await page.fill('.ff-modal input', 'Cave Ridge area')
        await page.click('.ff-modal button:has-text("Create")')
        await page.wait_for_function('ffReady', timeout=10000)
        await page.evaluate('ffSetAuthor("Tester Three")')
        ni0 = await page.evaluate('passageMesh.userData.meshes[0].geometry.index.count')
        # Through the UI: Tools → Update a cave from a file → pick
        await page.click('#tb-tools')
        await page.click('#ui-sheet .sh-row:has-text("Update a cave")')
        await page.click('.ff-modal button:has-text("Pick a .plt")')
        # (the file input is opened by the page; feed it)
        await page.set_input_files('#ff-plt-input', os.path.join(WORK, 'test_cave.plt'))
        await page.wait_for_selector('.ff-modal:has-text("approximate")', timeout=5000)
        txt = await page.inner_text('.ff-modal')
        ok('dialog warns approximate', 'Approximate' in txt, txt[:200])
        ok('dialog reports the turn', '+3.00°' in txt, txt); ok('dialog names the dropped station', 'Left out of the fit' in txt and 'A5' in txt, txt)
        ok('dialog names the worst station (A5)', 'at A5' in txt, txt)
        ok('dialog counts new stations', '2 new stations' in txt, txt)
        await page.screenshot(path=os.path.join(WORK, 'shots', '10_update_dialog.png'))
        await page.click('.ff-modal button:has-text("Update (approximate)")')
        await page.wait_for_timeout(500)
        fit = await page.evaluate('ffState.caveUpdates["Cave Ridge"].fit')
        ok('fit angle ≈ 3° (outlier left out)', abs(math.degrees(fit['th']) - 3.0) < 0.01, fit)
        a11 = await page.evaluate('stationMap.get("Cave Ridge|A11") && stationMap.get("Cave Ridge|A11").pos.toArray()')
        ok('new station A11 placed', a11 is not None)
        if a11:
            d = math.dist(a11, new[0][1])
            ok('A11 within 0.5 m of where it is', d < 0.5, d)
        ok('lead from the PLT', await page.evaluate('!!(stationMap.get("Cave Ridge|A12").leads||[]).length'))
        ok('old walls hidden (one cave, own colours)', await page.evaluate('passageMesh.userData.meshes[0].geometry.index.count') == 0)
        ok('new walls drawn', await page.evaluate('ffWallGroup.children.length >= 2'))
        await page.evaluate('flyToPoint(stationMap.get("Cave Ridge|A10").pos, 60)')
        await page.wait_for_timeout(1200)
        await page.screenshot(path=os.path.join(WORK, 'shots', '11_updated.png'))
        # Reload: the update comes back from the log
        await page.reload()
        await page.wait_for_function('typeof stationMap !== "undefined" && stationMap.has("Cave Ridge|A11")', timeout=60000)
        await page.wait_for_function('!!passageMesh && ffReady', timeout=20000)
        await page.wait_for_timeout(300)
        ok('after reload: still updated, walls still hidden', await page.evaluate('passageMesh.userData.meshes[0].geometry.index.count') == 0)
        # Undo → back to the export
        await page.evaluate('ffUndo(ffLog[ffLog.length - 1])')
        await page.wait_for_timeout(500)
        ok('undo: A11 gone', await page.evaluate('!stationMap.has("Cave Ridge|A11")'))
        ok('undo: exported walls back', await page.evaluate('passageMesh.userData.meshes[0].geometry.index.count') == ni0)
        ok('undo logged as revert', await page.evaluate('ffLog[ffLog.length-1].op') == 'cave.revert')
        ok('update in the project log with the cave id', await page.evaluate('ffEntries.proj.some(e => e.op === "cave.update" && e.cave === ffLinks.byName["Cave Ridge"])'))
        ok('no page errors', not errs, errs[:3])
        await b.close()

asyncio.run(main())
srv.terminate()
print(f'{passes} passed, {len(fails)} failed')
sys.exit(1 if fails else 0)
