/**
 * Regression test for the height-above-ground filter in pointcloud.vs.
 *
 * Why this exists: the filter runs entirely on the GPU, so for a long time the
 * only way to check it was to look at the screen. Four separate bugs got
 * through that way and two of them blanked the whole point cloud, which tells
 * you nothing about which uniform was wrong. This compiles the real shader in
 * a real WebGL context and asserts what it culls, that a cliff widens the band
 * rather than eating the points on it, that it fails open when a uniform is
 * missing, and that the debug colours mean what the UI claims.
 *
 * A culled point gets gl_Position.w = 0, which clips it. modelViewMatrix is
 * rigged to collapse every surviving point onto the origin, so one point is
 * drawn into a 1x1 framebuffer and the pixel read back.
 *
 *   npm i -D playwright && npx playwright install chromium
 *   node tools/test_hag_shader.js
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const CANDIDATES = [
  path.join(__dirname, '..', 'PotreeCopied', 'src', 'materials', 'shaders', 'pointcloud.vs'),
  '/mnt/user-data/uploads/FLEX/PotreeCopied/src/materials/shaders/pointcloud.vs',
];
const VS_PATH = CANDIDATES.find(p => fs.existsSync(p));
if (!VS_PATH) { console.error('cannot find pointcloud.vs'); process.exit(1); }

const DEFINES = [
  '#define num_shadowmaps 0', '#define num_snapshots 0', '#define num_clipboxes 0',
  '#define num_clipspheres 0', '#define num_clippolygons 0', '#define fixed_point_size',
  '#define square_point_shape', '#define color_type_rgba', '#define tree_type_octree',
  '#define clip_hag_enabled',
].join('\n');

const launchOpts = { args: ['--use-gl=angle', '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'] };
if (process.env.CHROMIUM_PATH) launchOpts.executablePath = process.env.CHROMIUM_PATH;

(async () => {
  const browser = await chromium.launch(launchOpts);
  const page = await browser.newPage();
  page.on('console', m => { if (m.type() === 'error') console.log('[page]', m.text()); });

  const result = await page.evaluate(({ vsSrc, defines }) => {
    const cv = document.createElement('canvas'); cv.width = cv.height = 1;
    const gl = cv.getContext('webgl', { preserveDrawingBuffer: true, antialias: false });
    if (!gl) return { error: 'no webgl context' };
    const out = { renderer: gl.getParameter(gl.RENDERER), cases: [], hues: [] };

    const mk = (t, src) => {
      const s = gl.createShader(t); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const FS_FLAT  = 'precision highp float;\nvoid main(){ gl_FragColor = vec4(0.0,1.0,0.0,1.0); }';
    const FS_COLOR = 'precision highp float;\nvarying vec3 vColor;\nvoid main(){ gl_FragColor = vec4(vColor,1.0); }';
    let progFlat, progColor;
    try {
      const vs = mk(gl.VERTEX_SHADER, defines + '\n' + vsSrc);
      for (const src of [FS_FLAT, FS_COLOR]) {
        const p = gl.createProgram();
        gl.attachShader(p, vs); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, src));
        gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
        if (!progFlat) progFlat = p; else progColor = p;
      }
    } catch (e) { return { error: String(e.message || e) }; }

    const DIM = 16, CELL = 1.0, Z_MIN = 300, Z_SPAN = 400, SPREAD_MAX = 128;
    const FLAT = 430.0;          // cells with a single ground height
    const CLIFF_BASE = 420.0, CLIFF_TOP = 450.0;   // a 30 m drop inside one cell

    // RG = 16-bit low ground, B = band above it, A = provenance. Mirrors the
    // packer in flex.js, including the reserved zero.
    const packel = (lo, hi, prov) => {
      let q = Math.round(((lo - Z_MIN) / Z_SPAN) * 65535);
      q = Math.max(1, Math.min(65535, q));
      const sp = Math.max(0, Math.min(SPREAD_MAX, hi - lo));
      return [(q >>> 8) & 255, q & 255, Math.round(sp * (255 / SPREAD_MAX)), prov];
    };
    const detail = new Uint8Array(DIM * DIM * 4);
    const coarse = new Uint8Array(DIM * DIM * 4);
    for (let cy = 0; cy < DIM; cy++) for (let cx = 0; cx < DIM; cx++) {
      const o = (cy * DIM + cx) * 4;
      if (cx === 7) { /* left empty so the fallback path can be exercised */ }
      else if (cx === 9) detail.set(packel(CLIFF_BASE, CLIFF_TOP, 255), o);   // the cliff cell
      else detail.set(packel(FLAT, FLAT, 255), o);
      coarse.set(packel(FLAT - 2, FLAT - 2, 255), o);
    }
    const tex = (unit, w, h, arr) => {
      const t = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, arr);
      for (const [k, v] of [['TEXTURE_MIN_FILTER','NEAREST'],['TEXTURE_MAG_FILTER','NEAREST'],
                            ['TEXTURE_WRAP_S','CLAMP_TO_EDGE'],['TEXTURE_WRAP_T','CLAMP_TO_EDGE']])
        gl.texParameteri(gl.TEXTURE_2D, gl[k], gl[v]);
    };
    tex(0, DIM, DIM, detail);
    tex(1, DIM, DIM, coarse);
    tex(2, 256, 1, new Uint8Array(256 * 4).fill(255));   // classificationLUT: opaque or all is culled
    tex(3, 1, 1, new Uint8Array([255, 255, 255, 255]));  // gradient

    const I = new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
    const COLLAPSE = new Float32Array([0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,1]);
    for (const prog of [progFlat, progColor]) {
      gl.useProgram(prog);
      const L = n => gl.getUniformLocation(prog, n);
      gl.uniform1i(L('uGroundTex'), 0); gl.uniform1i(L('uGroundTexC'), 1);
      gl.uniform1i(L('classificationLUT'), 2); gl.uniform1i(L('gradient'), 3);
      for (const n of ['projectionMatrix','viewMatrix','uViewInv']) gl.uniformMatrix4fv(L(n), false, I);
      gl.uniformMatrix4fv(L('modelViewMatrix'), false, COLLAPSE);
      for (const [n, v] of [['size',20],['minSize',20],['maxSize',50],['uScreenWidth',1],
        ['uScreenHeight',1],['fov',1],['near',0.1],['far',10000],['uOctreeSpacing',1],
        ['uNodeSpacing',1],['uOctreeSize',1000],['uLevel',0],['opacity',1],
        ['rgbGamma',1],['rgbBrightness',0],['rgbContrast',0],['uTransition',0],
        ['uGroundSpreadMax',SPREAD_MAX],['uGroundCellSizeC',CELL],['uGroundFallbackOn',1],
        ['uHagDebug',0],['uHagCull',1],['uBushOn',0]]) gl.uniform1f(L(n), v);
      gl.uniform2f(L('uBushRange'), 0.3, 1.5);
      gl.uniform1i(L('clipTask'), 0); gl.uniform1i(L('clipMethod'), 0);
      gl.uniform2f(L('uGroundTexSize'), DIM, DIM);
      gl.uniform2f(L('uGroundTexSizeC'), DIM, DIM);
      gl.uniform2f(L('uGroundShiftC'), 0, 0);
    }

    const buf = gl.createBuffer();
    const fb = gl.createFramebuffer(), rt = gl.createTexture();
    gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, rt);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, rt, 0);
    gl.viewport(0, 0, 1, 1);

    // EPSG:3857 magnitudes on purpose: this is where float32 bites.
    const GRID_OX = -13598712.0, GRID_OY = 4512345.0;
    const NODE_WX = GRID_OX + 0.0, NODE_WY = GRID_OY + 2.0;
    const cellX = lx => Math.floor((NODE_WX + lx - GRID_OX) / CELL);

    function draw(prog, lx, ly, worldZ, lo, hi, opt) {
      opt = opt || {};
      gl.useProgram(prog);
      const L = n => gl.getUniformLocation(prog, n);
      const m = new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0,
                                  NODE_WX - GRID_OX, NODE_WY - GRID_OY, 0, 1]);
      gl.uniformMatrix4fv(L('uGroundModelMatrix'), false,
        opt.break === 'model' ? new Float32Array(16) : m);
      gl.uniform2f(L('uGroundZRange'), opt.break === 'zrange' ? 0 : Z_MIN,
                                       opt.break === 'zrange' ? 1 : Z_SPAN);
      gl.uniform1f(L('uGroundCellSize'), opt.break === 'cell' ? 0 : CELL);
      gl.uniform2f(L('uHagRange'), lo, hi);
      gl.uniform1f(L('uHagDebug'), opt.debug ? 1 : 0);
      gl.uniform1f(L('uGroundFallbackOn'), opt.noFallback ? 0 : 1);
      gl.uniform1f(L('uHagCull'), opt.noCull ? 0 : 1);
      gl.uniform1f(L('uBushOn'), opt.bush ? 1 : 0);
      gl.uniform2f(L('uBushRange'), 0.3, 1.5);
      const aPos = gl.getAttribLocation(prog, 'position');
      const aCls = gl.getAttribLocation(prog, 'classification');
      const aCol = gl.getAttribLocation(prog, 'color');
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([lx, ly, worldZ]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);
      if (aCls >= 0) { gl.disableVertexAttribArray(aCls); gl.vertexAttrib1f(aCls, 2); }
      if (aCol >= 0) { gl.disableVertexAttribArray(aCol); gl.vertexAttrib3f(aCol, 1, 1, 1); }
      gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.POINTS, 0, 1);
      const px = new Uint8Array(4);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return px;
    }
    const kept = (...a) => draw(progFlat, ...a)[1] > 100;
    const HUES = { white:[255,255,255], magenta:[255,0,255], green:[26,255,51],
                   orange:[255,89,0], blue:[0,102,255], yellow:[255,242,26] };
    function hue(lx, ly, z, lo, hi, opt) {
      const px = draw(progColor, lx, ly, z, lo, hi, Object.assign({ debug: 1 }, opt || {}));
      let best = null, bestD = 1e9, dark = false;
      for (const scale of [1, 0.45]) for (const k of Object.keys(HUES)) {
        const c = HUES[k].map(v => Math.round(v * scale));
        const d = Math.abs(c[0]-px[0]) + Math.abs(c[1]-px[1]) + Math.abs(c[2]-px[2]);
        if (d < bestD) { bestD = d; best = k; dark = scale !== 1; }
      }
      return bestD > 45 ? `?(${px[0]},${px[1]},${px[2]})` : (dark ? 'dark ' : '') + best;
    }

    const F = 2.5;        // lands in a flat cell
    const C = 9.5;        // lands in the cliff cell
    const E = 7.5;        // lands in the empty cell, so the coarse grid answers
    out.cells = { flat: [cellX(F), FLAT], cliff: [cellX(C), CLIFF_BASE, CLIFF_TOP],
                  empty: [cellX(E), FLAT - 2] };

    out.cases = [
      ['flat: 1.5 m up, band [-0.5, 5]',           kept(F, 0.5, FLAT + 1.5,  -0.5, 5), true],
      ['flat: 9 m up, band [-0.5, 5]',             kept(F, 0.5, FLAT + 9,    -0.5, 5), false],
      ['flat: 9 m down, band [-0.5, 5]',           kept(F, 0.5, FLAT - 9,    -0.5, 5), false],
      ['flat: 9 m down, band [-15, 60]  THE RULE', kept(F, 0.5, FLAT - 9,    -15, 60), true],
      ['flat: 300 m down, band [-15, 60]',         kept(F, 0.5, FLAT - 300,  -15, 60), false],
      ['cliff: standing at the base',              kept(C, 0.5, CLIFF_BASE + 0.5, -0.5, 5), true],
      ['cliff: standing on top',                   kept(C, 0.5, CLIFF_TOP + 1.5,  -0.5, 5), true],
      ['cliff: halfway down the face',             kept(C, 0.5, CLIFF_BASE + 15,  -0.5, 5), true],
      ['cliff: 5 m below the base still goes',     kept(C, 0.5, CLIFF_BASE - 5,   -0.5, 5), false],
      ['cliff: 10 m above the top still goes',     kept(C, 0.5, CLIFF_TOP + 10,   -0.5, 5), false],
      ['cliff: 300 m below still goes',            kept(C, 0.5, CLIFF_BASE - 300, -15, 60), false],
      ['off the grid is never filtered',           kept(9999, 9999, FLAT,    -0.5, 5), true],
      ['detail empty -> coarse answers',           kept(E, 0.5, FLAT - 2 + 1.5, -0.5, 5), true],
      ['detail empty, fallback off -> no opinion', kept(E, 0.5, FLAT - 900,  -0.5, 5, { noFallback: 1 }), true],
      ['uGroundModelMatrix absent -> fail open',   kept(F, 0.5, FLAT + 9,    -0.5, 5, { break: 'model' }),  true],
      ['uGroundZRange absent      -> fail open',   kept(F, 0.5, FLAT + 9,    -0.5, 5, { break: 'zrange' }), true],
      ['uGroundCellSize absent    -> fail open',   kept(F, 0.5, FLAT + 9,    -0.5, 5, { break: 'cell' }),   true],
    ];
    // The highlight recolours without hiding, so it is read off vColor with
    // the diagnose mode OFF. Unpainted points keep the white vertex colour.
    const BUSH = [38, 255, 26], PLAIN = [255, 255, 255];
    function painted(lx, ly, z, opt) {
      const px = draw(progColor, lx, ly, z, -100, 100, Object.assign({ bush: 1, noCull: 1 }, opt || {}));
      const d = c => Math.abs(c[0]-px[0]) + Math.abs(c[1]-px[1]) + Math.abs(c[2]-px[2]);
      if (d(BUSH) < 30) return true;
      if (d(PLAIN) < 30) return false;
      return `?(${px[0]},${px[1]},${px[2]})`;
    }
    out.cases.push(
      ['cull off: 300 m down is kept',        kept(F, 0.5, FLAT - 300, -0.5, 5, { noCull: 1 }), true],
      ['highlight never hides anything',      kept(F, 0.5, FLAT + 3,   -0.5, 5, { noCull: 1, bush: 1 }), true],
      ['highlight + filter still culls',      kept(F, 0.5, FLAT + 9,   -0.5, 5, { bush: 1 }), false],
      // Marked brush outranks the keep-band: a band tight enough to strip
      // canopy would otherwise hide the brush you switched the highlight on to
      // look at.
      ['marked brush survives a band that excludes it',
                                              kept(F, 0.5, FLAT + 1.0, 3, 5, { bush: 1 }), true],
      ['same point, highlight off, is culled', kept(F, 0.5, FLAT + 1.0, 3, 5), false],
    );
    out.paints = [
      ['flat: 1.0 m over the ground',       painted(F, 0.5, FLAT + 1.0), true],
      ['flat: 0.1 m over the ground',       painted(F, 0.5, FLAT + 0.1), false],
      ['flat: 3.0 m over the ground',       painted(F, 0.5, FLAT + 3.0), false],
      ['cliff: 1 m over the base',          painted(C, 0.5, CLIFF_BASE + 1.0), true],
      ['cliff: 1 m over the top',           painted(C, 0.5, CLIFF_TOP + 1.0), true],
      ['cliff: halfway up the bare face',   painted(C, 0.5, CLIFF_BASE + 15), false],
      ['no ground reference anywhere',      painted(E, 0.5, FLAT + 1.0, { noFallback: 1 }), false],
    ];
    out.hues = [
      ['inside the band',                hue(F, 0.5, FLAT + 1.5,       -0.5, 5), 'green'],
      ['below the band',                 hue(F, 0.5, FLAT - 9,         -0.5, 5), 'orange'],
      ['above the band',                 hue(F, 0.5, FLAT + 9,         -0.5, 5), 'blue'],
      ['kept only because it is steep',  hue(C, 0.5, CLIFF_TOP + 1.5,  -0.5, 5), 'yellow'],
      ['reference from the coarse grid', hue(E, 0.5, FLAT - 2 + 1.5,   -0.5, 5), 'dark green'],
      ['no reference anywhere',          hue(E, 0.5, FLAT - 2 + 1.5,   -0.5, 5, { noFallback: 1 }), 'magenta'],
      ['uniforms missing',               hue(F, 0.5, FLAT + 1.5,       -0.5, 5, { break: 'model' }), 'white'],
    ];
    return out;
  }, { vsSrc: fs.readFileSync(VS_PATH, 'utf8'), defines: DEFINES });

  await browser.close();
  if (result.error) { console.error('shader did not build:\n' + result.error.slice(0, 4000)); process.exit(1); }

  console.log(`renderer: ${result.renderer}`);
  console.log(`cells: ${JSON.stringify(result.cells)}\n`);
  let bad = 0;
  for (const [name, got, want] of result.cases) {
    const ok = got === want; if (!ok) bad++;
    console.log(`${ok ? ' ok ' : 'FAIL'}  ${name.padEnd(44)} ${got ? 'kept' : 'culled'}`);
  }
  console.log('');
  for (const [name, got, want] of result.paints) {
    const ok = got === want; if (!ok) bad++;
    console.log(`${ok ? ' ok ' : 'FAIL'}  bushwhack: ${name.padEnd(33)} ${got === true ? 'green' : got === false ? 'plain' : got}`);
  }
  console.log('');
  for (const [name, got, want] of result.hues) {
    const ok = got === want; if (!ok) bad++;
    console.log(`${ok ? ' ok ' : 'FAIL'}  colour: ${name.padEnd(36)} ${got}${ok ? '' : `  (want ${want})`}`);
  }
  console.log(bad ? `\n${bad} failing` : '\nall passing');
  process.exit(bad ? 1 : 0);
})();
