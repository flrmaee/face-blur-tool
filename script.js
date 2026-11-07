/* script.js — UI logic for Face Blur Tool (wires the HTML to face-detection.js + image-editor.js) */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const IE = window.ImageEditor, FD = window.FaceDetection;
  const LEVELS = ['Light', 'Medium', 'Strong', 'Maximum'];
  const STYLES = { gaussian: 'Gaussian', pixelate: 'Pixelate', solid: 'Solid color', emoji: 'Emoji' };
  const COLORS = ['#A7C7E7', '#34495E', '#000000', '#FFFFFF', '#F8DCC8', '#E8A0A0', '#A8D5BA'];
  const EMOJIS = ['💙', '😊', '😎', '🙈', '⭐', '🐱'];
  const MAX_BYTES = 25 * 1024 * 1024;
  const OK_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

  const photos = [];
  let cur = -1, step = 1, view = 'edit', zoom = 'fit', z = 1, drawMode = null, uid = 1, raf = 0;

  const P = () => photos[cur];
  const defaults = () => ({ style: 'gaussian', intensity: 3, pixelSize: 14, color: '#A7C7E7', emoji: '💙', radius: 18 });
  const stateOf = (p) => ({ faces: p.faces, manual: p.manual, settings: p.settings });

  /* ---------- helpers ---------- */
  function toast(msg, type) {
    const t = document.createElement('div');
    t.className = 'toast ' + (type || '');
    t.textContent = msg;
    $('toasts').appendChild(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, 3200);
  }
  function confirmDlg(title, msg) {
    return new Promise((res) => {
      const d = $('confirmDlg');
      $('dlgTitle').textContent = title; $('dlgMsg').textContent = msg;
      d.returnValue = '';
      d.addEventListener('close', () => res(d.returnValue === 'ok'), { once: true });
      d.showModal();
    });
  }
  const fmtSize = (b) => (b < 1048576 ? (b / 1024).toFixed(0) + ' KB' : (b / 1048576).toFixed(2) + ' MB');
  const busy = (on, txt) => { $('busy').hidden = !on; if (txt) $('busyText').textContent = txt; };
  const stem = (n) => n.replace(/\.[^.]+$/, '');

  /* ---------- theme / nav ---------- */
  $('themeToggle').addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme !== 'dark';
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    $('themeIcon').querySelector('use').setAttribute('href', dark ? '#i-sun' : '#i-moon');
    $('themeToggle').setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
  });
  $('navToggle').addEventListener('click', () => {
    const o = $('navLinks').classList.toggle('open');
    $('navToggle').setAttribute('aria-expanded', o);
  });
  $$('#navLinks a').forEach((a) => a.addEventListener('click', () => $('navLinks').classList.remove('open')));

  /* ---------- steps ---------- */
  function goStep(n) {
    if (n > 1 && !photos.length) { toast('Upload a photo first 🩵', 'error'); return; }
    step = n;
    [1, 2, 3].forEach((i) => ($('panel' + i).hidden = i !== n));
    $$('.step').forEach((b) => {
      const i = +b.dataset.step;
      b.classList.toggle('is-current', i === n);
      b.classList.toggle('is-done', i < n);
      if (i === n) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
    });
    if (n === 2) { syncControls(); requestAnimationFrame(() => layout()); }
    if (n === 3) buildExport();
    $('editor').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  $$('.step').forEach((b) => b.addEventListener('click', () => goStep(+b.dataset.step)));
  $('toEditBtn').addEventListener('click', () => goStep(2));
  $('backBtn1').addEventListener('click', () => goStep(1));
  $('toExportBtn').addEventListener('click', () => goStep(3));
  $('backBtn2').addEventListener('click', () => goStep(2));

  /* ---------- upload ---------- */
  const dz = $('dropzone'), fi = $('fileInput');
  dz.addEventListener('click', (e) => { if (e.target !== fi) fi.click(); });
  dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fi.click(); } });
  ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('is-over'); }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('is-over'); }));
  dz.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));
  fi.addEventListener('change', () => { addFiles(fi.files); fi.value = ''; });
  $('addMoreBtn').addEventListener('click', () => fi.click());

  async function loadBitmap(file) {
    if (window.createImageBitmap) {
      try { return await createImageBitmap(file); } catch (e) { /* fall through */ }
    }
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(file), img = new Image();
      img.onload = () => res(img); img.onerror = () => rej(new Error('decode'));
      img.src = url;
    });
  }

  async function addFiles(list) {
    const errs = [];
    const files = Array.from(list || []);
    let first = -1;
    for (const f of files) {
      if (!OK_TYPES.includes(f.type)) { errs.push(f.name + ': unsupported format (use JPG, PNG or WebP).'); continue; }
      if (f.size > MAX_BYTES) { errs.push(f.name + ': larger than 25 MB.'); continue; }
      try {
        const src = await loadBitmap(f);
        const w = src.width || src.naturalWidth, h = src.height || src.naturalHeight;
        const p = { id: uid++, name: f.name, size: f.size, type: f.type, src, w, h, faces: [], manual: [], settings: defaults(), undo: [], redo: [], detected: false };
        photos.push(p);
        if (first < 0) first = photos.length - 1;
      } catch (e) { errs.push(f.name + ': could not be opened.'); }
    }
    const box = $('errorBox');
    if (errs.length) { box.hidden = false; box.innerHTML = '<ul>' + errs.map((x) => '<li></li>').join('') + '</ul>'; $$('li', box).forEach((li, i) => (li.textContent = errs[i])); }
    else box.hidden = true;
    if (first >= 0) { renderStrip(); selectPhoto(first); }
  }

  function updateInfo() {
    const p = P();
    $('uploadInfo').hidden = !p;
    if (!p) return;
    const c = document.createElement('canvas');
    IE.drawOriginal(c, p.src, p.w, p.h, Math.min(1, 640 / Math.max(p.w, p.h)));
    $('uploadPreview').src = c.toDataURL('image/jpeg', 0.8);
    $('infoName').textContent = p.name;
    $('infoDims').textContent = p.w + ' × ' + p.h + ' px';
    $('infoSize').textContent = fmtSize(p.size);
    $('infoType').textContent = p.type.replace('image/', '').toUpperCase();
  }

  function renderStrip() {
    const strip = $('strip');
    strip.innerHTML = '';
    $('batchBar').hidden = !photos.length;
    $('photoCount').textContent = photos.length;
    photos.forEach((p, i) => {
      const li = document.createElement('li');
      li.className = 'thumb' + (i === cur ? ' active' : '');
      li.innerHTML = '<button type="button" class="thumb-btn"><canvas></canvas></button><span class="badge"></span>' +
        '<button type="button" class="rm" aria-label="Remove photo"><svg class="i"><use href="#i-x"/></svg></button><span class="nm"></span>';
      li.querySelector('.nm').textContent = p.name;
      li.querySelector('.badge').textContent = p.detected ? p.faces.length + ' 🙂' : 'new';
      IE.render(li.querySelector('canvas'), p.src, p.w, p.h, stateOf(p), Math.min(1, 220 / Math.max(p.w, p.h)));
      li.querySelector('.thumb-btn').addEventListener('click', () => selectPhoto(i));
      li.querySelector('.rm').addEventListener('click', () => removePhoto(i));
      strip.appendChild(li);
    });
  }

  function selectPhoto(i) {
    cur = i;
    $$('.thumb').forEach((t, k) => t.classList.toggle('active', k === i));
    updateInfo();
    $('multiExport').hidden = photos.length < 2;
    if (step === 2) { syncControls(); layout(); }
    if (step === 3) buildExport();
  }

  async function removePhoto(i) {
    if (!(await confirmDlg('Remove this photo?', 'Its edits will be discarded.'))) return;
    photos.splice(i, 1);
    if (!photos.length) { cur = -1; renderStrip(); updateInfo(); goStep(1); return; }
    renderStrip(); selectPhoto(Math.min(i, photos.length - 1));
  }
  $('removeBtn').addEventListener('click', () => cur >= 0 && removePhoto(cur));

  /* ---------- history ---------- */
  const snap = (p) => JSON.stringify({ f: p.faces, m: p.manual });
  function pushHist(p) { p.undo.push(snap(p)); if (p.undo.length > 60) p.undo.shift(); p.redo = []; }
  function restore(p, s) { const o = JSON.parse(s); p.faces = o.f; p.manual = o.m; }
  function undo() { const p = P(); if (!p || !p.undo.length) return; p.redo.push(snap(p)); restore(p, p.undo.pop()); changed(); }
  function redo() { const p = P(); if (!p || !p.redo.length) return; p.undo.push(snap(p)); restore(p, p.redo.pop()); changed(); }
  $('undoBtn').addEventListener('click', undo);
  $('redoBtn').addEventListener('click', redo);
  $('resetBtn').addEventListener('click', async () => {
    const p = P(); if (!p) return;
    if (!(await confirmDlg('Reset to original?', 'All faces and manual regions will be removed.'))) return;
    pushHist(p); p.faces = []; p.manual = []; p.detected = false; $('noFacesMsg').hidden = true; changed();
  });
  document.addEventListener('keydown', (e) => {
    if (step !== 2) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    if ((e.key === 'Delete' || e.key === 'Backspace') && e.target.classList && e.target.classList.contains('box')) {
      const b = e.target._ref; if (b) removeBox(b);
    }
  });

  /* ---------- rendering ---------- */
  function previewScale(p) { return Math.min(1, 1600 / Math.max(p.w, p.h)); }

  function layout() {
    const p = P(); if (!p) return;
    const sc = view === 'side' ? $('scrollSideA') : view === 'slider' ? $('scrollSlider') : $('scrollEdit');
    const availW = Math.max(200, sc.clientWidth - 4), availH = window.innerHeight * 0.7;
    if (zoom === 'fit') z = Math.min(availW / p.w, availH / p.h, 1);
    else if (zoom === 'width') z = availW / p.w;
    else z = zoom;
    z = Math.max(0.05, Math.min(z, 8));
    $$('#stageEdit, #viewSide .stage, #stageSlider').forEach((s) => { s.style.width = p.w * z + 'px'; s.style.height = p.h * z + 'px'; });
    $('zoomLabel').textContent = Math.round(z * 100) + '%';
    paint(); buildOverlay();
  }

  function paint() {
    const p = P(); if (!p) return;
    const s = previewScale(p), st = stateOf(p);
    if (view === 'edit') IE.render($('cvEdit'), p.src, p.w, p.h, st, s);
    else if (view === 'side') { IE.drawOriginal($('cvSideOrig'), p.src, p.w, p.h, s); IE.render($('cvSideEdit'), p.src, p.w, p.h, st, s); }
    else { IE.drawOriginal($('cvSlOrig'), p.src, p.w, p.h, s); IE.render($('cvSlEdit'), p.src, p.w, p.h, st, s); }
  }
  function schedulePaint() { cancelAnimationFrame(raf); raf = requestAnimationFrame(paint); }

  function changed() {
    const p = P(); if (!p) return;
    paint(); buildOverlay(); buildFaceList(); updateStats();
    const idx = cur, li = $$('.thumb')[idx];
    if (li) {
      IE.render(li.querySelector('canvas'), p.src, p.w, p.h, stateOf(p), Math.min(1, 220 / Math.max(p.w, p.h)));
      li.querySelector('.badge').textContent = p.detected ? p.faces.length + ' 🙂' : 'new';
    }
    $('undoBtn').disabled = !p.undo.length; $('redoBtn').disabled = !p.redo.length;
  }

  /* ---------- view modes / zoom ---------- */
  $$('.seg-btn').forEach((b) => b.addEventListener('click', () => {
    view = b.dataset.view;
    $$('.seg-btn').forEach((x) => { const on = x === b; x.classList.toggle('is-on', on); x.setAttribute('aria-pressed', on); });
    $('viewEdit').hidden = view !== 'edit'; $('viewSide').hidden = view !== 'side'; $('viewSlider').hidden = view !== 'slider';
    layout();
  }));
  const setZoom = (v) => { zoom = v; layout(); };
  $('zoomInBtn').addEventListener('click', () => setZoom(z * 1.25));
  $('zoomOutBtn').addEventListener('click', () => setZoom(z / 1.25));
  $('fitBtn').addEventListener('click', () => setZoom('fit'));
  $('fitWidthBtn').addEventListener('click', () => setZoom('width'));
  $('actualBtn').addEventListener('click', () => setZoom(1));
  window.addEventListener('resize', () => { if (step === 2) layout(); });

  // before/after slider
  (function () {
    const st = $('stageSlider'), h = $('cmpHandle');
    let drag = false;
    const set = (pct) => { pct = Math.max(0, Math.min(100, pct)); st.style.setProperty('--pos', pct + '%'); h.setAttribute('aria-valuenow', Math.round(pct)); };
    const fromEvt = (e) => { const r = st.getBoundingClientRect(); set(((e.clientX - r.left) / r.width) * 100); };
    st.addEventListener('pointerdown', (e) => { drag = true; st.setPointerCapture(e.pointerId); fromEvt(e); });
    st.addEventListener('pointermove', (e) => drag && fromEvt(e));
    st.addEventListener('pointerup', () => (drag = false));
    h.addEventListener('keydown', (e) => {
      const v = +h.getAttribute('aria-valuenow');
      if (e.key === 'ArrowLeft') set(v - 3); if (e.key === 'ArrowRight') set(v + 3);
    });
  })();

  /* ---------- overlay boxes ---------- */
  function removeBox(b) {
    const p = P(); pushHist(p);
    p.faces = p.faces.filter((f) => f !== b); p.manual = p.manual.filter((m) => m !== b);
    changed();
  }
  function placeBox(el, b) {
    el.style.left = b.x * z + 'px'; el.style.top = b.y * z + 'px';
    el.style.width = b.w * z + 'px'; el.style.height = b.h * z + 'px';
  }
  function buildOverlay() {
    const p = P(), ov = $('overlay');
    ov.innerHTML = '';
    ov.classList.toggle('drawing', !!drawMode);
    if (!p || view !== 'edit') return;
    p.faces.forEach((f, i) => ov.appendChild(mkBox(p, f, 'face', i)));
    p.manual.forEach((m, i) => ov.appendChild(mkBox(p, m, 'manual', i)));
  }
  function mkBox(p, b, kind, i) {
    const el = document.createElement('div');
    el.className = 'box ' + kind + (kind === 'face' ? (b.sel ? ' selected' : ' unselected') : '');
    el.tabIndex = 0; el._ref = b;
    el.innerHTML = '<span class="tag"></span><button type="button" class="del" aria-label="Remove"><svg class="i"><use href="#i-x"/></svg></button>' +
      ['nw', 'ne', 'sw', 'se'].map((c) => '<span class="h ' + c + '" data-c="' + c + '"></span>').join('');
    el.querySelector('.tag').textContent = (kind === 'face' ? 'Face ' : b.pts ? 'Shape ' : 'Manual ') + (i + 1);
    if (b.pts) {
      el.classList.add('free');
      el.insertAdjacentHTML('afterbegin', '<svg class="free-shape" viewBox="0 0 1 1" preserveAspectRatio="none"><polygon vector-effect="non-scaling-stroke" points="' + b.pts.map((a) => a[0] + ',' + a[1]).join(' ') + '"/></svg>');
    }
    placeBox(el, b);
    el.querySelector('.del').addEventListener('click', (e) => { e.stopPropagation(); removeBox(b); });
    el.querySelector('.del').addEventListener('pointerdown', (e) => e.stopPropagation());
    el.addEventListener('pointerdown', (e) => {
      if (drawMode) return;
      e.stopPropagation(); e.preventDefault();
      const corner = e.target.dataset && e.target.dataset.c;
      const sx = e.clientX, sy = e.clientY, o = { x: b.x, y: b.y, w: b.w, h: b.h };
      let moved = false;
      pushHist(p);
      el.setPointerCapture(e.pointerId);
      const min = 8;
      const mv = (ev) => {
        const dx = (ev.clientX - sx) / z, dy = (ev.clientY - sy) / z;
        if (Math.abs(dx) + Math.abs(dy) > 3 / z) moved = true;
        if (!moved) return;
        if (!corner) {
          b.x = Math.max(0, Math.min(p.w - o.w, o.x + dx)); b.y = Math.max(0, Math.min(p.h - o.h, o.y + dy));
        } else {
          let x1 = o.x, y1 = o.y, x2 = o.x + o.w, y2 = o.y + o.h;
          if (corner.includes('w')) x1 = Math.min(x2 - min, Math.max(0, o.x + dx)); else x2 = Math.max(x1 + min, Math.min(p.w, x2 + dx));
          if (corner.includes('n')) y1 = Math.min(y2 - min, Math.max(0, o.y + dy)); else y2 = Math.max(y1 + min, Math.min(p.h, y2 + dy));
          b.x = x1; b.y = y1; b.w = x2 - x1; b.h = y2 - y1;
        }
        placeBox(el, b); schedulePaint();
      };
      const up = () => {
        el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
        if (!moved) {
          p.undo.pop();
          if (kind === 'face') { pushHist(p); b.sel = !b.sel; b.blurred = b.sel; }
        }
        changed();
      };
      el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
    });
    return el;
  }

  /* ---------- drawing tools: rectangle + free shape ---------- */
  function setTool(t) {
    drawMode = drawMode === t ? null : t;
    $('drawToolBtn').setAttribute('aria-pressed', drawMode === 'rect');
    $('freeToolBtn').setAttribute('aria-pressed', drawMode === 'free');
    if (drawMode && view !== 'edit') $$('.seg-btn')[0].click();
    $('overlay').classList.toggle('drawing', !!drawMode);
  }
  $('drawToolBtn').addEventListener('click', () => setTool('rect'));
  $('freeToolBtn').addEventListener('click', () => setTool('free'));

  $('overlay').addEventListener('pointerdown', (e) => {
    const p = P();
    if (!drawMode || !p || e.target !== $('overlay')) return;
    e.preventDefault();
    const ov = $('overlay'), r = ov.getBoundingClientRect();
    const pos = (ev) => [Math.max(0, Math.min(p.w, (ev.clientX - r.left) / z)), Math.max(0, Math.min(p.h, (ev.clientY - r.top) / z))];
    const [x0, y0] = pos(e);
    ov.setPointerCapture(e.pointerId);

    if (drawMode === 'free') {
      const NS = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(NS, 'svg'), poly = document.createElementNS(NS, 'polygon');
      svg.setAttribute('class', 'free-live'); svg.appendChild(poly); ov.appendChild(svg);
      const pts = [[x0, y0]];
      const mv = (ev) => {
        const q = pos(ev), l = pts[pts.length - 1];
        if (Math.hypot(q[0] - l[0], q[1] - l[1]) * z < 3) return;
        pts.push(q);
        poly.setAttribute('points', pts.map((a) => a[0] * z + ',' + a[1] * z).join(' '));
      };
      const up = () => {
        ov.removeEventListener('pointermove', mv); ov.removeEventListener('pointerup', up); ov.removeEventListener('pointercancel', up);
        svg.remove();
        const xs = pts.map((a) => a[0]), ys = pts.map((a) => a[1]);
        const bx = Math.min(...xs), by = Math.min(...ys), bw = Math.max(...xs) - bx, bh = Math.max(...ys) - by;
        if (pts.length >= 3 && bw * z > 10 && bh * z > 10) {
          pushHist(p);
          p.manual.push({ id: uid++, x: bx, y: by, w: bw, h: bh, pts: pts.map((a) => [(a[0] - bx) / bw, (a[1] - by) / bh]) });
        }
        changed();
      };
      ov.addEventListener('pointermove', mv); ov.addEventListener('pointerup', up); ov.addEventListener('pointercancel', up);
      return;
    }

    const tmp = document.createElement('div');
    tmp.className = 'box manual'; ov.appendChild(tmp);
    const rect = { x: x0, y: y0, w: 0, h: 0 };
    const mv = (ev) => {
      const [x1, y1] = pos(ev);
      rect.x = Math.min(x0, x1); rect.y = Math.min(y0, y1); rect.w = Math.abs(x1 - x0); rect.h = Math.abs(y1 - y0);
      placeBox(tmp, rect);
    };
    const up = () => {
      ov.removeEventListener('pointermove', mv); ov.removeEventListener('pointerup', up); ov.removeEventListener('pointercancel', up);
      tmp.remove();
      if (rect.w * z > 10 && rect.h * z > 10) { pushHist(p); p.manual.push({ id: uid++, x: rect.x, y: rect.y, w: rect.w, h: rect.h }); }
      changed();
    };
    ov.addEventListener('pointermove', mv); ov.addEventListener('pointerup', up); ov.addEventListener('pointercancel', up);
  });
  $('clearManualBtn').addEventListener('click', () => {
    const p = P(); if (!p || !p.manual.length) return;
    pushHist(p); p.manual = []; changed();
  });

  /* ---------- faces ---------- */
  async function detectFor(p) {
    const found = await FD.detect(p.src, p.w, p.h);
    p.faces = found.map((f) => ({ id: uid++, x: f.x, y: f.y, w: f.w, h: f.h, score: f.score, sel: true, blurred: true }));
    p.detected = true;
    return p.faces.length;
  }
  $('detectBtn').addEventListener('click', async () => {
    const p = P(); if (!p) return;
    busy(true, 'Loading face detection…');
    try {
      await FD.init((m) => ($('busyText').textContent = m));
      $('busyText').textContent = 'Looking for faces…';
      pushHist(p);
      const n = await detectFor(p);
      $('noFacesMsg').hidden = n > 0;
      toast(n ? n + (n === 1 ? ' face found 🩵' : ' faces found 🩵') : 'No faces found', n ? 'success' : '');
    } catch (e) { toast(e.message || 'Detection failed.', 'error'); }
    busy(false); changed();
  });
  $('blurAllBtn').addEventListener('click', () => { const p = P(); if (!p || !p.faces.length) return toast('Detect faces first.'); pushHist(p); p.faces.forEach((f) => (f.sel = f.blurred = true)); changed(); });
  $('blurSelBtn').addEventListener('click', () => { const p = P(); if (!p || !p.faces.length) return toast('Detect faces first.'); pushHist(p); p.faces.forEach((f) => (f.blurred = f.sel)); changed(); });
  $('clearBlurBtn').addEventListener('click', () => { const p = P(); if (!p) return; pushHist(p); p.faces.forEach((f) => (f.blurred = false)); changed(); });
  $('selAllBtn').addEventListener('click', () => { const p = P(); if (!p) return; pushHist(p); p.faces.forEach((f) => (f.sel = f.blurred = true)); changed(); });
  $('selNoneBtn').addEventListener('click', () => { const p = P(); if (!p) return; pushHist(p); p.faces.forEach((f) => (f.sel = f.blurred = false)); changed(); });

  function buildFaceList() {
    const p = P(), ul = $('faceList');
    ul.innerHTML = '';
    if (!p) return;
    p.faces.forEach((f, i) => {
      const li = document.createElement('li');
      li.innerHTML = '<label><input type="checkbox"><canvas></canvas><span></span><span class="st"></span></label>';
      const cb = li.querySelector('input');
      cb.checked = !!f.sel;
      li.querySelector('span').textContent = 'Face ' + (i + 1);
      const st = li.querySelector('.st'); st.textContent = f.blurred ? 'Blurred' : 'Visible'; st.classList.toggle('on', !!f.blurred);
      IE.drawCrop(li.querySelector('canvas'), p.src, f, 40);
      cb.addEventListener('change', () => { pushHist(p); f.sel = cb.checked; f.blurred = f.sel; changed(); });
      ul.appendChild(li);
    });
    const bl = p.faces.filter((f) => f.blurred).length;
    $('faceSummary').textContent = p.detected ? p.faces.length + ' detected · ' + bl + ' blurred' : 'No faces detected yet.';
  }

  function updateStats() {
    const p = P(); if (!p) return;
    const bl = p.faces.filter((f) => f.blurred).length;
    $('stDetected').textContent = p.faces.length; $('stBlurred').textContent = bl; $('stManual').textContent = p.manual.length;
    $('stStyle').textContent = STYLES[p.settings.style];
    $('stIntensity').textContent = ['gaussian', 'pixelate'].includes(p.settings.style) ? LEVELS[p.settings.intensity - 1] : '—';
    $('manualSummary').textContent = p.manual.length + ' manual region' + (p.manual.length === 1 ? '' : 's');
  }

  /* ---------- style controls ---------- */
  COLORS.forEach((c) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'swatch'; b.style.background = c; b.dataset.c = c; b.setAttribute('aria-label', 'Color ' + c);
    b.addEventListener('click', () => setSetting('color', c));
    $('swatches').appendChild(b);
  });
  EMOJIS.forEach((e) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'emoji-btn'; b.textContent = e; b.dataset.e = e; b.setAttribute('role', 'radio');
    b.addEventListener('click', () => setSetting('emoji', e));
    $('emojiRow').appendChild(b);
  });
  $$('.style-card').forEach((b) => b.addEventListener('click', () => setSetting('style', b.dataset.style)));
  $('intensityRange').addEventListener('input', (e) => setSetting('intensity', +e.target.value));
  $('pixelRange').addEventListener('input', (e) => setSetting('pixelSize', +e.target.value));
  $('radiusRange').addEventListener('input', (e) => setSetting('radius', +e.target.value));
  $('colorInput').addEventListener('input', (e) => setSetting('color', e.target.value));

  function setSetting(k, v) {
    const p = P(); if (!p) return;
    p.settings[k] = v; syncControls(); changed();
  }
  function syncControls() {
    const p = P(); if (!p) return;
    const s = p.settings;
    $$('.style-card').forEach((b) => b.setAttribute('aria-checked', b.dataset.style === s.style));
    $('ctlIntensity').hidden = !['gaussian', 'pixelate'].includes(s.style);
    $('ctlPixel').hidden = s.style !== 'pixelate';
    $('ctlColor').hidden = s.style !== 'solid';
    $('ctlEmoji').hidden = s.style !== 'emoji';
    $('intensityRange').value = s.intensity; $('intensityLabel').textContent = LEVELS[s.intensity - 1];
    $('intensityRange').setAttribute('aria-valuetext', LEVELS[s.intensity - 1]);
    $('pixelRange').value = s.pixelSize; $('pixelLabel').textContent = s.pixelSize;
    $('radiusRange').value = s.radius; $('radiusLabel').textContent = s.radius + '%';
    $('colorInput').value = /^#[0-9a-f]{6}$/i.test(s.color) ? s.color : '#A7C7E7';
    $$('.swatch').forEach((b) => b.classList.toggle('on', b.dataset.c.toLowerCase() === s.color.toLowerCase()));
    $$('.emoji-btn').forEach((b) => { const on = b.dataset.e === s.emoji; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); });
    updateStats(); buildFaceList();
    $('noFacesMsg').hidden = !(p.detected && !p.faces.length);
    $('undoBtn').disabled = !p.undo.length; $('redoBtn').disabled = !p.redo.length;
  }

  $('applyAllBtn').addEventListener('click', () => {
    const p = P(); if (!p) return;
    photos.forEach((q) => (q.settings = Object.assign({}, p.settings)));
    renderStrip(); toast('Blur style applied to all photos 🩵', 'success');
  });

  $('batchDetectBtn').addEventListener('click', async () => {
    if (!photos.length) return;
    const wrap = $('progressWrap'), bar = $('progressBar'), fill = $('progressFill'), txt = $('progressText');
    wrap.hidden = false; $('batchDetectBtn').disabled = true;
    try {
      await FD.init((m) => (txt.textContent = m));
      for (let i = 0; i < photos.length; i++) {
        txt.textContent = 'Processing photo ' + (i + 1) + ' of ' + photos.length + '…';
        const p = photos[i]; pushHist(p);
        await detectFor(p);
        const pct = Math.round(((i + 1) / photos.length) * 100);
        fill.style.width = pct + '%'; bar.setAttribute('aria-valuenow', pct);
        await new Promise((r) => setTimeout(r, 0));
      }
      txt.textContent = 'Done! Review each photo before exporting.';
      toast('All photos processed 🩵', 'success');
    } catch (e) { txt.textContent = e.message || 'Detection failed.'; toast('Detection failed.', 'error'); }
    $('batchDetectBtn').disabled = false;
    renderStrip(); if (step === 2) { syncControls(); layout(); }
  });

  /* ---------- export ---------- */
  function fmt() { return document.querySelector('input[name="fmt"]:checked').value; }
  function buildExport() {
    const p = P(); if (!p) return;
    IE.render($('cvExport'), p.src, p.w, p.h, stateOf(p), previewScale(p));
    const bl = p.faces.filter((f) => f.blurred).length;
    $('rvDetected').textContent = p.faces.length; $('rvBlurred').textContent = bl; $('rvManual').textContent = p.manual.length;
    $('rvStyle').textContent = STYLES[p.settings.style];
    $('rvIntensity').textContent = ['gaussian', 'pixelate'].includes(p.settings.style) ? LEVELS[p.settings.intensity - 1] : '—';
    const notes = [];
    if (!p.faces.length && !p.manual.length) notes.push(['Nothing is blurred yet. Go back and detect faces or draw a region.', false]);
    if (p.faces.length - bl > 0) notes.push([(p.faces.length - bl) + ' detected face(s) are NOT blurred.', false]);
    if (!p.detected && p.manual.length) notes.push(['Face detection was not run on this photo.', false]);
    if (!notes.length) notes.push(['Everything detected is covered. Still give the image a final look.', true]);
    $('reviewNotes').innerHTML = '';
    notes.forEach(([t, ok]) => { const li = document.createElement('li'); li.textContent = t; if (ok) li.className = 'ok'; $('reviewNotes').appendChild(li); });
    $('fileName').value = stem(p.name) + '-blurred';
    $('sizeNote').textContent = 'Exported at the original size (' + p.w + ' × ' + p.h + ' px).';
    $('multiExport').hidden = photos.length < 2;
    const ul = $('exportList'); ul.innerHTML = '';
    photos.forEach((q, i) => {
      const li = document.createElement('li');
      li.innerHTML = '<canvas></canvas><span class="nm"></span><button class="btn btn-ghost btn-xs" type="button">Download</button>';
      li.querySelector('.nm').textContent = q.name;
      IE.render(li.querySelector('canvas'), q.src, q.w, q.h, stateOf(q), Math.min(1, 120 / Math.max(q.w, q.h)));
      li.querySelector('button').addEventListener('click', async () => saveBlob(await makeBlob(q), stem(q.name) + '-blurred.' + ext()));
      ul.appendChild(li);
    });
  }
  const ext = () => (fmt() === 'jpeg' ? 'jpg' : 'png');
  document.querySelectorAll('input[name="fmt"]').forEach((r) => r.addEventListener('change', () => {
    $('qualityWrap').hidden = fmt() !== 'jpeg'; $('fileExt').textContent = '.' + ext();
  }));
  $('qualityRange').addEventListener('input', (e) => ($('qualityLabel').textContent = e.target.value + '%'));

  function makeBlob(p) {
    return new Promise((res, rej) => {
      const c = document.createElement('canvas');
      const jpeg = fmt() === 'jpeg';
      IE.render(c, p.src, p.w, p.h, stateOf(p), 1, jpeg ? { background: '#ffffff' } : {});
      c.toBlob((b) => { c.width = c.height = 0; b ? res(b) : rej(new Error('Export failed')); },
        jpeg ? 'image/jpeg' : 'image/png', +$('qualityRange').value / 100);
    });
  }
  function saveBlob(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  $('downloadBtn').addEventListener('click', async () => {
    const p = P(); if (!p) return;
    const name = ($('fileName').value || 'face-blur-edited').replace(/[\\/:*?"<>|]+/g, '_');
    try { saveBlob(await makeBlob(p), name + '.' + ext()); toast('Image downloaded 🩵', 'success'); }
    catch (e) { toast('Could not export this image (it may be too large).', 'error'); }
  });
  $('zipBtn').addEventListener('click', async () => {
    if (!window.JSZip) return toast('ZIP library could not load. Download photos one by one.', 'error');
    try {
      const zip = new JSZip();
      for (let i = 0; i < photos.length; i++) zip.file((i + 1) + '-' + stem(photos[i].name) + '-blurred.' + ext(), await makeBlob(photos[i]));
      saveBlob(await zip.generateAsync({ type: 'blob' }), 'face-blur-photos.zip');
      toast('ZIP downloaded 🩵', 'success');
    } catch (e) { toast('ZIP export failed.', 'error'); }
  });

})();