// Angle of Incidence visualisation: cylinders drawn at LiDAR points along the
// scan-angle direction (per Point Source ID flight line), coloured by flight
// line or by angle, with estimated flight paths. Moved out of flex.js unchanged
// (the flex.js split, wave 2; see client/src/README.md for the pattern).
//
// Pure exports (no browser, no three.js), node-testable:
//   FLIGHT_ALT, NADIR_THRESHOLD, flightLineHue(n), angleHue(angleDeg),
//   headingsFromSamples(samples)
// Setup:
//   setupPointcloudIncidence({ THREE, potreeViewer })
//     -> { incidenceState, updateIncidenceLines, clearIncidenceLines }
// flex.js's render loop reads incidenceState and calls updateIncidenceLines.

export const FLIGHT_ALT = 4000; // meters ASL — typical airborne LiDAR altitude
export const NADIR_THRESHOLD = 0.25; // degrees — points within this are "near nadir"

/** Hue (0..1) of the n-th flight line: golden-angle spacing. */
export function flightLineHue(n) { return (n * 0.618034) % 1.0; }

/** Hue (0..1) for a scan angle: green (nadir, 0°) → yellow (15°) → red (30°+). */
export function angleHue(angleDeg) {
  const t = Math.min(Math.abs(angleDeg) / 30, 1);
  return (1 - t) * 0.33;
}

/**
 * Fit a flight line per Point Source ID from the sampled points of
 * estimateFlightDirections: samples is a Map sourceId -> { nadirPts, allPts },
 * each point { x, y, z, scanAngle, gpsTime }. Pure.
 */
export function headingsFromSamples(samples) {
  const headings = new Map();
  for (const [sid, s] of samples) {
    // Use nadir points for line fitting; fall back to all points
    const fitPts = s.nadirPts.length >= 3 ? s.nadirPts : s.allPts;
    if (fitPts.length < 3) continue;

    // Least-squares fit of a straight line in XY through nadir points.
    // Line parameterized as: P(t) = centroid + t * direction
    const n = fitPts.length;
    let sx = 0, sy = 0;
    for (const p of fitPts) { sx += p.x; sy += p.y; }
    const cx = sx / n, cy = sy / n;

    // Covariance for PCA (only on near-nadir points = clean signal)
    let cxx = 0, cxy = 0, cyy = 0;
    for (const p of fitPts) {
      const dx = p.x - cx, dy = p.y - cy;
      cxx += dx * dx; cxy += dx * dy; cyy += dy * dy;
    }

    // Primary eigenvector = flight direction
    const trace = cxx + cyy;
    const det = cxx * cyy - cxy * cxy;
    const eigenval1 = trace / 2 + Math.sqrt(Math.max(0, trace * trace / 4 - det));
    let alongX, alongY;
    if (Math.abs(cxy) > 1e-10) {
      alongX = eigenval1 - cyy;
      alongY = cxy;
    } else {
      alongX = cxx >= cyy ? 1 : 0;
      alongY = cxx >= cyy ? 0 : 1;
    }
    const len = Math.sqrt(alongX * alongX + alongY * alongY);
    if (len < 1e-10) continue;
    alongX /= len; alongY /= len;

    // Orient by GPS time: increasing time = positive direction
    const hasGps = s.allPts.some(p => p.gpsTime !== 0);
    if (hasGps) {
      let tMin = Infinity, tMax = -Infinity, pMin = null, pMax = null;
      for (const p of s.allPts) {
        if (p.gpsTime < tMin) { tMin = p.gpsTime; pMin = p; }
        if (p.gpsTime > tMax) { tMax = p.gpsTime; pMax = p; }
      }
      if (pMin && pMax && tMax > tMin) {
        const dot = (pMax.x - pMin.x) * alongX + (pMax.y - pMin.y) * alongY;
        if (dot < 0) { alongX = -alongX; alongY = -alongY; }
      }
    }

    // Across-track = 90° CCW rotation
    const acrossX = -alongY, acrossY = alongX;

    // Build flight path as a STRAIGHT LINE at FLIGHT_ALT.
    // Project the extent of sampled points onto the along-track axis
    // to find the start and end of the line.
    let tMin = Infinity, tMax = -Infinity;
    for (const p of s.allPts) {
      const t = (p.x - cx) * alongX + (p.y - cy) * alongY;
      if (t < tMin) tMin = t;
      if (t > tMax) tMax = t;
    }

    // Extend slightly beyond the data extent
    tMin -= 50; tMax += 50;

    const pathPts = [
      { x: cx + tMin * alongX, y: cy + tMin * alongY, z: FLIGHT_ALT },
      { x: cx + tMax * alongX, y: cy + tMax * alongY, z: FLIGHT_ALT },
    ];

    headings.set(sid, {
      acrossX, acrossY, alongX, alongY,
      flightHeight: FLIGHT_ALT,
      pathPts,
    });
  }

  return headings;
}

export function setupPointcloudIncidence({ THREE, potreeViewer } = {}) {
  // ── Angle of Incidence Visualization ────────────────────────────────
  const incidenceState = {
    enabled: false,
    lineLength: 2,
    cylRadius: 0.05,
    maxPoints: 20000,
    maxDistance: 200, // metres from camera in projected coords
    colorMode: 'flightline', // 'angle' or 'flightline'
    flipSign: 1, // 1 or -1 — flips scan angle sign for datasets with opposite convention
    classFilter: new Set([7]), // default: only low noise (class 7)
    linesGroup: new THREE.Group(),
    lastCamPos: new THREE.Vector3(),
    refreshDistSq: 50 * 50, // only refresh when camera moves 50m
    needsRefresh: true, // force first draw
    lastRefreshTime: 0,
    minRefreshInterval: 2000, // minimum 2 seconds between refreshes
    // Shared cylinder geometry: unit height along Y, centered at origin
    cylGeom: new THREE.CylinderGeometry(1, 1, 1, 6, 1),
    // Material supports per-instance color
    cylMat: new THREE.MeshLambertMaterial({ transparent: true, opacity: 0.8 }),
  };
  // Pre-generate distinct flight line colors (golden-angle hue spacing)
  const _flightLineColors = {};
  function getFlightLineColor(sourceId) {
    if (_flightLineColors[sourceId]) return _flightLineColors[sourceId];
    const hue = flightLineHue(Object.keys(_flightLineColors).length);
    const c = new THREE.Color().setHSL(hue, 0.9, 0.5);
    _flightLineColors[sourceId] = c;
    return c;
  }
  function getAngleColor(angleDeg) {
    // Green (nadir, 0°) → Yellow (15°) → Red (30°+)
    return new THREE.Color().setHSL(angleHue(angleDeg), 0.9, 0.5);
  }

  function clearIncidenceLines() {
    const g = incidenceState.linesGroup;
    while (g.children.length > 0) {
      const child = g.children[0];
      g.remove(child);
      if (child.instanceMatrix) {
        child.dispose(); // InstancedMesh: cleans up instance buffers
      } else {
        if (child.geometry) child.geometry.dispose();
        if (child.material && child.material !== incidenceState.cylMat) child.material.dispose();
      }
    }
  }

  // Estimate flight paths per Point Source ID.
  // Strategy: collect near-nadir points (scan angle near 0°), fit a straight
  // line through them via least-squares, use GPS time for direction, and
  // place the path at a configurable altitude (default 3000m ASL).
  function estimateFlightDirections(pointclouds) {

    const samples = new Map(); // sourceId -> { nadirPts: [], allPts: [] }
    const _v = new THREE.Vector3();

    for (const pc of pointclouds) {
      if (!pc.visible || !pc.visibleNodes) continue;
      for (const node of pc.visibleNodes) {
        if (!node.sceneNode) continue;
        const gn = node.geometryNode || node;
        const g = gn.geometry;
        if (!g) continue;
        const posAttr = g.attributes.position;
        const psAttr = g.attributes['source id'];
        const saAttr = g.attributes['scan angle'];
        const gpsAttr = g.attributes['gps-time'] || g.attributes.gpsTime; // Potree 1.8.2 names it 'gps-time'
        if (!posAttr || !psAttr || !saAttr) continue;
        const snMatrix = node.sceneNode.matrixWorld;
        const numPts = posAttr.count;
        const stride = Math.max(1, Math.floor(numPts / 40));
        for (let i = 0; i < numPts; i += stride) {
          _v.set(posAttr.array[i*3], posAttr.array[i*3+1], posAttr.array[i*3+2])
            .applyMatrix4(snMatrix);
          const sid = psAttr.array[i];
          const sa = saAttr.array[i];
          const gps = gpsAttr ? gpsAttr.array[i] : 0;
          if (!samples.has(sid)) samples.set(sid, { nadirPts: [], allPts: [] });
          const s = samples.get(sid);
          const pt = { x: _v.x, y: _v.y, z: _v.z, scanAngle: sa, gpsTime: gps };
          s.allPts.push(pt);
          if (Math.abs(sa) <= NADIR_THRESHOLD) {
            s.nadirPts.push(pt);
          }
        }
      }
    }
    return headingsFromSamples(samples);
  }

  function updateIncidenceLines() {
    clearIncidenceLines();

    if (!incidenceState.enabled) return;

    const pointclouds = potreeViewer.scene.pointclouds;
    if (!pointclouds || pointclouds.length === 0) return;

    const classFilter = incidenceState.classFilter;
    if (classFilter.size === 0) return;

    const cam = potreeViewer.scene.getActiveCamera();
    const camX = cam.position.x;
    const camY = cam.position.y;
    const maxDist = incidenceState.maxDistance;
    const maxDistSq = maxDist * maxDist;

    const maxPts = incidenceState.maxPoints;
    const lineLen = incidenceState.lineLength;
    const cylR = incidenceState.cylRadius;
    const colorMode = incidenceState.colorMode;

    // Estimate flight headings from point distribution per flight line
    const headings = estimateFlightDirections(pointclouds);

    // Reusable objects
    const _v = new THREE.Vector3();
    const _q = new THREE.Quaternion();
    const _up = new THREE.Vector3(0, 1, 0); // cylinder default axis
    const _dir = new THREE.Vector3();
    const _m = new THREE.Matrix4();
    const _s = new THREE.Vector3(cylR, lineLen, cylR);
    const _color = new THREE.Color();

    // Collect matching points across all nodes
    const instances = [];

    for (const pc of pointclouds) {
      if (!pc.visible || !pc.visibleNodes) continue;

      for (const node of pc.visibleNodes) {
        if (instances.length >= maxPts) break;
        if (!node.sceneNode) continue;

        const geomNode = node.geometryNode || node;
        const geometry = geomNode.geometry;
        if (!geometry) continue;

        const posAttr = geometry.attributes.position;
        const saAttr = geometry.attributes['scan angle'];
        const clsAttr = geometry.attributes.classification;
        if (!posAttr || !saAttr || !clsAttr) continue;

        const snMatrix = node.sceneNode.matrixWorld;

        // Quick 2D node-level distance check
        const bb = geomNode.boundingBox;
        if (bb) {
          _v.set(
            (bb.max.x - bb.min.x) * 0.5,
            (bb.max.y - bb.min.y) * 0.5,
            (bb.max.z - bb.min.z) * 0.5
          ).applyMatrix4(snMatrix);
          const dx = _v.x - camX, dy = _v.y - camY;
          const nodeRadius = bb.getSize(new THREE.Vector3()).length() * 0.5;
          if (Math.sqrt(dx*dx + dy*dy) - nodeRadius > maxDist) continue;
        }

        const originX = snMatrix.elements[12];
        const originY = snMatrix.elements[13];
        const originZ = snMatrix.elements[14];

        const psAttr = geometry.attributes['source id'];

        const numPts = posAttr.count;
        for (let i = 0; i < numPts; i++) {
          if (instances.length >= maxPts) break;

          const cls = clsAttr.array[i] & 31;
          if (!classFilter.has(cls)) continue;

          _v.set(
            posAttr.array[i * 3],
            posAttr.array[i * 3 + 1],
            posAttr.array[i * 3 + 2]
          ).applyMatrix4(snMatrix);

          const dx = _v.x - camX, dy = _v.y - camY;
          if (dx*dx + dy*dy > maxDistSq) continue;

          const angleDeg = saAttr.array[i];
          const sourceId = psAttr ? psAttr.array[i] : 0;

          instances.push({
            rx: _v.x - originX, ry: _v.y - originY, rz: _v.z - originZ,
            originX, originY, originZ,
            angleDeg, sourceId,
          });
        }
      }
      if (instances.length >= maxPts) break;
    }

    if (instances.length === 0) {
      incidenceState.lastRefreshTime = performance.now();
      return;
    }

    // Group instances by origin to keep Float32 values small
    const groups = new Map();
    for (const inst of instances) {
      const key = `${inst.originX},${inst.originY},${inst.originZ}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(inst);
    }

    for (const [key, group] of groups) {
      const { originX, originY, originZ } = group[0];
      const count = group.length;

      const mesh = new THREE.InstancedMesh(incidenceState.cylGeom, incidenceState.cylMat, count);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);

      for (let j = 0; j < count; j++) {
        const inst = group[j];
        const angleRad = incidenceState.flipSign * inst.angleDeg * (Math.PI / 180);

        // Get the estimated across-track direction for this flight line.
        // Scan angle is measured perpendicular to flight path:
        //   positive = right of flight direction
        //   negative = left of flight direction
        const heading = headings.get(inst.sourceId);
        let acrossX, acrossY;
        if (heading) {
          acrossX = heading.acrossX;
          acrossY = heading.acrossY;
        } else {
          // Fallback: assume E-W across-track
          acrossX = 1; acrossY = 0;
        }

        // Direction from point toward sensor:
        // Horizontal component = scan angle tilt along across-track direction
        // Vertical component = cos(angle) upward
        const sinA = Math.sin(angleRad);
        const cosA = Math.cos(Math.abs(angleRad));
        _dir.set(
          sinA * acrossX,  // X (east/west component of across-track tilt)
          sinA * acrossY,  // Y (north/south component of across-track tilt)
          cosA             // Z (upward toward sensor)
        ).normalize();

        // Quaternion to rotate cylinder from Y-up to _dir
        _q.setFromUnitVectors(_up, _dir);

        // Position: midpoint of the cylinder
        const mx = inst.rx + _dir.x * lineLen * 0.5;
        const my = inst.ry + _dir.y * lineLen * 0.5;
        const mz = inst.rz + _dir.z * lineLen * 0.5;

        _m.compose(
          _v.set(mx, my, mz),
          _q,
          _s
        );
        mesh.setMatrixAt(j, _m);

        // Color
        if (colorMode === 'flightline') {
          _color.copy(getFlightLineColor(inst.sourceId));
        } else {
          _color.copy(getAngleColor(inst.angleDeg));
        }
        mesh.instanceColor.setXYZ(j, _color.r, _color.g, _color.b);
      }

      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor.needsUpdate = true;
      mesh.position.set(originX, originY, originZ);
      incidenceState.linesGroup.add(mesh);
    }

    // Render flight path lines for each flight line with a known heading
    for (const [sid, h] of headings) {
      if (!h.pathPts || h.pathPts.length < 2) continue;
      const pts = h.pathPts;
      const color = getFlightLineColor(sid);

      // Use first point as origin for Float32 precision
      const ox = pts[0].x, oy = pts[0].y, oz = pts[0].z;

      // Build line strip as pairs of segments
      const lineVerts = [];
      for (let i = 0; i < pts.length - 1; i++) {
        lineVerts.push(pts[i].x - ox, pts[i].y - oy, pts[i].z - oz);
        lineVerts.push(pts[i+1].x - ox, pts[i+1].y - oy, pts[i+1].z - oz);
      }

      const lineGeom = new THREE.BufferGeometry();
      lineGeom.setAttribute('position', new THREE.Float32BufferAttribute(lineVerts, 3));
      const lineMat = new THREE.LineBasicMaterial({ color, linewidth: 2 });
      const line = new THREE.LineSegments(lineGeom, lineMat);
      line.position.set(ox, oy, oz);
      incidenceState.linesGroup.add(line);
    }

    incidenceState.lastRefreshTime = performance.now();
  }

  // Wire up UI controls
  {
    const toggle = document.getElementById('incidence_toggle');
    const lengthSlider = document.getElementById('incidence_length');
    const lengthLabel = document.getElementById('incidence_length_label');
    const radiusSlider = document.getElementById('incidence_radius');
    const radiusLabel = document.getElementById('incidence_radius_label');
    const maxSlider = document.getElementById('incidence_max_points');
    const maxLabel = document.getElementById('incidence_max_points_label');
    const colorSelect = document.getElementById('incidence_color_mode');

    if (toggle) {
      toggle.addEventListener('change', () => {
        incidenceState.enabled = toggle.checked;
        if (toggle.checked) {
          incidenceState.needsRefresh = true;
        } else {
          clearIncidenceLines();
        }
      });
    }
    if (lengthSlider) {
      lengthSlider.addEventListener('input', () => {
        incidenceState.lineLength = parseFloat(lengthSlider.value);
        if (lengthLabel) lengthLabel.textContent = lengthSlider.value + 'm';
      });
    }
    if (radiusSlider) {
      radiusSlider.addEventListener('input', () => {
        incidenceState.cylRadius = parseFloat(radiusSlider.value);
        if (radiusLabel) radiusLabel.textContent = radiusSlider.value + 'm';
      });
    }
    if (maxSlider) {
      maxSlider.addEventListener('input', () => {
        incidenceState.maxPoints = parseInt(maxSlider.value);
        if (maxLabel) maxLabel.textContent = (parseInt(maxSlider.value) / 1000) + 'k';
      });
    }
    if (colorSelect) {
      colorSelect.addEventListener('change', () => {
        incidenceState.colorMode = colorSelect.value;
        if (incidenceState.enabled) incidenceState.needsRefresh = true;
      });
    }

    // Per-class checkboxes
    const classCheckboxes = [
      { id: 'incidence_cls_2', cls: 2 },
      { id: 'incidence_cls_3', cls: 3 },
      { id: 'incidence_cls_4', cls: 4 },
      { id: 'incidence_cls_5', cls: 5 },
      { id: 'incidence_cls_6', cls: 6 },
      { id: 'incidence_cls_7', cls: 7 },
    ];
    for (const { id, cls } of classCheckboxes) {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener('change', () => {
          if (el.checked) incidenceState.classFilter.add(cls);
          else incidenceState.classFilter.delete(cls);
        });
      }
    }
    // Flip angle sign button
    const flipBtn = document.getElementById('incidence_flip');
    if (flipBtn) {
      flipBtn.addEventListener('click', () => {
        incidenceState.flipSign *= -1;
        flipBtn.textContent = incidenceState.flipSign === 1 ? 'Flip Angles' : 'Flip Angles (flipped)';
        if (incidenceState.enabled) incidenceState.needsRefresh = true;
      });
    }

    // "Other / Unclassified" covers 0, 1, 8, 9, 12, and anything not in the named list
    const otherEl = document.getElementById('incidence_cls_other');
    if (otherEl) {
      otherEl.addEventListener('change', () => {
        const otherClasses = [0, 1, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18];
        for (const c of otherClasses) {
          if (otherEl.checked) incidenceState.classFilter.add(c);
          else incidenceState.classFilter.delete(c);
        }
      });
    }
  }

  // Add lines group to Potree's regular Three.js scene (rendered by standard renderer)
  potreeViewer.scene.scene.add(incidenceState.linesGroup);

  // Add lights to scene.scene for shaded incidence cylinders
  {
    const ambient = new THREE.AmbientLight(0xffffff, 0.4);
    const directional = new THREE.DirectionalLight(0xffffff, 0.8);
    directional.position.set(0, 0, 1); // light from above (Z-up in Potree)
    potreeViewer.scene.scene.add(ambient);
    potreeViewer.scene.scene.add(directional);
  }

  return { incidenceState, updateIncidenceLines, clearIncidenceLines };
}
