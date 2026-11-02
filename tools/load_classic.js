// Load a classic (non-module) browser script under Node, as CommonJS.
// client/package.json says "type": "module", so require() would read these
// files as ES modules; they are plain scripts that set module.exports when
// there is one (survey-export.js, caltopo-*.js, terrain-patch.js, ...).
const Module = require('module');
const fs = require('fs');
const path = require('path');
module.exports = function loadClassic(file) {
  const f = path.resolve(file);
  const m = new Module(f, module);
  m.filename = f;
  m.paths = Module._nodeModulePaths(path.dirname(f));
  m._compile(fs.readFileSync(f, 'utf8'), f);
  return m.exports;
};
