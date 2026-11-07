/* image-editor.js — blur / pixelate / solid / emoji effects on a canvas.
   Pure canvas code: nothing here touches the network. */
(function () {
  'use strict';

  // Gaussian sigma as a fraction of the region's longest side, per intensity level 1..4
  const BLUR_FACTORS = [0.09, 0.16, 0.28, 0.45];
  // Pixel block multiplier per intensity level 1..4
  const PIXEL_MUL = [0.6, 1, 1.5, 2.2];
  const EMOJI_FONT = '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';

  let filterOK = null;
  function supportsFilter() {
    if (filterOK !== null) return filterOK;
    try {
      const s = document.createElement('canvas');
      s.width = s.height = 16;
      const sx = s.getContext('2d');
      sx.fillStyle = '#000'; sx.fillRect(0, 0, 8, 16);
      sx.fillStyle = '#fff'; sx.fillRect(8, 0, 8, 16);
      const d = document.createElement('canvas');
      d.width = d.height = 16;
      const dx = d.getContext('2d');
      if (!('filter' in dx)) { filterOK = false; return false; }
      dx.filter = 'blur(4px)';
      dx.drawImage(s, 0, 0);
      const v = dx.getImageData(7, 8, 1, 1).data[0];
      filterOK = v > 10 && v < 245;
    } catch (e) { filterOK = false; }
    return filterOK;
  }

  /* Area-averaging downscale by repeated halving (avoids aliasing). */
  function downscaleTo(src, sx, sy, sw, sh, tw, th) {
    let w = Math.max(1, Math.round(sw)), h = Math.max(1, Math.round(sh));
    tw = Math.max(1, Math.round(tw)); th = Math.max(1, Math.round(th));
    let cur = document.createElement('canvas');
    cur.width = w; cur.height = h;
    let cx = cur.getContext('2d');
    cx.imageSmoothingQuality = 'high';
    cx.drawImage(src, sx, sy, sw, sh, 0, 0, w, h);
    while (w > tw * 2 || h > th * 2) {
      const nw = Math.max(tw, Math.floor(w / 2)), nh = Math.max(th, Math.floor(h / 2));
      const n = document.createElement('canvas');
      n.width = nw; n.height = nh;
      const nx = n.getContext('2d');
      nx.imageSmoothingQuality = 'high';
      nx.drawImage(cur, 0, 0, w, h, 0, 0, nw, nh);
      cur.width = cur.height = 0;
      cur = n; w = nw; h = nh;
    }
    if (w !== tw || h !== th) {
      const n = document.createElement('canvas');
      n.width = tw; n.height = th;
      const nx = n.getContext('2d');
      nx.imageSmoothingQuality = 'high';
      nx.drawImage(cur, 0, 0, w, h, 0, 0, tw, th);
      cur.width = cur.height = 0;
      cur = n;
    }
    return cur;
  }

  function avgColor(src, r) {
    try {
      const c = downscaleTo(src, r.x, r.y, r.w, r.h, 1, 1);
      const d = c.getContext('2d').getImageData(0, 0, 1, 1).data;
      c.width = c.height = 0;
      return `rgb(${d[0]},${d[1]},${d[2]})`;
    } catch (e) { return '#cccccc'; }
  }

  function roundRectPath(ctx, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* region r is in source-image pixels, k = canvas px per source px */
  function gaussian(ctx, src, r, k, sigma, srcW, srcH) {
    sigma = Math.max(1, sigma);
    const pad = Math.ceil((sigma * 3) / k);
    const sx = Math.max(0, r.x - pad), sy = Math.max(0, r.y - pad);
    const ex = Math.min(srcW, r.x + r.w + pad), ey = Math.min(srcH, r.y + r.h + pad);
    const sw = ex - sx, sh = ey - sy;
    // Underlay with the average colour so blur never fades back to sharp pixels at image borders
    ctx.fillStyle = avgColor(src, r);
    ctx.fillRect(r.x * k, r.y * k, r.w * k, r.h * k);
    if (supportsFilter()) {
      ctx.filter = 'blur(' + sigma + 'px)';
      ctx.drawImage(src, sx, sy, sw, sh, sx * k, sy * k, sw * k, sh * k);
      ctx.filter = 'none';
    } else {
      const f = Math.max(1, sigma * 0.8);
      const tw = Math.max(1, Math.round((sw * k) / f)), th = Math.max(1, Math.round((sh * k) / f));
      const t = downscaleTo(src, sx, sy, sw, sh, tw, th);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(t, 0, 0, tw, th, sx * k, sy * k, sw * k, sh * k);
      t.width = t.height = 0;
    }
  }

  function pixelate(ctx, src, r, k, block) {
    block = Math.max(2, Math.round(block));
    const dw = r.w * k, dh = r.h * k;
    const tw = Math.max(1, Math.ceil(dw / block)), th = Math.max(1, Math.ceil(dh / block));
    const t = downscaleTo(src, r.x, r.y, r.w, r.h, tw, th);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(t, 0, 0, tw, th, r.x * k, r.y * k, tw * block, th * block);
    ctx.imageSmoothingEnabled = true;
    t.width = t.height = 0;
  }

  /* Emoji are drawn once onto a hidden canvas, trimmed to their visible pixels,
     then scaled to cover the region. This avoids clipped / empty-box emoji. */
  const emojiCache = {};
  function emojiSprite(ch) {
    if (emojiCache[ch] !== undefined) return emojiCache[ch];
    const S = 256, c = document.createElement('canvas');
    c.width = c.height = S;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.font = '200px ' + EMOJI_FONT;
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(ch, S / 2, S / 2 + 8);
    const d = x.getImageData(0, 0, S, S).data;
    let x0 = S, y0 = S, x1 = -1, y1 = -1;
    for (let yy = 0; yy < S; yy++) {
      for (let xx = 0; xx < S; xx++) {
        if (d[(yy * S + xx) * 4 + 3] > 10) {
          if (xx < x0) x0 = xx; if (xx > x1) x1 = xx;
          if (yy < y0) y0 = yy; if (yy > y1) y1 = yy;
        }
      }
    }
    return (emojiCache[ch] = x1 < 0 ? null : { canvas: c, sx: x0, sy: y0, sw: x1 - x0 + 1, sh: y1 - y0 + 1 });
  }

  function applyEffect(ctx, src, r, st, k, srcW, srcH, cw, ch) {
    const x = r.x * k, y = r.y * k, w = r.w * k, h = r.h * k;
    ctx.save();
    if (r.pts && r.pts.length > 2) {            // free-shape region
      ctx.beginPath();
      r.pts.forEach((p, i) => {
        const px = (r.x + p[0] * r.w) * k, py = (r.y + p[1] * r.h) * k;
        if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
      });
      ctx.closePath();
    } else {                                     // box with adjustable corner radius (%)
      const rad = st.radius == null ? 18 : st.radius;
      roundRectPath(ctx, x, y, w, h, Math.min(w, h) * rad / 100);
    }
    ctx.clip();
    const lvl = Math.min(4, Math.max(1, st.intensity | 0 || 3)) - 1;
    const longest = Math.max(w, h);
    switch (st.style) {
      case 'pixelate':
        pixelate(ctx, src, r, k, st.pixelSize * (Math.max(cw, ch) / 1000) * PIXEL_MUL[lvl]);
        break;
      case 'solid':
        ctx.fillStyle = st.color || '#A7C7E7';
        ctx.fillRect(x, y, w, h);
        break;
      case 'emoji': {
        gaussian(ctx, src, r, k, longest * BLUR_FACTORS[3], srcW, srcH); // hidden base layer
        const sp = emojiSprite(st.emoji || '💙');
        if (sp) {
          const side = longest * 0.95;
          const dw = sp.sw >= sp.sh ? side : side * sp.sw / sp.sh;
          const dh = sp.sw >= sp.sh ? side * sp.sh / sp.sw : side;
          ctx.drawImage(sp.canvas, sp.sx, sp.sy, sp.sw, sp.sh, x + w / 2 - dw / 2, y + h / 2 - dh / 2, dw, dh);
        }
        break;
      }
      default:
        gaussian(ctx, src, r, k, longest * BLUR_FACTORS[lvl], srcW, srcH);
    }
    ctx.restore();
  }

  /* Regions that are actually obscured in the output, clamped to the image. */
  function getRegions(state, srcW, srcH) {
    const list = [];
    const add = (b) => {
      if (b.pts) { if (b.w >= 1 && b.h >= 1) list.push({ x: b.x, y: b.y, w: b.w, h: b.h, pts: b.pts }); return; }
      const x = Math.max(0, b.x), y = Math.max(0, b.y);
      const w = Math.min(srcW, b.x + b.w) - x, h = Math.min(srcH, b.y + b.h) - y;
      if (w >= 1 && h >= 1) list.push({ x, y, w, h });
    };
    (state.faces || []).forEach((f) => { if (f.blurred) add(f); });
    (state.manual || []).forEach(add);
    return list;
  }

  /* Render the edited image into `canvas` at `scale` (1 = full resolution). */
  function render(canvas, src, srcW, srcH, state, scale, opts) {
    opts = opts || {};
    const cw = Math.max(1, Math.round(srcW * scale)), ch = Math.max(1, Math.round(srcH * scale));
    if (canvas.width !== cw) canvas.width = cw;
    if (canvas.height !== ch) canvas.height = ch;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    if (opts.background) { ctx.fillStyle = opts.background; ctx.fillRect(0, 0, cw, ch); }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, srcW, srcH, 0, 0, cw, ch);
    const k = cw / srcW;
    const regions = getRegions(state, srcW, srcH);
    regions.forEach((r) => applyEffect(ctx, src, r, state.settings, k, srcW, srcH, cw, ch));
    return regions.length;
  }

  function drawOriginal(canvas, src, srcW, srcH, scale) {
    return render(canvas, src, srcW, srcH, { faces: [], manual: [], settings: {} }, scale);
  }

  /* Small square-ish crop for the face list */
  function drawCrop(canvas, src, r, size) {
    size = size || 44;
    const ratio = r.w / r.h;
    canvas.width = ratio >= 1 ? size : Math.round(size * ratio);
    canvas.height = ratio >= 1 ? Math.round(size / ratio) : size;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, r.x, r.y, r.w, r.h, 0, 0, canvas.width, canvas.height);
  }

  window.ImageEditor = { render, drawOriginal, drawCrop, getRegions, supportsFilter };
})();