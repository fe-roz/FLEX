// export_updates.js — the PC's side of "update a phone map with only what changed" (export_update.py does the work).
//
// Every finished export keeps its manifest beside the zip, in export_<id>.json:
//   { name, filename, kind: 'map', map_id, exported, files_hash, bytes, time, sent?, manifest }
// An update package is an export of its own (export_<id>.zip, sent like a map), with
//   { name, filename, kind: 'update', map_id, of: <the full export it stands for>, base: <the export it was made against>,
//     exported, from, summary }
//
//   GET  /api/export/bases?area=<area id>&name=<map name>   { ok, map_id, bases: [{ id, name, exported, time, sent, bytes, zip }] }
//         earlier maps of the same area (or, without one, the same name) that an update can be made against: the
//         last one sent to a phone first, then the newest. A base needs only its manifest, not its zip.
//   POST /api/export/update { export, base }                 { ok, update: <summary> } the package for a finished export
//         summary: { same, mostly, add, replace, remove, bytes, total, share, package_bytes, full_bytes, id?, base_id, from, to }
//
// The map id: "a-<area id>" for an export that names a Process area, else made from the name (export_update.map_id_of).
// Tests: tools/test_export_updates.js.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const ID = /^[A-Za-z0-9]{4,24}$/;
const AREA = /^[A-Za-z0-9_-]{1,40}$/;
const nameId = name => 'n' + crypto.createHash('sha256').update(String(name || '').trim().toLowerCase(), 'utf8').digest('hex').slice(0, 16);
/** The id a map keeps across exports. */
function mapIdOf({ area, name }) { return typeof area === 'string' && AREA.test(area) ? 'a-' + area : nameId(name); }
const slugOf = name => String(name || '').normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').slice(0, 48);

module.exports = function exportUpdates({ exportsDir, python, script }) {
  const sideFile = id => path.join(exportsDir, `export_${id}.json`);
  const zipFile = id => path.join(exportsDir, `export_${id}.zip`);
  const readSide = id => { if (!ID.test(String(id || ''))) return null; try { return JSON.parse(fs.readFileSync(sideFile(id), 'utf8')); } catch (_) { return null; } };
  const writeSide = (id, d) => { const t = sideFile(id) + '.tmp'; fs.writeFileSync(t, JSON.stringify(d)); fs.renameSync(t, sideFile(id)); };
  const json = (res, d, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(d)); };

  /** Where the exporter is told to write the manifest of export `id` (--manifest-out). */
  const manifestOut = id => path.join(exportsDir, `export_${id}.manifest.json`);
  /** After an export finished: its name and manifest beside the zip. */
  function record(id, { name, filename }) {
    let man = null; try { man = JSON.parse(fs.readFileSync(manifestOut(id), 'utf8')); } catch (_) {}
    try { fs.unlinkSync(manifestOut(id)); } catch (_) {}
    const d = { name, filename, kind: 'map', time: Date.now() };
    if (man && man.files && man.files_hash) Object.assign(d, { map_id: man.map_id, exported: man.exported, files_hash: man.files_hash, bytes: man.bytes, manifest: man });
    writeSide(id, d);
    return d;
  }
  /** Earlier maps with this id, the last one sent first, then newest first. */
  function bases(mapId, notId) {
    let names = []; try { names = fs.readdirSync(exportsDir); } catch (_) {}
    const out = [];
    for (const n of names) {
      const id = (/^export_([A-Za-z0-9]{4,24})\.json$/.exec(n) || [])[1]; if (!id || id === notId) continue;
      const s = readSide(id); if (!s || s.kind !== 'map' || s.map_id !== mapId || !s.manifest || !s.files_hash) continue;
      let zip = 0; try { zip = fs.statSync(zipFile(id)).size; } catch (_) {}
      out.push({ id, name: s.name, exported: s.exported || '', time: s.time || 0, sent: s.sent || 0, bytes: s.bytes || 0, zip });
    }
    out.sort((a, b) => (b.sent || 0) - (a.sent || 0) || b.time - a.time);
    const lastSent = out.find(b => b.sent);
    if (lastSent) { out.splice(out.indexOf(lastSent), 1); out.sort((a, b) => b.time - a.time); out.unshift(lastSent); }
    return out;
  }
  /** A map or an update reached a phone: remembered, so the next update is offered against it. An update marks the map it stands for. */
  function markSent(id) {
    const s = readSide(id); if (!s) return;
    const now = Date.now();
    s.sent = now; writeSide(id, s);
    if (s.kind === 'update' && s.of) { const f = readSide(s.of); if (f) { f.sent = now; writeSide(s.of, f); } }
  }
  /** The update package that turns the map of export `baseId` into the map of export `newId`. → summary */
  function makeUpdate(newId, baseId) {
    return new Promise((resolve, reject) => {
      const n = readSide(newId), b = readSide(baseId);
      if (!n || n.kind !== 'map' || !fs.existsSync(zipFile(newId))) return reject(new Error('No such map.'));
      if (!b || b.kind !== 'map' || !b.manifest) return reject(new Error('The earlier map has no manifest: an update cannot be made against it.'));
      if (n.map_id !== b.map_id) return reject(new Error('That is another map.'));
      const uid = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      execFile(python, [script, 'update', '--base', sideFile(baseId), '--new', zipFile(newId), '--out', zipFile(uid)], { maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
        let s = null; try { s = JSON.parse(String(stdout || '').trim().split('\n').pop()); } catch (_) {}
        if (err || !s) return reject(new Error((String(stderr || '').trim().split('\n').pop() || (err && err.message) || 'the update could not be made').replace(/^ERROR:\s*/, '')));
        const sum = { same: !!s.same, mostly: !!s.mostly, add: s.add || [], replace: s.replace || [], remove: s.remove || [], bytes: s.bytes || 0, total: s.total || 0, share: s.share || 0,
          package_bytes: s.package_bytes || 0, full_bytes: s.full_bytes || 0, base_id: baseId, of: newId, from: (s.base && s.base.exported) || '', to: s.to || '' };
        if (!sum.same) {
          const slug = slugOf(n.name);
          writeSide(uid, { name: 'Update for ' + n.name, filename: (slug ? `FLEX-${slug}` : `flex_export_${newId}`) + '-update.zip', kind: 'update', map_id: n.map_id, of: newId, base: baseId,
            exported: sum.to, from: sum.from, time: Date.now(), summary: sum });
          sum.id = uid;
        }
        const nn = readSide(newId); if (nn) { nn.update = sum; writeSide(newId, nn); }
        resolve(sum);
      });
    });
  }
  function handle(req, res, rest, query) {
    if (rest === 'bases' && req.method === 'GET') {
      const q = query || {}, id = mapIdOf({ area: q.area ? String(q.area) : null, name: String(q.name || '') });
      return json(res, { ok: true, map_id: id, bases: String(q.name || '').trim() || q.area ? bases(id) : [] });
    }
    if (rest === 'update' && req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 4096) req.destroy(); });
      req.on('end', () => {
        let b; try { b = JSON.parse(body || '{}'); } catch (_) { return json(res, { ok: false, error: 'Invalid JSON' }, 400); }
        if (!ID.test(String(b.export || '')) || !ID.test(String(b.base || ''))) return json(res, { ok: false, error: 'export and base are needed' }, 400);
        makeUpdate(String(b.export), String(b.base)).then(u => json(res, { ok: true, update: u }), e => json(res, { ok: false, error: String(e.message || e) }, 409));
      });
      return true;
    }
    return false;
  }
  return { mapIdOf, manifestOut, record, bases, markSent, makeUpdate, handle, readSide };
};
module.exports.mapIdOf = mapIdOf;
