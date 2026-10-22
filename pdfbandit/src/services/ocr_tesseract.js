// OCR for scanned regions (spec §22.2). Tesseract.js runs entirely in the browser:
// the page crop never leaves the machine, while the engine, WASM core and language
// data are fetched from jsDelivr on first use and cached by the browser afterwards.
//
// The module stays import-safe under Node: loading the engine is lazy and only
// happens inside recognizeImage(). The pure result mapper is exported for tests.
const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.min.js';

// Tesseract language data uses ISO 639-2/T codes. The app's picker uses ISO 639-1.
const TESS_LANG = {
  en: 'eng', ar: 'ara', az: 'aze', bg: 'bul', bn: 'ben', ca: 'cat', cs: 'ces',
  da: 'dan', de: 'deu', el: 'ell', es: 'spa', et: 'est', fa: 'fas', fi: 'fin',
  fr: 'fra', ga: 'gle', he: 'heb', hi: 'hin', hu: 'hun', id: 'ind', it: 'ita',
  ja: 'jpn', ko: 'kor', lt: 'lit', lv: 'lav', ms: 'msa', nb: 'nor', nl: 'nld',
  pl: 'pol', pt: 'por', ro: 'ron', ru: 'rus', sk: 'slk', sl: 'slv', sq: 'sqi',
  sr: 'srp', sv: 'swe', th: 'tha', tr: 'tur', uk: 'ukr', ur: 'urd', vi: 'vie',
};

export function tesseractLanguage(code) {
  const value = String(code || '').trim().toLowerCase();
  const raw = value.replace(/_/g, '-');
  if (!raw || raw === 'auto') return 'eng';
  if (raw.startsWith('zh-hant') || raw === 'zh-tw' || raw === 'zh-hk') return 'chi_tra';
  if (raw.startsWith('zh')) return 'chi_sim';
  // A caller may already pass a Tesseract code (eng, fra, chi_sim…). Preserve the
  // underscore form before splitting on hyphens; `zh_*` was handled above.
  if (/^[a-z]{3}(?:_[a-z]+)?$/.test(value)) return value;
  const base = raw.split('-')[0];
  if (TESS_LANG[base]) return TESS_LANG[base];
  return /^[a-z]{3}$/.test(base) ? base : 'eng';
}

const RTL_CHARS = /[\u0590-\u05FF\u0600-\u06FF\u0700-\u074F\u0750-\u077F\u0780-\u07BF\u08A0-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/g;
const LTR_CHARS = /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF]/g;
const HEBREW = /[\u0590-\u05FF\uFB1D-\uFB4F]/g;
const ARABIC = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g;

function detectDir(text) {
  const s = String(text || '');
  const rtl = (s.match(RTL_CHARS) || []).length;
  const ltr = (s.match(LTR_CHARS) || []).length;
  return rtl > ltr ? 'rtl' : 'ltr';
}

function detectSourceLang(text) {
  const s = String(text || '');
  const he = (s.match(HEBREW) || []).length;
  const ar = (s.match(ARABIC) || []).length;
  if (!he && !ar) return 'auto';
  return he > ar ? 'he' : 'ar';
}

// OCR is noisier than a text layer. Keep the same contract as the text-layer
// reader's quality gate (empty / broken / no letters), but be a little more
// forgiving: OCR often emits a stray punctuation mark around real words.
function ocrTextQuality(raw) {
  const t = String(raw || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/\s+/g, ' ').trim();
  if (t.length < 2) return { ok: false, reason: 'empty' };
  if (/\(cid:\d+\)/.test(t)) return { ok: false, reason: 'garbage' };
  const replacement = (t.match(/\uFFFD/g) || []).length;
  if (replacement / t.length > 0.02) return { ok: false, reason: 'garbage' };
  const letters = (t.match(/[\p{L}\p{N}]/gu) || []).length;
  const nonSpace = t.replace(/\s/g, '').length || 1;
  if (letters / nonSpace < 0.4) return { ok: false, reason: 'garbage' };
  return { ok: true };
}

function median(values) {
  const xs = values.filter(v => Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return 0;
  return xs[Math.floor(xs.length / 2)];
}

function cleanLine(value) {
  return String(value || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/[ \t]+/g, ' ').trim();
}

function lineFromTesseract(line, scale) {
  const text = cleanLine(line?.text);
  if (!text) return null;
  const confidence = Number(line?.confidence);
  // Tesseract uses 0…100; undefined/0 may simply mean the engine did not report it.
  // Keep a low-confidence line only if it still looks like text, below.
  const bbox = line?.bbox || {};
  const h = Math.max(0, Number(bbox.y1) - Number(bbox.y0)) / scale;
  const size = Math.max(6, Math.min(96, h || 12));
  return { text, size, confidence: Number.isFinite(confidence) ? confidence : null, dir: detectDir(text) };
}

function collectLines(data, scale) {
  const out = [];
  const blocks = Array.isArray(data?.blocks) ? data.blocks : [];
  for (const block of blocks) {
    for (const paragraph of block?.paragraphs || []) {
      for (const line of paragraph?.lines || []) {
        const parsed = lineFromTesseract(line, scale);
        if (parsed) out.push(parsed);
      }
    }
  }
  if (!out.length && typeof data?.text === 'string') {
    for (const text of data.text.split(/\r?\n/)) {
      const parsed = lineFromTesseract({ text, bbox: null }, scale);
      if (parsed) out.push(parsed);
    }
  }
  // A line with an explicitly reported, very low confidence is usually noise. Do not
  // let one such line poison an otherwise usable crop; drop it before the text check.
  const confident = out.filter(l => l.confidence == null || l.confidence >= 20);
  return confident.length ? confident : out;
}

/**
 * Map a Tesseract.js result to the same intermediate shape the text-layer reader
 * returns. `scale` is the OCR render's pixels per PDF point; it only affects the
 * inferred font size. Pure, so the result can be tested without a browser.
 */
export function ocrExtractionFromData(data, scale = 1) {
  const s = Number(scale) > 0 ? Number(scale) : 1;
  const raw = collectLines(data, s);
  if (!raw.length) return { ok: false, reason: 'empty' };
  const text = raw.map(l => l.text).join('\n');
  const q = ocrTextQuality(text);
  if (!q.ok) return { ok: false, reason: q.reason };
  const dir = detectDir(text);
  const ordered = raw.map(line => {
    const rounded = Math.max(6, Math.min(96, Math.round(line.size)));
    const chars = [...line.text].map(() => ({
      size: rounded, font: 'sans', bold: false, italic: false,
    }));
    return { text: line.text, chars, dir: line.dir, font: rounded };
  });
  const size = Math.max(6, Math.min(96, Math.round(median(ordered.map(l => l.font)))));
  const maxSize = Math.max(...ordered.map(l => l.font));
  const heading = ordered.length <= 3 && maxSize >= Math.max(16, size * 1.35);
  return {
    ok: true,
    text,
    lines: ordered,
    lineCount: ordered.length,
    dir,
    size,
    heading,
    sourceLang: detectSourceLang(text),
  };
}

let enginePromise = null;
let workerPromise = null;
let workerLang = '';
let progressSink = null;

function reportProgress(m) {
  if (!progressSink || !m) return;
  const fraction = Number(m.progress);
  progressSink(Number.isFinite(fraction) ? fraction : null, m.status || 'OCR');
}

function loadEngine() {
  const injected = globalThis.__PMAP_TESSERACT_ENGINE;
  if (injected?.createWorker) return Promise.resolve(injected);
  if (globalThis.Tesseract?.createWorker) return Promise.resolve(globalThis.Tesseract);
  if (enginePromise) return enginePromise;
  enginePromise = new Promise((resolve, reject) => {
    if (typeof document === 'undefined') { reject(new Error('OCR requires a browser')); return; }
    const script = document.createElement('script');
    script.src = globalThis.__PMAP_TESSERACT_URL || TESSERACT_URL;
    script.async = true;
    script.onload = () => {
      if (globalThis.Tesseract?.createWorker) resolve(globalThis.Tesseract);
      else reject(new Error('Tesseract.js loaded but createWorker is missing'));
    };
    script.onerror = () => reject(new Error('Could not load Tesseract.js'));
    document.head.appendChild(script);
  }).catch((e) => { enginePromise = null; throw e; });
  return enginePromise;
}

async function getWorker(T, lang) {
  if (workerPromise && workerLang === lang) return workerPromise;
  if (workerPromise) {
    const old = await workerPromise.catch(() => null);
    try { await old?.terminate?.(); } catch {}
    workerPromise = null;
  }
  workerLang = lang;
  workerPromise = (async () => T.createWorker(lang, T.OEM?.LSTM_ONLY ?? 1, {
    logger: reportProgress,
    errorHandler: () => {},
  }))();
  try { return await workerPromise; }
  catch (e) { workerPromise = null; workerLang = ''; throw e; }
}

/**
 * Recognize one crop. `image` can be a data URL, Blob, canvas or whatever the
 * Tesseract.js version accepts. Throws on engine/worker failure; callers map that
 * to the §18 `ocr-unavailable` reason rather than inventing text.
 */
export async function recognizeImage(image, { lang = 'en', onProgress } = {}) {
  progressSink = typeof onProgress === 'function' ? onProgress : null;
  try {
    const T = await loadEngine();
    const worker = await getWorker(T, tesseractLanguage(lang));
    const result = await worker.recognize(image, {}, { text: true, blocks: true });
    if (!result?.data) throw new Error('OCR returned no result');
    return result.data;
  } finally {
    progressSink = null;
  }
}
