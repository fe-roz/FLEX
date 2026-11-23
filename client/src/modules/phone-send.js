// phone-send.js — "Send to phone": a finished export to FLEX Field on the phone plugged into this PC by USB
// (phone_api.js on the server; adb does the copying). window._phone.
//
// In the Export panel, under the download button: what the phone says (not plugged in, asking to allow this PC,
// ready with its name), the exports that can be sent (the one just made first, and earlier ones still on this PC),
// and the button. A finished export in the Jobs strip has the same button. Sending is a job (phone.<id>) in the
// Jobs strip with Cancel; the line under the button says where the map ended up on the phone.
//
//   _phone.refresh(preferId)   ask the server again (status + exports); preferId = the export to preselect
//   _phone.send(exportId)      send that export (or the selected one) to the ready phone
//   _phone.state()             { status, exports, sending, last } (tests)
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const S = { status: null, exports: [], sending: null, last: null, prefer: null, serial: null, timer: null };
  const api = async (p, opt) => { const r = await fetch('/api/phone/' + p, opt); return r.json(); };
  const mb = n => (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB';
  const when = t => { const d = new Date(t), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };

  function statusText(s) {
    if (!s) return ['Looking for a phone…', ''];
    if (s.state === 'ready') return [`${s.model}${s.android ? ' (Android ' + s.android + ')' : ''} is plugged in` + (s.app && s.app.installed ? `, FLEX Field ${s.app.version || ''}`.trimEnd() + '.' : '.'),
      s.app && s.app.installed ? '' : 'FLEX Field is not installed on it: the zip will go to the phone\'s Download folder.'];
    if (s.state === 'choose') return ['More than one phone is plugged in: choose one.', ''];
    if (s.state === 'unauthorized') return ['The phone is asking to allow this computer.', s.hint || ''];
    if (s.state === 'no-adb') return ['adb was not found on this computer.', 'It comes with the Android SDK (platform-tools), the one FLEX Field is built with. Set FLEX_ADB to its path if it is somewhere unusual, then restart FLEX.'];
    return ['No phone found.', s.hint || 'Plug it in by USB, unlock it, and switch USB debugging on.'];
  }
  function paint() {
    const box = $('phone_box'); if (!box) return;
    const s = S.status, [line, hint] = statusText(s);
    $('phone_status').textContent = line; $('phone_status').dataset.state = s ? s.state : 'loading';
    $('phone_hint').textContent = hint; $('phone_hint').style.display = hint ? 'block' : 'none';
    const dev = $('phone_device'), many = s && (s.devices || []).filter(d => d.state === 'device');
    dev.style.display = many && many.length > 1 ? '' : 'none';
    if (many && many.length > 1) {
      const cur = S.serial || (s.state === 'ready' ? s.serial : '');
      dev.textContent = '';
      dev.add(new Option('Choose a phone…', ''));
      many.forEach(d => dev.add(new Option((d.model || 'Phone') + ' · ' + d.serial, d.serial)));
      dev.value = cur || '';
    }
    const sel = $('phone_export'), keep = S.prefer || sel.value;
    sel.textContent = '';
    if (!S.exports.length) sel.add(new Option('No finished export on this computer yet', ''));
    S.exports.forEach(e => sel.add(new Option(`${e.name} · ${mb(e.bytes)}${e.kind === 'update' && e.full_bytes ? ' (full map ' + mb(e.full_bytes) + ')' : ''} · ${when(e.time)}`, e.id)));      // an update package: only what changed
    if (keep && S.exports.some(e => e.id === keep)) sel.value = keep;
    sel.disabled = !S.exports.length;
    const btn = $('phone_send');
    btn.disabled = !(s && s.state === 'ready' && S.exports.length && !S.sending);
    btn.title = btn.disabled ? (S.sending ? 'A map is being sent' : !S.exports.length ? 'Export a map first' : line) : 'Copy the chosen export to the phone over the USB cable';
    const msg = $('phone_msg');
    const m = S.sending ? S.sending.message : S.last ? S.last.message : '';
    msg.textContent = m || ''; msg.style.display = m ? 'block' : 'none';
    msg.dataset.kind = S.sending ? 'running' : S.last ? S.last.kind : '';
  }
  async function refresh(prefer) {
    if (prefer) S.prefer = prefer;
    try {
      const [st, ex] = await Promise.all([api('status' + (S.serial ? '?serial=' + encodeURIComponent(S.serial) : '')), api('exports')]);
      S.status = st; S.exports = (ex && ex.exports) || [];
    } catch (e) { S.status = { state: 'no-device', hint: 'The FLEX server did not answer.' }; }
    paint();
    return S.status;
  }
  async function send(exportId) {
    const id = exportId || ($('phone_export') && $('phone_export').value);
    if (!id || S.sending) return null;
    const st = await refresh(id);
    if (!st || st.state !== 'ready') { S.last = { kind: 'bad', message: statusText(st).filter(Boolean).join(' ') }; paint(); openBox(); return null; }
    S.last = null; S.sending = { id: null, message: 'Starting…' }; paint();
    let r;
    try { r = await api('send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ export: id, serial: st.serial }) }); }
    catch (e) { r = { ok: false, error: 'The FLEX server did not answer.' }; }
    if (!r || !r.ok) { S.sending = null; S.last = { kind: 'bad', message: (r && r.error) || 'It could not be sent.' }; paint(); return null; }
    S.sending = { id: r.jobId, message: 'Sending…' };
    const exp = S.exports.find(e => e.id === id);
    if (window._jobs && window._jobs.add) window._jobs.add({ id: 'phone.' + r.jobId, kind: 'phone', name: 'To phone: ' + (exp ? exp.name : 'map'), server: true });
    paint();
    return new Promise(resolve => {
      const tick = async () => {
        let j; try { j = await api('job/' + r.jobId); } catch (_) { j = null; }
        if (j && j.ok && j.status === 'running') { S.sending.message = (j.message || 'Sending…') + (j.pct ? ` (${j.pct} %)` : ''); paint(); S.timer = setTimeout(tick, 700); return; }
        S.sending = null;
        if (j && j.ok && j.status === 'done') S.last = { kind: j.how === 'download' ? 'warn' : 'good', how: j.how, message: (j.result && j.result.message) || 'Sent.' };
        else S.last = { kind: 'bad', message: j && j.error === 'Cancelled' ? 'Cancelled: nothing was left on the phone.' : (j && j.error) || 'It could not be sent.' };
        paint(); resolve(S.last);
      };
      S.timer = setTimeout(tick, 400);
    });
  }
  // Show the box (the Export panel) when a send is started from the Jobs strip and something needs saying.
  function openBox() { const b = $('phone_box'); if (b && b.scrollIntoView) try { b.scrollIntoView({ block: 'nearest' }); } catch (_) {} }

  function start() {
    if (!$('phone_box')) return;
    $('phone_send').addEventListener('click', () => { send(); });
    $('phone_refresh').addEventListener('click', () => { refresh(); });
    $('phone_device').addEventListener('change', e => { S.serial = e.target.value || null; refresh(); });
    $('phone_export').addEventListener('change', e => { S.prefer = e.target.value || null; });
    const panel = $('exportCollapsible');
    if (panel) new MutationObserver(() => { if (panel.classList.contains('show')) refresh(); }).observe(panel, { attributes: true, attributeFilter: ['class'] });
    paint();
  }
  window._phone = { refresh, send, state: () => ({ status: S.status, exports: S.exports, sending: S.sending, last: S.last }) };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
