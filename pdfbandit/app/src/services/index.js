// Pluggable service interfaces. OCR is on-device via Tesseract.js; table detection
// remains out of MVP. Translation optional.
import { chromeAiTranslate } from './translate_chromeai.js';
import { recognizeImage } from './ocr_tesseract.js';

export const OCRService = {
  // The §18 extraction primitive calls recognizeImage directly so it can map the
  // result through the same text-layer contract. This seam stays for callers that
  // want a raw Tesseract result.
  recognize(image, options = {}) { return recognizeImage(image, options); },
};

// ---- LibreTranslate instances -------------------------------------------------
// The instances below are all public LibreTranslate servers: the exact same HTTP
// API, differing only by host, so the client is a single POST to `<host>/translate`:
//
//   POST /translate   form-encoded { q, source, target, format: 'text', api_key? }
//     -> 200 { translatedText, detectedLanguage? }
//
// They are community-hosted and free: expect rate limits, downtime, and some
// instances requiring an API key (sent with the request when set). The PyPI
// `libretranslate` package is the *server* itself, not a browser client, so there
// is nothing to install here — this is the documented HTTP contract it serves.
//
// Public instances come and go: the list is kept to servers known to answer, and
// every entry's URL stays editable in Preferences… (the host is only a preset).
export const LIBRETRANSLATE_INSTANCES = [
  // Keyless and reachable from a *browser* (verified: a form POST answers 200 with
  // CORS `*`; `translate.disroot.org` answers curl but rejects Chrome, and the other
  // long-listed mirrors have since died or lost their certificates).
  { host: 'lt.dialectapp.org', url: 'https://lt.dialectapp.org/translate' },
  // The official server. Reliable, but the public endpoint requires an API key
  // (free at portal.libretranslate.com) — paste it in the API key field.
  { host: 'libretranslate.com', url: 'https://libretranslate.com/translate', needsKey: true },
];

// A provider id is `lt:<host>`, so the known instances and the custom-URL
// provider (`libretranslate`) never collide in localStorage.
export const providerIdForInstance = (host) => `lt:${host}`;
export const DEFAULT_INSTANCE = 'lt.dialectapp.org';
export const DEFAULT_PROVIDER = providerIdForInstance(DEFAULT_INSTANCE);
// The default instance's URL, so the UI can pre-fill the custom-URL field instead
// of failing with "URL not set" on the first translation.
export const DEFAULT_INSTANCE_URL =
  LIBRETRANSLATE_INSTANCES.find(i => i.host === DEFAULT_INSTANCE)?.url || LIBRETRANSLATE_INSTANCES[0].url;

const hostOf = (url) => String(url).replace(/^https?:\/\//, '').split('/')[0];

async function libreTranslate(text, src, dst, url, host, apiKey) {
  // Form-encoded body on purpose. Upstream LibreTranslate reads `request.values`
  // for non-JSON bodies (app.py), and `application/x-www-form-urlencoded` is a
  // CORS-*simple* content type: the browser sends the POST directly instead of a
  // preflight OPTIONS. Public instances sit behind proxies that mishandle (or
  // rate-limit) the preflight, which surfaced as an opaque "Failed to fetch"
  // even though the plain POST works.
  const body = new URLSearchParams({ q: text, source: src || 'auto', target: dst, format: 'text' });
  if (apiKey) body.set('api_key', apiKey);
  let res;
  try {
    res = await fetch(url, { method: 'POST', body });
  } catch (e) {
    throw new Error(`Cannot reach ${host} (offline, blocked, or CORS): ${e.message}`);
  }
  // Read the body once, even on failure: the server's own error text ("...get an API
  // key", "Slowdown: ...") tells the user far more than a bare status code.
  let payload = null;
  try { payload = await res.json(); } catch { payload = null; }
  if (!res.ok) {
    const detail = payload && typeof payload.error === 'string' ? `: ${payload.error}` : '';
    const extra = (res.status === 400 || res.status === 401 || res.status === 403 || res.status === 429)
      ? ' — the instance may need an API key, or be rate-limiting this client' : '';
    throw new Error(`${host} returned HTTP ${res.status}${detail}${extra}`);
  }
  const out = payload?.translatedText;
  if (typeof out !== 'string') throw new Error(`${host} returned no translation (${JSON.stringify(payload).slice(0, 120)})`);
  return { text: out };
}

// Translation providers selectable in the Preferences… ▸ Translation Service tab. Manual stays available
// and is the fallback; the default is the public Argos Open Tech LibreTranslate
// instance. Each instance is its own entry so the user picks the host directly.
export const translationProviders = {
  none: {
    label: 'None (manual / external)',
    async translate() { throw new Error('No translation provider selected. Use Copy region as image + paste the result.'); },
  },
  stub: {
    label: 'Stub (offline demo)',
    async translate(text, _src, dst) { return { text: `[${dst}] ${text}` }; },
  },
  libretranslate: {
    label: 'LibreTranslate (custom URL…)',
    custom: true,
    async translate(text, src, dst, opts = {}) {
      const url = String(opts.endpoint || '').trim();
      if (!url) throw new Error('LibreTranslate URL not set in Preferences… ▸ Translation Service.');
      return libreTranslate(text, src, dst, url, hostOf(url), opts.apiKey);
    },
  },
  // Chrome's built-in on-device model: free, private, no key or endpoint — but
  // Chrome-only. See translate_chromeai.js. Unavailable browsers still list it so
  // the user gets a reason instead of a mystery.
  'chrome-ai': {
    label: 'chrome-ai (on-device, Chrome only)',
    local: true,
    translate: (text, src, dst, opts = {}) => chromeAiTranslate(text, src, dst, opts),
  },
};
for (const inst of LIBRETRANSLATE_INSTANCES) {
  translationProviders[providerIdForInstance(inst.host)] = {
    // `needsKey` only decorates the label: the API key field is shown for every
    // LibreTranslate server and is simply empty when the server doesn't want one.
    label: inst.needsKey ? `${inst.host} (API key required)` : inst.host,
    host: inst.host,
    url: inst.url,
    needsKey: !!inst.needsKey,
    // The instance's own URL is the *default* for this provider; `opts.endpoint`
    // (what the Preferences… URL field holds) wins, so any server can be pointed at
    // another host without losing the preset.
    translate: (text, src, dst, opts = {}) => {
      const url = String(opts.endpoint || '').trim() || inst.url;
      return libreTranslate(text, src, dst, url, hostOf(url), opts.apiKey);
    },
  };
}

// The URL a LibreTranslate provider will actually call: the per-provider value the
// user set in Preferences… (`settings.endpoints[id]`), else the instance's built-in
// default, else the shipped default for the custom-URL provider. Never empty, so a
// translation can't fail with "URL not set".
export function endpointForProvider(settings, id = settings?.provider) {
  const own = String(settings?.endpoints?.[id] || '').trim();
  if (own) return own;
  const p = translationProviders[id];
  if (p?.url) return p.url;
  return String(settings?.endpoint || '').trim() || DEFAULT_INSTANCE_URL;
}

// Is this provider a LibreTranslate server (so it takes an optional API key)?
export function isLibreTranslateProvider(id) {
  const p = translationProviders[id];
  return !!p && (id === 'libretranslate' || typeof p.url === 'string');
}

// Is this provider Chrome's on-device model (no key, no endpoint, Chrome-only)?
export function isChromeAiProvider(id) {
  return id === 'chrome-ai';
}

export function makeTranslationService(settings, hooks = {}) {
  const p = translationProviders[settings.provider] || translationProviders.none;
  return {
    // The provider contract (spec 1.5 §23):
    //
    //   translate(text, sourceLanguage, targetLanguage, options?) -> Promise<{ text }>
    //
    // `options.maxWords` is a hint, not a contract: LLM-backed providers may use it to
    // keep the result short, while dictionary/MT APIs (LibreTranslate) and Chrome's
    // on-device translator ignore it. `hooks` (e.g. onProgress) ride along with the
    // settings so a provider can report long-running work — the model download.
    async translate(text, src, dst, options = {}) {
      const opts = { ...settings, ...hooks, ...options };
      // Resolve the server URL here (never in the UI) so every LibreTranslate
      // provider — preset or custom — calls exactly one, always-set URL.
      if (isLibreTranslateProvider(settings.provider)) opts.endpoint = endpointForProvider(settings);
      return p.translate(text, src, dst, opts);
    },
    provider: translationProviders[settings.provider] || translationProviders.none,
  };
}

// The word count a translation is asked to stay near (spec 1.5 §23). Whitespace
// tokens for spaced scripts, one word per CJK/kana/hangul character: a CJK source
// with no spaces would otherwise count as a single "word" and the hint would be
// useless. Punctuation-only tokens are not words.
const CJK_CHAR = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/g;
export function countWords(text) {
  const s = String(text || '').trim();
  if (!s) return 0;
  const cjk = (s.match(CJK_CHAR) || []).length;
  const rest = s.replace(CJK_CHAR, ' ').trim();
  const spaced = rest ? rest.split(/\s+/).filter(t => /[\p{L}\p{N}]/u.test(t)).length : 0;
  return cjk + spaced;
}

export const TableService = {
  async extract(_imageDataUrl) { throw new Error('Table extraction not implemented in MVP (stub)'); },
};
// Region detection. Tier-1 (digital PDFs) is implemented in detect_digital.js.
export const RegionDetectionService = {
  async detect(pageInput) {
    if (pageInput?.kind === 'digital') {
      const { detectPageRegions } = await import('./detect_digital.js');
      const out = await detectPageRegions(pageInput.page, pageInput.viewport);
      return out.regions;
    }
    throw new Error('Region detection is only available for digital (text-based) PDFs in this version.');
  },
};
