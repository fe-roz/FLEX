// USGS Ref Fix, chosen automatically from each point cloud's projection.
//
// What the fix is: a fixed ~-32 m lift (plus the cos(lat) Z scale) that puts a cloud whose
// heights are ORTHOMETRIC (above the geoid, as in the USGS EPT clouds) at the ellipsoid
// heights the globe uses. A cloud whose heights are already ellipsoidal must not get it.
//
// The rule (classifyProjection), from the cloud's projection string (WKT / PROJ / EPSG code):
//   - none given, or Web Mercator (EPSG:3857 / 900913 / "Pseudo-Mercator", +proj=merc with
//     the spherical Earth)                                  -> 'on'  (the USGS EPT case)
//   - a projected CRS (UTM, state plane, ...) that names a vertical datum other than an
//     ellipsoidal one (compound CRS / VERT_CS / NAVD / NGVD / EGM / geoid grid)
//                                                            -> 'on'  (orthometric heights)
//   - a projected CRS with no vertical datum, or an ellipsoidal one
//                                                            -> 'off' (heights taken as ellipsoidal)
//   - geographic or unreadable                               -> 'on'  (unknown; most clouds need it)
// Several clouds: on if any says on (chooseUsgsRef). A manual choice (usgsRefAuto = false)
// is never changed by this; "auto" in the LiDAR panel turns it back on.
// Node-testable (no browser).

export function classifyProjection(proj) {
  if (proj === null || proj === undefined) return 'on';
  const s = typeof proj === 'string' ? proj : (() => { try { return JSON.stringify(proj); } catch (e) { return ''; } })();
  if (!s.trim()) return 'on';
  if (/\b(3857|900913|102100|102113)\b|pseudo[- ]?mercator|popular visuali[sz]ation|web mercator/i.test(s)) return 'on';
  if (/\+proj=merc\b/i.test(s) && /\+a=6378137\b/.test(s) && /\+b=6378137\b/.test(s)) return 'on';
  const projected = /\+proj=(?!longlat|latlong|lonlat|geocent)\w+|PROJCS|PROJCRS|PROJECTEDCRS|\bUTM\b|\bEPSG:(326|327|269|258|257|259)\d\d\b|state ?plane/i.test(s);
  if (!projected) return 'on';
  const vertical = /VERT_?CS|VERTCRS|VERTICALCRS|COMPD_CS|COMPOUNDCRS|\+geoidgrids|\+vunits|NAVD|NGVD|EGM\s?\d+|geoid|orthometric/i.test(s);
  const ellipsoidal = /ellipsoid(al)? height|ellipsoidal/i.test(s);
  return vertical && !ellipsoidal ? 'on' : 'off';
}

/** kinds: array of 'on'/'off'. null = nothing loaded (no change). Any 'on' wins. */
export function chooseUsgsRef(kinds) {
  if (!kinds || !kinds.length) return null;
  return kinds.includes('on');
}

/** Restore from a saved session's layers object. An old session has no usgsRefManual
 *  flag: it is treated as automatic whatever usgsRef it stored. */
export function restoreUsgsRef(viewModel, saved) {
  if (saved && saved.usgsRefManual === true && saved.usgsRef !== undefined) {
    viewModel.usgsRefAuto = false;
    viewModel.usgsRef = !!saved.usgsRef;
  } else {
    viewModel.usgsRefAuto = true;
  }
}

/** What goes in the session. */
export function usgsRefToSave(viewModel) {
  return { usgsRef: !!viewModel.usgsRef, usgsRefManual: viewModel.usgsRefAuto === false };
}

let _autoWrite = false;
/** True while applyAutoUsgsRef is writing (so a subscriber can tell it from a click). */
export const isAutoWrite = () => _autoWrite;

/** Decide from the clouds in the scene (each with ._usgsKind) and set the switch unless manual. */
export function applyAutoUsgsRef(viewModel, pointclouds, log) {
  if (viewModel.usgsRefAuto === false) return false;
  const kinds = (pointclouds || []).map(pc => pc._usgsKind).filter(Boolean);
  const want = chooseUsgsRef(kinds);
  if (want === null) return false;
  if (log && kinds.includes('on') && kinds.includes('off')) log('[usgs] clouds differ (' + kinds.join('/') + '): USGS Ref Fix on');
  if (viewModel.usgsRef !== want) {
    _autoWrite = true;
    try { viewModel.usgsRef = want; } finally { _autoWrite = false; }
  }
  return true;
}
