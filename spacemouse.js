// spacemouse.js — 3Dconnexion 6-DoF mouse as a camera controller (WebHID).
//
// Chrome/Edge only (WebHID). FLEX is served from 127.0.0.1, a secure context,
// which is all WebHID needs. The first connection needs a click (Chrome shows
// its device picker); after that the browser remembers the permission and the
// device is reopened on every page load and whenever it is plugged in.
//
// Control model: fly like a camera. Push/pull = forward/back, slide = strafe,
// lift/press = rise/sink along the local vertical, twist = turn, tilt
// forward/back = look down/up. Roll is ignored so the horizon stays level.
// Motion is per second, not per frame, and translation speed scales with
// height above ground, so the same push is gentle at a cave entrance and fast
// over a range. Left button halves the speed, right button doubles it.
//
// Axis signs differ between models and are not well documented; the panel
// shows live axis values and every axis can be inverted.

const SETTINGS_KEY = 'flex_spacemouse_v1';

// 3Dconnexion devices identify as a Generic Desktop / Multi-axis Controller.
// Newer ones use 3Dconnexion's own vendor ID; older ones (SpaceNavigator,
// SpacePilot, SpaceExplorer...) still carry Logitech's, so for that vendor the
// usage filter keeps ordinary Logitech mice out of the picker.
const HID_FILTERS = [
  { vendorId: 0x256f },
  { vendorId: 0x046d, usagePage: 0x01, usage: 0x08 },
];

const FULL_SCALE   = 350;    // typical full deflection; older units reach ~512 (clamped)
const DEAD_ZONE    = 0.08;   // fraction of full scale ignored around rest
const STALE_MS     = 250;    // treat the puck as released if reports stop
const MAX_TURN_DEG = 90;     // deg/s at full twist / tilt, before sensitivity
// Pitch limits. Straight down is useful (map view); straight up is not, and
// Cesium's heading readback flips by 180 deg above ~87 deg of upward pitch,
// which would spin the view every frame since heading is read back and
// re-applied.
const PITCH_DOWN   = Cesium.Math.toRadians(-89);
const PITCH_UP     = Cesium.Math.toRadians(80);

const DEFAULTS = {
  speed: 1.0,          // translation multiplier (buttons halve / double it)
  turn: 1.0,           // rotation multiplier
  invert: { fwd: false, right: false, up: false, yaw: false, pitch: false },
  enabled: true,
};

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
    if (s) return { ...DEFAULTS, ...s, invert: { ...DEFAULTS.invert, ...(s.invert || {}) } };
  } catch (_) { /* private window or blocked storage: use defaults */ }
  return structuredClone(DEFAULTS);
}
function saveSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (_) {}
}

// Shape the raw axis: dead zone, then a gentle curve for fine control near rest.
function shape(raw) {
  let v = Math.max(-1, Math.min(1, raw / FULL_SCALE));
  const a = Math.abs(v);
  if (a < DEAD_ZONE) return 0;
  return Math.sign(v) * Math.pow((a - DEAD_ZONE) / (1 - DEAD_ZONE), 1.5);
}

export function initSpaceMouse({ viewer, heightAboveGround }) {
  const camera = viewer.camera;
  const settings = loadSettings();
  const axes = { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 };
  let lastReportAt = 0;
  let lastButtons = 0;
  let device = null;
  let lastFrameMs = null;

  const $ = id => document.getElementById(id);
  const ui = {
    connect: $('sm_connect_btn'), status: $('sm_status'), enabled: $('sm_enabled'),
    speed: $('sm_speed'), speedLabel: $('sm_speed_label'),
    turn: $('sm_turn'), turnLabel: $('sm_turn_label'), live: $('sm_live'),
  };

  function setStatus(text, ok) {
    if (!ui.status) return;
    ui.status.textContent = text;
    ui.status.style.color = ok ? '#7CFC9A' : 'rgba(255,255,255,0.55)';
  }
  function showSpeed() {
    if (ui.speed) ui.speed.value = String(Math.log2(settings.speed));
    if (ui.speedLabel) ui.speedLabel.textContent = '×' + +settings.speed.toFixed(3);
  }
  function showTurn() {
    if (ui.turn) ui.turn.value = String(settings.turn);
    if (ui.turnLabel) ui.turnLabel.textContent = '×' + settings.turn.toFixed(2);
  }

  // ── Device I/O ─────────────────────────────────────────────────────────────
  function onReport(e) {
    const d = e.data;
    const i16 = off => (off + 2 <= d.byteLength ? d.getInt16(off, true) : 0);
    if (e.reportId === 1) {
      axes.tx = i16(0); axes.ty = i16(2); axes.tz = i16(4);
      if (d.byteLength >= 12) { axes.rx = i16(6); axes.ry = i16(8); axes.rz = i16(10); }
      lastReportAt = performance.now();
    } else if (e.reportId === 2) {
      axes.rx = i16(0); axes.ry = i16(2); axes.rz = i16(4);
      lastReportAt = performance.now();
    } else if (e.reportId === 3) {
      let bits = 0;
      for (let k = 0; k < Math.min(4, d.byteLength); k++) bits |= d.getUint8(k) << (8 * k);
      const pressed = bits & ~lastButtons;
      lastButtons = bits;
      if (pressed & 1) setSpeed(settings.speed / 2);
      if (pressed & 2) setSpeed(settings.speed * 2);
    }
  }

  function zeroAxes() {
    axes.tx = axes.ty = axes.tz = axes.rx = axes.ry = axes.rz = 0;
  }

  async function open(dev) {
    if (device === dev && dev.opened) return;
    try {
      if (!dev.opened) await dev.open();
      dev.addEventListener('inputreport', onReport);
      device = dev;
      zeroAxes();
      setStatus('Connected: ' + (dev.productName || 'SpaceMouse'), true);
      if (ui.connect) ui.connect.textContent = 'Reconnect';
    } catch (err) {
      console.warn('[spacemouse] open failed', err);
      setStatus('Could not open the device (is another tab using it?)', false);
    }
  }

  async function reopenKnown() {
    const devs = await navigator.hid.getDevices();
    const sm = devs.filter(d => HID_FILTERS.some(f =>
      d.vendorId === f.vendorId &&
      (!f.usagePage || d.collections.some(c => c.usagePage === f.usagePage && c.usage === f.usage))));
    if (sm.length) await open(sm[0]);
  }

  if (!('hid' in navigator)) {
    setStatus('Needs Chrome or Edge (WebHID)', false);
    if (ui.connect) ui.connect.disabled = true;
  } else {
    if (ui.connect) ui.connect.addEventListener('click', async () => {
      try {
        const picked = await navigator.hid.requestDevice({ filters: HID_FILTERS });
        if (picked.length) await open(picked[0]);
      } catch (err) {
        console.warn('[spacemouse] request failed', err);
      }
    });
    navigator.hid.addEventListener('connect', e => {
      if (!device) open(e.device);
    });
    navigator.hid.addEventListener('disconnect', e => {
      if (e.device === device) {
        device = null; zeroAxes();
        setStatus('Disconnected', false);
        if (ui.connect) ui.connect.textContent = 'Connect SpaceMouse';
      }
    });
    setStatus('Not connected', false);
    reopenKnown().catch(err => console.warn('[spacemouse]', err));
  }

  // ── Panel ──────────────────────────────────────────────────────────────────
  function setSpeed(v) {
    settings.speed = Math.min(64, Math.max(1 / 64, v));
    showSpeed(); saveSettings(settings);
  }
  if (ui.enabled) {
    ui.enabled.checked = settings.enabled;
    ui.enabled.addEventListener('change', () => { settings.enabled = ui.enabled.checked; saveSettings(settings); });
  }
  if (ui.speed) ui.speed.addEventListener('input', () => setSpeed(Math.pow(2, parseFloat(ui.speed.value))));
  if (ui.turn) ui.turn.addEventListener('input', () => {
    settings.turn = parseFloat(ui.turn.value); showTurn(); saveSettings(settings);
  });
  for (const k of Object.keys(DEFAULTS.invert)) {
    const box = $('sm_inv_' + k);
    if (!box) continue;
    box.checked = !!settings.invert[k];
    box.addEventListener('change', () => { settings.invert[k] = box.checked; saveSettings(settings); });
  }
  showSpeed(); showTurn();

  // ── Per-frame camera update ───────────────────────────────────────────────
  const scratchUp = new Cesium.Cartesian3();
  let liveShownAt = 0;

  function update(nowMs) {
    const dt = lastFrameMs === null ? 0 : Math.min(0.1, Math.max(0, (nowMs - lastFrameMs) / 1000));
    lastFrameMs = nowMs;
    if (!device) return;
    if (performance.now() - lastReportAt > STALE_MS) zeroAxes();

    if (ui.live && nowMs - liveShownAt > 150) {
      liveShownAt = nowMs;
      ui.live.textContent =
        `T ${axes.tx} ${axes.ty} ${axes.tz}   R ${axes.rx} ${axes.ry} ${axes.rz}`;
    }
    if (!settings.enabled || dt === 0) return;

    const inv = settings.invert;
    const s = (v, flip) => (flip ? -v : v);
    // Device frame: X right, Y toward the user, Z down. Defaults map that onto
    // the camera; the invert boxes fix any model that disagrees.
    const fwd   = s(-shape(axes.ty), inv.fwd);
    const right = s( shape(axes.tx), inv.right);
    const up    = s(-shape(axes.tz), inv.up);
    const yaw   = s( shape(axes.rz), inv.yaw);
    const pitch = s(-shape(axes.rx), inv.pitch);
    if (!fwd && !right && !up && !yaw && !pitch) return;

    // Translation: metres per second at full deflection, scaled with height
    // above ground (same idea as keyboard flying, but per second).
    const carto = camera.positionCartographic;
    const hag = Math.max(heightAboveGround(carto), 1);
    const mps = Math.min(20000, Math.max(2, 0.6 * (hag + 15))) * settings.speed;
    const step = mps * dt;
    if (fwd)   camera.moveForward(fwd * step);
    if (right) camera.moveRight(right * step);
    if (up) {
      Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(camera.positionWC, scratchUp);
      camera.move(scratchUp, up * step);
    }

    // Rotation: heading about the local vertical, pitch clamped, roll held at 0.
    if (yaw || pitch) {
      const rate = Cesium.Math.toRadians(MAX_TURN_DEG) * settings.turn * dt;
      const heading = camera.heading + yaw * rate;
      const newPitch = Cesium.Math.clamp(camera.pitch + pitch * rate, PITCH_DOWN, PITCH_UP);
      camera.setView({ orientation: { heading, pitch: newPitch, roll: 0 } });
    }
  }

  return { update };
}
