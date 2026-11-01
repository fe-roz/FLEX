// ui_kit.js — the switch half of the UI kit (ui_kit.css has the look and the rule).
//
// Panel checkboxes are drawn as switches by CSS alone; this file only adds
// what CSS cannot:
//   - role="switch" on each of them (screen readers say "on/off", not
//     "checked"), also on the ones panels build later (a MutationObserver),
//   - Enter toggles a switch as Space does,
//   - window.uiSwitch(checked, onChange, label) for code that builds one.
// A checkbox with the class .keep-box stays a checkbox (tick now, act later).
(function () {
  'use strict';
  const SCOPE = '#toolbar, #mini_map_controls';
  const SEL = ':is(' + SCOPE + ') input[type=checkbox]:not(.keep-box), input.ui-sw[type=checkbox]';

  function tag(root) {
    if (!root || root.nodeType !== 1) return;
    if (root.matches && root.matches('input[type=checkbox]')) { mark(root); return; }
    root.querySelectorAll && root.querySelectorAll('input[type=checkbox]').forEach(mark);
  }
  function mark(x) {
    const sw = x.matches(SEL);
    if (sw && x.getAttribute('role') !== 'switch') x.setAttribute('role', 'switch');
    else if (!sw && x.getAttribute('role') === 'switch' && !x.classList.contains('ui-sw')) x.removeAttribute('role');
  }

  // uiSwitch(checked, onChange, label) → a <label class="sw-row"> holding the
  // switch and its text, or the bare <input> when there is no label. onChange
  // gets the new value (true = on); the input is also .sw on the label.
  window.uiSwitch = function (checked, onChange, label, opts) {
    const o = opts || {};
    const x = document.createElement('input');
    x.type = 'checkbox'; x.className = 'ui-sw' + (o.small ? ' ui-sw-sm' : '');
    x.checked = !!checked; x.setAttribute('role', 'switch');
    if (o.id) x.id = o.id;
    if (onChange) x.addEventListener('change', () => onChange(x.checked, x));
    if (label == null || label === '') return x;
    const row = document.createElement('label');
    row.className = 'sw-row' + (o.className ? ' ' + o.className : '');
    if (o.title) row.title = o.title;
    row.append(x, document.createTextNode(label));
    row.sw = x;
    return row;
  };

  // Enter on a focused switch flips it, like Space (WAI-ARIA switch).
  document.addEventListener('keydown', e => {
    const x = e.target;
    if (e.key !== 'Enter' || !x || x.tagName !== 'INPUT' || x.type !== 'checkbox' || x.getAttribute('role') !== 'switch' || x.disabled) return;
    e.preventDefault(); x.click();
  });

  const start = () => {
    tag(document.documentElement);
    new MutationObserver(ms => { for (const m of ms) m.addedNodes.forEach(tag); })
      .observe(document.documentElement, { childList: true, subtree: true });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
