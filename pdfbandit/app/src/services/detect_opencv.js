// Opt-in heavy CV tier (spec 1.5 §19). OpenCV.js replaces only the bitmap segmentation:
// grayscale → adaptive threshold (one page polarity) → morphological close → external
// contours. The resulting raw boxes go through the same classifier, text grouping, figure
// cleanup and PDF-points conversion as the classical tier, so both engines share one
// proposal contract and differ only in how they find candidate blocks.
//
// This uses the OpenCV 4.10 WASM build with a **separate 8 MB .wasm** (the package is a
// fork of the OpenCV.js build; Apache-2.0). Loading the common single-file build would
// mean parsing a ~10 MB script with the WASM base64-embedded — a long synchronous decode
// on the main thread. The separate binary compiles asynchronously and can be streamed
// with a real progress bar. It is fetched lazily on the first scanned page detected with
// this engine, never at startup, and is cached by the browser HTTP cache and `cvPromise`.
// The default classical tier stays dependency-free and can run offline; the viewer falls
// back to it if this download or initialization fails, with a status note.

import { assembleBlocks, blocksToRegions, medianSample } from './detect_cv.js';

// Pinned, self-contained ESM glue (≈210 KB) + its 8 MB WASM. Both URLs are overridable
// only for the offline smoke harness; production uses the CDN (which sends CORS `*`).
export const OPENCV_MODULE_URL = 'https://cdn.jsdelivr.net/npm/@dusion/opencv-js@4.10.0-release.6/dist/index.web.mjs';
export const OPENCV_WASM_URL = 'https://cdn.jsdelivr.net/npm/@dusion/opencv-js@4.10.0-release.6/lib/opencv_js.wasm';
// Decoded size of the pinned `opencv_js.wasm`. jsDelivr compresses it, so the response's
// `content-length` is the encoded size (~2.4 MB) while the stream yields these 8,053,016
// bytes; using the known decoded size keeps the download bar honest. Overrides fall back
// to the header (or an indeterminate MB label when the response is encoded).
const OPENCV_WASM_BYTES = 8053016;
const LOAD_TIMEOUT_MS = 45000;

// Mirrors detect_cv.js's pre-classification filters. Kept here (rather than exported
// tuning constants) because these are only a cheap early-out; the shared classifier
// applies the authoritative minimum sizes afterwards.
const MIN_SIDE = 3;          // px — drop degenerate slivers
const MIN_AREA_FRAC = 2e-5;  // drop specks (fraction of the page)
const MAX_COVER = 0.92;      // the scan background is not a region
const ADAPT_C = 10;          // same local-mean contrast as the classical tier
const CLOSE_W_FRAC = 0.012;  // bridge inter-word gaps; a line becomes one blob
const CLOSE_H_FRAC = 0.010;  // merge adjacent lines into one block

let cvPromise = null;

function moduleUrl() {
  const override = globalThis.__PMAP_OPENCV_MODULE_URL;
  return typeof override === 'string' && override ? override : OPENCV_MODULE_URL;
}
function wasmUrl() {
  const override = globalThis.__PMAP_OPENCV_WASM_URL;
  return typeof override === 'string' && override ? override : OPENCV_WASM_URL;
}
function odd(n) {
  const v = Math.max(3, Math.round(n));
  return v % 2 ? v : v + 1;
}

// Fetch the WASM with byte progress (a plain `fetch().arrayBuffer()` gives none) and a
// timeout so an unreachable CDN becomes a fallback instead of a hung Detect. The buffer
// is handed to OpenCV's `wasmBinary` option, so there is no second request for the same
// file and no dependence on its relative URL.
async function fetchWasm(url, onProgress) {
  const ac = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ac ? setTimeout(() => ac.abort(), LOAD_TIMEOUT_MS) : null;
  try {
    const res = await fetch(url, { credentials: 'omit', signal: ac?.signal });
    if (!res.ok) throw new Error(`WASM download failed (HTTP ${res.status})`);
    const headerTotal = Number(res.headers.get('content-length')) || 0;
    const encoded = !!res.headers.get('content-encoding');
    const expected = url === OPENCV_WASM_URL ? OPENCV_WASM_BYTES : 0;
    // The stream is decoded, so a compressed response's header cannot size it; prefer the
    // pinned decoded size for the CDN and use the header only for uncompressed overrides.
    const total = expected || (encoded ? 0 : headerTotal);
    if (!res.body || typeof res.body.getReader !== 'function') {
      const buf = await res.arrayBuffer();
      onProgress?.({ phase: 'download', received: buf.byteLength, total: total || buf.byteLength, fraction: 1 });
      return buf;
    }
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      onProgress?.({
        phase: 'download', received, total,
        fraction: total ? Math.min(1, received / total) : 0,
      });
    }
    if (!received) throw new Error('WASM download was empty');
    const out = new Uint8Array(received);
    let offset = 0;
    for (const c of chunks) { out.set(c, offset); offset += c.length; }
    return out.buffer;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    Promise.resolve(promise).then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

async function load(onProgress) {
  const mod = await withTimeout(import(moduleUrl()), LOAD_TIMEOUT_MS, 'module did not load within 45 s');
  const cv = mod.default;
  if (!cv || typeof cv.loadOpenCV !== 'function') throw new Error('OpenCV module has no loadOpenCV');
  const wasm = await fetchWasm(wasmUrl(), onProgress);
  onProgress?.({ phase: 'init' });
  await withTimeout(cv.loadOpenCV(wasm), LOAD_TIMEOUT_MS, 'runtime did not initialize within 45 s');
  if (!cv.Mat) throw new Error('OpenCV initialized without Mat');
  return cv;
}

// Public loader. Concurrent callers share one load; a failed load can be retried.
// `onProgress` receives {phase:'module'|'download'|'init', received, total, fraction}.
export async function loadOpenCv(onProgress) {
  if (cvPromise) return cvPromise;
  const report = typeof onProgress === 'function' ? onProgress : null;
  report?.({ phase: 'module' });
  cvPromise = load(report).catch((e) => {
    cvPromise = null;
    throw e;
  });
  return cvPromise;
}

// The OpenCV segmentation on one RGBA bitmap. Returns pixel boxes plus the grayscale
// page for the shared classifier.
export async function opencvBoxes(imageData, opts = {}) {
  const cv = await loadOpenCv(opts.onProgress);
  const width = imageData.width, height = imageData.height;
  const long = Math.max(width, height);
  const blockSize = odd(long / 16);
  const kw = odd(long * CLOSE_W_FRAC);
  const kh = odd(long * CLOSE_H_FRAC);
  const minArea = long * long * MIN_AREA_FRAC;
  const pageArea = width * height;
  const boxes = [];
  const mats = [];
  const mat = (m) => { mats.push(m); return m; };
  try {
    const src = mat(cv.matFromImageData(imageData));
    const gray = mat(new cv.Mat());
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    const kernel = mat(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(kw, kh)));
    const grayCopy = new Uint8Array(gray.data); // avoid using a Mat after cleanup
    // Choose one polarity from the page median, exactly like the classical tier. Running
    // both created duplicate contours and, worse, panel/background contours on covers;
    // the per-block classifier below still handles knockout (light-on-dark) text.
    const mode = medianSample(grayCopy, width * height) < 128 ? cv.THRESH_BINARY : cv.THRESH_BINARY_INV;
    const bin = mat(new cv.Mat());
    const closed = mat(new cv.Mat());
    cv.adaptiveThreshold(gray, bin, 255, cv.ADAPTIVE_THRESH_MEAN_C, mode, blockSize, ADAPT_C);
    cv.morphologyEx(bin, closed, cv.MORPH_CLOSE, kernel);
    const contours = mat(new cv.MatVector());
    const hierarchy = mat(new cv.Mat());
    cv.findContours(closed, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const r = cv.boundingRect(c);
      c.delete();
      const w = r.width, h = r.height, area = w * h;
      if (w < MIN_SIDE || h < MIN_SIDE || area < minArea || area / pageArea > MAX_COVER) continue;
      boxes.push({ x0: r.x, y0: r.y, x1: r.x + w, y1: r.y + h, ink: 0 });
    }
    return { boxes, gray: grayCopy, width, height };
  } finally {
    for (const m of mats) {
      try { m.delete(); } catch { /* already gone */ }
    }
  }
}

// Whole contract on a bitmap: OpenCV segmentation → shared structural classifier →
// PDF-point polygons. `scale` is pixels per point; `onProgress` reports the lazy load.
export async function detectOpenCvRegions(imageData, pt, scale, opts = {}) {
  const { boxes, gray, width, height } = await opencvBoxes(imageData, opts);
  return blocksToRegions(assembleBlocks(gray, width, height, boxes, { scale }), pt, scale);
}
