// FLEX project (state, constants, el / btn / when / toast, the dialogs).
// Part of project.js, split into classic scripts that load in order (index.html);
// they share their functions through window._pjParts until project.js has loaded.
// Behaviour unchanged. See client/src/README.md.
(function () {
  'use strict';
  const FL = window.FlexLib;
  if (!FL) { console.warn('[project] flexlib.js missing'); return; }
  const X = window._pjParts = { FL };       // shared by the project*.js parts while they load; project.js removes it
  // defined in a later part: called only after every part has loaded
  const api = (...a) => X.api(...a);

  // (constants and state)
  const API = '/api/lib/';
  const PAGE_PX = 2400;
  const FIELD_COLOR = '#ff9f1c';
  const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';

  // ── State ──────────────────────────────────────────────────────────────────
  const pj = {
    dev: null, pid: null, P: FL.replayProject([], ''), D: FL.replayDocs([]),
    proj: [], docs: [], projects: [], ready: false,
    leadShow: 'active', docTab: 'inbox', card: null, gallery: null,
    at: null, mode: null, readonly: false,           // at: a snapshot's date (project open read-only as it was); mode: 'snapshot' | 'archived' | null
  };
  window._pj = pj;                               // for the console and tests
  const $ = id => document.getElementById(id);
  const esc = t => String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // text: a string, or ['icon', 'text'] for a line icon in front (icons.js iconLabel).
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) window.iconLabel(e, text); return e; }
  function btn(label, fn, cls) { const b = el('button', 'pj-btn' + (cls ? ' ' + cls : ''), label); b.type = 'button'; b.addEventListener('click', e => { e.stopPropagation(); fn(e); }); return b; }
  function when(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' }) + ' ' +
           d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }
  function fnv(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, '0');
  }
  function toast(msg) {
    let t = $('pj-toast');
    if (!t) { t = el('div'); t.id = 'pj-toast'; document.body.appendChild(t); }
    t.textContent = msg; t.classList.add('on');
    clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('on'), 2600);
  }


  // ── Dialogs ────────────────────────────────────────────────────────────────
  function dialog({ title, text, html, body, input, textarea, buttons, wide }) {
    return new Promise(resolve => {
      const wrap = el('div', 'pj-modal');
      const box = el('div', 'pj-modal-box' + (wide ? ' wide' : ''));
      if (title) box.appendChild(el('div', 'pj-modal-title', title));
      if (text) box.appendChild(el('div', 'pj-modal-text', text));
      if (html) { const d = el('div', 'pj-modal-text'); d.innerHTML = html; box.appendChild(d); }
      if (body) box.appendChild(body);
      let field = null;
      if (input || textarea) {
        const o = input || textarea;
        field = el(textarea ? 'textarea' : 'input', 'pj-input');
        field.value = o.value || ''; field.placeholder = o.placeholder || '';
        if (textarea) field.rows = 6;
        box.appendChild(field);
      }
      const row = el('div', 'pj-modal-btns');
      const done = v => { wrap.remove(); document.removeEventListener('keydown', key, true); resolve(v); };
      (buttons || [{ label: 'OK', value: 'ok', primary: true }]).forEach(bt => {
        row.appendChild(btn(bt.label, () => done(bt.value === null ? null : { button: bt.value, value: field ? field.value : '', box }),
          (bt.primary ? 'primary' : '') + (bt.danger ? ' danger' : '')));
      });
      box.appendChild(row);
      wrap.appendChild(box);
      wrap.addEventListener('mousedown', e => { if (e.target === wrap) done(null); });
      const key = e => {
        if (e.key === 'Escape') { e.stopPropagation(); done(null); }
        if (e.key === 'Enter' && field && !textarea && document.activeElement === field) { e.preventDefault(); const p = (buttons || []).find(b => b.primary); done(p ? { button: p.value, value: field.value, box } : null); }
      };
      document.addEventListener('keydown', key, true);
      document.body.appendChild(wrap);
      if (field) setTimeout(() => field.focus(), 30);
    });
  }
  async function choose(title, text, options, cancel = 'Cancel') {
    return new Promise(resolve => {
      const body = el('div', 'pj-choices');
      let picked = false;
      options.forEach(o => {
        const b = btn(o.label, () => { picked = true; b.closest('.pj-modal').remove(); resolve(o.value); }, o.primary ? 'primary' : '');
        if (o.sub) b.appendChild(el('div', 'pj-sub', o.sub));
        body.appendChild(b);
      });
      dialog({ title, text, body, buttons: [{ label: cancel, value: null }] }).then(() => { if (!picked) resolve(null); });
    });
  }


  Object.assign(X, {
    API, PAGE_PX, FIELD_COLOR, PDFJS, pj, $, esc, el, btn, when, fnv, toast, dialog, choose,
  });
})();
