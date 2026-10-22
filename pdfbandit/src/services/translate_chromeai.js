// Chrome's built-in, on-device Translator API — no API key, no server, and the
// text never leaves the browser. It is Chrome-only (desktop, Chrome 138+).
//
// The API surface moved around while it was experimental, so we detect whichever
// global is present instead of assuming one:
//
//   Chrome 138+  Translator.availability({sourceLanguage, targetLanguage})
//                Translator.create({sourceLanguage, targetLanguage, monitor, signal})
//   Chrome 131–137  translation.canTranslate({...}) / translation.createTranslator({...})
//   first origin trial  ai.translator.capabilities() / ai.translator.create({...})
//
// In every flavour: `translator.translate(text)` -> string, `translator.destroy()`,
// and `monitor(m) { m.addEventListener('downloadprogress', e => e.loaded /*0..1*/) }`.
// `availability()` answers 'available' | 'downloadable' | 'downloading' | 'unavailable'
// ('readily' / 'after-download' / 'no' on the older surface). The first use of a
// language pair downloads a model once (~1–2 GB) — we surface that via onProgress.
//
// Docs: https://developer.chrome.com/docs/ai/translator-api
//
// This module is DOM-free apart from feature detection on `globalThis`: callers
// pass an `onProgress(fraction, label)` hook and get { text } back, exactly like the
// other translation providers.

/** Typed, user-displayable failure. `code` lets the UI vary its advice. */
export class ChromeAiError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ChromeAiError';
    this.code = code;
  }
}

// The language codes Chrome's own Translator API accepts (from the docs above —
// it is the browser's list, not a general ISO table, and it changes between
// Chrome versions). Note there is no Persian (fa) or Urdu (ur), so RTL targets
// are limited to ar/he.
export const CHROME_AI_LANGUAGES = [
  'ar', 'bg', 'bn', 'cs', 'da', 'de', 'el', 'en', 'es', 'fi', 'fr', 'he', 'hi', 'hr',
  'hu', 'id', 'it', 'ja', 'kn', 'ko', 'lt', 'mr', 'nl', 'no', 'pl', 'pt', 'ro', 'ru',
  'sk', 'sl', 'sv', 'ta', 'te', 'th', 'tr', 'uk', 'vi', 'zh', 'zh-Hant',
];

const OTHER_PROVIDER = 'Pick another provider in Preferences… ▸ Translation Service, or use “Copy region as image” and translate it externally.';

// App/ISO spellings that differ from what Chrome expects.
const LANG_ALIASES = { nb: 'no', iw: 'he', in: 'id' };

// 'auto'/'und' -> '' (meaning "unknown"); otherwise a code Chrome-style code.
export function normalizeLang(code) {
  const raw = String(code ?? '').trim().toLowerCase();
  if (!raw || raw === 'auto' || raw === 'und') return '';
  if (/^zh[-_](hant|tw|hk|mo)$/.test(raw)) return 'zh-Hant';
  if (/^zh([-_]|$)/.test(raw)) return 'zh';
  const base = raw.split(/[-_]/)[0];
  return LANG_ALIASES[base] || base;
}

export function isChromeAiLanguage(code) {
  return CHROME_AI_LANGUAGES.includes(normalizeLang(code));
}

// Scripts that map to exactly one supported language. Latin, Cyrillic and
// Devanagari are deliberately absent: several supported languages share them, so
// guessing would silently mistranslate — the caller must pick a source language.
const SCRIPT_HINTS = [
  [/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/, 'ar'],
  [/[\u0590-\u05FF]/, 'he'],
  [/[\u0370-\u03FF\u1F00-\u1FFF]/, 'el'],
  [/[\u0980-\u09FF]/, 'bn'],
  [/[\u0B80-\u0BFF]/, 'ta'],
  [/[\u0C00-\u0C7F]/, 'te'],
  [/[\u0C80-\u0CFF]/, 'kn'],
  [/[\u0E00-\u0E7F]/, 'th'],
  [/[\u3040-\u30FF]/, 'ja'],
  [/[\uAC00-\uD7AF]/, 'ko'],
];

// Best-effort script -> language, used only when the caller asked for 'auto'.
export function detectScriptLang(text) {
  const s = String(text || '');
  if (!s) return '';
  for (const [re, code] of SCRIPT_HINTS) if (re.test(s)) return code;
  if (/[\u4E00-\u9FFF]/.test(s)) return 'zh';
  return '';
}

function coerceAvailability(v) {
  if (v === 'available' || v === 'readily') return 'available';
  if (v === 'downloadable' || v === 'after-download') return 'downloadable';
  if (v === 'downloading') return 'downloading';
  return 'unavailable';
}

// The first usable API surface, or null. Each surface is normalised to the
// current shape: { id, availability(src,dst), create(opts), supportsSignal }.
export function chromeAiSurface() {
  const w = globalThis;
  if (w.Translator && typeof w.Translator.availability === 'function' && typeof w.Translator.create === 'function') {
    return {
      id: 'Translator',
      supportsSignal: true,
      availability: async (src, dst) => coerceAvailability(
        await w.Translator.availability({ sourceLanguage: src, targetLanguage: dst }),
      ),
      create: (opts) => w.Translator.create(opts),
    };
  }
  if (w.translation && typeof w.translation.createTranslator === 'function') {
    return {
      id: 'translation',
      supportsSignal: false,
      availability: async (src, dst) => {
        if (typeof w.translation.canTranslate !== 'function') return 'downloadable';
        return coerceAvailability(await w.translation.canTranslate({ sourceLanguage: src, targetLanguage: dst }));
      },
      create: (opts) => w.translation.createTranslator(opts),
    };
  }
  if (w.ai && w.ai.translator && typeof w.ai.translator.create === 'function') {
    return {
      id: 'ai.translator',
      supportsSignal: false,
      availability: async (src, dst) => {
        const caps = typeof w.ai.translator.capabilities === 'function' ? await w.ai.translator.capabilities() : null;
        const v = caps?.languagePairAvailable
          ? caps.languagePairAvailable(src, dst)
          : (typeof caps?.available === 'function' ? caps.available(src, dst) : caps?.available);
        return v == null ? 'downloadable' : coerceAvailability(v);
      },
      create: (opts) => w.ai.translator.create(opts),
    };
  }
  return null;
}

function chromeVersion() {
  const ua = globalThis.navigator?.userAgent || '';
  const m = /(?:HeadlessChrome|Chrome|Chromium)\/(\d+)/.exec(ua);
  return m ? Number(m[1]) : 0;
}

export function isChromeBrowser() {
  return /Chrome\/|Chromium\//.test(globalThis.navigator?.userAgent || '');
}

// { ok, api } when usable, else { ok:false, api:null, reason } for the UI.
export function chromeAiStatus() {
  const surface = chromeAiSurface();
  if (surface) return { ok: true, api: surface.id };
  const w = globalThis;
  const present = !!(w.Translator || w.translation || w.ai);
  const v = chromeVersion();
  let reason;
  if (!isChromeBrowser()) {
    reason = 'this browser isn’t Chrome — on-device translation is Chrome-only (desktop, Chrome 138+)';
  } else if (present) {
    reason = 'Chrome exposes the Translator API here but it isn’t usable (it may be disabled by policy or an origin trial)';
  } else if (v && v < 138) {
    reason = `Chrome ${v} is too old — on-device translation needs Chrome 138+ on desktop`;
  } else {
    reason = 'this Chrome build doesn’t expose the on-device Translator API (needs Chrome 138+ on desktop)';
  }
  return { ok: false, api: null, reason };
}

// 'available' | 'downloadable' | 'downloading' | 'unavailable' for a pair.
export async function chromeAiAvailability(sourceLang, targetLang) {
  const surface = chromeAiSurface();
  if (!surface) throw new ChromeAiError('no-api', chromeAiStatus().reason);
  const src = normalizeLang(sourceLang);
  const dst = normalizeLang(targetLang);
  if (!src || !dst || src === dst) return 'unavailable';
  if (!isChromeAiLanguage(src) || !isChromeAiLanguage(dst)) return 'unavailable';
  try {
    return await surface.availability(src, dst);
  } catch (e) {
    if (e?.name === 'NotSupportedError') return 'unavailable';
    throw e;
  }
}

// One Translator per language pair, reused across calls. Aborting a controller
// cancels a download in flight, or destroys an already-created translator.
const CACHE = new Map();

/** Cancel any in-flight model download and drop the cached translators. */
export function cancelChromeAiDownload() {
  for (const entry of CACHE.values()) {
    try { entry.controller?.abort(); } catch {}
  }
  CACHE.clear();
}

function wrapCreateError(e, src, dst) {
  if (e instanceof ChromeAiError) return e;
  if (e?.name === 'AbortError') return new ChromeAiError('cancelled', 'The on-device model download was cancelled.');
  if (e?.name === 'NotAllowedError') {
    return new ChromeAiError('not-allowed', `Chrome needs a direct click to download the ${src} → ${dst} on-device model (or downloads are blocked). Try again with the “Translate from page text” button, or use another provider.`);
  }
  if (e?.name === 'NetworkError') {
    return new ChromeAiError('download-failed', `Couldn’t download the on-device ${src} → ${dst} model (network unavailable, or the download was cancelled). ${OTHER_PROVIDER}`);
  }
  if (e?.name === 'NotSupportedError') {
    return new ChromeAiError('unsupported-pair', `Chrome can’t translate ${src} → ${dst} on this device. ${OTHER_PROVIDER}`);
  }
  return new ChromeAiError('download-failed', `Couldn’t prepare on-device translation (${src} → ${dst}): ${e?.message || e}`);
}

function wrapTranslateError(e, src, dst) {
  if (e instanceof ChromeAiError) return e;
  if (e?.name === 'AbortError') return new ChromeAiError('cancelled', 'On-device translation was cancelled.');
  if (e?.name === 'QuotaExceededError') return new ChromeAiError('quota', 'This page hit Chrome’s on-device translation quota. Wait a moment, then try again — or use another provider.');
  if (e?.name === 'NotSupportedError') return new ChromeAiError('unsupported-pair', `Chrome can’t translate ${src} → ${dst} on this device. ${OTHER_PROVIDER}`);
  return new ChromeAiError('translate-failed', `On-device translation (${src} → ${dst}) failed: ${e?.message || e}`);
}

async function getTranslator(src, dst, opts) {
  const key = `${src}>${dst}`;
  const cached = CACHE.get(key);
  if (cached) {
    try { return await cached.promise; }
    catch (e) { CACHE.delete(key); throw e; }
  }
  const surface = chromeAiSurface();
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const entry = { controller, promise: null };
  const label = `Downloading the ${src} → ${dst} on-device model (one-time, ~1–2 GB)`;
  const onProgress = typeof opts?.onProgress === 'function' ? opts.onProgress : null;

  entry.promise = (async () => {
    const avail = await surface.availability(src, dst).catch(() => 'downloadable');
    if (avail === 'unavailable') {
      throw new ChromeAiError('unsupported-pair', `Chrome can’t translate ${src} → ${dst} on this device. ${OTHER_PROVIDER}`);
    }
    if (avail === 'downloadable' || avail === 'downloading') onProgress?.(0, label);
    const createOpts = {
      sourceLanguage: src,
      targetLanguage: dst,
      monitor(monitor) {
        monitor?.addEventListener?.('downloadprogress', (e) => {
          const loaded = Number(e?.loaded);
          onProgress?.(Number.isFinite(loaded) ? Math.max(0, Math.min(1, loaded)) : 0, label);
        });
      },
    };
    if (controller && surface.supportsSignal) createOpts.signal = controller.signal;
    let translator;
    try { translator = await surface.create(createOpts); }
    catch (e) { throw wrapCreateError(e, src, dst); }
    onProgress?.(1, label);
    return translator;
  })();

  CACHE.set(key, entry);
  try { return await entry.promise; }
  catch (e) { CACHE.delete(key); throw e; }
}

function resolveSource(sourceLang, text) {
  const explicit = normalizeLang(sourceLang);
  if (explicit) return explicit;
  const guess = detectScriptLang(text);
  if (guess) return guess;
  throw new ChromeAiError('needs-source', 'Chrome’s on-device translator can’t auto-detect the source language. Choose the source language in the toolbar (or use another provider in Preferences… ▸ Translation Service).');
}

function resultText(out) {
  if (typeof out === 'string') return out;
  return String(out?.text ?? out?.translatedText ?? out?.translation ?? '');
}

// The provider entry point. `text` is one or more lines; `sourceLang` may be
// 'auto' (resolved by script when it is unambiguous). Returns { text }.
export async function chromeAiTranslate(text, sourceLang, targetLang, opts = {}) {
  if (!chromeAiSurface()) throw new ChromeAiError('no-api', chromeAiStatus().reason);

  const dst = normalizeLang(targetLang);
  if (!dst || !isChromeAiLanguage(dst)) {
    throw new ChromeAiError('unsupported-pair', `Chrome’s on-device translator has no model for “${targetLang || '?'}” as a target language. ${OTHER_PROVIDER}`);
  }
  const src = resolveSource(sourceLang, text);
  if (src === dst) {
    throw new ChromeAiError('unsupported-pair', `Source and target are both ${src}, so there is nothing to translate. ${OTHER_PROVIDER}`);
  }
  if (!isChromeAiLanguage(src)) {
    throw new ChromeAiError('unsupported-pair', `Chrome’s on-device translator supports neither ${src} as a source here (its model list has no ${src}). ${OTHER_PROVIDER}`);
  }

  const translator = await getTranslator(src, dst, opts);
  try {
    const out = await translator.translate(String(text ?? ''));
    return { text: resultText(out) };
  } catch (e) {
    throw wrapTranslateError(e, src, dst);
  }
}
