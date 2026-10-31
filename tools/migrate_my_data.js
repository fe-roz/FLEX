// Move the Caves panel's Recent list into My data (user_files/mine/, doc 14):
// recents.json (caves, placement, style, cave sets, point cloud links) and the
// survey texts in plt_cache/ (also the ones no longer in the list).
// Copies only: recents.json and plt_cache/ stay as they are (the backup).
// Checks that My data gives back exactly what the old files held.
//
//   node tools/migrate_my_data.js          dry run
//   node tools/migrate_my_data.js --go     do it
'use strict';
const path = require('path');
const mine = require(path.join(__dirname, '..', 'mine.js'));
const go = process.argv.includes('--go');
const r = mine.migrate({ go });
if (r.reason) { console.log('Nothing to do: ' + r.reason); process.exit(0); }
console.log((go ? 'Moved into My data' : 'Dry run (add --go to do it)') + ' → ' + mine.MINE_DIR);
for (const c of r.plan.caves) console.log(`  ${c.file ? '✓' : '✗ no survey text'}  ${c.name}  (${c.from})`);
if (r.plan.sets.length) console.log('  cave sets: ' + r.plan.sets.join(', '));
if (r.plan.ept.length) console.log('  point cloud links: ' + r.plan.ept.length);
if (go) {
  if (r.problems.length) { console.error('PROBLEMS:\n  ' + r.problems.join('\n  ')); process.exitCode = 1; }
  else console.log(`Checked: My data gives back the same ${r.back.plt.length} caves, placements, styles and survey texts. recents.json and plt_cache/ are untouched.`);
}
