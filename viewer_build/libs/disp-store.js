// Where the viewer's display and settings state is kept: per PROJECT when the map belongs to one, else per map.
//
// The viewer hands this file the map's key, the project it belongs to (or none) and a way to read / write a string under a
// key (FLEX Field's key/value store and localStorage). The rules, all here and with no DOM so node can test them
// (tools/test_disp_store.js):
//   - a map with a project reads and writes  flex_display_v1|project:<project id>;
//     a map without one its own               flex_display_v1|<map key>   (as before).
//   - a project's state starts empty, that is from the defaults: a map's old state is never copied into it.
//   - only what CHANGED on this map since it was opened is written. The viewer tells us what it actually shows
//     (seen(), once the state is restored); wherever that differs from what was saved, the map could not honour the saved
//     value (imagery "slope" on a map without that picture, trees on a map without trees) and fell back. A fall-back is
//     not a change, so it never reaches the store. A value that is undefined (a part this map does not have) is skipped.
//   - inside a part ({v, on, ...} of trees, ridgewalking, ...) only the changed fields are written, unless the saved part
//     is of another version (`v`) or missing: then the whole part is.
//   - keys listed in `mapOnly` always stay with the map, also when it has a project (for things tied to this map's ground).
//   - the map is linked to / unlinked from a project while open (setProject): what is on screen stays, the saved state
//     becomes the new place's, and from then on changes go there. Nothing is carried over.
// Any key is covered: nothing here knows the names of the settings. Phone / browser only; never in the library logs.
(function (root) {
  'use strict';
  var PREFIX = 'flex_display_v1|';
  var PID_OK = /^[A-Za-z0-9_-]{1,40}$/;

  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
  function same(a, b) {
    if (a === b) return true;
    if (Array.isArray(a) || Array.isArray(b)) {
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
      for (var i = 0; i < a.length; i++) if (!same(a[i], b[i])) return false;
      return true;
    }
    if (!isObj(a) || !isObj(b)) return false;
    var k, n = 0;
    for (k in a) if (a[k] !== undefined) { n++; if (!same(a[k], b[k])) return false; }
    for (k in b) if (b[k] !== undefined) n--;
    return n === 0;
  }
  function pid(p) { return typeof p === 'string' && PID_OK.test(p) ? p : null; }
  function mapKeyOf(mapKey) { return PREFIX + mapKey; }
  function projectKeyOf(p) { return PREFIX + 'project:' + p; }
  // The key a map's state is read from and written to.
  function keyFor(mapKey, project) { return pid(project) ? projectKeyOf(pid(project)) : mapKeyOf(mapKey); }
  // The project to start with, known before the page has asked its library: the one the map is linked to, else the one
  // the export names (the page links the map to it a moment later, without asking).
  function startProject(linked, metaProject) { return pid(linked) || pid(metaProject && metaProject.id) || null; }
  function parse(raw) { try { var v = raw && JSON.parse(raw); return isObj(v) ? v : {}; } catch (_) { return {}; } }

  // What the viewer shows now, laid over what we thought it showed: the new picture of "this map's state".
  function overlay(base, effective) {
    var out = clone(base) || {}, k;
    for (k in effective) if (effective[k] !== undefined) out[k] = clone(effective[k]);
    return out;
  }
  // Take a patch (the state now, or a few keys of it). `saved` and `base` are changed in place; returns the top-level
  // keys of `saved` that changed.
  function commit(saved, base, patch) {
    var changed = [], k, v;
    for (k in patch) {
      v = patch[k];
      if (v === undefined || same(v, base[k])) continue;
      if (isObj(v) && isObj(base[k]) && isObj(saved[k]) && saved[k].v === v.v) {
        var sub = commit(saved[k], base[k], v);
        if (sub.length) changed.push(k);
        continue;
      }
      saved[k] = clone(v); base[k] = clone(v); changed.push(k);
    }
    return changed;
  }

  // o: { mapKey, project, get(key) -> string|null, set(key, string), mapOnly: [keys] }.
  // Returns { state, key(), project(), seen(effective), save(patch) -> bool, setProject(project) -> bool }.
  // `state` is ONE object for the life of the page (the viewer's DISP): what is saved, where this map reads it.
  function open(o) {
    var mapOnly = {}, state = {}, base, project = pid(o.project);
    (o.mapOnly || []).forEach(function (k) { mapOnly[k] = true; });
    var read = function (key) { var raw = null; try { raw = o.get(key); } catch (_) {} return parse(raw); };
    function load() {
      var k, own = read(mapKeyOf(o.mapKey)), from = project ? read(projectKeyOf(project)) : own;
      for (k in state) delete state[k];
      for (k in from) if (!project || !mapOnly[k]) state[k] = from[k];
      if (project) for (k in own) if (mapOnly[k]) state[k] = own[k];
    }
    // Write the changed keys: read what is stored now, replace those keys, write (another map of the project may have
    // written since this one was opened).
    function write(key, keys) {
      if (!keys.length) return;
      var cur = read(key);
      keys.forEach(function (k) { cur[k] = state[k]; });
      try { o.set(key, JSON.stringify(cur)); } catch (_) {}
    }
    load();
    base = clone(state);
    return {
      state: state,
      key: function () { return keyFor(o.mapKey, project); },
      project: function () { return project; },
      seen: function (effective) { base = overlay(base, effective || {}); },
      save: function (patch) {
        var changed = commit(state, base, patch || {});
        if (!changed.length) return false;
        if (!project) write(mapKeyOf(o.mapKey), changed);
        else {
          write(projectKeyOf(project), changed.filter(function (k) { return !mapOnly[k]; }));
          write(mapKeyOf(o.mapKey), changed.filter(function (k) { return mapOnly[k]; }));
        }
        return true;
      },
      setProject: function (p) {
        p = pid(p);
        if (p === project) return false;
        project = p;
        load();
        return true;
      },
    };
  }

  var R = { PREFIX: PREFIX, same: same, keyFor: keyFor, startProject: startProject, parse: parse, overlay: overlay, commit: commit, open: open };
  root.FlexDisp = R;
  if (typeof module !== 'undefined' && module.exports) module.exports = R;
})(typeof window !== 'undefined' ? window : globalThis);
