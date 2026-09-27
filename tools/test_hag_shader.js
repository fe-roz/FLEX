/**
 * Regression test for the height-above-ground filter in pointcloud.vs.
 *
 * NOTE: this covers culling behaviour and the fail-open guards. The debug
 * colour key (uHagDebug) is exercised by the same harness in the session
 * scratch copy; fold that in when you next touch this file.
 *
 * Why this exists: the HAG block runs entirely on the GPU, so the only way it
 * was ever checked was by looking at the screen. Three separate bugs got
 * through that way, and two of them blanked the whole point cloud rather than
 * failing quietly. This compiles the real shader source in a real WebGL
 * context and asserts what it culls.
 *
 * How it works: a culled point is assigned gl_Position.w = 0, which clips it.
 * modelViewMatrix is rigged to collapse every surviving point onto the origin,
 * so one point is drawn into a 1x1 framebuffer and the pixel is read back —
 * green means kept, black means culled. Nothing else about the point matters.
 *
 *   npm i -D playwright && npx playwright install chromium
 *   node tools/test_hag_shader.js
 *
 * Exits non-zero on any failure, so it can go in CI.
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const VS_PATH = path.join(__dirname, '..', 'PotreeCopied', 'src', 'materials', 'shaders', 'pointcloud.vs');
const VS_SRC = fs.readFileSync(VS_PATH, 'utf8');

// What PointCloudMaterial.getDefines() and PotreeRenderer.renderOctree() would
// prepend for an ordinary RGB octree with the filter switched on.
const DEFINES = [
  '#define num_shadowmaps 0',
  '#define num_snapshots 0',
  '#define num_clipboxes 0',
  '#define num_clipspheres 0',
  '#define num_clippolygons 0',
  '#define fixed_point_size',
  '#define square_point_shape',
  '#define color_type_rgba',
  '#define tree_type_octree',
  '#define clip_hag_enabled',
].join('\n');

const FS_SRC = 'precision highp float;\nvoid main() { gl_FragColor = vec4(0.0, 1.0, 0.0, 1.0); }\n';

(async () => {
  const browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
           '--ignore-gpu-blocklist', '--no-sandbox'],
  });
  const page = await browser.newPage();
  page.on('console', m => { if (m.type() === 'error') console.log('[page]', m.text()); });

  const result = await page.evaluate(({ vsSrc, fsSrc, defines }) => {
    const out = {};
    const cv = document.createElement('canvas');
    cv.width = cv.height = 1;
    const gl = cv.getContext('webgl', { preserveDrawingBuffer: true, antialias: false });
    if (!gl) return { error: 'no webgl context' };
    out.renderer = gl.getParameter(gl.RENDERER);

    const mk = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    let prog;
    try {
      prog = gl.createProgram();
      gl.attachShader(prog, mk(gl.VERTEX_SHADER, defines + '\n' + vsSrc));
      gl.attachShader(prog, mk(gl.FRAGMENT_SHADER, fsSrc));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    } catch (e) { return { error: String(e.message || e) }; }
    gl.useProgram(prog);
    const L = n => gl.getUniformLocation(prog, n);

    out.active = [];
    for (let i = 0; i < gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS); i++) {
      const u = gl.getActiveUniform(prog, i);
      if (/uGround|uHagRange/.test(u.name)) out.active.push(u.name);
    }

    const DIM = 16, CELL = 1.0, Z_MIN = 300, Z_SPAN = 400;
    const GROUND = (cx, cy) => 430 + cx * 0.07 + cy * 0.02;
    const grid = new Uint8Array(DIM * DIM * 4);
    for (let cy = 0; cy < DIM; cy++) for (let cx = 0; cx < DIM; cx++) {
      const q = Math.round(((GROUND(cx, cy) - Z_MIN) / Z_SPAN) * 16777215);
      const o = (cy * DIM + cx) * 4;
      grid[o] = (q >>> 16) & 255; grid[o+1] = (q >>> 8) & 255; grid[o+2] = q & 255;
      grid[o+3] = 255;                         // 255 = a real class-2 return
    }
    const tex = (unit, w, h, arr) => {
      const t = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, arr);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    tex(0, DIM, DIM, grid);                              gl.uniform1i(L('uGroundTex'), 0);
    tex(1, DIM, DIM, new Uint8Array(DIM * DIM * 4));     gl.uniform1i(L('uGroundTexC'), 1);
    // doClipping() culls anything whose classification LUT entry has alpha 0,
    // so the LUT has to be opaque or every case below reads as "culled".
    tex(2, 256, 1, new Uint8Array(256 * 4).fill(255));   gl.uniform1i(L('classificationLUT'), 2);
    tex(3, 1, 1, new Uint8Array([255,255,255,255]));     gl.uniform1i(L('gradient'), 3);

    const I = new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
    const COLLAPSE = new Float32Array([0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,1]);
    gl.uniformMatrix4fv(L('projectionMatrix'), false, I);
    gl.uniformMatrix4fv(L('modelViewMatrix'), false, COLLAPSE);
    gl.uniformMatrix4fv(L('viewMatrix'), false, I);
    gl.uniformMatrix4fv(L('uViewInv'), false, I);
    for (const [n, v] of [['size',20],['minSize',20],['maxSize',50],['uScreenWidth',1],
                          ['uScreenHeight',1],['fov',1],['near',0.1],['far',10000],
                          ['uOctreeSpacing',1],['uNodeSpacing',1],['uOctreeSize',1000],
                          ['uLevel',0],['opacity',1]]) gl.uniform1f(L(n), v);
    gl.uniform1i(L('clipTask'), 0); gl.uniform1i(L('clipMethod'), 0);
    gl.uniform2f(L('uGroundTexSize'), DIM, DIM);
    gl.uniform1f(L('uGroundCellSizeC'), 16);
    gl.uniform2f(L('uGroundTexSizeC'), DIM, DIM);
    gl.uniform2f(L('uGroundShiftC'), 0, 0);
    gl.uniform1f(L('uGroundFallbackOn'), 0);

    const buf = gl.createBuffer();
    const aPos = gl.getAttribLocation(prog, 'position');
    const aCls = gl.getAttribLocation(prog, 'classification');
    const aCol = gl.getAttribLocation(prog, 'color');
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
    const NODE_WX = GRID_OX + 3.0, NODE_WY = GRID_OY + 2.0;

    function survives(lx, ly, worldZ, lo, hi, sabotage) {
      const m = new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0,
                                  NODE_WX - GRID_OX, NODE_WY - GRID_OY, 0, 1]);
      gl.uniformMatrix4fv(L('uGroundModelMatrix'), false,
        sabotage === 'model' ? new Float32Array(16) : m);
      gl.uniform2f(L('uGroundZRange'), sabotage === 'zrange' ? 0 : Z_MIN,
                                       sabotage === 'zrange' ? 1 : Z_SPAN);
      gl.uniform1f(L('uGroundCellSize'), sabotage === 'cell' ? 0 : CELL);
      gl.uniform2f(L('uHagRange'), lo, hi);
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
      return px[1] > 100;
    }

    const lx = 0.5, ly = 0.5;
    const cx = Math.floor((NODE_WX + lx - GRID_OX) / CELL);
    const cy = Math.floor((NODE_WY + ly - GRID_OY) / CELL);
    const gz = GROUND(cx, cy);
    out.cell = [cx, cy, +gz.toFixed(3)];
    out.cases = [
      ['1.5 m above ground, band [-0.5, 5]',        survives(lx, ly, gz + 1.5,  -0.5, 5), true],
      ['9 m above ground, band [-0.5, 5]',          survives(lx, ly, gz + 9,    -0.5, 5), false],
      ['9 m below ground, band [-0.5, 5]',          survives(lx, ly, gz - 9,    -0.5, 5), false],
      ['9 m below ground, band [-15, 60]  THE RULE',survives(lx, ly, gz - 9,    -15, 60), true],
      ['300 m below ground, band [-15, 60]',        survives(lx, ly, gz - 300,  -15, 60), false],
      ['1.5 m above ground, band [-100, 100]',      survives(lx, ly, gz + 1.5, -100,100), true],
      ['outside the grid is never filtered',        survives(9999, 9999, gz,    -0.5, 5), true],
      ['uGroundModelMatrix absent -> fail open',    survives(lx, ly, gz + 1.5, -0.5, 5, 'model'),  true],
      ['uGroundZRange absent      -> fail open',    survives(lx, ly, gz + 1.5, -0.5, 5, 'zrange'), true],
      ['uGroundCellSize absent    -> fail open',    survives(lx, ly, gz + 1.5, -0.5, 5, 'cell'),   true],
    ];
    return out;
  }, { vsSrc: VS_SRC, fsSrc: FS_SRC, defines: DEFINES });

  await browser.close();

  if (result.error) {
    console.error('shader did not build:\n' + result.error.slice(0, 4000));
    process.exit(1);
  }
  console.log(`renderer: ${result.renderer}`);
  console.log(`uniforms live in the compiled program: ${result.active.join(', ')}`);
  console.log(`test cell ${result.cell[0]},${result.cell[1]} ground ${result.cell[2]} m\n`);
  let bad = 0;
  for (const [name, got, want] of result.cases) {
    const ok = got === want;
    if (!ok) bad++;
    console.log(`${ok ? ' ok ' : 'FAIL'}  ${name.padEnd(44)} ${got ? 'kept' : 'culled'}`);
  }
  console.log(bad ? `\n${bad} failing` : '\nall passing');
  process.exit(bad ? 1 : 0);
})();
