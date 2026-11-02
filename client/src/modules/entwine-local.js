// Local Entwine server integration: the "Link Entwine" / "Enable Entwine" /
// "Entwine Datasets" button, the link dialog, the dataset picker and the server
// start. Moved out of flex.js unchanged (the flex.js split, wave 2; see
// client/src/README.md for the pattern).
//
// Setup:
//   setupEntwineLocal({ ic }) -> { loadEntwineConfig }
// flex.js calls loadEntwineConfig() at the old place (restores the linked state).
// window._entwineBtn / _entwineLink / _entwineConfirmLink / _entwineEnable /
// _entwineOpen / _entwineStartServer / _entwineLoad / _entwineUnlink are
// defined here (index.html's buttons and the picker's inline onclicks).
// Loading a dataset goes through window.addPC.

export function setupEntwineLocal({ ic: _ic } = {}) {
  let _entwineConfig = null;  // null = not linked; { path, url, enabled } = linked

  async function _loadEntwineConfig() {
    try {
      const r = await fetch('/api/entwine/config');
      const data = await r.json();
      _entwineConfig = data.linked === false ? null : data;
    } catch(e) {
      _entwineConfig = null;
    }
    _renderEntwineBtn();
  }

  function _renderEntwineBtn() {
    const btn = document.getElementById('entwine-btn');
    if (!btn) return;
    if (!_entwineConfig) {
      btn.innerHTML = _ic('server') + 'Link Entwine';
      btn.style.background = 'rgba(80,180,120,0.1)';
      btn.style.borderColor = 'rgba(80,180,120,0.3)';
      btn.style.color = '#8ecfa8';
      btn.title = 'Link your local Entwine server';
    } else if (!_entwineConfig.enabled) {
      btn.textContent = '▶ Enable Entwine';
      btn.style.background = 'rgba(255,200,80,0.1)';
      btn.style.borderColor = 'rgba(255,200,80,0.3)';
      btn.style.color = '#f5c842';
      btn.title = 'Enable local Entwine server (' + _entwineConfig.url + ')';
    } else {
      btn.innerHTML = _ic('folder-open') + 'Entwine Datasets';
      btn.style.background = 'rgba(80,180,120,0.2)';
      btn.style.borderColor = 'rgba(80,180,120,0.45)';
      btn.style.color = '#6ee08a';
      btn.title = 'Browse local EPT datasets';
    }
  }

  window._entwineBtn = function() {
    if (!_entwineConfig) {
      window._entwineLink();
    } else if (!_entwineConfig.enabled) {
      window._entwineEnable();
    } else {
      window._entwineOpen();
    }
  };

  window._entwineLink = function() {
    const pathInp = document.getElementById('entwine-path-input');
    const urlInp  = document.getElementById('entwine-url-input');
    const errDiv  = document.getElementById('entwine-link-error');
    const exeInp  = document.getElementById('entwine-exe-input');
    if (pathInp) pathInp.value = (_entwineConfig && _entwineConfig.path) || '~/entwine';
    if (urlInp)  urlInp.value  = (_entwineConfig && _entwineConfig.url)  || 'http://localhost:8083';
    if (exeInp)  exeInp.value  = (_entwineConfig && _entwineConfig.exe)  || '';
    if (errDiv)  errDiv.style.display = 'none';
    const ov = document.getElementById('entwine-link-overlay');
    if (ov) ov.style.display = 'flex';
  };

  window._entwineConfirmLink = async function() {
    const pathVal = (document.getElementById('entwine-path-input')?.value || '').trim();
    const urlVal  = (document.getElementById('entwine-url-input')?.value  || '').trim();
    const exeVal  = (document.getElementById('entwine-exe-input')?.value   || '').trim();
    const errDiv  = document.getElementById('entwine-link-error');
    if (!pathVal || !urlVal) {
      if (errDiv) { errDiv.textContent = 'Both fields are required.'; errDiv.style.display = 'block'; }
      return;
    }
    const cfg = { path: pathVal, url: urlVal.replace(/\/$/, ''), enabled: true };
    if (exeVal) cfg.exe = exeVal;
    try {
      const r = await fetch('/api/entwine/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) });
      const data = await r.json();
      if (!data.ok) throw new Error(data.error || 'Save failed');
      _entwineConfig = cfg;
      document.getElementById('entwine-link-overlay').style.display = 'none';
      _renderEntwineBtn();
      // Auto-open picker after linking
      window._entwineOpen();
    } catch(e) {
      if (errDiv) { errDiv.textContent = e.message; errDiv.style.display = 'block'; }
    }
  };

  window._entwineEnable = async function() {
    if (!_entwineConfig) return;
    _entwineConfig.enabled = true;
    try {
      await fetch('/api/entwine/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(_entwineConfig) });
    } catch(e) { /* non-fatal */ }
    _renderEntwineBtn();
  };

  window._entwineOpen = async function() {
    const ov   = document.getElementById('entwine-picker-overlay');
    const list = document.getElementById('entwine-picker-list');
    const urlEl = document.getElementById('entwine-picker-url');
    if (!ov || !list) return;
    if (urlEl) urlEl.textContent = _entwineConfig?.url || '';
    list.innerHTML = '<div style="color:rgba(255,255,255,0.35);font-size:11px;padding:8px 0;">Checking server…</div>';
    ov.style.display = 'flex';
    try {
      const statusR = await fetch('/api/entwine/status');
      const status = await statusR.json();
      if (!status.running) {
        list.innerHTML = `<div style="text-align:center;padding:16px 0;">
          <div style="color:rgba(255,255,255,0.45);font-size:11px;margin-bottom:12px;">Entwine server is not running</div>
          <button id="entwine-start-btn" onclick="window._entwineStartServer()"
            style="padding:5px 18px;background:rgba(80,180,120,0.2);border:1px solid rgba(80,180,120,0.5);border-radius:4px;color:#8ecfa8;cursor:pointer;font-size:12px;">▶ Start Server</button>
        </div>`;
        return;
      }
      const r = await fetch('/api/entwine/datasets');
      const data = await r.json();
      if (!data.ok) throw new Error(data.error || 'Failed to list datasets');
      if (!data.datasets.length) {
        list.innerHTML = '<div style="color:rgba(255,255,255,0.35);font-size:11px;padding:8px 0;">No datasets found in ' + (_entwineConfig?.path || '') + '.<br>Make sure each dataset has an ept.json file.</div>';
        return;
      }
      list.innerHTML = data.datasets.map(d => `
        <div style="display:flex;align-items:center;justify-content:space-between;padding:6px 4px;border-bottom:1px solid rgba(255,255,255,0.06);">
          <span style="font-size:12px;color:#ddd;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${d.url}">${d.name}</span>
          <button onclick="window._entwineLoad('${d.url.replace(/'/g,"\'")}','${d.name.replace(/'/g,"\'")}')""
            style="margin-left:8px;flex-shrink:0;padding:3px 10px;background:rgba(80,180,120,0.2);border:1px solid rgba(80,180,120,0.4);border-radius:3px;color:#8ecfa8;cursor:pointer;font-size:11px;">Load</button>
        </div>`).join('');
    } catch(e) {
      list.innerHTML = '<div style="color:#f88;font-size:11px;padding:8px 0;">Error: ' + e.message + '</div>';
    }
  };

  window._entwineStartServer = async function() {
    const btn = document.getElementById('entwine-start-btn');
    const list = document.getElementById('entwine-picker-list');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Starting…'; }
    try {
      const r = await fetch('/api/entwine/start', { method: 'POST' });
      const data = await r.json();
      if (!data.ok) throw new Error(data.error || 'Failed to start');
      let ready = false;
      for (let i = 0; i < 20; i++) {
        await new Promise(res => setTimeout(res, 500));
        try {
          const s = await fetch('/api/entwine/status');
          const st = await s.json();
          if (st.running) { ready = true; break; }
        } catch(e) {}
        if (btn) btn.textContent = '⏳ Starting' + '.'.repeat((i % 3) + 1);
      }
      if (ready) {
        window._entwineOpen();
      } else {
        // Show server log so user can debug
        let logHtml = '';
        try {
          const ls = await fetch('/api/entwine/status');
          const lst = await ls.json();
          if (lst.log && lst.log.length) logHtml = '<pre style="font-size:10px;color:#aaa;margin-top:8px;white-space:pre-wrap;word-break:break-all;">' + lst.log.join('\n') + '</pre>';
        } catch(e) {}
        if (list) list.innerHTML = '<div style="color:#f88;font-size:11px;padding:8px 0;">Server started but not responding. Check entwine is in your PATH.' + logHtml + '</div>';
      }
    } catch(e) {
      if (list) list.innerHTML = '<div style="color:#f88;font-size:11px;padding:8px 0;">Error: ' + e.message + '</div>';
    }
  };

  window._entwineLoad = function(url, name) {
    document.getElementById('entwine-picker-overlay').style.display = 'none';
    const statusEl = document.getElementById('lp-pc-status');
    if (statusEl) { statusEl.textContent = '⏳ Loading ' + name + '…'; statusEl.style.color = '#aaa'; }
    try {
      const eptUrl = url.endsWith('/ept.json') ? url : url.replace(/\/+$/, '') + '/ept.json';
      window.addPC(eptUrl);
    } catch(e) {
      if (statusEl) { statusEl.textContent = '✗ ' + (e.message || e); statusEl.style.color = '#f77'; }
    }
  };

  window._entwineUnlink = async function() {
    if (!confirm('Unlink local Entwine server?')) return;
    try {
      await fetch('/api/entwine/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ linked: false }) });
    } catch(e) { /* non-fatal */ }
    _entwineConfig = null;
    document.getElementById('entwine-picker-overlay').style.display = 'none';
    _renderEntwineBtn();
  };

  return { loadEntwineConfig: _loadEntwineConfig };
}
