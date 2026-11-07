/* face-detection.js — in-browser face detection.
   Uses MediaPipe Face Detector (tasks-vision). The model and WASM runtime are downloaded
   from a CDN once; the photo itself is never sent anywhere. Falls back to the browser's
   built-in Shape Detection API (FaceDetector) when available.

   v2: multi-scale overlapping tiles (finds small faces in group photos),
       drops detections clipped by tile borders, and filters implausible boxes. */
(function () {
  'use strict';

  const VERSION = '0.10.14';
  const BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@' + VERSION;
  const MODEL = 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite';

  let initPromise = null;
  let detector = null;
  let mode = null; // 'mediapipe' | 'native'

  async function createMediaPipe(onStatus) {
    onStatus && onStatus('Loading face detection model…');
    const vision = await import(BASE + '/vision_bundle.mjs');
    const fileset = await vision.FilesetResolver.forVisionTasks(BASE + '/wasm');
    const make = (delegate) => vision.FaceDetector.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL, delegate },
      runningMode: 'IMAGE',
      minDetectionConfidence: 0.35,
    });
    try { return await make('GPU'); } catch (e) { return await make('CPU'); }
  }

  function init(onStatus) {
    if (detector) return Promise.resolve(mode);
    if (!initPromise) {
      initPromise = (async () => {
        try {
          detector = await createMediaPipe(onStatus);
          mode = 'mediapipe';
        } catch (err) {
          if ('FaceDetector' in window) {
            try {
              detector = new window.FaceDetector({ fastMode: false, maxDetectedFaces: 60 });
              mode = 'native';
            } catch (e2) { detector = null; }
          }
          if (!detector) {
            initPromise = null; // allow retry
            throw new Error('Could not load the face detection model. Check your internet connection and try again, or use the manual blur tool.');
          }
        }
        return mode;
      })();
    }
    return initPromise;
  }

  /* Run the detector on one crop (sx,sy,sw,sh) of src. The crop is resized so its longest
     side is `target` px (up OR down). Returns boxes in source-image pixels. */
  async function runOn(src, sx, sy, sw, sh, target) {
    const s = target / Math.max(sw, sh);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(sw * s));
    c.height = Math.max(1, Math.round(sh * s));
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
    const out = [];
    if (mode === 'mediapipe') {
      const res = detector.detect(c);
      (res.detections || []).forEach((d) => {
        const b = d.boundingBox;
        if (!b) return;
        out.push({
          x: sx + b.originX / s, y: sy + b.originY / s, w: b.width / s, h: b.height / s,
          score: d.categories && d.categories[0] ? d.categories[0].score : 0.5,
        });
      });
    } else {
      const faces = await detector.detect(c);
      faces.forEach((f) => {
        const b = f.boundingBox;
        out.push({ x: sx + b.x / s, y: sy + b.y / s, w: b.width / s, h: b.height / s, score: 0.5 });
      });
    }
    c.width = c.height = 0;
    // Drop faces cut off by an interior tile border (they are partial faces; a neighbouring
    // overlapping tile will contain the whole face).
    const isTile = sw < src.width * 0.999 || sh < src.height * 0.999;
    if (!isTile) return out;
    const mx = sw * 0.015, my = sh * 0.015;
    const W = src.width || src.naturalWidth, H = src.height || src.naturalHeight;
    return out.filter((f) => {
      const touchL = f.x < sx + mx && sx > 1;
      const touchT = f.y < sy + my && sy > 1;
      const touchR = f.x + f.w > sx + sw - mx && sx + sw < W - 1;
      const touchB = f.y + f.h > sy + sh - my && sy + sh < H - 1;
      return !(touchL || touchT || touchR || touchB);
    });
  }

  function overlap(a, b) {
    const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
    const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    const union = a.w * a.h + b.w * b.h - inter;
    const minA = Math.min(a.w * a.h, b.w * b.h);
    return { iou: union ? inter / union : 0, contain: minA ? inter / minA : 0 };
  }

  function nms(list) {
    const sorted = list.slice().sort((a, b) => b.score - a.score);
    const keep = [];
    sorted.forEach((c) => {
      if (!keep.some((k) => { const o = overlap(c, k); return o.iou > 0.3 || o.contain > 0.6; })) keep.push(c);
    });
    return keep;
  }

  /* Overlapping grid of tiles. `frac` = tile size as a fraction of each image side. */
  function tiles(w, h, frac) {
    const tw = w * frac, th = h * frac;
    const stepX = tw * 0.5, stepY = th * 0.5;
    const xs = [], ys = [];
    for (let x = 0; x + tw < w - 1; x += stepX) xs.push(x);
    xs.push(Math.max(0, w - tw));
    for (let y = 0; y + th < h - 1; y += stepY) ys.push(y);
    ys.push(Math.max(0, h - th));
    const out = [];
    ys.forEach((y) => xs.forEach((x) => out.push([x, y, tw, th])));
    return out;
  }

  /* Detect faces in `src` (image or canvas of size w×h). Returns padded boxes in source pixels. */
  async function detect(src, w, h) {
    if (!detector) await init();
    const big = Math.max(w, h);
    let found = await runOn(src, 0, 0, w, h, Math.min(big, 1600));

    // Multi-scale tiled passes find small faces in group photos. The model effectively sees
    // a small input, so a face needs to fill a decent share of the tile to be found.
    const fracs = [];
    if (big >= 700) fracs.push(0.6);
    if (big >= 1000) fracs.push(0.4);
    if (big >= 1400) fracs.push(0.27);
    if (big >= 2200) fracs.push(0.18);
    let count = 0;
    for (const frac of fracs) {
      for (const [x, y, tw, th] of tiles(w, h, frac)) {
        const part = await runOn(src, x, y, tw, th, 960);
        found = found.concat(part);
        if (++count % 6 === 0) await new Promise((r) => setTimeout(r, 0)); // keep UI responsive
      }
    }

    const minSize = Math.max(10, big * 0.006);
    let faces = nms(found).filter((f) =>
      f.w >= minSize && f.h >= minSize && f.w / f.h > 0.55 && f.w / f.h < 1.8);

    // Reject implausible boxes: very large, low-confidence boxes (e.g. a torso or floor)
    faces = faces.filter((f) => {
      const frac = Math.max(f.w / w, f.h / h);
      if (frac > 0.35 && f.score < 0.7) return false;
      if (frac > 0.6 && f.score < 0.85) return false;
      return true;
    });
    // ...and boxes far larger than the rest of the group, unless they are very confident
    if (faces.length >= 3) {
      const ws = faces.map((f) => f.w).sort((a, b) => a - b);
      const med = ws[Math.floor(ws.length / 2)];
      faces = faces.filter((f) => !(f.w > med * 3.5 && f.score < 0.9));
    }

    return faces
      .map((f) => {
        // pad so hairline / ears / chin are covered
        const px = f.w * 0.15, pyTop = f.h * 0.28, pyBot = f.h * 0.1;
        const x = Math.max(0, f.x - px), y = Math.max(0, f.y - pyTop);
        const x2 = Math.min(w, f.x + f.w + px), y2 = Math.min(h, f.y + f.h + pyBot);
        return { x, y, w: x2 - x, h: y2 - y, score: f.score };
      })
      .sort((a, b) => a.x - b.x);
  }

  window.FaceDetection = { init, detect, get mode() { return mode; } };
})();