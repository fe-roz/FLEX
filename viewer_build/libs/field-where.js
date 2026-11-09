/* FLEX Field: where a field survey is.
 *
 *  - The declination line: "Declination 10.3° E (WMM 2026 at T6)", with the number's source, an override
 *    you can type ("12 W", "10.3"), and a way back to the model's value. The World Magnetic Model runs in
 *    the page (no network): at the tie-in station, for the survey's date.
 *  - 📍 Use my location: one GPS fix from the phone (navigator.geolocation; FLEX Field grants it and it
 *    needs no network). It is kept on the survey and is where the model is worked out for a survey with no
 *    known tie-in, and the source is shown.
 *  - A survey tied to no station the map knows can have its first station placed at that fix (approximate,
 *    flagged), so its shots can be drawn; and a survey can start at the phone's position from the survey list.
 *
 * Survey fields (the project log, shared with FLEX; readers that don't know them ignore them):
 *   gps       { lat, lon, alt, acc, t }  the last fix taken for the survey
 *   gpsStart  true                       the first station (survey.tie) is placed at gps, approximate
 *   decl      number | null              declination entered (degrees east); null = the model's value
 *
 * Loaded by viewer.html before its own script. What it calls from the page (ffRecord, el, ffDialog, showToast,
 * ffUid, …) is looked up when it runs.
 */
(function () {
  'use strict';
  const FL = window.FlexLib;

  const css = document.createElement('style');
  css.textContent = `
    .ff-where { display: flex; flex-direction: column; gap: 6px; border: 1px solid rgba(255,255,255,.12); border-radius: 8px; padding: 6px 8px; }
    .ff-decl-line { font-size: 13px; line-height: 1.35; }
    .ff-decl-line b { font-size: 14px; color: #e8f7ff; }
    .ff-decl-src { opacity: .65; font-size: 12px; }
    .ff-where .ff-set-l { width: 62px; }
    .ff-where-gps { font-size: 11px; opacity: .65; }
    .ff-where-warn { font-size: 12px; padding: 5px 7px; border-radius: 6px; background: rgba(255,143,0,.15); color: #ffc266; display: flex; flex-direction: column; gap: 5px; }
    .ff-where-ok { font-size: 12px; padding: 5px 7px; border-radius: 6px; background: rgba(255,200,60,.12); color: #ffe08a; }
    .ff-where .fp-btn { font-size: 12px; padding: 6px 9px; }
  `;
  document.head.appendChild(css);

  const fmtAcc = g => (g && g.acc != null && isFinite(g.acc) ? ' (±' + Math.max(1, Math.round(g.acc)) + ' m)' : '');
  const fmtLL = g => g.lat.toFixed(5) + ', ' + g.lon.toFixed(5);

  // One GPS fix from the phone, no network: { lat, lon, alt, acc, t }; rejects with Error(what to tell the person).
  function fix(opts) {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error('This device has no location service.'));
      if (window.isSecureContext === false) return reject(new Error('Location needs the FLEX Field app, https or localhost, not a file.'));
      navigator.geolocation.getCurrentPosition(p => {
        const c = (p && p.coords) || {};
        if (!isFinite(c.latitude) || !isFinite(c.longitude)) return reject(new Error('The phone gave no position.'));
        resolve({
          lat: +c.latitude.toFixed(6), lon: +c.longitude.toFixed(6),
          alt: c.altitude != null && isFinite(c.altitude) ? +c.altitude.toFixed(1) : null,
          acc: c.accuracy != null && isFinite(c.accuracy) ? +c.accuracy.toFixed(1) : null,
          t: new Date((p && p.timestamp) || Date.now()).toISOString(),
        });
      }, e => reject(new Error(e && e.code === 1 ? 'Location is off for this app: allow it in the phone’s settings.'
        : e && e.code === 3 ? 'No GPS fix yet (it timed out). Step outside, or wait a moment, and try again.'
        : 'No GPS fix yet. Step outside, or wait a moment, and try again.')),
      Object.assign({ enableHighAccuracy: true, timeout: 25000, maximumAge: 30000 }, opts || {}));
    });
  }
  async function fixOrToast() {
    showToast('Getting your location…');
    try { return await fix(); } catch (e) { showToast(e.message); return null; }
  }

  // "WMM 2026 at T6" / "entered; WMM would give 10.3° E at T6" — where the number on the line comes from.
  function sourceText(d) {
    if (d.src === 'entered') return ' (entered' + (d.wmm != null ? '; WMM would give ' + FL.fmtDecl(d.wmm) + ' at ' + d.at : '') + ')';
    if (/^WMM/.test(d.src)) return ' (' + d.src + ' at ' + d.at + ')';
    return ' (' + d.src + ')';
  }

  // The block shown at the top of a survey: the declination line, its override, the GPS fix, and what to do
  // when the survey is tied to no station of the map.
  function block(sv, info) {
    info = info || {};
    const d = info.decl || { v: 0, src: '', at: '' };
    const box = el('div', 'ff-where'); box.id = 'ff-where';
    const line = el('div', 'ff-decl-line'); line.id = 'ff-decl-line';
    line.appendChild(el('b', null, 'Declination ' + FL.fmtDecl(d.v)));
    line.appendChild(el('span', 'ff-decl-src', sourceText(d)));
    box.appendChild(line);

    // Override: what was entered, or blank for the model's value.
    const entered = sv.decl != null && sv.decl !== '' && isFinite(Number(sv.decl));
    const row = el('div', 'ff-set'); row.appendChild(el('span', 'ff-set-l', 'Override'));
    const inp = el('input', 'ff-input ff-small'); inp.id = 'ff-decl-input';
    inp.type = 'text'; inp.inputMode = 'decimal'; inp.autocomplete = 'off'; inp.spellcheck = false;
    inp.placeholder = FL.fmtDecl(d.wmm != null ? d.wmm : d.v);
    inp.value = entered ? FL.fmtDecl(Number(sv.decl)) : '';
    inp.addEventListener('change', () => {
      const t = inp.value.trim(), v = t === '' ? null : FL.parseDecl(t);
      if (t !== '' && v === null) { showToast('Declination: a number, east + / west −, like 10.3 or 12 W'); inp.value = entered ? FL.fmtDecl(Number(sv.decl)) : ''; return; }
      if ((v === null && !entered) || (entered && v === Number(sv.decl))) return;
      ffRecord('survey.set', { sid: sv.id, patch: { decl: v }, prev: { decl: sv.decl == null ? null : sv.decl } });
    });
    row.appendChild(inp);
    if (entered) {
      const rb = el('button', 'fp-btn', 'Use WMM'); rb.id = 'ff-decl-reset'; rb.title = 'Go back to the World Magnetic Model’s value';
      rb.addEventListener('click', () => ffRecord('survey.set', { sid: sv.id, patch: { decl: null }, prev: { decl: sv.decl } }));
      row.appendChild(rb);
    } else row.appendChild(el('span', 'fp-note', 'east +, west − (10.3, 12 W)'));
    box.appendChild(row);

    // The phone's location, and the survey on the map.
    const placed = !!(sv.gpsStart && sv.gps), tied = !!info.tied && !placed;
    const gr = el('div', 'ff-set');
    const gb = el('button', 'fp-btn', placed ? '📍 Use my location again' : '📍 Use my location'); gb.id = 'ff-use-loc';
    gb.title = 'One GPS fix from this phone; no network needed';
    gb.addEventListener('click', () => (placed ? placeHere(sv, true) : useLocation(sv, info)));
    gr.appendChild(gb);
    const sm = el('button', 'fp-btn', '🗺 Show on map'); sm.id = 'ff-show-map'; sm.title = 'Close this panel and go to the survey';
    sm.addEventListener('click', () => ffShowOnMap(sv));
    gr.appendChild(sm);
    box.appendChild(gr);
    if (sv.gps) box.appendChild(el('div', 'ff-where-gps', 'Last fix ' + fmtLL(sv.gps) + fmtAcc(sv.gps) + ' · ' + ffWhen(sv.gps.t)));

    const tie = String(sv.tie || '').trim();
    if (placed) {
      const w = el('div', 'ff-where-ok'); w.id = 'ff-where-note';
      w.textContent = '≈ ' + tie + ' is placed at your GPS fix' + fmtAcc(sv.gps) + ': approximate, not a surveyed station. Its shots are drawn from there.';
      box.appendChild(w);
    } else if (!tied) {
      const w = el('div', 'ff-where-warn'); w.id = 'ff-where-note';
      w.appendChild(el('div', null, '“' + tie + '” is not a station on this map, so these shots can’t be drawn yet.'));
      const pb = el('button', 'fp-btn', '📍 Place ' + tie + ' at my location (approximate)'); pb.id = 'ff-place-here';
      pb.addEventListener('click', () => placeHere(sv, false));
      w.appendChild(pb);
      box.appendChild(w);
    }
    return box;
  }

  // 📍 Use my location: keep the fix on the survey. It is where the model is worked out when the survey has
  // no tie-in on the map; for a tied survey the declination stays where its tie-in is.
  async function useLocation(sv, info) {
    await ffEnsureAuthor();
    const g = await fixOrToast();
    if (!g) return;
    ffRecord('survey.set', { sid: sv.id, patch: { gps: g }, prev: { gps: sv.gps || null } });
    const now = ffState.surveys[sv.id], d = (ffBuiltInfo[sv.id] || {}).decl;
    if (info && info.tied) showToast('Location kept' + fmtAcc(g) + '. The declination is worked out at ' + String(sv.tie).trim() + ', which the map knows.');
    else if (now && d) showToast('Declination ' + FL.fmtDecl(d.v) + ' (' + d.src + ' at ' + d.at + ')');
  }

  // Put the survey's first station (survey.tie) at a GPS fix: approximate, and flagged as such.
  async function placeHere(sv, again) {
    await ffEnsureAuthor();
    const g = await fixOrToast();
    if (!g) return;
    const tie = String(sv.tie || '').trim();
    const r = await ffDialog({
      title: again ? 'Move ' + tie + ' to where you are?' : 'Place ' + tie + ' here?',
      html: 'Your GPS position is <b>' + fmtLL(g) + '</b>' + fmtAcc(g) + '.<br>The survey’s first station <b>' + tie + '</b> will stand there and its shots are drawn from it. ' +
        'That is <b>approximate</b> and marked so; it is not tied to a surveyed station.',
      buttons: [{ label: 'Cancel', value: null }, { label: again ? 'Move ' + tie : 'Place ' + tie + ' here', value: 'ok', primary: true }] });
    if (!r) return;
    ffRecord('survey.set', { sid: sv.id, patch: { gps: g, gpsStart: true }, prev: { gps: sv.gps || null, gpsStart: !!sv.gpsStart } });
    showToast(tie + ' placed at your location (approximate)');
  }

  // A new survey that starts at the phone's position (no station of the map to tie it to).
  async function startHere() {
    await ffEnsureAuthor();
    const names = el('div', 'ff-where');
    const n = ffState.order.length + 1;
    const nameIn = el('input', 'ff-input'); nameIn.placeholder = 'Survey name'; nameIn.value = 'Field ' + n + ' ' + new Date().toLocaleDateString(); nameIn.id = 'ff-start-name';
    const stIn = el('input', 'ff-input'); stIn.placeholder = 'First station'; stIn.value = 'S1'; stIn.id = 'ff-start-station';
    stIn.autocomplete = 'off'; stIn.spellcheck = false;
    names.appendChild(el('span', 'fp-note', 'Survey name')); names.appendChild(nameIn);
    names.appendChild(el('span', 'fp-note', 'First station (a new name)')); names.appendChild(stIn);
    const r = await ffDialog({
      title: 'New field survey at my location',
      html: 'It is tied to no station of the map: its first station is placed at your GPS position, which is <b>approximate</b> and marked so. ' +
        'Declination is worked out there. The survey stays in the change log; tie it to a real station later by starting again from that station.',
      body: names,
      buttons: [{ label: 'Cancel', value: null }, { label: 'Get my location and start', value: 'ok', primary: true }] });
    if (!r) return;
    const name = nameIn.value.trim().slice(0, 60), first = stIn.value.trim();
    if (!name || !first) { showToast('Give the survey a name and its first station a name'); return; }
    const taken = ffNameWhere({ cave: '', tie: first }, first);
    if (taken) { showToast('“' + first + '” is already a station here: give the first station a new name'); return; }
    const g = await fixOrToast();
    if (!g) return;
    const id = ffUid(), d = new Date();
    ffRecord('survey.add', { survey: { id, name, cave: '', tie: first, lenUnit: 'ft', lrudAt: 'from', decl: null, gps: g, gpsStart: true,
      date: d.toISOString().slice(0, 10), created: d.toISOString(), shots: [] } });
    ffOpenPanel(id);
    showToast(first + ' placed at your location (approximate)');
  }

  window.FieldWhere = { fix, block, useLocation, placeHere, startHere, sourceText };
})();
