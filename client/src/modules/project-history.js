// FLEX project (History and undo, suggestions to review, sync files).
// Part of project.js, split into classic scripts that load in order (index.html);
// they share their functions through window._pjParts until project.js has loaded.
// Behaviour unchanged. See client/src/README.md.
(function () {
  'use strict';
  const X = window._pjParts;
  if (!X) return;                          // project-ui-kit.js found no flexlib.js
  const { $, pj, targetLabel, caveName, FL, el, when, btn, record, dialog, toast, docByPage, docOpen, api, who, API, post, pickFiles, setProject, loadAll, choose } = X;
  // defined in a later part: called only after every part has loaded
  const render = (...a) => X.render(...a);
  const refreshCard = (...a) => X.refreshCard(...a);
  const drawField = (...a) => X.drawField(...a);
  const drawLeads = (...a) => X.drawLeads(...a);

  // ── History and undo ───────────────────────────────────────────────────────
  function describe(e) {
    const pre = e.proposed ? `Suggested by ${e.proposed.by || e.who || '?'}${e.proposed.confidence != null ? ' (' + Math.round(e.proposed.confidence * 100) + '%)' : ''}: ` : '';
    const doc = id => '“' + ((pj.D.docs[id] && pj.D.docs[id].title) || 'document') + '”';
    const at = (rec, id) => { const r = rec[id]; return r && r.target ? targetLabel(r.target) : e.target ? targetLabel(e.target) : '?'; };
    const n = [].concat(e.ref != null ? [e.ref] : [], e.refs || []).length;
    const sv = id => (pj.P.surveys[id] && pj.P.surveys[id].name) || 'survey';
    const m = {
      'project.set': () => `Project “${e.name || ''}”`,
      'project.archive': () => e.archived === false ? 'Project unarchived' : 'Project archived (read-only)' + (e.note ? ': ' + e.note : ''),
      'project.footprint': () => Array.isArray(e.ring) && e.ring.length >= 3 ? `Footprint drawn by hand (${e.ring.length} corners)` : 'Hand-drawn footprint cleared (the computed one is used)',
      'cave.moved': () => e.dir === 'in' ? `Cave “${e.name || caveName(e.cave)}” moved in from ${(e.peer && e.peer.name) || 'another project'}` : `Cave “${e.name || caveName(e.cave)}” moved to ${(e.peer && e.peer.name) || 'another project'}`,
      'project.lists': () => 'Added to lists: ' + Object.values(e.add || {}).flat().join(', '),
      'cave.set': () => e.removed ? `Removed cave ${caveName(e.cave)}` : `Cave “${e.name || caveName(e.cave)}”${e.sources ? ' (made of ' + e.sources.map(s => s.file + (s.surveys && s.surveys.length ? ' ' + s.surveys.join(',') : '')).join('; ') + ')' : ''}`,
      'system.set': () => { const g = pj.P.systems[e.system] || {}, nm = e.name || g.name || 'system', cn = ids => (ids || []).map(caveName).join(', ');
        return e.removed ? `Deleted system “${nm}”` : e.removed === false ? `System “${nm}” back` : e.created ? `System “${nm}”${e.add && e.add.length ? ' of ' + cn(e.add) : ''}`
          : [e.name != null ? `Renamed system to “${e.name}”` : '', e.add && e.add.length ? `Put ${cn(e.add)} in system “${nm}”` : '', e.remove && e.remove.length ? `Took ${cn(e.remove)} out of system “${nm}”` : ''].filter(Boolean).join('; ') || `System “${nm}”`; },
      'cave.alias': () => `“${e.alias}” is ${caveName(e.cave)}`,
      'cave.unalias': () => `“${e.alias}” is no longer ${caveName(e.cave)}`,
      'note.set': () => (e.text ? (e.prev ? 'Edited note at ' : 'Note at ') : 'Removed note at ') + at(pj.P.notes, e.note) + (e.text ? ': ' + e.text.slice(0, 60) : ''),
      'lead.set': () => (e.prev ? 'Lead at ' : 'New lead at ') + at(pj.P.leads, e.lead) + (e.proposed && e.fields && e.fields.desc ? ': ' + String(e.fields.desc).slice(0, 80)
        : e.fields ? ': ' + Object.keys(e.fields).map(k => k === 'status' ? FL.statusLabel(e.fields.status) : k).join(', ') : '') + (e.sighting ? ' (sighting)' : ''),
      'lead.del': () => 'Removed lead at ' + at(pj.P.leads, e.lead),
      'lead.restore': () => 'Restored lead at ' + at(pj.P.leads, e.lead),
      'doc.add': () => `Document ${doc(e.doc)}, ${(e.pages || []).length} page(s)`,
      'doc.pages': () => `Added ${(e.add || []).length} page(s) to ${doc(e.doc)}`,
      'doc.droppage': () => `Removed a page from ${doc(e.doc)}`,
      'doc.rotate': () => `Turned a page of ${doc(e.doc)}`,
      'doc.tag': () => `Tagged ${doc(e.doc)}: ${targetLabel(e.target)}`,
      'doc.untag': () => `Untagged ${doc(e.doc)}: ${targetLabel(e.target)}`,
      'doc.set': () => `Edited ${doc(e.doc)} (${Object.keys(e.fields || {}).join(', ')})`,
      'doc.page': () => `Page details in ${doc(e.doc)}`,
      'doc.del': () => `Deleted ${doc(e.doc)}`,
      'doc.restore': () => `Restored ${doc(e.doc)}`,
      'survey.add': () => `New field survey “${e.survey && e.survey.name}”`,
      'survey.set': () => `Changed field survey “${sv(e.id)}”`,
      'survey.delete': () => `Deleted field survey “${(e.prev && e.prev.name) || ''}”`,
      'survey.restore': () => `Restored field survey “${e.survey && e.survey.name}”`,
      'shot.add': () => `Shot ${e.shot && e.shot.from} → ${e.shot && e.shot.to} in “${sv(e.sid)}”`,
      'shot.set': () => `Edited shot in “${sv(e.sid)}”`,
      'shot.delete': () => `Deleted shot in “${sv(e.sid)}”`,
      'cave.update': () => `Updated ${caveName(e.cave)} from ${e.file || 'a file'} on a phone (approximate)`,
      'cave.revert': () => `Put ${caveName(e.cave)} back as exported`,
      'cavefile.set': () => (e.multi != null || e.surfaceAdd || e.surfaceDel) && !e.h ? [e.multi === true ? `${e.file} is a multi-cave file` : e.multi === false ? `${e.file} is no longer a multi-cave file` : '', e.surfaceAdd && e.surfaceAdd.length ? `Surface traverse: ${e.surfaceAdd.join(', ')} of ${e.file}` : '', e.surfaceDel && e.surfaceDel.length ? `Not a surface traverse any more: ${e.surfaceDel.join(', ')} of ${e.file}` : ''].filter(Boolean).join('; ') : e.removed ? `Removed survey file ${e.file} from the project` : e.h ? `Survey file ${e.file}${e.place ? ' and where it is placed' : ''}` : `Placed ${e.file}${e.place && e.place.station ? ' at station ' + e.place.station : ''}`,
      'layer.set': () => e.removed ? `Removed ${(pj.P.layers[e.layer] || {}).name || 'a layer'} from the project` : `${{ pointcloud: 'Point cloud', caltopo: 'CalTopo map', file: 'Data file', imagery: 'Map layer', tiles: 'Tile link' }[e.kind || (pj.P.layers[e.layer] || {}).kind] || 'Layer'} ${e.name || (pj.P.layers[e.layer] || {}).name || ''}`,
      'survey.version': () => e.raw && e.raw.tie ? `Survey ${e.code || ''} missing from the file: ${(e.raw.shots || []).length} shot(s) from ${e.raw.tie}${e.note ? ' — ' + e.note : ''}`
        : `New version of survey ${e.code} (${e.version || 'transcribed'})`,
      'segment.set': () => `Segment “${e.name || (pj.P.segments[e.seg] || {}).name || e.seg}” (${(e.shots || []).length} shots)`,
      'segment.del': () => `Removed ${[].concat(e.seg != null ? [e.seg] : [], e.segs || []).length} segment(s)`,
      'feature.set': () => { const f = pj.P.features[e.feature] || {}, k = e.kind || f.kind, nm = e.name || f.name || ''; return e.removed ? `Removed ${k || 'feature'} “${nm}”` : `${{ point: 'Point', line: 'Line', area: 'Area' }[k] || 'Feature'} “${nm}”`; },
      'arealabel.set': () => { const a = pj.P.arealabels[e.label] || {}, nm = e.text || a.text || '', f = e.file || a.file || ''; return (e.removed ? `Removed area label “${nm}”` : e.removed === false ? `Area label “${nm}” back` : e.prev === null ? `Area label “${nm}”` : e.text != null ? `Renamed area label to “${nm}”` : `Moved area label “${nm}”`) + (f ? ' in ' + f : ''); },
      'trip.set': () => { const t = pj.P.trips[e.trip] || {}, nm = e.name || t.name || 'trip'; return e.removed ? `Deleted trip “${nm}”` : e.removed === false ? `Trip “${nm}” back` : e.prev === null ? `Trip “${nm}”` : `Edited trip “${nm}”: ` + [['name', 'name'], ['start', 'dates'], ['end', 'dates'], ['desc', 'notes']].filter(([k]) => e[k] != null).map(x => x[1]).concat(['people', 'caves', 'links'].filter(k => (e.add && e.add[k]) || (e.drop && e.drop[k])).map(k => k === 'links' ? 'surveys, notes, photos' : k)).filter((v, i, a) => a.indexOf(v) === i).join(', '); },
      'group.set': () => e.removed ? `Removed folder “${(pj.P.groups[e.group] || {}).name || ''}”` : `Folder “${e.name || (pj.P.groups[e.group] || {}).name || ''}”`,
      accept: () => `Accepted ${n} suggestion(s)${e.note ? ': ' + e.note : ''}`,
      reject: () => `Turned down ${n} suggestion(s)${e.why ? ': ' + e.why : ''}`,
    };
    return pre + (m[e.op] ? m[e.op]() : e.op);
  }
  function inverse(e) {
    if (e.proposed) return null;
    switch (e.op) {
      case 'note.set': return { op: 'note.set', note: e.note, text: e.prev || '', prev: e.text || '', base: [e.id] };
      case 'lead.set': return e.prev ? { op: 'lead.set', lead: e.lead, fields: e.prev, prev: e.fields, base: [e.id] } : null;
      case 'lead.del': return { op: 'lead.restore', lead: e.lead, base: [e.id] };
      case 'lead.restore': return { op: 'lead.del', lead: e.lead, base: [e.id] };
      case 'doc.add': return { op: 'doc.del', doc: e.doc, _w: 'docs' };
      case 'doc.del': return { op: 'doc.restore', doc: e.doc, _w: 'docs' };
      case 'doc.restore': return { op: 'doc.del', doc: e.doc, _w: 'docs' };
      case 'doc.tag': return { op: 'doc.untag', doc: e.doc, target: e.target, _w: 'docs' };
      case 'doc.untag': return { op: 'doc.tag', doc: e.doc, target: e.target, _w: 'docs' };
      case 'doc.rotate': return e.prev != null ? { op: 'doc.rotate', doc: e.doc, h: e.h, rot: e.prev, prev: e.rot, _w: 'docs' } : null;
      case 'doc.set': return e.prev ? { op: 'doc.set', doc: e.doc, fields: e.prev, prev: e.fields, _w: 'docs' } : null;
      case 'doc.droppage': return e.page ? { op: 'doc.pages', doc: e.doc, add: [e.page], at: e.at, _w: 'docs' } : null;
      case 'cave.alias': return { op: 'cave.unalias', cave: e.cave, alias: e.alias };
      case 'system.set': return FL.systemUndo(e);
      case 'cave.set': return FL.multiUndo(e);
      case 'cavefile.set': if (e.multi != null || e.surfaceAdd || e.surfaceDel) return FL.multiUndo(e); return e.removed ? { op: 'cavefile.set', file: e.file, removed: false } : null;
      case 'layer.set': return e.removed ? { op: 'layer.set', layer: e.layer, removed: false } : null;
      case 'arealabel.set': return FL.areaLabelUndo(e);
      case 'trip.set': return FL.tripUndo(e);
      default: return null;
    }
  }
  function history(ids, title, where) {
    const byId = id => pj.P.byId.get(id) || pj.D.byId.get(id);
    const list = (ids ? ids.map(byId).filter(Boolean) : FL.sortEntries(pj.proj.concat(pj.docs.filter(e => {
      const d = pj.D.docs[e.doc]; return d && FL.docInProject(d, pj.P);
    })))).slice().reverse();
    const body = el('div', 'pj-list');
    if (!list.length) body.appendChild(el('div', 'pj-note', 'Nothing yet.'));
    list.slice(0, 400).forEach(e => {
      const r = el('div', 'pj-item');
      r.appendChild(el('div', 'pj-item-t', describe(e)));
      r.appendChild(el('div', 'pj-sub', `${e.who || '?'} · ${when(e.t)}${e.dev === pj.dev ? '' : ' · from ' + e.dev}${e.undoOf ? ' · undo' : ''}`));
      const inv = e.dev === pj.dev && inverse(e);
      if (inv) r.appendChild(btn('Undo', async () => {
        const { op, _w, ...data } = inv;
        await record(op, Object.assign(data, { undoOf: e.id }), _w || (where === 'docs' || /^doc\./.test(e.op) ? 'docs' : null));
        r.remove();
      }, 'small'));
      body.appendChild(r);
    });
    dialog({ title: title || 'History · ' + (pj.P.name || ''), body, wide: true, buttons: [{ label: 'Close', value: null }] });
  }

  // ── Suggestions to review (proposals from the archive or any helper) ───────
  /** Accept every open suggestion at or above confidence t (0..1); how many. */
  async function acceptAbove(t) {
    const q = FL.reviewQueue(pj.P, pj.D).filter(p => (p.confidence || 0) >= t);
    if (!q.length) { toast('None at that level'); return 0; }
    const proj = q.filter(p => pj.P.proposals[p.id]), docs = q.filter(p => pj.D.proposals[p.id]);
    if (proj.length) await record('accept', { refs: proj.map(p => p.id), base: proj.map(p => p.id).concat(...proj.map(headsFor)) });
    if (docs.length) await record('accept', { refs: docs.map(p => p.id), base: docs.map(p => p.id) }, 'docs');
    toast(`Accepted ${q.length} suggestion${q.length > 1 ? 's' : ''}`);
    return q.length;
  }
  async function review() {
    const body = el('div', 'pj-list');
    const thr = el('input', 'pj-input pj-num'); thr.type = 'number'; thr.min = 0; thr.max = 100; thr.value = 80;
    const top = el('div', 'pj-row');
    top.append('Accept all at or above ', thr, '% ', btn('Accept', async () => {
      if (await acceptAbove(Number(thr.value) / 100)) paint();
    }, 'primary'));
    const paint = () => {
      body.textContent = '';
      const q = FL.reviewQueue(pj.P, pj.D);
      if (!q.length) body.appendChild(el('div', 'pj-note', 'Nothing to review.'));
      q.slice(0, 300).forEach(p => {
        const r = el('div', 'pj-item');
        r.appendChild(el('div', 'pj-item-t', describe(p.entry)));
        const ev = (p.evidence || []).map(x => x.text).filter(Boolean).join(' · ');
        if (ev) r.appendChild(el('div', 'pj-sub', 'Evidence: ' + ev));
        const pages = (p.evidence || []).map(x => x.page && x.page.h).filter(Boolean);
        const row = el('div', 'pj-row');
        pages.slice(0, 3).forEach(h => { const d = docByPage(h); if (d) row.appendChild(btn(['doc', d.title || 'page'], () => docOpen(d.id, d.pages.findIndex(x => x.h === h)), 'small')); });
        const docs = !!pj.D.proposals[p.id];
        row.appendChild(btn('Accept', async () => { await record('accept', { ref: p.id, base: [p.id].concat(headsFor(p)) }, docs ? 'docs' : null); paint(); }, 'small primary'));
        row.appendChild(btn('Turn down', async () => { await record('reject', { ref: p.id }, docs ? 'docs' : null); paint(); }, 'small'));
        r.appendChild(row);
        body.appendChild(r);
      });
    };
    paint();
    const wrap = el('div'); wrap.append(top, body);
    await dialog({ title: 'Suggestions to review', text: 'Suggestions change nothing until accepted. Accepting is logged under your name.', body: wrap, wide: true, buttons: [{ label: 'Close', value: null }] });
    render();
  }
  // The record heads a proposal builds on when accepted now (so it isn't a conflict).
  function headsFor(p) {
    const e = p.entry;
    if (e.op === 'lead.set' && pj.P.leads[e.lead]) return pj.P.leads[e.lead].heads || [];
    if (e.op === 'note.set' && pj.P.notes[e.note]) return pj.P.notes[e.note].heads || [];
    return [];
  }

  // ── Sync files ─────────────────────────────────────────────────────────────
  // jszip.min.js is in viewer_build/libs once an export has fetched it; else the CDN.
  function zipLib() {
    if (window.JSZip) return Promise.resolve(true);
    return new Promise(res => {
      const sc = document.createElement('script');
      sc.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
      sc.onload = () => res(true);
      sc.onerror = () => { toast('The zip library could not load'); res(false); };
      document.head.appendChild(sc);
    });
  }
  async function makeSync(mode) {
    if (!pj.pid) return;
    if (!(await zipLib())) return;
    const sentRaw = (await api('kv?k=' + encodeURIComponent('sync-sent|' + pj.pid))).v;
    const sel = FL.selectForSync(pj.proj, pj.docs, pj.P, pj.D, sentRaw ? JSON.parse(sentRaw) : null, mode);
    if (!sel.count) { toast('Nothing new since the last sync file'); return; }
    const man = FL.syncManifest(pj.P, pj.dev, who(), sel);
    const z = new JSZip();
    z.file('manifest.json', JSON.stringify(man, null, 1));
    Object.entries(sel.entries).forEach(([sc, list]) => {
      const byDev = {};
      list.forEach(e => (byDev[e.dev] || (byDev[e.dev] = [])).push(JSON.stringify(e)));
      Object.entries(byDev).forEach(([dev, ls]) => z.file(`logs/${sc}/log-${dev}.jsonl`, ls.join('\n') + '\n'));
    });
    let missing = 0;
    for (const n of sel.blobs) {
      const r = await fetch(API + 'blob/' + n);
      if (!r.ok) { missing++; continue; }
      z.file('blobs/' + n, await r.arrayBuffer(), { compression: 'STORE' });
    }
    const blob = await z.generateAsync({ type: 'blob', compression: 'DEFLATE' });
    const slug = (pj.P.name || 'project').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';
    const d = new Date(), p2 = n => String(n).padStart(2, '0');
    const name = `FLEX-sync-${slug}-${(who() || pj.dev).replace(/[^A-Za-z0-9]+/g, '')}-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}.zip`;
    const a = el('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    await post('kv', { k: 'sync-sent|' + pj.pid, v: JSON.stringify(sel.sent) });
    await post('kv', { k: 'sync-last|' + pj.pid, v: new Date().toISOString() });
    toast(`Sync file: ${sel.count} change(s), ${sel.blobs.length - missing} page(s)` + (missing ? ` (${missing} page(s) missing here)` : ''));
    render();
  }
  async function importSync(file) {
    file = file || (await pickFiles('.zip,application/zip', false))[0];
    if (!file) return;
    if (!(await zipLib())) return;
    // The Jobs panel (jobs-panel.js): this import as a job; Retry reads the same file again
    const job = window._jobs ? window._jobs.add({ id: 'sync.' + Date.now().toString(36), kind: 'sync', name: 'Import sync file: ' + (file.name || 'sync.zip'), retry: () => importSync(file) }) : null;
    try {
      const z = await JSZip.loadAsync(file);
      if (job) job.progress(0.15, 'reading the file');
      const mf = z.file('manifest.json');
      if (!mf) throw new Error('not a FLEX sync file (no manifest.json)');
      const man = JSON.parse(await mf.async('string'));
      if (man.format !== 'flex-sync') throw new Error('not a FLEX sync file');
      const scopes = {};
      for (const n of Object.keys(z.files)) {
        const m = /^logs\/([^/]+)\/log-([^/]+)\.jsonl$/.exec(n);
        if (!m || !/^(docs|p-[A-Za-z0-9_-]{1,40})$/.test(m[1])) continue;
        (scopes[m[1]] || (scopes[m[1]] = [])).push(...parseLines(await z.file(n).async('string')));
      }
      // The project first (a new one gets its folder), then its pages, so no entry points at a
      // page that isn't here, then the entries — all into that project's folder.
      const mpid = man.project && /^[A-Za-z0-9_-]{1,40}$/.test(man.project.id || '') ? man.project.id : '';
      const into = mpid ? '&project=' + encodeURIComponent(mpid) : '';
      if (mpid) await post('projects', { id: mpid, name: man.project.name || '' });
      const names = Object.keys(z.files).map(n => /^blobs\/([0-9a-f]{64}\.[a-z]{2,4})$/.exec(n)).filter(Boolean).map(m => m[1]);
      const { missing } = names.length ? await post('blobs-missing?x=1' + into, { names }) : { missing: [] };
      let pages = 0;
      if (job) job.progress(0.3, 'pages 0/' + missing.length);
      for (const n of missing) {
        if (job) job.progress(0.3 + 0.55 * pages / missing.length, 'pages ' + pages + '/' + missing.length);
        const [h, ext] = n.split('.');
        await api(`blob?ext=${ext}&h=${h}${into}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: await z.file('blobs/' + n).async('arraybuffer') });
        pages++;
      }
      let added = 0;
      if (job) job.progress(0.9, 'merging the changes');
      for (const [sc, list] of Object.entries(scopes)) added += (await post('merge?scope=' + sc + into, list)).added;
      const other = man.project && man.project.id && man.project.id !== pj.pid;
      if (!pj.pid && man.project && man.project.id) await setProject(man.project.id); else await loadAll();
      render(); refreshCard(); drawField(); drawLeads();
      if (job) job.done(`${added} new change(s), ${pages} new page(s)`);
      dialog({ title: 'Sync file imported', text: `${added} new change(s) and ${pages} new page(s)` + (man.from && man.from.who ? ` from ${man.from.who}` : '') +
        (man.project ? ` for project “${man.project.name || man.project.id}”` : '') + '.' + (other ? ' That isn’t the open project; choose it in Project to see it.' : '') });
    } catch (e) {
      if (job) job.fail(e.message || String(e));
      dialog({ title: 'Sync file not imported', text: e.message || String(e) });
    }
  }


  Object.assign(X, {
    describe, inverse, history, acceptAbove, review, headsFor, makeSync, importSync,
  });
})();
