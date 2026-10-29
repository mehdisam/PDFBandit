// pdf.js wrapper: load document, render pages, thumbnails. No map logic.
import * as pdfjs from 'pdfjs-dist';

// Use the same CDN as the importmap for consistency
// Configure worker to prevent main-thread blocking
pdfjs.GlobalWorkerOptions.workerSrc =
  'https://esm.sh/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';
pdfjs.GlobalWorkerOptions.workerPort = null; // Use default message channel
// pdfjs.verbosity = 0; // verbosity is read-only in newer versions

export class PdfViewer {
  constructor() {
    this.doc = null;
    this.pageCount = 0;
    this.baseSizes = new Map(); // pageNum -> {width,height} in points at scale 1
    this.fontMaps = new Map();  // pageNum -> Map(loadedName -> { name, bold, italic })
    this.textLayerCache = new Map(); // pageNum -> boolean
    this.documentLanguageCache = undefined; // undefined = not read yet, null = not declared
    this.ocrCanvasCache = null; // { pageNum, scale, canvas } for the current OCR page
    // Detection proposals per page + requested tier. Reading the operator list makes pdf.js
    // decode every figure image, which can take seconds on an image-heavy page; the proposals
    // for a given page and tier cannot change during a session, so a rerun is free. Cleared
    // when another document is loaded.
    this.detectCache = new Map();
  }
  async close() {
    if (this.renderTask) {
      try { this.renderTask.cancel(); await this.renderTask.promise.catch(() => {}); } catch {}
      this.renderTask = null;
    }
    if (this.textLayer) {
      try { this.textLayer.cancel?.(); } catch {}
      this.textLayer = null;
    }
    if (this.doc) { try { await this.doc.destroy(); } catch {} }
    this.doc = null;
    this.pageCount = 0;
    this.baseSizes.clear();
    this.fontMaps.clear();
    this.textLayerCache.clear();
    this.documentLanguageCache = undefined;
    this.ocrCanvasCache = null;
    this.detectCache.clear();
  }
  async load(arrayBuffer) {
    if (this.doc) { try { await this.doc.destroy(); } catch {} }
    const buf = arrayBuffer.slice(0);
    this.doc = await pdfjs.getDocument({ data: buf }).promise;
    this.pageCount = this.doc.numPages;
    this.baseSizes.clear();
    this.fontMaps.clear();
    this.textLayerCache.clear();
    this.documentLanguageCache = undefined;
    this.ocrCanvasCache = null;
    this.detectCache.clear();
    return this.pageCount;
  }
  // The document's declared language, for pre-filling the PDF-language question
  // (spec 1.6 §7.2). PDF /Lang wins, then the XMP dc:language property. This is a
  // *hint only*: the user is still asked, because metadata is frequently wrong or
  // missing. Returns a normalised code (e.g. `fr`, `pt-BR`) or null.
  async documentLanguage() {
    if (this.documentLanguageCache !== undefined) return this.documentLanguageCache;
    const candidates = [];
    const collect = (value) => {
      if (value == null) return;
      if (typeof value === 'string') { candidates.push(value); return; }
      if (Array.isArray(value)) { for (const v of value) collect(v); return; }
      if (typeof value === 'object') { collect(value.value); collect(value.lang); }
    };
    try {
      const { info, metadata } = await this.doc.getMetadata();
      collect(info?.Language);
      collect(metadata?.get?.('dc:language'));
    } catch { /* metadata is optional: fall through to no hint */ }
    for (const candidate of candidates) {
      const code = String(candidate).trim().toLowerCase().replace(/_/g, '-');
      if (/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/.test(code)) {
        this.documentLanguageCache = code;
        return code;
      }
    }
    this.documentLanguageCache = null;
    return null;
  }
  async baseSize(pageNum) {
    if (this.baseSizes.has(pageNum)) return this.baseSizes.get(pageNum);
    const page = await this.doc.getPage(pageNum);
    const vp = page.getViewport({ scale: 1 });
    const s = { width: vp.width, height: vp.height };
    this.baseSizes.set(pageNum, s);
    page.cleanup();
    return s;
  }
  async renderTo(canvas, pageNum, scale) {
    if (this.renderTask) {
      try { this.renderTask.cancel(); await this.renderTask.promise.catch(() => {}); } catch {}
      this.renderTask = null;
    }
    const page = await this.doc.getPage(pageNum);
    const vp = page.getViewport({ scale });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(vp.width * dpr);
    canvas.height = Math.round(vp.height * dpr);
    canvas.style.width = `${vp.width}px`;
    canvas.style.height = `${vp.height}px`;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const task = page.render({ canvasContext: ctx, viewport: vp });
    this.renderTask = task;
    try { await task.promise; } catch (e) { if (e?.name !== 'RenderingCancelledException') { page.cleanup(); this.renderTask = null; throw e; } }
    this.renderTask = null;
    page.cleanup();
    return { cssWidth: vp.width, cssHeight: vp.height };
  }
  // Region detection for a single page. Per-page page strategy (spec 1.5 §19): a page with
  // a text layer uses tier-1 digital detection; a page without one uses the CV detector.
  // `tier` is `auto` (default), `digital` or `cv` (Preferences… override). `engine` picks the
  // CV implementation: `classical` (dependency-free) or `opencv` (lazy ~10 MB OpenCV.js).
  // Returns { regions:[{type,points}], notes:[string], width, height, tier, engine } in PDF
  // points (top-left origin). `notes` carries non-fatal detection problems for the status bar.
  async detectRegions(pageNum, { tier = 'auto', engine = 'classical', onProgress } = {}) {
    const eng = engine === 'opencv' ? 'opencv' : 'classical';
    const cacheKey = `${pageNum}:${tier}:${eng}`;
    const cached = this.detectCache.get(cacheKey);
    if (cached) return structuredClone(cached);
    const page = await this.doc.getPage(pageNum);
    const vp = page.getViewport({ scale: 1 });
    const remember = (result) => { this.detectCache.set(cacheKey, result); return structuredClone(result); };
    try {
      const useCv = tier === 'cv' ? true : tier === 'digital' ? false : !(await this.pageHasTextLayer(page));
      if (!useCv) {
        const { detectPageRegions } = await import('../services/detect_digital.js');
        const out = await detectPageRegions(page, vp);
        // Accept the pre-4a1e820 array return too, so a browser holding an old cached module
        // cannot turn detection into an opaque TypeError.
        const regions = Array.isArray(out) ? out : (Array.isArray(out?.regions) ? out.regions : []);
        const notes = Array.isArray(out?.notes) ? out.notes : [];
        return remember({ regions, notes, width: vp.width, height: vp.height, tier: 'digital', engine: 'digital' });
      }
      const { detectCvRegions, cvScale } = await import('../services/detect_cv.js');
      const scale = cvScale(vp);
      const bitmap = await this.renderImageData(page, scale);
      const pt = { width: vp.width, height: vp.height };
      if (eng === 'opencv') {
        try {
          const { detectOpenCvRegions } = await import('../services/detect_opencv.js');
          const regions = await detectOpenCvRegions(bitmap, pt, scale, { onProgress });
          return remember({ regions, notes: [], ...pt, tier: 'cv', engine: 'opencv' });
        } catch (e) {
          const note = `OpenCV.js unavailable (${(e && e.message) || e}); used classical CV`;
          const regions = detectCvRegions(bitmap, pt, scale);
          const result = { regions, notes: [note], ...pt, tier: 'cv', engine: 'classical' };
          // Cache the fallback under the classical key so a later classical run is instant,
          // but without the OpenCV-specific note; leave the OpenCV key empty so a retry can
          // attempt the load again (e.g. after a transient network failure).
          this.detectCache.set(`${pageNum}:${tier}:classical`, { ...result, notes: [] });
          return structuredClone(result);
        }
      }
      const regions = detectCvRegions(bitmap, pt, scale);
      return remember({ regions, notes: [], ...pt, tier: 'cv', engine: 'classical' });
    } finally {
      page.cleanup();
    }
  }
  // Does the page expose a text layer at all? Cheap and safe: pdf.js resolves an empty
  // item list for a scanned page, so this never throws on one.
  async pageHasTextLayer(page) {
    const n = page.pageNumber;
    if (this.textLayerCache.has(n)) return this.textLayerCache.get(n);
    let has = false;
    try {
      const tc = await page.getTextContent();
      has = (tc.items || []).some(it => it.str && it.str.trim());
    } catch { has = false; }
    this.textLayerCache.set(n, has);
    return has;
  }
  // Best-effort per-run weight/italic (spec 1.5 §18): pdf.js's text layer carries only a
  // generic family and the glyph size, so the one signal for bold/italic is the PDF's
  // BaseFont name. The font objects pdf.js resolved for the page live in commonObjs,
  // keyed by the same loadedName the text items use. Cached per page; if the internals
  // are unavailable the map is empty and extraction still gets size + family runs.
  async fontStyleMap(page) {
    const n = page.pageNumber;
    if (this.fontMaps.has(n)) return this.fontMaps.get(n);
    const out = new Map();
    try {
      const ops = await page.getOperatorList();
      const setFont = pdfjs.OPS.setFont;
      for (let i = 0; i < ops.fnArray.length; i++) {
        if (ops.fnArray[i] !== setFont) continue;
        const id = ops.argsArray[i] && ops.argsArray[i][0];
        if (typeof id !== 'string' || out.has(id)) continue;
        try {
          if (page.commonObjs.has && !page.commonObjs.has(id)) continue;
          const f = page.commonObjs.get(id);
          const name = String(f && f.name || '');
          out.set(id, {
            name,
            bold: !!(f && f.bold) || /bold|black|heavy|semibold|demibold/i.test(name),
            italic: !!(f && f.italic) || /italic|oblique/i.test(name),
          });
        } catch { /* not resolved: fall back to family + size */ }
      }
    } catch { /* fonts unavailable: family + size runs still work */ }
    this.fontMaps.set(n, out);
    return out;
  }
  // Render a page to a plain (device-scale-free) ImageData at `scale`, for the CV detector.
  async renderImageData(page, scale) {
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(vp.width));
    canvas.height = Math.max(1, Math.round(vp.height));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    return ctx.getImageData(0, 0, canvas.width, canvas.height);
  }
  // Render a page once at OCR resolution and keep only the current page's canvas. A
  // scan run walks regions page by page, so this makes the full-page render cost one
  // per page instead of one per region. Cleared when another document is loaded.
  async ocrPageCanvas(pageNum, scale) {
    if (this.ocrCanvasCache && this.ocrCanvasCache.pageNum === pageNum && this.ocrCanvasCache.scale === scale) {
      return this.ocrCanvasCache.canvas;
    }
    const page = await this.doc.getPage(pageNum);
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(vp.width));
    canvas.height = Math.max(1, Math.round(vp.height));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    page.cleanup();
    this.ocrCanvasCache = { pageNum, scale, canvas };
    return canvas;
  }
  // A white-background PNG crop exactly inside the region polygon, at ~300 DPI (capped
  // by 4000 px on the page's long edge). OCR gets no pixels from outside the polygon,
  // so a nearby column cannot leak into the region's text. Returns { image, scale,
  // width, height }; `scale` converts Tesseract pixel boxes back to PDF points.
  async cropRegionForOcr(pageNum, rings, { scale } = {}) {
    if (!Array.isArray(rings?.[0]?.[0])) rings = [rings];
    const rs = (rings || []).filter(r => Array.isArray(r) && r.length >= 3);
    if (!rs.length) throw new Error('region has no polygon');
    const size = await this.baseSize(pageNum);
    const maxEdge = 4000;
    const s = Number(scale) || Math.max(0.5, Math.min(4, maxEdge / Math.max(size.width, size.height)));
    const full = await this.ocrPageCanvas(pageNum, s);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const ring of rs) for (const [x, y] of ring) {
      x0 = Math.min(x0, x); y0 = Math.min(y0, y);
      x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
    if (![x0, y0, x1, y1].every(Number.isFinite) || x1 <= x0 || y1 <= y0) {
      throw new Error('region has an empty bounding box');
    }
    const dx = Math.max(0, Math.round(x0 * s));
    const dy = Math.max(0, Math.round(y0 * s));
    const w = Math.max(1, Math.round((x1 - x0) * s));
    const h = Math.max(1, Math.round((y1 - y0) * s));
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.save();
    ctx.beginPath();
    for (const ring of rs) {
      ring.forEach(([x, y], i) => {
        const px = x * s - dx, py = y * s - dy;
        if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
      });
      ctx.closePath();
    }
    ctx.clip();
    ctx.drawImage(full, dx, dy, w, h, 0, 0, w, h);
    ctx.restore();
    return { image: out.toDataURL('image/png'), scale: s, width: w, height: h };
  }
  async renderThumbnail(canvas, pageNum) {
    const page = await this.doc.getPage(pageNum);
    const v1 = page.getViewport({ scale: 1 });
    const scale = 120 / v1.width;
    const vp = page.getViewport({ scale });
    canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    page.cleanup();
  }
  // Crop a PDF-point bbox to a dataURL (for IMAGE content / export).
  async cropDataUrl(pageNum, bboxPdf, scale = 2) {
    const page = await this.doc.getPage(pageNum);
    const vp = page.getViewport({ scale });
    const [x0, y0, x1, y1] = bboxPdf.map(v => v * scale);
    const w = Math.max(1, Math.round(x1 - x0)), h = Math.max(1, Math.round(y1 - y0));
    const full = document.createElement('canvas');
    full.width = Math.round(vp.width); full.height = Math.round(vp.height);
    await page.render({ canvasContext: full.getContext('2d'), viewport: vp }).promise;
    page.cleanup();
    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    out.getContext('2d').drawImage(full, Math.round(x0), Math.round(y0), w, h, 0, 0, w, h);
    return out.toDataURL('image/png');
  }
  // Crop a polygon area (clipped exactly to the polygon) to a PNG blob.
  // `rings` is one or more polygon rings (a region may be multi-part after a merge).
  async cropPolygonBlob(pageNum, rings, scale = 2) {
    if (!Array.isArray(rings?.[0]?.[0])) rings = [rings];
    const page = await this.doc.getPage(pageNum);
    const vp = page.getViewport({ scale });
    const full = document.createElement('canvas');
    full.width = Math.round(vp.width);
    full.height = Math.round(vp.height);
    const fctx = full.getContext('2d');
    await page.render({ canvasContext: fctx, viewport: vp }).promise;
    page.cleanup();
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const ring of rings) for (const [x, y] of ring) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    const dx = x0 * scale, dy = y0 * scale;
    const w = Math.max(1, Math.round((x1 - x0) * scale)), h = Math.max(1, Math.round((y1 - y0) * scale));
    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    const ctx = out.getContext('2d');
    ctx.save();
    ctx.beginPath();
    for (const ring of rings) ring.forEach(([x, y], i) => { const sx = x * scale - dx, sy = y * scale - dy; i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); });
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(full, dx, dy, w, h, 0, 0, w, h);
    ctx.restore();
    return await new Promise((res, rej) => out.toBlob(b => b ? res(b) : rej(new Error('toBlob failed')), 'image/png'));
  }
  // Render selectable text layer for digital PDFs over the canvas.
  async renderTextLayer(container, pageNum, scale) {
    if (this.textLayer) { try { this.textLayer.cancel?.(); } catch {} this.textLayer = null; }
    container.innerHTML = '';
    const page = await this.doc.getPage(pageNum);
    const vp = page.getViewport({ scale });
    container.style.setProperty('--scale-factor', String(scale));
    container.style.width = `${vp.width}px`;
    container.style.height = `${vp.height}px`;
    const textLayer = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container, viewport: vp });
    this.textLayer = textLayer;
    await textLayer.render();
    page.cleanup();
    return textLayer;
  }
}
