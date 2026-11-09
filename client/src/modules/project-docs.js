// FLEX project (documents, files to pages, the page viewer (gallery), tags).
// Part of project.js, split into classic scripts that load in order (index.html);
// they share their functions through window._pjParts until project.js has loaded.
// Behaviour unchanged. See client/src/README.md.
(function () {
  'use strict';
  const X = window._pjParts;
  if (!X) return;                          // project-ui-kit.js found no flexlib.js
  const { pj, FL, targetLabel, $, el, blobUrl, PAGE_PX, api, PDFJS, toast, ensureAuthor, record, esc, API, btn, editNote, when, choose, dialog, partsOf, editTags, askNewDoc } = X;
  // defined in a later part: called only after every part has loaded
  const render = (...a) => X.render(...a);
  const history = (...a) => X.history(...a);

  // ── Documents ──────────────────────────────────────────────────────────────
  const docByPage = h => h && Object.values(pj.D.docs).find(d => !d.deleted && d.pages.some(p => p.h === h));
  function docSub(d, skipPages) {
    const tags = d.tagList.filter(t => t !== FL.T.project(pj.pid)).map(targetLabel);
    const m = FL.docMedia(d);
    const what = m === 'video' ? 'Video' : m === 'photo' ? `${d.pages.length > 1 ? d.pages.length + ' photos' : 'Photo'}`
      : `${d.pages.length} page${d.pages.length === 1 ? '' : 's'}${d.kind ? ' · ' + (FL.DOC_KIND_LABELS[d.kind] || d.kind) : ''}`;
    const pt = d.pages.filter(p => p.targets && p.targets.length).length;
    return `${what}${d.date ? ' · ' + d.date : ''} · ` +
      (tags.length ? tags.slice(0, 3).join(', ') + (tags.length > 3 ? ` +${tags.length - 3}` : '') : pt ? 'pages tagged' : 'inbox') +
      (pt && !skipPages ? ` · ${pt} page${pt === 1 ? '' : 's'} tagged` : '') +
      (d.has_coordinates ? ' · shows coordinates' : '') + (d.conflicts ? ' · edited on two devices' : '');
  }
  // " · page 3: stations T6–T8": the page a lookup (FL.docsFor) found a document by.
  function pageNote(d, i, item) {
    const p = d.pages[i], ts = p && p.targets && p.targets.length ? p.targets.map(targetLabel) : [];
    return item && item.via === 'page' && ts.length ? ` · page ${i + 1}: ${ts.slice(0, 2).join(', ')}` : '';
  }
  // item: what FL.docsFor found it by ({ page, via, … }): opens at that page and says why; else target: the page covering it.
  function docEl(d, target, item) {
    const r = el('div', 'pj-item pj-doc');
    const at = item && item.page != null ? item.page : target ? FL.pageFor(d, target) : 0;
    const p = d.pages[at];
    const vid = FL.docMedia(d) === 'video';
    if (p && p.ext !== 'pdf') { const im = el('img', 'pj-thumb'); im.loading = 'lazy'; im.src = blobUrl(p); if (p.rot) im.style.transform = `rotate(${p.rot}deg)`; r.appendChild(im); }
    else r.appendChild(el('div', 'pj-thumb pj-thumb-x', vid ? ['video'] : p ? 'PDF' : '—'));
    if (vid) r.classList.add('pj-doc-video');
    const t = el('div'); t.appendChild(el('div', 'pj-item-t', d.title || 'Untitled')); const note = pageNote(d, at, item);
    t.appendChild(el('div', 'pj-sub', docSub(d, !!note) + note));
    r.appendChild(t);
    r.dataset.doc = d.id;
    r.addEventListener('click', () => docOpen(d.id, at));
    return r;
  }
  /**
   * A FL.docsFor result as sections: per group a heading "Survey notes (2)" — "· from survey T" when the documents are
   * not the selection's own — and its documents, each opening at the page it was found by. A group that fell back from
   * a wider level shows its first few; the rest behind a link.
   */
  function docGroupsInto(box, res, opts = {}) {
    if (!res || res.empty) return 0;
    const lim = opts.limit || 5;
    res.groups.forEach(g => {
      const h = el('div', 'pj-h pj-gh'); h.dataset.group = g.id;
      h.appendChild(document.createTextNode(`${g.label} (${g.items.length})`));
      if (g.from) h.appendChild(el('span', 'pj-from', ' · from ' + g.from));
      box.appendChild(h);
      const rows = g.items.map(it => docEl(it.doc, null, it));
      const cut = g.fallback && rows.length > lim + 1;
      (cut ? rows.slice(0, lim) : rows).forEach(r => box.appendChild(r));
      if (cut) {
        const more = btn(`${rows.length - lim} more…`, () => { rows.slice(lim).forEach(r => box.insertBefore(r, more)); more.remove(); }, 'link');
        box.appendChild(more);
      }
    });
    return res.items.length;
  }
  function fitCanvas(w, h) {
    const m = Math.max(w, h), k = m > PAGE_PX ? PAGE_PX / m : 1;
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(w * k)); cv.height = Math.max(1, Math.round(h * k));
    const g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height);
    return cv;
  }
  async function storeBytes(buf, ext) { return api('blob?ext=' + ext + (pj.pid ? '&project=' + encodeURIComponent(pj.pid) : ''), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: buf }); }
  async function storeCanvas(cv, name) {
    const blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.85));
    const o = await storeBytes(await blob.arrayBuffer(), 'jpg');
    return { h: o.h, ext: 'jpg', w: cv.width, ht: cv.height, name };
  }
  // pdf.js 3.11.174 is vendored in client/libs/pdfjs/ (works offline); the CDN is the fallback if that copy is missing.
  const PDFJS_LOCAL = '/client/libs/pdfjs/';
  let _pdfjs = null;
  function pdfJsFrom(base) {
    return new Promise((res, rej) => {
      const fail = () => rej(new Error('PDF reader could not load'));
      const go = () => fetch(base + 'pdf.worker.min.js').then(r => { if (!r.ok) throw new Error(); return r.text(); }).then(t => {
        // A worker can't load from another origin: fetch it and start it from a blob.
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([t], { type: 'application/javascript' }));
        res(window.pdfjsLib);
      }).catch(fail);
      if (window.pdfjsLib) return go();
      const s = document.createElement('script');
      s.src = base + 'pdf.min.js';
      s.onload = go; s.onerror = () => { s.remove(); fail(); };
      document.head.appendChild(s);
    });
  }
  function loadPdfJs() {
    if (_pdfjs) return _pdfjs;
    _pdfjs = pdfJsFrom(PDFJS_LOCAL).catch(() => pdfJsFrom(PDFJS)).catch(() => { _pdfjs = null; throw new Error('PDF reader could not load (offline?)'); });
    return _pdfjs;
  }
  /** Files → pages: photos and scans ≤ 2400 px JPEG, TIFF and PDF one page per sheet. */
  async function filesToPages(files, progress) {
    const pages = [], failed = [];
    for (const f of files) {
      try {
        progress && progress(f.name);
        if (/\.tiff?$/i.test(f.name) || f.type === 'image/tiff') {
          const buf = await f.arrayBuffer(), ifds = UTIF.decode(buf);
          const subs = ifds.filter(ifd => ifd.width || ifd.t256);
          for (let i = 0; i < subs.length; i++) {
            const ifd = subs[i];
            UTIF.decodeImage(buf, ifd);
            const w = ifd.width, h = ifd.height;
            if (!w || !h) continue;
            const rgba = UTIF.toRGBA8(ifd);
            const src = document.createElement('canvas'); src.width = w; src.height = h;
            src.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, w * h * 4), w, h), 0, 0);
            const cv = fitCanvas(w, h); cv.getContext('2d').drawImage(src, 0, 0, cv.width, cv.height);
            pages.push(await storeCanvas(cv, f.name + (subs.length > 1 ? ` (${i + 1})` : '')));
          }
        } else if (/\.pdf$/i.test(f.name) || f.type === 'application/pdf') {
          const buf = await f.arrayBuffer();
          let lib = null;
          try { lib = await loadPdfJs(); } catch (e) { toast(e.message + ' — keeping the PDF as one page'); }
          if (!lib) { const o = await storeBytes(buf, 'pdf'); pages.push({ h: o.h, ext: 'pdf', name: f.name }); continue; }
          const pdf = await lib.getDocument({ data: new Uint8Array(buf) }).promise;
          for (let i = 1; i <= pdf.numPages; i++) {
            const pg = await pdf.getPage(i);
            const v1 = pg.getViewport({ scale: 1 });
            const vp = pg.getViewport({ scale: PAGE_PX / Math.max(v1.width, v1.height) });
            const cv = fitCanvas(vp.width, vp.height);
            await pg.render({ canvasContext: cv.getContext('2d'), viewport: pg.getViewport({ scale: vp.scale * cv.width / vp.width }) }).promise;
            pages.push(await storeCanvas(cv, `${f.name} (${i})`));
          }
        } else if (/^image\//.test(f.type) || /\.(jpe?g|png|webp|gif|bmp|heic)$/i.test(f.name)) {
          const bmp = await createImageBitmap(f, { imageOrientation: 'from-image' });
          const cv = fitCanvas(bmp.width, bmp.height); cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
          pages.push(await storeCanvas(cv, f.name));
        } else failed.push(f.name + ' (not an image, TIFF or PDF)');
      } catch (e) { console.warn('[project] page', f.name, e); failed.push(f.name); }
    }
    return { pages, failed };
  }
  function pickFiles(accept, multiple = true) {
    return new Promise(resolve => {
      const inp = el('input'); inp.type = 'file'; inp.multiple = multiple; inp.accept = accept; inp.style.display = 'none';
      inp.addEventListener('change', () => { resolve(Array.from(inp.files || [])); inp.remove(); });
      document.body.appendChild(inp); inp.click();
    });
  }
  /** The kind a set of files suggests (FL.suggestKind; a JPEG with camera data is a photo): the first file's. */
  async function kindForFiles(files) {
    const f = files[0];
    if (!f) return '';
    let camera = false;
    if (/\.jpe?g$/i.test(f.name) || f.type === 'image/jpeg') { try { camera = FL.exifCamera(new Uint8Array(await f.slice(0, 65536).arrayBuffer())); } catch (_) {} }
    return FL.suggestKind({ name: f.name, type: f.type, camera });
  }
  /**
   * Add files as a new document or into `docId`. `tags`: where it is about (a card's Add pages); none = the quick tag
   * picker asks what the files are and what they are about (Cancel adds nothing; with no tags they go to the inbox).
   * `kind`: set by the caller; else suggested from the files (a camera photo is Media, a scan Survey notes…).
   */
  async function addPages({ tags, docId, files, kind } = {}) {
    if (!pj.pid) { toast('Choose or create a project first'); return; }
    if (!(await ensureAuthor())) return;
    files = files || await pickFiles('image/*,.tif,.tiff,application/pdf');
    if (!files.length) return;
    let useTags = tags && tags.length ? tags : null, useKind = kind;
    if (!docId) {
      if (useKind == null) useKind = await kindForFiles(files);
      if (!useTags && askNewDoc) {
        const r = await askNewDoc({ names: files.map(f => f.name), kind: useKind });
        if (!r) return;
        useTags = r.tags; useKind = r.kind;
      }
    }
    toast(`Adding ${files.length} file(s)…`);
    const { pages, failed } = await filesToPages(files, n => toast('Adding ' + n));
    failed.forEach(n => toast('Could not read ' + n));
    if (!pages.length) return;
    if (docId && pj.D.docs[docId]) {
      await record('doc.pages', { doc: docId, add: pages }, 'docs');
      toast(`Added ${pages.length} page(s)`);
      return;
    }
    const strip = n => n.replace(/\.[^.]*$/, '').replace(/ \(\d+\)$/, '');
    const title = pages.length === 1 || new Set(pages.map(p => strip(p.name))).size === 1 ? strip(pages[0].name) : `${strip(pages[0].name)} +${pages.length - 1}`;
    const id = FL.uid(12);
    await record('doc.add', { doc: id, title: title.slice(0, 80), kind: useKind || '', date: new Date().toISOString().slice(0, 10), pages,
      tags: useTags && useTags.length ? useTags : [FL.T.project(pj.pid)] }, 'docs');
    toast(`New document, ${pages.length} page(s)`);
    docOpen(id, 0);
  }

  // Gallery
  // A video stops for good when it goes out of sight: paused, its source
  // dropped and reloaded (no more decoding or downloading), then removed. A
  // video only hidden or taken out of the page plays on, unseen.
  function stopVideos(root) {
    (root ? [...root.querySelectorAll('video')].concat(root.tagName === 'VIDEO' ? [root] : []) : []).forEach(v => {
      try { v.pause(); v.removeAttribute('src'); v.querySelectorAll('source').forEach(x => x.remove()); v.load(); } catch (_) {}
      v.remove();
    });
  }
  function docOpen(id, i) {
    if (window._info) window._info.stopMedia();             // one video at a time: the details panel's stops
    pj.gallery = { doc: id, i: i || 0 };
    galleryFrame();
  }
  /** A file of the project folder that is no document (📄 Docs): a photo or a video, shown in the gallery. */
  function fileOpen(path) {
    if (window._info) window._info.stopMedia();
    pj.gallery = { file: path, i: 0 };
    galleryFrame();
  }
  function galleryFrame() {
    let g = $('pj-gallery');
    if (!g) {
      g = el('div'); g.id = 'pj-gallery';
      g.innerHTML = '<div class="pjg-bar"><div class="pjg-title"></div><div class="pjg-btns"></div></div><div class="pjg-stage"><button class="pjg-prev">‹</button><div class="pjg-view"></div><button class="pjg-next">›</button></div><div class="pjg-tags"></div>';
      document.body.appendChild(g);
      g.querySelector('.pjg-prev').addEventListener('click', () => galleryShow(pj.gallery.i - 1));
      g.querySelector('.pjg-next').addEventListener('click', () => galleryShow(pj.gallery.i + 1));
      document.addEventListener('keydown', e => {
        if (!pj.gallery || document.querySelector('.pj-modal')) return;
        if (e.key === 'Escape') galleryClose();
        if (e.key === 'ArrowLeft') galleryShow(pj.gallery.i - 1);
        if (e.key === 'ArrowRight') galleryShow(pj.gallery.i + 1);
      });
    }
    g.classList.add('open');
    galleryShow(pj.gallery.i);
  }
  function galleryClose() { pj.gallery = null; const g = $('pj-gallery'); if (g) { stopVideos(g); g.classList.remove('open'); } }
  const isVideoName = n => /\.(mp4|m4v|mov|webm|mkv|avi)$/i.test(n || '');
  function galleryShow(i) {
    const g = $('pj-gallery'), G = pj.gallery;
    if (!g || !G) return;
    if (G.file) { galleryFile(g, G.file); return; }
    const d = pj.D.docs[G.doc];
    if (!d || d.deleted) { galleryClose(); return; }
    const n = d.pages.length;
    G.i = n ? Math.max(0, Math.min(n - 1, i)) : 0;
    const p = d.pages[G.i];
    g.querySelector('.pjg-title').innerHTML = `<b>${esc(d.title || 'Untitled')}</b> <span>${n ? (G.i + 1) + ' / ' + n : 'no pages'}${p && p.name ? ' · ' + esc(p.name) : ''}${p && p.kind ? ' · ' + esc(FL.DOC_KIND_LABELS[p.kind] || p.kind) : ''}</span>` +
      (p && p.ext !== 'pdf' && d.file ? ` <span class="pjg-render" title="FLEX shows page images made from the original for quick viewing; the original file is unchanged in the project folder: ${esc(d.file.path)}">page image for viewing</span>` : '');
    const bb = g.querySelector('.pjg-btns'); bb.textContent = '';
    const isVid = !!(d.file && /^(mp4|m4v|mov|webm|mkv)$/i.test(d.file.ext)), fileUrl = d.file && d.file.path ? API + 'file?project=' + encodeURIComponent(pj.pid) + '&path=' + encodeURIComponent(d.file.path) : null;
    if (d.file) {
      const a = el('a', 'pj-btn'); window.iconLabel(a, [isVid ? 'download' : 'doc', 'Original']);
      a.href = isVid && fileUrl ? fileUrl : API + 'blob/' + d.file.h + '.' + d.file.ext;
      // A video is saved, to open in your own player, not played in a tab of its own (where it goes on unseen).
      if (isVid) { a.download = d.file.name || 'video.' + d.file.ext; a.title = 'Save the video to open it in your own player: ' + d.file.path; }
      else { a.target = '_blank'; a.rel = 'noopener'; a.title = d.file.path + (d.file.ext === 'tif' ? ' (TIFF: opens in your image viewer)' : ''); }
      bb.appendChild(a);
    }
    if (p && p.ext !== 'pdf') {
      bb.appendChild(btn('⟲', () => record('doc.rotate', { doc: d.id, h: p.h, rot: ((p.rot || 0) + 270) % 360, prev: p.rot || 0 }, 'docs')));
      bb.appendChild(btn('⟳', () => record('doc.rotate', { doc: d.id, h: p.h, rot: ((p.rot || 0) + 90) % 360, prev: p.rot || 0 }, 'docs')));
    }
    bb.appendChild(btn(['tag', 'Tags'], () => editTags(d.id)));
    if (n) { const tp = btn(['tag', 'Tag this page…'], () => editTags(d.id, { page: G.i })); tp.dataset.act = 'tag-page'; tp.title = 'Say which station or range of stations (T6~T8) this page is about'; bb.appendChild(tp); }
    bb.appendChild(btn(['pencil', 'Details'], () => editDoc(d.id)));
    bb.appendChild(btn(['plus', 'Pages'], () => addPages({ docId: d.id })));
    bb.appendChild(btn(['note', 'Note'], () => editNote(FL.T.doc(d.id), (FL.notesOn(pj.P, FL.T.doc(d.id))[0] || {}).id)));
    bb.appendChild(btn('⋯', () => docMenu(d.id)));
    bb.appendChild(btn('✕', galleryClose));
    const v = g.querySelector('.pjg-view');
    const playing = v.querySelector('video');
    if (playing && isVid && playing.dataset.src === fileUrl) { /* the same video: it plays on */ }
    else { stopVideos(v); v.textContent = ''; }
    v.scrollTop = 0;
    if (isVid && fileUrl) {                       // a video in the project folder: played from there, with seeking (Range)
      if (!v.querySelector('video')) v.appendChild(videoEl(fileUrl, p ? blobUrl(p) : null));
    }
    else if (p && p.ext === 'pdf') { const f = el('iframe', 'pjg-pdf'); f.src = blobUrl(p); v.appendChild(f); }
    else if (p) {
      const im = el('img', 'pjg-img'); im.src = blobUrl(p);
      const rot = p.rot || 0;
      im.style.transform = `rotate(${rot}deg)`;
      if (rot % 180) { im.style.maxWidth = 'calc(100vh - 140px)'; im.style.maxHeight = 'calc(100vw - 120px)'; }
      v.appendChild(im);
    }
    const tg = g.querySelector('.pjg-tags');
    const notes = FL.notesOn(pj.P, FL.T.doc(d.id));
    tg.textContent = docSub(d) + (p && p.targets && p.targets.length ? ' · This page: ' + p.targets.map(targetLabel).join(', ') : '') + (d.desc ? ' — ' + d.desc : '') + (notes.length ? ` · Note: ${notes[0].text}` : '');
    g.querySelector('.pjg-prev').disabled = G.i <= 0;
    g.querySelector('.pjg-next').disabled = G.i >= n - 1;
  }
  /** A video player: seeking by ranges, a note when this browser cannot play it. */
  function videoEl(url, poster, cls) {
    const box = el('div', 'pj-video ' + (cls || ''));
    const vd = el('video', 'pjg-img'); vd.controls = true; vd.preload = 'metadata'; vd.playsInline = true; vd.src = url; vd.dataset.src = url; if (poster) vd.poster = poster;
    const note = el('div', 'pj-video-note', 'This browser cannot play this video (probably HEVC). Use Original to save it and open it in your own player.');
    vd.addEventListener('error', () => { note.style.display = 'block'; });
    // HEVC in a browser without it: sometimes no error, only sound and no picture.
    vd.addEventListener('loadedmetadata', () => { if (!vd.videoWidth) note.style.display = 'block'; });
    box.append(vd, note);
    return box;
  }
  function galleryFile(g, path) {
    const url = API + 'file?project=' + encodeURIComponent(pj.pid) + '&path=' + encodeURIComponent(path), name = path.split('/').pop(), vid = isVideoName(name);
    g.querySelector('.pjg-title').innerHTML = `<b>${esc(name)}</b> <span>${esc(path)}</span>`;
    const bb = g.querySelector('.pjg-btns'); bb.textContent = '';
    const a = el('a', 'pj-btn'); window.iconLabel(a, ['download', 'Original']); a.href = url; a.download = name; bb.appendChild(a);
    bb.appendChild(btn('✕', galleryClose));
    const v = g.querySelector('.pjg-view');
    const playing = v.querySelector('video');
    if (!(playing && playing.dataset.src === url)) { stopVideos(v); v.textContent = ''; v.appendChild(vid ? videoEl(url, null) : Object.assign(el('img', 'pjg-img'), { src: url })); }
    g.querySelector('.pjg-tags').textContent = 'A file of the project folder (not a document yet).';
    g.querySelector('.pjg-prev').disabled = g.querySelector('.pjg-next').disabled = true;
  }
  async function docMenu(docId) {
    const d = pj.D.docs[docId];
    const G = pj.gallery;
    const r = await choose(d.title || 'Document', `${d.pages.length} page(s) · added by ${(d.created && d.created.who) || '?'}, ${when(d.created && d.created.t)}`, [
      ...(d.pages.length ? [{ label: ['pencil', 'This page: kind and date'], value: 'page' }, { label: ['trash', 'Remove this page'], value: 'drop' }] : []),
      { label: ['compass', 'Trip…'], value: 'trip' }, { label: ['history', 'History'], value: 'hist' }, { label: ['trash', 'Delete the document'], value: 'del' }]);
    if (!r) return;
    const pg = d.pages[G ? G.i : 0];
    if (r === 'trip') { if (window._pjTrips) await window._pjTrips.pick('doc:' + docId); return; }
    if (r === 'hist') history(d.history, 'Document history', 'docs');
    if (r === 'drop') await record('doc.droppage', { doc: docId, h: pg.h, page: pg, at: G ? G.i : 0 }, 'docs');
    if (r === 'del') {
      const ok = await dialog({ title: `Delete “${d.title}”?`, text: 'It stays in the history and can be restored from it.', buttons: [{ label: 'Cancel', value: null }, { label: 'Delete', value: 'rm', danger: true }] });
      if (ok) { await record('doc.del', { doc: docId }, 'docs'); galleryClose(); }
    }
    if (r === 'page') {
      const form = el('div', 'pj-form');
      const k = kindInput(pg.kind || ''), dt = el('input', 'pj-input'); dt.value = pg.date || ''; dt.placeholder = '1994-07-16, 1994, 1970s…';
      form.append(labelled('Kind of this page', k), labelled('Date', dt));
      const r2 = await dialog({ title: 'Page ' + ((G ? G.i : 0) + 1), body: form, buttons: [{ label: 'Cancel', value: null }, { label: 'Save', value: 'ok', primary: true }] });
      if (!r2) return;
      const fields = {};
      if (k.value.trim() !== (pg.kind || '')) fields.kind = k.value.trim();
      if (dt.value.trim() !== (pg.date || '')) fields.date = dt.value.trim();
      if (Object.keys(fields).length) await record('doc.page', { doc: docId, h: pg.h, fields }, 'docs');
    }
  }
  function labelled(label, input) { const r = el('div', 'pj-f'); r.appendChild(el('div', 'pj-f-l', label)); r.appendChild(input); return r; }
  function kindInput(v) {
    const i = el('input', 'pj-input'); i.value = v; i.placeholder = 'sketch-plan, shot-table, trip-report…';
    let dl = $('pj-kinds');
    if (!dl) { dl = el('datalist'); dl.id = 'pj-kinds'; FL.DOC_KINDS.forEach(k => { const o = el('option'); o.value = k; o.label = FL.DOC_KIND_LABELS[k]; dl.appendChild(o); }); document.body.appendChild(dl); }
    i.setAttribute('list', 'pj-kinds');
    return i;
  }
  async function editDoc(docId) {
    const d = pj.D.docs[docId];
    const form = el('div', 'pj-form');
    const ti = el('input', 'pj-input'); ti.value = d.title || '';
    const ki = kindInput(d.kind || '');
    const da = el('input', 'pj-input'); da.value = d.date || ''; da.placeholder = '1994-07-16, 1994, 1970s, c. 1975';
    const de = el('textarea', 'pj-input'); de.rows = 3; de.value = d.desc || '';
    const co = el('label', 'pj-check'); const cb = el('input'); cb.type = 'checkbox'; cb.checked = !!d.has_coordinates; co.append(cb, ' Shows coordinates');
    form.append(labelled('Title', ti), labelled('Kind', ki), labelled('Date (can be approximate)', da), labelled('Description', de), co);
    if (d.conflicts) form.appendChild(el('div', 'pj-conflict', ['warn', 'Edited on two devices: ' + Object.entries(d.conflicts).map(([k, v]) => k + ': ' + v.map(x => `${x.v} (${x.who})`).join(' / ')).join('; ')]));
    const r = await dialog({ title: 'Document', body: form, wide: true, buttons: [{ label: 'Cancel', value: null }, { label: 'Save', value: 'ok', primary: true }] });
    if (!r) return;
    const now = { title: ti.value.trim(), kind: ki.value.trim(), date: da.value.trim(), desc: de.value.trim(), has_coordinates: cb.checked };
    const fields = {}, prev = {};
    Object.keys(now).forEach(k => { const old = k === 'has_coordinates' ? !!d[k] : (d[k] || ''); if (now[k] !== old) { fields[k] = now[k]; prev[k] = old; } });
    if (Object.keys(fields).length || d.conflicts) await record('doc.set', { doc: docId, fields, prev }, 'docs');
  }

  Object.assign(X, {
    docByPage, docSub, docEl, docGroupsInto, storeBytes, filesToPages, pickFiles, addPages, stopVideos, docOpen, fileOpen, galleryClose, galleryShow, videoEl,
  });
})();
