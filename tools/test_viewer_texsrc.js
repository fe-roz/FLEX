// Regression test for the portable viewer's texture source resolution.
//
// The single-file export embeds textures as bare base64; the APK build ships
// them as sidecar files. A JPEG's base64 always begins "/9j/", and a rule keyed
// on a leading slash once sent every single-file export off to fetch a file
// that does not exist, leaving the terrain untextured. This pulls textureSrc()
// straight out of viewer_build/viewer.html and checks every shape it must accept.
//
//   node tools/test_viewer_texsrc.js
'use strict';
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'viewer_build', 'viewer.html'), 'utf8');
const m = html.match(/function textureSrc\(src\) \{[\s\S]*?\n\}/);
if (!m) { console.error('FAIL textureSrc() not found in viewer.html'); process.exit(1); }
const textureSrc = new Function(m[0] + '\nreturn textureSrc;')();

let fail = 0, pass = 0;
function eq(label, got, want) {
  if (got === want) { pass++; return; }
  fail++; console.error('FAIL ' + label + '\n  got  ' + String(got).slice(0, 80) + '\n  want ' + String(want).slice(0, 80));
}

const jpeg = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8L';
const png  = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

eq('inline JPEG base64 (starts with a slash)', textureSrc(jpeg), 'data:image/jpeg;base64,' + jpeg);
eq('inline PNG base64',                         textureSrc(png),  'data:image/png;base64,' + png);
eq('APK sidecar tex_sat.jpg',                    textureSrc('tex_sat.jpg'), 'tex_sat.jpg');
eq('APK sidecar tex_hs.jpg',                     textureSrc('tex_hs.jpg'),  'tex_hs.jpg');
eq('relative ./ path',                           textureSrc('./tex_sat.jpg'), './tex_sat.jpg');
eq('relative ../ path',                          textureSrc('../x/tex.png'), '../x/tex.png');
eq('rooted path with extension',                 textureSrc('/assets/tex.jpeg'), '/assets/tex.jpeg');
eq('data: URI untouched',                        textureSrc('data:image/jpeg;base64,' + jpeg), 'data:image/jpeg;base64,' + jpeg);
eq('https URL untouched',                        textureSrc('https://example.com/t.jpg'), 'https://example.com/t.jpg');
eq('blob URL untouched',                         textureSrc('blob:abc'), 'blob:abc');

// Base64 has no '.', so no payload can be mistaken for a file name however it ends.
const endsJpg = 'AAAAjpg';
eq('base64 ending in letters "jpg" is still base64', textureSrc(endsJpg), 'data:image/jpeg;base64,' + endsJpg);

// Placeholders never reach textureSrc (the caller checks), but must not crash it.
eq('placeholder string is harmless', typeof textureSrc('PLACEHOLDER_TEX_B64'), 'string');

console.log((fail ? 'FAILED ' : 'ok ') + pass + '/' + (pass + fail) + ' assertions');
process.exit(fail ? 1 : 0);
