// Cave import: loading a cave survey (file, wizard, recents, cave sets,
// Walls / Breakout files), placing it (anchor or UTM), replacing a placed
// cave's survey file, and the globe pick used to set an anchor.
// Moved out of flex.js (sections "Cave Survey", "Recents (EPT + PLT)",
// "Recent PLT and cave sets", "Replace a placed cave's survey", "Globe pick
// mode", "ENU / UTM-based cave render", "Wizard UI"). Behaviour unchanged.
//
// Shared state stays in flex.js and comes in through `state`:
//   state.recents, state.cwizParsed, state.cavePickMode, state.cavePickResolve
// (flex.js's globe click handler and the project workspace hooks use them too).

import { parsePLT } from './compass-plt.js';

// ── Pure helpers (no DOM, no Cesium) ─────────────────────────────────────────

export const jsonCopy = o => (o == null ? null : JSON.parse(JSON.stringify(o)));

export const escH = t => String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const btnCss = (bg, bd, fg) => `font-size:9px;padding:1px 6px;background:${bg};border:1px solid ${bd};color:${fg};border-radius:3px;cursor:pointer;white-space:nowrap;flex-shrink:0;`;

export function georefLabel(g) {
  return g ? (g.mode === 'anchor' ? `${Number(g.lat).toFixed(4)}°, ${Number(g.lon).toFixed(4)}°`
                                  : `UTM ${g.zone}${g.south ? 'S' : 'N'}`) : 'no georef stored';
}

// The station the anchor or a control point names, by the same rule as
// renderCaveSurveyAnchored (full name, or the part after a survey prefix).
export function caveFindStation(parsed, name) {
  const n = String(name ?? '').trim();
  if (!n) return null;
  return parsed.stations.find(s => s.name === n || s.name === n.split(/[./]/)[1]) || null;
}

// What replacing `oldParsed` with `newParsed` under `georef` does: stations
// added / removed / moved (in the file's own frame, lined up on the anchor
// when both have it), and which placement stations the new file is missing,
// each with a suggested stand-in (the new station nearest where it was).
export function replaceSurveyPlan(oldParsed, newParsed, georef) {
  const byName = p => { const m = new Map(); p.stations.forEach(s => { if (s.name && !m.has(s.name)) m.set(s.name, s); }); return m; };
  const A = byName(oldParsed), B = byName(newParsed);
  const added = [...B.keys()].filter(n => !A.has(n));
  const removed = [...A.keys()].filter(n => !B.has(n));
  let off = { n: 0, e: 0, v: 0 };
  if (georef && georef.mode === 'anchor') {
    const a = caveFindStation(oldParsed, georef.station), b = caveFindStation(newParsed, georef.station);
    if (a && b) off = { n: a.n - b.n, e: a.e - b.e, v: a.v - b.v };
  }
  const moved = [];
  A.forEach((a, n) => {
    const b = B.get(n);
    if (!b) return;
    const d = Math.hypot(b.n + off.n - a.n, b.e + off.e - a.e, b.v + off.v - a.v);
    if (d > 0.05) moved.push({ name: n, d });
  });
  moved.sort((x, y) => y.d - x.d);
  const suggest = name => {
    const a = caveFindStation(oldParsed, name);
    if (!a) return '';
    let best = '', bd = Infinity;
    B.forEach((b, n) => { const d = Math.hypot(b.n + off.n - a.n, b.e + off.e - a.e, b.v + off.v - a.v); if (d < bd) { bd = d; best = n; } });
    return bd < 5 ? best : '';                       // only a near one is a real guess
  };
  const missing = [];
  if (georef && georef.mode === 'anchor' && !caveFindStation(newParsed, georef.station))
    missing.push({ role: 'anchor', name: georef.station, suggestion: suggest(georef.station) });
  ((georef && georef.controlPoints) || []).forEach((cp, k) => {
    if (!caveFindStation(newParsed, cp.station)) missing.push({ role: 'cp', index: k, name: cp.station, suggestion: suggest(cp.station) });
  });
  return { added, removed, moved, missing };
}

// The placement for the new file: renamed stations where re-picked
// ({ role, index } → new name), missing control points dropped.
export function replaceGeoref(georef, newParsed, picks) {
  const g = jsonCopy(georef);
  const pick = (role, index) => (picks || []).find(p => p.role === role && (role === 'anchor' || p.index === index));
  if (g.mode === 'anchor' && !caveFindStation(newParsed, g.station)) {
    const p = pick('anchor');
    if (!p || !caveFindStation(newParsed, p.to)) return null;          // nothing to place it by
    g.station = caveFindStation(newParsed, p.to).name;
  }
  if (g.controlPoints) {
    g.controlPoints = g.controlPoints.map((cp, k) => {
      if (caveFindStation(newParsed, cp.station)) return cp;
      const p = pick('cp', k), st = p && caveFindStation(newParsed, p.to);
      return st ? { ...cp, station: st.name } : null;
    }).filter(Boolean);
    if (!g.controlPoints.length) delete g.controlPoints;
  }
  return g;
}


// ── Setup ────────────────────────────────────────────────────────────────────

/**
 * Called by flex.js where the "Cave Survey" section used to be.
 * @param {object} deps  see the destructuring below
 * @returns {object} the functions flex.js and other modules still call
 */
export function setupCaveImport({
  Cesium, cesiumViewer, viewModel, caveImports: _caveImports, state,
  // root-file libraries, passed in
  isWallsSelection, readWallsShapefileSets, wallsToPlt, isBreakoutFile, breakoutToPlt,
  // flex.js functions (lazy: they live later in flex.js)
  caveColourChanged, notifyCaveVisibilityChanged, rerenderCave, renderCaveList, defaultDisplayOptions,
  escapeHtml, icon,
}) {
  const _caveFindStation = caveFindStation, _replaceSurveyPlan = replaceSurveyPlan, _replaceGeoref = replaceGeoref;
  const _jsonCopy = jsonCopy, _escH = escH, _btnCss = btnCss, _georefLabel = georefLabel;
  const _caveColourChanged = (...a) => caveColourChanged(...a);
  const _renderCaveList = (...a) => renderCaveList(...a);
  const _defaultDisplayOptions = (...a) => defaultDisplayOptions(...a);
  const _rerenderCave = (...a) => rerenderCave(...a);
  const _escapeHtml = (...a) => escapeHtml(...a);
  const _ic = (...a) => icon(...a);

  // ── Recents (EPT + PLT) ───────────────────────────────────────────────────────
  // recents.json stores only lightweight metadata — NO rawText.
  // PLT file contents are stored as individual files via /api/plt-cache so that
  // large PLT files (600KB+) don't bloat the JSON payload and cause silent failures.
  const RECENTS_MAX = Infinity;          // My data keeps every cave (× forgets one)

  async function _loadRecents() {
    try {
      const r = await fetch('/api/recents');
      if (r.ok) state.recents = await r.json();
      if (!Array.isArray(state.recents.ept)) state.recents.ept = [];
      if (!Array.isArray(state.recents.plt)) state.recents.plt = [];
      if (!Array.isArray(state.recents.pltSets)) state.recents.pltSets = [];
    } catch(e) {
      console.warn('[recents] load failed:', e);
      state.recents = { ept: [], plt: [], pltSets: [] };
    }
    _renderEptRecents();
    _renderPltRecents();
  }

  async function _saveRecents() {
    // Strip any legacy rawText before saving so the payload stays small
    const payload = {
      ept: state.recents.ept,
      plt: state.recents.plt.map(({ rawText: _drop, ...rest }) => rest),
      pltSets: state.recents.pltSets || [],
    };
    try {
      const r = await fetch('/api/recents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!r.ok) console.warn('[recents] save returned', r.status);
    } catch(e) {
      console.warn('[recents] save failed:', e);
    }
  }

  async function _savePltCache(name, rawText) {
    try {
      const r = await fetch('/api/plt-cache', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, text: rawText }),
      });
      if (!r.ok) console.warn('[plt-cache] save returned', r.status);
    } catch(e) {
      console.warn('[plt-cache] save failed:', e);
    }
  }

  async function _fetchPltCache(name) {
    try {
      const r = await fetch('/api/plt-cache?name=' + encodeURIComponent(name));
      if (r.ok) return await r.text();
      console.warn('[plt-cache] fetch returned', r.status, 'for', name);
    } catch(e) {
      console.warn('[plt-cache] fetch failed:', e);
    }
    return null;
  }

  function _addEptRecent(url, name) {
    state.recents.ept = state.recents.ept.filter(r => r.url !== url);
    state.recents.ept.unshift({ url, name, lastUsed: new Date().toISOString() });
    if (state.recents.ept.length > RECENTS_MAX) state.recents.ept.length = RECENTS_MAX;
    _saveRecents();
    _renderEptRecents();
  }

  function _addPltRecent(name, rawText, georef, displayOptions, { force = false } = {}) {
    // A cave of the open project lives there, not in My data: placing or
    // styling it here doesn't copy it back (project_workspace.js decides).
    if (!force && window._pjWs && window._pjWs.owns && window._pjWs.owns(name)) return;
    // Save raw text to its own server-side file, not into recents.json
    _savePltCache(name, rawText);
    // Only lightweight metadata goes into recents index
    state.recents.plt = state.recents.plt.filter(r => r.name !== name);
    state.recents.plt.unshift({ name, georef, displayOptions: displayOptions || null, lastUsed: new Date().toISOString() });
    if (state.recents.plt.length > RECENTS_MAX) state.recents.plt.length = RECENTS_MAX;
    _saveRecents();
    _renderPltRecents();
  }

  function _removeEptRecent(url) {
    state.recents.ept = state.recents.ept.filter(r => r.url !== url);
    _saveRecents();
    _renderEptRecents();
  }

  function _removePltRecent(name) {
    state.recents.plt = state.recents.plt.filter(r => r.name !== name);
    _saveRecents();
    _renderPltRecents();
  }

  function _renderEptRecents() {
    const el = document.getElementById('lp-ept-recents');
    if (!el) return;
    if (!state.recents.ept.length) { el.innerHTML = ''; return; }
    const rows = state.recents.ept.map((r, i) => {
      const label = r.name || r.url;
      const shortUrl = r.url.length > 60 ? '…' + r.url.slice(-57) : r.url;
      return `<div style="display:flex;align-items:center;gap:4px;padding:2px 0;border-bottom:1px solid rgba(255,255,255,0.05);">
        <div style="flex:1;min-width:0;">
          <div style="font-size:9px;color:rgba(255,255,255,0.75);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${r.url}">${label}</div>
          <div style="font-size:8px;color:rgba(255,255,255,0.3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${shortUrl}</div>
        </div>
        <button onclick="window._loadEptRecent(${i})" style="font-size:9px;padding:1px 6px;background:rgba(0,120,255,0.2);border:1px solid rgba(0,120,255,0.35);color:#8cf;border-radius:3px;cursor:pointer;white-space:nowrap;flex-shrink:0;">Load</button>
        <button onclick="window._removeEptRecent(${i})" title="Remove" style="font-size:9px;padding:1px 4px;background:none;border:none;color:rgba(255,100,100,0.6);cursor:pointer;flex-shrink:0;">✕</button>
      </div>`;
    }).join('');
    el.innerHTML = `<div style="margin-top:5px;padding-top:4px;border-top:1px solid rgba(255,255,255,0.08);">
      <div style="font-size:9px;color:rgba(255,255,255,0.35);text-transform:uppercase;letter-spacing:0.07em;margin-bottom:3px;">Recent EPT</div>
      ${rows}
    </div>`;
  }

  // ── Recent PLT and cave sets ─────────────────────────────────────────────────
  // A set is a named selection of caves, loaded together in one click. It keeps
  // its own copy of each cave's placement (georef) and style (displayOptions);
  // the survey text itself comes from the PLT cache, by cave name, like a
  // recent. Make one from the caves currently loaded (💾 in the cave list) or
  // by ticking recents.
  let _recentTicks = new Set();           // names ticked in Recent PLT
  let _setsOpen = new Set();              // sets shown expanded
  let _setNamePrompt = null;              // { records, value } while naming a new set
  let _recentsNoteMsg = null;             // { text, color }

  function _recentsNote(text, color = '#8fa', ms = 8000) {
    _recentsNoteMsg = { text, color };
    _renderPltRecents();
    setTimeout(() => { if (_recentsNoteMsg && _recentsNoteMsg.text === text) { _recentsNoteMsg = null; _renderPltRecents(); } }, ms);
  }

  function _renderPltRecents() {
    const el = document.getElementById('lp-plt-recents');
    if (!el) return;
    // The two cave columns (cave_columns.js) show My data's caves and sets;
    // here only the messages.
    if (window._caveCols) {
      el.innerHTML = _recentsNoteMsg ? `<div style="font-size:10px;color:${_recentsNoteMsg.color};padding:3px 6px;border:1px solid rgba(255,255,255,0.15);border-radius:3px;margin:4px 0;">${_escapeHtml(_recentsNoteMsg.text)}</div>` : '';
      window._caveCols.render();
      return;
    }
    const sets = state.recents.pltSets || [];
    if (!state.recents.plt.length && !sets.length && !_setNamePrompt && !_recentsNoteMsg) { el.innerHTML = ''; return; }
    const esc = _escapeHtml;
    const head = t => `<div style="font-size:9px;color:rgba(255,255,255,0.35);text-transform:uppercase;letter-spacing:0.07em;margin:4px 0 3px;">${t}</div>`;
    let html = '';
    if (_recentsNoteMsg) {
      html += `<div style="font-size:10px;color:${_recentsNoteMsg.color};padding:3px 6px;border:1px solid rgba(255,255,255,0.15);border-radius:3px;margin-bottom:4px;">${esc(_recentsNoteMsg.text)}</div>`;
    }
    if (_setNamePrompt) {
      html += `<div style="display:flex;gap:4px;align-items:center;margin:4px 0;">
        <input id="lp-set-name" type="text" maxlength="60" value="${esc(_setNamePrompt.value || '')}" placeholder="Set name"
          onkeydown="if(event.key==='Enter')window._caveSetNameSave();if(event.key==='Escape')window._caveSetNameCancel()"
          style="flex:1;min-width:0;padding:2px 5px;background:#0d1418;border:1px solid rgba(255,255,255,0.2);border-radius:3px;color:#eee;font-size:10px;">
        <button onclick="window._caveSetNameSave()" style="${_btnCss('rgba(0,200,120,0.15)', 'rgba(0,200,120,0.3)', '#8fa')}">Save ${_setNamePrompt.records.length}</button>
        <button onclick="window._caveSetNameCancel()" style="${_btnCss('none', 'rgba(255,255,255,0.15)', '#aaa')}">Cancel</button>
      </div>`;
    }
    if (sets.length) {
      html += head('Cave sets');
      html += sets.map((st, i) => {
        const open = _setsOpen.has(st.name);
        const members = open ? `<div style="padding:1px 0 3px 16px;">${st.caves.map(c =>
          `<div style="font-size:8px;color:rgba(255,255,255,0.45);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(c.name)} · ${_georefLabel(c.georef)}</div>`).join('')}</div>` : '';
        return `<div style="border-bottom:1px solid rgba(255,255,255,0.05);">
          <div style="display:flex;align-items:center;gap:4px;padding:2px 0;">
            <button onclick="window._caveSetToggle(${i})" title="Show the caves in this set" style="background:none;border:none;color:rgba(255,255,255,0.5);cursor:pointer;font-size:9px;padding:0;width:10px;">${open ? '▾' : '▸'}</button>
            <div style="flex:1;min-width:0;font-size:9px;color:rgba(255,255,255,0.8);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${esc(st.name)}">${_ic('folder')}${esc(st.name)} <span style="opacity:0.45;">· ${st.caves.length}</span></div>
            <button onclick="window._caveSetLoad(${i})" title="Load every cave in the set (ones already loaded are skipped)" style="${_btnCss('rgba(0,200,120,0.15)', 'rgba(0,200,120,0.3)', '#8fa')}">Load</button>
            <button onclick="window._caveSetDelete(${i})" title="Delete the set (its caves stay in Recent)" style="font-size:9px;padding:1px 4px;background:none;border:none;color:rgba(255,100,100,0.6);cursor:pointer;flex-shrink:0;">✕</button>
          </div>${members}</div>`;
      }).join('');
    }
    if (state.recents.plt.length) {
      for (const n of [..._recentTicks]) if (!state.recents.plt.some(r => r.name === n)) _recentTicks.delete(n);
      html += head('Recent PLT');
      html += state.recents.plt.map((r, i) => `<div style="display:flex;align-items:center;gap:4px;padding:2px 0;border-bottom:1px solid rgba(255,255,255,0.05);">
        <input type="checkbox" class="keep-box" ${_recentTicks.has(r.name) ? 'checked' : ''} ${r.georef ? '' : 'disabled'} onchange="window._recentTick(${i}, this.checked)"
          title="${r.georef ? 'Tick to load or save several at once' : 'Load it once to place it first'}" style="margin:0;flex-shrink:0;">
        <div style="flex:1;min-width:0;">
          <div style="font-size:9px;color:rgba(255,255,255,0.75);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(r.name)}</div>
          <div style="font-size:8px;color:rgba(255,255,255,0.35);">${_georefLabel(r.georef)}</div>
        </div>
        <button onclick="window._loadPltRecent(${i})" style="${_btnCss('rgba(0,200,120,0.15)', 'rgba(0,200,120,0.3)', '#8fa')}">Load</button>
        <button onclick="window._removePltRecent(${i})" title="Remove" style="font-size:9px;padding:1px 4px;background:none;border:none;color:rgba(255,100,100,0.6);cursor:pointer;flex-shrink:0;">✕</button>
      </div>`).join('');
      if (_recentTicks.size) {
        html += `<div style="display:flex;gap:4px;justify-content:flex-end;margin-top:4px;">
          <button onclick="window._recentLoadTicked()" style="${_btnCss('rgba(0,200,120,0.15)', 'rgba(0,200,120,0.3)', '#8fa')}">Load ticked (${_recentTicks.size})</button>
          <button onclick="window._recentSaveTicked()" style="${_btnCss('rgba(80,220,255,0.12)', 'rgba(80,220,255,0.4)', '#8ee8ff')}">Save ticked as set…</button>
        </div>`;
      }
    }
    el.innerHTML = `<div style="margin-top:5px;padding-top:4px;border-top:1px solid rgba(255,255,255,0.08);">${html}</div>`;
    if (_setNamePrompt) {
      const inp = document.getElementById('lp-set-name');
      if (inp) { inp.oninput = () => { _setNamePrompt.value = inp.value; }; if (document.activeElement !== inp) inp.focus(); }
    }
  }


  // Place one cave from a stored record { name, georef, displayOptions } and its
  // cached survey text. → { entry } or { entry: null, why: 'cache'|'parse'|'georef' }
  async function _placeCaveRecord(r, { recent = true, rawText: text = null } = {}) {
    const rawText = text ?? await _fetchPltCache(r.name);
    if (!rawText) return { entry: null, why: 'cache' };
    let parsed;
    try { parsed = parsePLT(rawText); } catch (e) { return { entry: null, why: 'parse' }; }
    parsed._fileName = r.name;
    parsed._rawText  = rawText;
    if (!r.georef) return { entry: null, why: 'georef' };
    const georef = _jsonCopy(r.georef), dopt = _jsonCopy(r.displayOptions);
    let entry;
    if (georef.mode === 'anchor' && !_caveFindStation(parsed, georef.station) && georef.station !== '__first__') {
      // Was placed silently at the first point; say so (Replace survey… / Rectify fix it).
      _flexDialog({ title: 'Anchor station not found',
        html: `“${_escH(r.name)}” is anchored at station ${_escH(georef.station)}, which its survey file no longer has, so it was placed at the first station instead. ` +
              `Use Replace survey file… (re-pick the anchor) or Rectify to fix it.` });
    }
    if (georef.mode === 'anchor') {
      entry = renderCaveSurveyAnchored(r.name, parsed, georef.station, georef.lat, georef.lon, georef.elev, georef.survey || '', georef.declination ?? null);
      if (entry) {
        if (georef.controlPoints && georef.controlPoints.length) entry.georef.controlPoints = georef.controlPoints;
        if (dopt) entry.displayOptions = dopt;
        if (dopt || entry.georef.controlPoints) window._rerenderCave(_caveImports.indexOf(entry));
      }
    } else {
      entry = renderCaveSurveyUTM(r.name, parsed, georef.zone, georef.south, dopt, georef.controlPoints || null);
    }
    if (!entry) return { entry: null, why: 'georef' };
    _finishCaveLoad(entry, { recent });
    return { entry };
  }

  // ── Replace a placed cave's survey, keeping its placement ────────────────────
  // A cave's placement is stored apart from its survey text, and refers to
  // stations by name: the anchor station (anchor mode) and every control point.
  // So a newer survey file can take the old one's place and be put exactly where
  // the old one was, as Recent and cave sets already do with cached text. What
  // can go wrong is a station the placement names that the new file doesn't
  // have (renumbered, or a different file): that is shown before anything
  // changes, with Cancel / Proceed (drop those control points) / Re-pick.

  // A small modal in the panels' style. buttons: [{ label, value, primary, danger, disabled }]
  function _flexDialog({ title, html, buttons, wide }) {
    return new Promise(resolve => {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;font:12px system-ui,sans-serif;';
      const box = document.createElement('div');
      box.style.cssText = `width:min(${wide ? 520 : 420}px,calc(100vw - 32px));max-height:calc(100vh - 40px);overflow:auto;background:rgba(18,18,30,.98);color:#e8e8ee;border:1px solid rgba(255,255,255,.18);border-radius:10px;padding:14px 16px;display:flex;flex-direction:column;gap:10px;`;
      box.innerHTML = `<div style="font-size:14px;font-weight:700">${title}</div><div style="line-height:1.45;color:rgba(255,255,255,.8)">${html || ''}</div>`;
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap';
      (buttons || [{ label: 'OK', value: 'ok', primary: true }]).forEach(b => {
        const el = document.createElement('button');
        el.textContent = b.label;
        el.disabled = !!b.disabled;
        el.style.cssText = `font-size:12px;padding:6px 12px;border-radius:5px;cursor:pointer;color:${b.danger ? '#ffb0b0' : '#eee'};` +
          `background:${b.primary ? 'rgba(33,150,243,.35)' : 'rgba(255,255,255,.07)'};border:1px solid ${b.primary ? '#2196F3' : b.danger ? 'rgba(255,107,107,.6)' : 'rgba(255,255,255,.2)'};` +
          (b.disabled ? 'opacity:.35;cursor:default;' : '');
        el.onclick = () => { if (b.disabled) return; wrap.remove(); resolve({ button: b.value, box }); };
        row.appendChild(el);
      });
      box.appendChild(row);
      wrap.appendChild(box);
      wrap.addEventListener('mousedown', e => { if (e.target === wrap) { wrap.remove(); resolve(null); } });
      document.body.appendChild(wrap);
    });
  }

  // Survey text from a file selection: a .plt, a Breakout .json, or a Walls
  // shapefile set. Several caves in one file: the one named like this cave.
  async function _surveyTextFromFiles(files, caveName) {
    const pickNamed = list => list.find(c => c.name === caveName) || (list.length === 1 ? list[0] : null);
    if (isWallsSelection(files)) {
      const sets = await readWallsShapefileSets(files);
      const cs = sets.map(s => wallsToPlt(s, window.proj4));
      const c = pickNamed(cs);
      if (!c) throw new Error(`these Walls files hold ${cs.length} caves and none is named “${caveName}”`);
      return c.plt;
    }
    const f = files[0];
    const text = await f.text();
    if (/^\s*\{/.test(text)) {
      let data; try { data = JSON.parse(text); } catch (e) { throw new Error('not valid JSON'); }
      if (!isBreakoutFile(data)) throw new Error('this JSON is not a Breakout file');
      const cs = [...breakoutToPlt(data)];
      const c = pickNamed(cs);
      if (!c) throw new Error(`this file holds ${cs.length} caves and none is named “${caveName}”`);
      return c.plt;
    }
    return text;
  }

  window._replaceCaveSurvey = function(i) {
    const imp = _caveImports[i];
    if (!imp) return;
    let inp = document.getElementById('cave-replace-input');
    if (!inp) {
      inp = document.createElement('input');
      inp.type = 'file'; inp.id = 'cave-replace-input'; inp.multiple = true; inp.style.display = 'none';
      inp.accept = '.plt,.PLT,.txt,.json,.dbf,.DBF,.prj,.PRJ,.shp,.SHP,.shx,.SHX';
      document.body.appendChild(inp);
      inp.addEventListener('change', () => {
        const files = [...inp.files]; inp.value = '';
        const target = _caveImports.find(c => c === inp._imp);
        if (files.length && target) _replaceCaveSurveyWith(target, files);
      });
    }
    inp._imp = imp;
    inp.click();
  };

  async function _replaceCaveSurveyWith(imp, files) {
    let text, parsed;
    try {
      text = await _surveyTextFromFiles(files, imp.name);
      parsed = parsePLT(text);
      if (!parsed.segments.length) throw new Error('no survey lines in it');
    } catch (e) {
      await _flexDialog({ title: 'Can’t use that file', html: _escH(e.message || String(e)) });
      return;
    }
    const g = imp.georef;
    if (!g) { await _flexDialog({ title: 'No placement stored', html: 'This cave has no stored placement to keep.' }); return; }
    const plan = _replaceSurveyPlan(imp.parsed, parsed, g);
    const list = (arr, f, max = 12) => arr.slice(0, max).map(f).join(', ') + (arr.length > max ? `, … (${arr.length - max} more)` : '');
    const moveTxt = plan.moved.length
      ? `${plan.moved.length} moved — most: ${list(plan.moved, m => `${_escH(m.name)} ${m.d < 10 ? m.d.toFixed(2) : m.d.toFixed(0)} m`, 4)}`
      : 'none moved';
    let html = `<b>${_escH(imp.name)}</b>: ${parsed.stations.length} stations in the new file (${imp.parsed.stations.length} before).<br>` +
      `${plan.added.length} added${plan.added.length ? ' (' + list(plan.added, _escH, 6) + ')' : ''}; ` +
      `${plan.removed.length} gone${plan.removed.length ? ' (' + list(plan.removed, _escH, 6) + ')' : ''}; ${moveTxt}.<br>` +
      `The cave keeps its placement (${g.mode === 'anchor' ? 'anchored at ' + _escH(g.station) : 'UTM zone ' + _escH(g.zone ?? parsed.utmZone ?? '?')}` +
      `${g.controlPoints && g.controlPoints.length ? ', ' + g.controlPoints.length + ' control point' + (g.controlPoints.length > 1 ? 's' : '') : ''}) and its style.`;
    const anchorMissing = plan.missing.some(m => m.role === 'anchor');
    let picks = [];
    if (plan.missing.length) {
      html += `<div style="margin-top:8px;padding:8px;border-radius:6px;background:rgba(255,143,0,.12);color:#ffc266">` +
        `<b>The new file doesn’t have ${plan.missing.length === 1 ? 'a station' : 'stations'} the placement uses:</b><br>` +
        plan.missing.map(m => `${m.role === 'anchor' ? 'Anchor' : 'Control point'} <b>${_escH(m.name)}</b>` +
          (m.suggestion ? ` (nearest in the new file: ${_escH(m.suggestion)})` : '')).join('<br>') +
        (anchorMissing ? '<br>Without the anchor the cave can’t be placed: re-pick it.' : '<br>Proceed drops those control points; Re-pick lets you name their new stations.') +
        `</div>`;
      const r = await _flexDialog({ title: 'Replace the survey of ' + _escH(imp.name) + '?', html, wide: true, buttons: [
        { label: 'Cancel', value: null }, { label: 'Proceed', value: 'proceed', disabled: anchorMissing, danger: true },
        { label: 'Re-pick…', value: 'repick', primary: true }] });
      if (!r || !r.button) return;
      if (r.button === 'repick') {
        const names = parsed.stations.map(s => s.name).filter(Boolean);
        const dl = `<datalist id="cave-replace-names">${names.slice(0, 5000).map(n => `<option value="${_escH(n)}">`).join('')}</datalist>`;
        const rows = plan.missing.map((m, k) => `<div style="display:flex;gap:8px;align-items:center;margin:4px 0">` +
          `<span style="width:150px">${m.role === 'anchor' ? 'Anchor' : 'Control point'} ${_escH(m.name)} →</span>` +
          `<input data-k="${k}" list="cave-replace-names" value="${_escH(m.suggestion)}" placeholder="station in the new file" ` +
          `style="flex:1;padding:4px 6px;background:rgba(0,0,0,.4);color:#eee;border:1px solid rgba(255,255,255,.25);border-radius:4px"></div>`).join('');
        const r2 = await _flexDialog({ title: 'Re-pick stations', wide: true,
          html: `Which station in the new file is each of these? Leave a control point empty to drop it.${dl}${rows}`,
          buttons: [{ label: 'Cancel', value: null }, { label: 'Replace', value: 'ok', primary: true }] });
        if (!r2 || r2.button !== 'ok') return;
        picks = plan.missing.map((m, k) => ({ role: m.role, index: m.index, to: (r2.box.querySelector(`input[data-k="${k}"]`).value || '').trim() }));
      }
    } else {
      const r = await _flexDialog({ title: 'Replace the survey of ' + _escH(imp.name) + '?', html, wide: true,
        buttons: [{ label: 'Cancel', value: null }, { label: 'Replace', value: 'ok', primary: true }] });
      if (!r || r.button !== 'ok') return;
    }
    const georef = _replaceGeoref(g, parsed, picks);
    if (!georef) { await _flexDialog({ title: 'Not replaced', html: 'The anchor station has to be one of the new file’s stations.' }); return; }
    // Place the new one first; the old one goes only once that worked. Recent
    // (and the cached text) then hold the new file with the same placement.
    const rec = { name: imp.name, georef, displayOptions: _jsonCopy(imp.displayOptions) };
    const res = await _placeCaveRecord(rec, { recent: true, rawText: text });
    if (!res.entry) {
      await _flexDialog({ title: 'Couldn’t place the new survey', html: `(${_escH(res.why)}) Nothing was changed.` });
      return;
    }
    const at = _caveImports.indexOf(imp);
    if (at >= 0) window._removeCaveImport(at);
    _renderCaveList();
  }

  // Load several records; caves already loaded (by name) are skipped.
  async function _loadCaveRecords(records, what) {
    const loaded = new Set(_caveImports.map(c => c.name));
    const missing = [];
    let n = 0, skipped = 0;
    for (const r of records) {
      if (loaded.has(r.name)) { skipped++; continue; }
      const res = await _placeCaveRecord(r, { recent: false });
      if (res.entry) { n++; loaded.add(r.name); continue; }
      missing.push(r.name + (res.why === 'cache' ? ' (not cached: import its file once)'
                           : res.why === 'georef' ? ' (not placed yet)' : ' (could not be read)'));
    }
    _recentsNote(`${what}: loaded ${n}` + (skipped ? `, ${skipped} already loaded` : '')
                 + (missing.length ? `. Not loaded: ${missing.join(', ')}` : ''), missing.length ? '#fa0' : '#8fa');
  }

  window._caveSetToggle = function(i) {
    const st = (state.recents.pltSets || [])[i];
    if (!st) return;
    if (_setsOpen.has(st.name)) _setsOpen.delete(st.name); else _setsOpen.add(st.name);
    _renderPltRecents();
  };
  window._caveSetLoad = function(i) {
    const st = (state.recents.pltSets || [])[i];
    if (st) _loadCaveRecords(st.caves, `“${st.name}”`);
  };
  window._caveSetDelete = function(i) {
    const st = (state.recents.pltSets || [])[i];
    if (!st || !confirm(`Delete the set “${st.name}”? Its caves stay in Recent PLT.`)) return;
    state.recents.pltSets.splice(i, 1);
    _saveRecents();
    _renderPltRecents();
  };
  window._recentTick = function(i, on) {
    const r = state.recents.plt[i];
    if (!r) return;
    if (on) _recentTicks.add(r.name); else _recentTicks.delete(r.name);
    _renderPltRecents();
  };
  window._recentLoadTicked = function() {
    const recs = state.recents.plt.filter(r => _recentTicks.has(r.name));
    _recentTicks.clear();
    _loadCaveRecords(recs, 'Ticked caves');
  };
  window._recentSaveTicked = function() {
    const recs = state.recents.plt.filter(r => _recentTicks.has(r.name) && r.georef);
    if (!recs.length) return;
    _setNamePrompt = { records: recs.map(r => ({ name: r.name, georef: r.georef, displayOptions: r.displayOptions })), value: '' };
    _renderPltRecents();
  };
  // 💾 in the cave list: the caves loaded now, as they are placed and styled now.
  window._caveSetSaveLoaded = function() {
    const recs = _caveImports.filter(imp => imp.georef && imp.parsed && imp.parsed._rawText).map(imp => {
      _savePltCache(imp.name, imp.parsed._rawText);           // make sure the set can reload it
      return { name: imp.name, georef: imp.georef, displayOptions: imp.displayOptions };
    });
    if (!recs.length) { _recentsNote('Load some caves first, then save them as a set.', '#fa0'); return; }
    _setNamePrompt = { records: recs, value: '' };
    _renderPltRecents();
  };
  window._caveSetNameSave = function() {
    const p = _setNamePrompt;
    const inp = document.getElementById('lp-set-name');
    const name = ((inp && inp.value) || (p && p.value) || '').trim();
    if (!p || !name) { if (inp) inp.focus(); return; }
    const set = { name, savedAt: new Date().toISOString(),
                  caves: p.records.map(r => ({ name: r.name, georef: _jsonCopy(r.georef), displayOptions: _jsonCopy(r.displayOptions) })) };
    const sets = state.recents.pltSets || (state.recents.pltSets = []);
    const at = sets.findIndex(x => x.name === name);
    if (at >= 0) sets[at] = set; else sets.unshift(set);
    _setNamePrompt = null;
    _recentTicks.clear();
    _saveRecents();
    _recentsNote(`${at >= 0 ? 'Replaced' : 'Saved'} set “${name}” (${set.caves.length} cave${set.caves.length === 1 ? '' : 's'}).`);
  };
  window._caveSetNameCancel = function() { _setNamePrompt = null; _renderPltRecents(); };

  window._loadEptRecent = function(i) {
    const r = state.recents.ept[i];
    if (!r) return;
    const statusEl = document.getElementById('lp-pc-status');
    if (statusEl) { statusEl.textContent = '⏳ Loading…'; statusEl.style.color = '#aaa'; }
    try { window.addPC(r.url); } catch(e) {
      if (statusEl) { statusEl.textContent = '✗ ' + (e.message || e); statusEl.style.color = '#f77'; }
    }
  };

  window._removeEptRecent = function(i) {
    if (state.recents.ept[i]) { state.recents.ept.splice(i, 1); _saveRecents(); _renderEptRecents(); }
  };

  window._removePltRecent = function(i) {
    if (state.recents.plt[i]) { state.recents.plt.splice(i, 1); _saveRecents(); _renderPltRecents(); }
  };

  // Holds pending georef when cache misses and user must re-select the PLT file
  let _pltRestorePending = null;

  // Wire the hidden restore input once DOM is ready (called at init time below)
  function _initPltRestoreInput() {
    const inp = document.getElementById('plt-restore-input');
    if (!inp) return;
    inp.addEventListener('change', () => {
      const file = inp.files[0];
      inp.value = '';
      if (!file || !_pltRestorePending) return;
      const pending = _pltRestorePending;
      _pltRestorePending = null;
      const reader = new FileReader();
      reader.onload = ev => {
        const rawText = ev.target.result;
        let parsed;
        try { parsed = parsePLT(rawText); } catch(e) {
          console.error('[cave] restore re-parse failed:', e); return;
        }
        parsed._fileName = file.name.replace(/\.plt$/i, '');
        parsed._rawText  = rawText;
        // Re-cache so next Load works without the file picker
        _savePltCache(pending.name, rawText);
        if (!pending.georef) {
          state.cwizParsed = parsed;
          window._importCavePLT();
          return;
        }
        let entry;
        if (pending.georef.mode === 'anchor') {
          entry = renderCaveSurveyAnchored(pending.name, parsed, pending.georef.station, pending.georef.lat, pending.georef.lon, pending.georef.elev, pending.georef.survey || '', pending.georef.declination ?? null);
        } else {
          entry = renderCaveSurveyUTM(pending.name, parsed, pending.georef.zone, pending.georef.south, null,
                                      pending.georef.controlPoints || null);
        }
        _finishCaveLoad(entry);
      };
      reader.readAsText(file);
    });
  }

  window._loadPltRecent = async function(i) {
    const r = state.recents.plt[i];
    if (!r) return;

    // Fetch the cached PLT text from the server — no file picker needed
    const rawText = await _fetchPltCache(r.name);
    if (!rawText) {
      // Cache miss (server restarted or first load). Ask user to re-select the file;
      // georef will be applied automatically — no wizard needed.
      console.warn('[cave] PLT cache missing for', r.name, '— prompting re-select');
      _pltRestorePending = { name: r.name, georef: r.georef };
      const inp = document.getElementById('plt-restore-input');
      if (inp) {
        // Show a small banner in the recents area, then trigger picker
        const el = document.getElementById('lp-plt-recents');
        if (el) {
          const note = document.createElement('div');
          note.style.cssText = 'font-size:10px;color:#fa0;padding:3px 6px;border:1px solid rgba(255,160,0,0.3);border-radius:3px;margin-bottom:4px;';
          note.textContent = '⚠ Cache expired for “' + r.name + '” — re-select the .plt file to reload.';
          el.prepend(note);
          setTimeout(() => { try { el.removeChild(note); } catch(_) {} }, 6000);
        }
        inp.click();
      } else {
        alert('PLT file cache missing for "' + r.name + '".\nPlease use the + Cave Import button to re-load the file.');
      }
      return;
    }

    let parsed;
    try { parsed = parsePLT(rawText); } catch(e) {
      console.error('[cave] PLT re-parse failed:', e); return;
    }
    parsed._fileName = r.name;
    parsed._rawText  = rawText;

    if (!r.georef) {
      // No georef saved — open wizard pre-loaded
      state.cwizParsed = parsed;
      window._importCavePLT();
      return;
    }
    // Georef saved — skip wizard and place directly
    _finishCaveLoad(_placeCave(r.name, parsed, r.georef, r.displayOptions || null));
  };

  // Place a parsed survey with a saved georef (anchor or UTM) and display options.
  function _placeCave(name, parsed, georef, displayOptions) {
    let entry;
    if (displayOptions && !displayOptions.surveyColors) displayOptions = Object.assign(_defaultDisplayOptions(parsed), displayOptions);   // a look with only area labels
    if (georef.mode === 'anchor') {
      entry = renderCaveSurveyAnchored(name, parsed, georef.station, georef.lat, georef.lon, georef.elev, georef.survey || '', georef.declination ?? null);
      // Restore saved control points and re-warp
      if (entry && georef.controlPoints && georef.controlPoints.length) {
        entry.georef.controlPoints = georef.controlPoints;
      }
      if (entry && georef.heights) entry.georef.heights = georef.heights;
      // Restore saved display options
      if (entry && displayOptions) {
        entry.displayOptions = displayOptions;
      } else if (entry) {
        entry.displayOptions = _defaultDisplayOptions(entry.parsed);
      }
      if (entry) _rerenderCave(_caveImports.indexOf(entry));
    } else {
      entry = renderCaveSurveyUTM(name, parsed, georef.zone, georef.south, displayOptions || null,
                                  georef.controlPoints || null);
      if (entry && georef.heights) { entry.georef.heights = georef.heights; _rerenderCave(_caveImports.indexOf(entry)); }
    }
    return entry;
  }


  function _startGlobePick(source = 'cesium') {
    return new Promise(resolve => {
      const banner = document.getElementById('cave-pick-banner');
      const wizOverlay = document.getElementById('cave-wizard-overlay');

      if (source === 'potree') {
        // ── Potree pick: listen for click on Potree canvas, resolve with Cesium coords ──
        // The cameras are synced, so screen (clientX, clientY) maps to the same
        // geographic position in both Potree and Cesium.
        const ptCanvas = window.potreeViewer?.renderer?.domElement;
        if (!ptCanvas) { resolve(null); return; }
        if (wizOverlay) wizOverlay.style.display = 'none';
        if (banner) {
          banner.querySelector && (banner.querySelector('span:first-child').textContent =
            'Click on the point cloud to set the anchor · Esc to cancel');
          banner.style.display = 'block';
        }
        const clickH = (event) => {
          event.stopPropagation();
          ptCanvas.removeEventListener('click', clickH, true);
          document.removeEventListener('keydown', escH);
          if (banner) banner.style.display = 'none';
          if (wizOverlay) wizOverlay.style.display = 'flex';
          // Use Cesium for geographic coords at the same screen position
          const screenPos = new Cesium.Cartesian2(event.clientX, event.clientY);
          const ray = cesiumViewer.camera.getPickRay(screenPos);
          let cart = ray ? cesiumViewer.scene.globe.pick(ray, cesiumViewer.scene) : null;
          if (!cart || !Cesium.defined(cart)) {
            cart = cesiumViewer.camera.pickEllipsoid(screenPos, cesiumViewer.scene.globe.ellipsoid);
          }
          if (cart && Cesium.defined(cart)) {
            const carto = Cesium.Cartographic.fromCartesian(cart);
            resolve({
              lat:  Cesium.Math.toDegrees(carto.latitude),
              lon:  Cesium.Math.toDegrees(carto.longitude),
              elev: carto.height,
            });
          } else {
            resolve(null);
          }
        };
        const escH = (e) => {
          if (e.key !== 'Escape') return;
          ptCanvas.removeEventListener('click', clickH, true);
          document.removeEventListener('keydown', escH);
          if (banner) banner.style.display = 'none';
          if (wizOverlay) wizOverlay.style.display = 'flex';
          resolve(null);
        };
        ptCanvas.addEventListener('click', clickH, true);
        document.addEventListener('keydown', escH);
        return;
      }

      // ── Cesium pick (default) ─────────────────────────────────────────────────
      state.cavePickMode = true;
      state.cavePickResolve = resolve;
      if (banner) banner.style.display = 'block';
      if (wizOverlay) wizOverlay.style.display = 'none';

      const onEsc = e => {
        if (e.key === 'Escape') { _cancelGlobePick(); document.removeEventListener('keydown', onEsc); }
      };
      document.addEventListener('keydown', onEsc);
    });
  }

  function _cancelGlobePick() {
    state.cavePickMode = false;
    const banner = document.getElementById('cave-pick-banner');
    if (banner) banner.style.display = 'none';
    document.getElementById('cave-wizard-overlay').style.display = 'flex';
    if (state.cavePickResolve) { state.cavePickResolve(null); state.cavePickResolve = null; }
  }

  // Wired into Cesium canvas click handler (called from main click handler)
  function _onCavePickClick(windowPos) {
    if (!state.cavePickMode) return false;
    state.cavePickMode = false;
    const banner = document.getElementById('cave-pick-banner');
    if (banner) banner.style.display = 'none';

    let cart3 = cesiumViewer.scene.pickPosition(windowPos);
    if (!cart3 || !Cesium.defined(cart3)) {
      // Fallback: pick on ellipsoid surface
      cart3 = cesiumViewer.camera.pickEllipsoid(windowPos, cesiumViewer.scene.globe.ellipsoid);
    }

    const resolve = state.cavePickResolve;
    state.cavePickResolve = null;
    document.getElementById('cave-wizard-overlay').style.display = 'flex';

    if (cart3 && resolve) {
      const carto = Cesium.Cartographic.fromCartesian(cart3);
      resolve({
        lat:  Cesium.Math.toDegrees(carto.latitude),
        lon:  Cesium.Math.toDegrees(carto.longitude),
        elev: carto.height,
      });
    } else if (resolve) {
      resolve(null);
    }
    return true;
  }
  // Canvas click handler for pick mode is wired below (in the canvas section).

  // ── ENU-based cave render (anchor mode) ──────────────────────────────────────
  // anchorStationName: survey station name (required; must match a parsed station)
  // anchorLat/Lon/Elev: real-world position of that station (degrees, metres)
  //
  // Multi-anchor groundwork: this function accepts a single anchor point.
  // A future version will accept an array of anchors:
  //   anchors: [{stationName, lat, lon, elev}, ...] (2+ points → least-squares fit)
  // For now the single-anchor ENU transform is exact and sufficient.
  // anchorStationName: survey station name (required; must match a parsed station)
  // surveyName: the survey the station belongs to (for multi-survey PLTs), or ''
  // declinationDeg: magnetic declination correction in degrees (positive = east), or null
  function renderCaveSurveyAnchored(name, parsed, anchorStationName, anchorLat, anchorLon, anchorElevM, surveyName = '', declinationDeg = null) {
    // Find the anchor station (metres in survey space)
    let anchorLocal = null, resolved = '__first__';
    if (!anchorStationName) {
      console.warn('[cave] No station specified; falling back to first point');
    } else {
      const nameNorm = String(anchorStationName).trim();
      anchorLocal = parsed.stations.find(s => s.name === nameNorm || s.name === nameNorm.split(/[./]/)[1]);
      if (anchorLocal) resolved = anchorLocal.name;
      else console.warn(`[cave] Station "${anchorStationName}" not found; using first point`);
    }
    if (!anchorLocal && !parsed.segments[0]?.points[0]) { console.error('[cave] No anchor point available'); return null; }

    // Drawn by _rerenderCave like UTM caves (per-survey colours, fast layers),
    // which places the anchor station at lat/lon/elev, turned by the declination.
    // The station is stored as the name actually matched, so every re-render
    // finds the same one.
    const entry = {
      name, parsed, cesiumIds: [], visible: true,
      georef: { mode: 'anchor', station: resolved, survey: surveyName, lat: anchorLat, lon: anchorLon,
                elev: anchorElevM, declination: declinationDeg },
      displayOptions: _defaultDisplayOptions(parsed),
    };
    _caveImports.push(entry);
    window._rerenderCave(_caveImports.length - 1);
    return entry;
  }

  // ── UTM-based cave render (file-coords-as-is mode) ────────────────────────────
  function renderCaveSurveyUTM(name, parsed, zoneOverride, southOverride, displayOptions = null, controlPoints = null) {
    // Built by the same code as anchored caves (window._rerenderCave), with a
    // UTM → globe conversion instead of the anchor frame, so UTM caves get
    // per-survey colours, hiding, surface options, labels and walls too.
    if (!(zoneOverride ?? parsed.utmZone)) {
      console.warn('[cave] UTM render failed: no UTM zone for', name);
      return null;
    }
    const entry = {
      name, parsed, cesiumIds: [], visible: true,
      georef: { mode: 'utm', zone: zoneOverride, south: southOverride,
                ...(controlPoints && controlPoints.length ? { controlPoints } : {}) },
      displayOptions: displayOptions || _defaultDisplayOptions(parsed),
    };
    _caveImports.push(entry);
    window._rerenderCave(_caveImports.length - 1);
    return entry;
  }

  // Keep old renderCaveSurvey as alias for UTM mode
  function renderCaveSurvey(name, parsed, zoneOverride, southOverride) {
    return renderCaveSurveyUTM(name, parsed, zoneOverride, southOverride);
  }

  // ── Wizard UI ─────────────────────────────────────────────────────────────────
  window._importCavePLT = function() {
    state.cwizParsed = null;
    const overlay     = document.getElementById('cave-wizard-overlay');
    const fileInput   = document.getElementById('cwiz-file-input');
    const fileInfo    = document.getElementById('cwiz-file-info');
    const georef      = document.getElementById('cwiz-step-georef');
    const stats       = document.getElementById('cwiz-stats');
    const errDiv      = document.getElementById('cwiz-error');
    const loadBtn     = document.getElementById('cwiz-load');
    const utmZoneRow  = document.getElementById('cwiz-utm-zone-row');
    const anchorBody  = document.getElementById('cwiz-anchor-body');
    const utmHint     = document.getElementById('cwiz-utm-hint');

    // Reset
    fileInput.value = '';
    fileInfo.textContent = '';
    stats.style.display = 'none';
    georef.style.display = 'none';
    errDiv.style.display = 'none';
    loadBtn.disabled = true;
    overlay.style.display = 'flex';

    // Radio change handlers
    const utmRadio    = document.getElementById('cwiz-radio-utm');
    const anchorRadio = document.getElementById('cwiz-radio-anchor');

    function updateModeUI() {
      const isAnchor = anchorRadio.checked;
      anchorBody.style.display  = isAnchor ? 'block' : 'none';
      utmZoneRow.style.display  = isAnchor ? 'none'  : 'flex';
    }
    utmRadio.onchange    = updateModeUI;
    anchorRadio.onchange = updateModeUI;

    fileInput.onchange = () => {
      const files = [...fileInput.files];
      if (!files.length) return;
      // PLT text (or a Breakout JSON file) from `fileName`: parse and offer georeferencing.
      const showText = (text, fileName) => {
        try {
          // A Breakout JSON file: every cave in it is placed from its
          // own UTM coordinates, so there is nothing to ask — load and close.
          if (/^\s*\{/.test(text)) {
            const n = _loadBreakoutText(text);
            if (n) { overlay.style.display = 'none'; state.cwizParsed = null; return; }
            throw new Error('no cave in the file could be placed');
          }
          const parsed = parsePLT(text);
          state.cwizParsed = parsed;
          state.cwizParsed._fileName = fileName.replace(/\.plt$/i, '').replace(/ \(Walls\)$/, '');
          state.cwizParsed._rawText  = text;

          // Stats
          const totalPts = parsed.segments.reduce((s, seg) => s + seg.points.length, 0);
          const allN = parsed.segments.flatMap(s => s.points.map(p => p.n));
          const maxAbsN = allN.length ? Math.max(...allN.map(Math.abs)) : 0;
          const isAbsUTM = maxAbsN > 500000;
          let statsHtml = `${parsed.segments.length} segments &nbsp;·&nbsp; ${parsed.stations.length} stations &nbsp;·&nbsp; ${totalPts} points`;
          statsHtml += `<br>Coord type: <b>${isAbsUTM ? 'Absolute UTM' : 'Local survey (offset from origin)'}</b>`;
          if (parsed.fixedStations.length) {
            statsHtml += `<br>Fixed ref stations in file: <b>${parsed.fixedStations.map(s => s.name).join(', ')}</b>`;
          }
          if (parsed.utmZone) {
            statsHtml += `<br>Zone in file: <b>${parsed.utmZone}${parsed.utmSouth ? 'S' : 'N'}</b>${parsed.datum ? ' &nbsp;(' + parsed.datum + ')' : ''}`;
          }
          stats.innerHTML = statsHtml;
          stats.style.display = 'block';

          // Set recommended defaults
          if (isAbsUTM) {
            utmRadio.checked = true;
            utmHint.innerHTML = `Absolute UTM detected (max northing ${(maxAbsN/1000).toFixed(0)} km)`;
            document.getElementById('cwiz-zone-input').value = parsed.utmZone || 17;
            document.getElementById('cwiz-hemi-input').value = parsed.utmSouth ? 'S' : 'N';
          } else {
            anchorRadio.checked = true;
            utmHint.innerHTML = 'Local coords — use "Anchor" mode instead for correct placement';
          }

          // Populate station dropdown — grouped by survey (N-line code + description), naturally sorted
          const sel = document.getElementById('cwiz-station-select');
          sel.innerHTML = '<option value="">-- Select a station --</option>';

          if (parsed.stations.length > 0) {
            function _naturalCmp(a, b) {
              const re = /(\d+)|(\D+)/g;
              const pa = String(a).match(re) || [];
              const pb = String(b).match(re) || [];
              for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
                const ca = pa[i] || '';
                const cb = pb[i] || '';
                const na = parseInt(ca, 10), nb = parseInt(cb, 10);
                const diff = (!isNaN(na) && !isNaN(nb)) ? na - nb : ca.localeCompare(cb);
                if (diff !== 0) return diff;
              }
              return 0;
            }

            // Group stations by survey code, preserving survey order from file
            // Use a Map keyed by "surveyCode|||surveyDesc" to keep unique entries in order
            const surveyOrder = [];
            const groups = {};
            for (const st of parsed.stations) {
              const code = st.survey || '';
              const desc = st.surveyDesc || '';
              const key  = code + '|||' + desc;
              if (!groups[key]) {
                groups[key] = [];
                surveyOrder.push({ key, code, desc });
              }
              groups[key].push(st);
            }

            // Within each survey, sort stations naturally by name
            for (const { key, code, desc } of surveyOrder) {
              const sts = groups[key];
              sts.sort((a, b) => _naturalCmp(a.name, b.name));
              const label = code && desc ? `${code} — ${desc}`
                          : code        ? `Survey ${code}`
                          :               '(unsurveyed)';
              const grp = document.createElement('optgroup');
              grp.label = label;
              for (const st of sts) {
                const opt = document.createElement('option');
                // Value encodes both survey code and station name to disambiguate duplicates
                opt.value = JSON.stringify({ survey: code, name: st.name });
                // Show station name + local coords (N/E in metres) — NOT "m from entrance"
                // because we're choosing which station IS the anchor, not measuring from it
                const coordHint = `N${st.n.toFixed(0)} E${st.e.toFixed(0)} V${st.v.toFixed(0)}`;
                opt.textContent = `${st.name}  (${coordHint})`;
                grp.appendChild(opt);
              }
              sel.appendChild(grp);
            }
          }

          updateModeUI();
          georef.style.display = 'block';
          fileInfo.textContent = `✓ ${fileName}`;
          errDiv.style.display = 'none';
          loadBtn.disabled = false;
        } catch(e) {
          errDiv.textContent = 'Parse error: ' + e.message;
          errDiv.style.display = 'block';
          loadBtn.disabled = true;
        }
      };
      // Walls: the shapefile set Walls exports from a compiled project
      // (walls.js). Sets with a UTM zone load straight away; one exported
      // without a .prj comes back as PLT text, so the usual step asks for
      // its zone.
      if (isWallsSelection(files)) {
        _loadWallsFiles(files).then(({ placed, needZone }) => {
          if (needZone) showText(needZone.plt, needZone.name + ' (Walls)');
          else if (placed) { overlay.style.display = 'none'; state.cwizParsed = null; }
          else throw new Error('no cave in the selection could be placed');
        }).catch(e => {
          errDiv.textContent = 'Walls import: ' + e.message;
          errDiv.style.display = 'block';
          loadBtn.disabled = true;
        });
        return;
      }
      const file = files[0];
      const reader = new FileReader();
      reader.onload = ev => showText(ev.target.result, file.name);
      reader.readAsText(file);
    };

    // ── Pick location buttons ────────────────────────────────────────────────
    function _fillAnchorCoords(result) {
      if (!result) return;
      document.getElementById('cwiz-anc-lat').value  = result.lat.toFixed(7);
      document.getElementById('cwiz-anc-lon').value  = result.lon.toFixed(7);
      document.getElementById('cwiz-anc-elev').value = result.elev.toFixed(1);
    }

    // Cesium globe pick
    document.getElementById('cwiz-pick-cesium').onclick = async () => {
      _fillAnchorCoords(await _startGlobePick('cesium'));
    };

    // Potree point cloud pick (placeholder — full impl when Potree pick API is wired)
    document.getElementById('cwiz-pick-potree').onclick = () => {
      // TODO: potreeViewer.scene pick → resolve with {lat, lon, elev}
      // Disabled visually for now
    };

    // Manual — just focus the lat field
    document.getElementById('cwiz-pick-manual').onclick = () => {
      document.getElementById('cwiz-anc-lat').focus();
    };

    // Auto-fetch magnetic declination from NOAA WMM proxy
    document.getElementById('cwiz-decl-fetch').onclick = async () => {
      const lat = parseFloat(document.getElementById('cwiz-anc-lat').value);
      const lon = parseFloat(document.getElementById('cwiz-anc-lon').value);
      const statusEl = document.getElementById('cwiz-decl-status');
      if (isNaN(lat) || isNaN(lon)) {
        statusEl.style.color = '#f88';
        statusEl.textContent = 'Enter lat/lon first';
        return;
      }
      statusEl.style.color = 'rgba(255,255,255,0.35)';
      statusEl.textContent = 'Fetching…';
      try {
        const year = new Date().getFullYear();
        const r = await fetch('/api/declination?lat=' + lat + '&lon=' + lon + '&year=' + year);
        const data = await r.json();
        if (data.declination != null) {
          document.getElementById('cwiz-decl-input').value = data.declination.toFixed(2);
          statusEl.style.color = '#8fa';
          statusEl.textContent = '✓ ' + data.declination.toFixed(2) + '° (' + data.year + ')';
        } else {
          statusEl.style.color = '#f88';
          statusEl.textContent = 'Error: ' + (data.error || 'unknown');
        }
      } catch(e) {
        statusEl.style.color = '#f88';
        statusEl.textContent = 'Fetch failed: ' + e.message;
      }
    };

    // Screen-center quick-fill
    document.getElementById('cwiz-pick-screen-center').onclick = async () => {
      const canvas = cesiumViewer.canvas;
      const center = new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2);
      const ray = cesiumViewer.camera.getPickRay(center);
      let cart = ray ? cesiumViewer.scene.globe.pick(ray, cesiumViewer.scene) : null;
      if (!cart) cart = cesiumViewer.camera.pickEllipsoid(center, cesiumViewer.scene.globe.ellipsoid);
      if (!cart) { alert('Could not determine globe position at screen center.'); return; }
      const carto = Cesium.Cartographic.fromCartesian(cart);
      const lat  = Cesium.Math.toDegrees(carto.latitude);
      const lon  = Cesium.Math.toDegrees(carto.longitude);
      const elev = carto.height ?? 0;
      document.getElementById('cwiz-anc-lat').value  = lat.toFixed(6);
      document.getElementById('cwiz-anc-lon').value  = lon.toFixed(6);
      document.getElementById('cwiz-anc-elev').value = elev.toFixed(1);
      // Auto-select __first__ anchor station if none chosen
      const sel = document.getElementById('cwiz-station-select');
      if (!sel.value) {
        // pick the first real option
        for (const opt of sel.options) { if (opt.value) { sel.value = opt.value; break; } }
      }
      // Switch to anchor radio if not already
      document.getElementById('cwiz-radio-anchor').checked = true;
      updateModeUI();
    };

    document.getElementById('cwiz-cancel').onclick = () => {
      overlay.style.display = 'none';
      state.cwizParsed = null;
    };

    loadBtn.onclick = () => {
      if (!state.cwizParsed) return;
      errDiv.style.display = 'none';
      const isAnchor = anchorRadio.checked;

      if (isAnchor) {
        const lat  = parseFloat(document.getElementById('cwiz-anc-lat').value);
        const lon  = parseFloat(document.getElementById('cwiz-anc-lon').value);
        const elev = parseFloat(document.getElementById('cwiz-anc-elev').value) || 0;
        if (isNaN(lat) || isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
          errDiv.textContent = 'Please enter valid latitude (−90 to 90) and longitude (−180 to 180), or click "Click on globe..."';
          errDiv.style.display = 'block';
          return;
        }
        const stationRaw = document.getElementById('cwiz-station-select').value;
        if (!stationRaw) {
          errDiv.textContent = 'Please select a survey station to anchor the survey.';
          errDiv.style.display = 'block';
          return;
        }
        // Station value is JSON {survey, name} to disambiguate duplicates across surveys
        let stationSurvey = '', stationName = stationRaw;
        try {
          const parsed2 = JSON.parse(stationRaw);
          stationSurvey = parsed2.survey || '';
          stationName   = parsed2.name   || stationRaw;
        } catch(_) { /* plain string fallback */ }
        overlay.style.display = 'none';
        const declVal  = parseFloat(document.getElementById('cwiz-decl-input')?.value);
        const declInput = isNaN(declVal) ? null : declVal;
        const entry = renderCaveSurveyAnchored(state.cwizParsed._fileName, state.cwizParsed, stationName, lat, lon, elev, stationSurvey, declInput);
        state.cwizParsed = null;
        _finishCaveLoad(entry);
      } else {
        // UTM mode
        let zone  = state.cwizParsed.utmZone;
        let south = state.cwizParsed.utmSouth;
        const forceManual = !document.getElementById('cwiz-radio-utm').checked || !zone;
        if (forceManual) {
          zone  = parseInt(document.getElementById('cwiz-zone-input').value, 10);
          south = document.getElementById('cwiz-hemi-input').value === 'S';
        }
        if (!zone || zone < 1 || zone > 60) {
          errDiv.textContent = 'Enter a valid UTM zone (1–60).';
          errDiv.style.display = 'block';
          return;
        }
        overlay.style.display = 'none';
        const entry = renderCaveSurveyUTM(state.cwizParsed._fileName, state.cwizParsed, zone, south);
        state.cwizParsed = null;
        _finishCaveLoad(entry);
      }
    };
  };

  // Load every cave in a Breakout JSON file. Each is converted to PLT
  // text (breakout.js), so it parses, renders, caches and reloads from recents
  // exactly like a .plt. Returns how many caves were placed.
  function _loadBreakoutText(text) {
    let data;
    try { data = JSON.parse(text); }
    catch (e) { throw new Error('not valid JSON (' + e.message + ')'); }
    if (!isBreakoutFile(data)) throw new Error('this JSON is not a Breakout file');
    let placed = 0;
    for (const c of breakoutToPlt(data)) {
      if (!c.zone) { console.warn('[breakout] no UTM zone for', c.name, '- skipped'); continue; }
      const parsed = parsePLT(c.plt);
      parsed._fileName = c.name;
      parsed._rawText  = c.plt;
      const entry = renderCaveSurveyUTM(c.name, parsed, c.zone, c.south);
      if (!entry) continue;
      _finishCaveLoad(entry);
      placed++;
      const st = c.stats;
      console.log(`[breakout] "${c.name}": ${st.trips} trips, ${st.shots} shots, ${st.stations} stations, ` +
                  `${st.leads} leads` + (st.unplaced ? `, ${st.unplaced} stations not connected (left out)` : ''));
    }
    return placed;
  }

  // Load every Walls shapefile set in the selection (walls.js): one cave per
  // set, placed from its UTM coordinates and kept as PLT text so it renders,
  // caches and reloads from recents like a .plt. A set with no zone (exported
  // without a .prj) is handed back for the wizard to ask about.
  async function _loadWallsFiles(files) {
    const sets = await readWallsShapefileSets(files);
    let placed = 0, needZone = null;
    for (const set of sets) {
      const c = wallsToPlt(set, window.proj4);
      c.warnings.forEach(w => console.warn('[walls]', `"${c.name}":`, w));
      if (!c.zone) { needZone = needZone || c; continue; }
      const parsed = parsePLT(c.plt);
      parsed._fileName = c.name;
      parsed._rawText  = c.plt;
      const entry = renderCaveSurveyUTM(c.name, parsed, c.zone, c.south);
      if (!entry) continue;
      _finishCaveLoad(entry);
      placed++;
      const st = c.stats;
      console.log(`[walls] "${c.name}": ${st.surveys} survey files, ${st.shots} shots, ${st.stations} stations, ` +
                  `${st.notes} notes, ${st.leads} leads, LRUD in ${st.units}, ${st.datum}` +
                  (st.skipped ? `, ${st.skipped} vectors left out` : ''));
    }
    return { placed, needZone };
  }

  function _finishCaveLoad(entry, { recent = true } = {}) {
    if (!entry) return;
    if (window._pjLabels) window._pjLabels.loaded(entry.name);    // a project cave's older area labels move into the project
    _caveColourChanged();
    const chk = document.getElementById('lp-cave-toggle');
    if (chk && !chk.checked) { chk.checked = true; notifyCaveVisibilityChanged(true); }
    // Loading a cave leaves the camera where it is; the ⌖ button in the cave
    // list flies to it on demand.
    // Persist to PLT recents (raw text stored in parsed._rawText)
    if (recent && entry.parsed && entry.parsed._rawText) {
      _addPltRecent(entry.name, entry.parsed?._rawText || '', entry.georef || null, entry.displayOptions || null);
    }
  }

  // Save displayOptions changes to recent
  function _displayUpdateRecent(imp) {
    if (imp && imp.parsed && imp.parsed._rawText && imp.georef) {
      _addPltRecent(imp.name, imp.parsed._rawText, imp.georef, imp.displayOptions);
    }
  }


  return {
    addPltRecent: _addPltRecent, fetchPltCache: _fetchPltCache, finishCaveLoad: _finishCaveLoad,
    placeCave: _placeCave, initPltRestoreInput: _initPltRestoreInput, loadRecents: _loadRecents,
    removePltRecent: _removePltRecent, startGlobePick: _startGlobePick, displayUpdateRecent: _displayUpdateRecent,
    renderCaveSurveyAnchored, renderCaveSurveyUTM, renderCaveSurvey,
  };
}
