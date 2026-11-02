// Update checker: the "Check for updates" button (window._checkForUpdates).
// Moved out of flex.js unchanged (flex.js split, wave 2; see client/src/README.md).
//
// Setup: setupUpdateChecker() -> { checkForUpdates }

export function setupUpdateChecker() {
  window._checkForUpdates = async function () {
    const btn       = document.getElementById('update_check_btn');
    const indicator = document.getElementById('update_status_indicator');
    if (!indicator) return;

    const _setStatus = (msg, color) => {
      indicator.textContent = msg;
      indicator.style.color = color;
      indicator.style.display = 'inline';
    };

    if (btn) btn.disabled = true;
    _setStatus('Checking…', '#aaa');

    try {
      const res  = await fetch('/api/updates/check');
      const data = await res.json();

      if (!data.ok) {
        _setStatus('⚠ ' + (data.error || 'Check failed'), '#f77');
        return;
      }

      if (data.behind === 0) {
        _setStatus(`✓ Up to date (${data.currentHash})`, '#aaffaa');
        return;
      }

      // There are updates available — ask to apply
      const apply = confirm(
        `${data.behind} update${data.behind === 1 ? '' : 's'} available ` +
        `(${data.currentHash} → ${data.remoteHash}).\n\nApply now? ` +
        `(FLEX will need to be restarted after)`
      );
      if (!apply) {
        _setStatus(`${data.behind} update${data.behind === 1 ? '' : 's'} available`, '#ffdd88');
        return;
      }

      _setStatus('Applying…', '#aaa');
      const applyRes  = await fetch('/api/updates/apply', { method: 'POST' });
      const applyData = await applyRes.json();

      if (applyData.ok) {
        _setStatus('✓ Updated — please restart FLEX', '#aaffaa');
        console.log('[updates]', applyData.output);
      } else {
        _setStatus('✗ Update failed — see console', '#f77');
        console.error('[updates] git pull failed:\n', applyData.output);
      }
    } catch (e) {
      _setStatus('✗ Server unreachable', '#f77');
      console.error('[updates] fetch error:', e);
    } finally {
      if (btn) btn.disabled = false;
    }
  };

  return { checkForUpdates: window._checkForUpdates };
}
