// Pure parts of the wave-2 ui-misc modules (client/src/modules/search-pins.js ...).
const path = require('path');
const M = f => require(path.join(__dirname, '..', 'client', 'src', 'modules', f));
let pass = 0, fail = 0;
function ok(label, cond, info) {
  if (cond) pass++; else { fail++; console.log('FAIL', label, info === undefined ? '' : JSON.stringify(info)); }
}
{
  const { escapeHtml } = M('search-pins.js');
  ok('escapes markup', escapeHtml('<b a="x">Cave Ridge & \'co\'</b>') ===
    '&lt;b a=&quot;x&quot;&gt;Cave Ridge &amp; &#39;co&#39;&lt;/b&gt;');
  ok('non-string', escapeHtml(45.1234) === '45.1234');
  ok('plain unchanged', escapeHtml('Cave Ridge') === 'Cave Ridge');
}
{
  for (const f of ['update-checker.js', 'poi-list.js', 'workspace-hooks.js', 'measure-mode.js', 'html-labels.js', 'selection-monitor.js']) {
    const m = M(f);
    ok(f + ' exports one setup function', Object.keys(m).length === 1 && typeof Object.values(m)[0] === 'function', Object.keys(m));
  }
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
