// Settings / Preferences — extracted from main.js
import { appState, els, $,
  DEFAULT_TEXT_PADDING, DEFAULT_DETECT_OVERLAP } from './app.js';
import { settings, translationProviders, loadSettings, saveSettings } from './main.js';
import {
  isLibreTranslateProvider, endpointForProvider,
  DEFAULT_PROVIDER, DEFAULT_INSTANCE_URL
} from './services/index.js';
import { chromeAiStatus, chromeAiAvailability, isChromeAiLanguage } from './services/translate_chromeai.js';
import { sourceLangValue, clampPadding, clampDetectOverlap, clampDetectTier, clampCvEngine, clampOcrEngine,
  textPadding, detectOverlap, detectTier, cvEngine, ocrEngine, ocrEnabled } from './main.js';
import { DEFAULT_STYLE, DEFAULT_LINE_HEIGHT } from './model/region.js';

let chromeAiStatusToken = 0;

// Preferences tabs. Kept in the session only. The active variant's workflow decides the
// default section — Translate opens Translation Service, Improve opens OCR Service — and
// remembering the last tab per workflow keeps a detour into Region Detection from changing
// the other workflow.
export function showPrefTab(name) {
  const tabs = [...document.querySelectorAll('[data-pref-tab]')];
  if (!tabs.some(tab => tab.dataset.prefTab === name)) name = workflowCopy().prefsTab;
  for (const tab of tabs) {
    const on = tab.dataset.prefTab === name;
    tab.classList.toggle('active', on);
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    const panel = $(`pref-panel-${tab.dataset.prefTab}`);
    if (panel) panel.hidden = !on;
  }
}

export function openSettings() {
  fillSettingsFields();
  refreshSettingsRows();
  showPrefTab(workflowCopy().prefsTab);
  $('settings-modal').hidden = false;
}

// Fill the dialog's controls from the settings. Also called once at startup, so a
// close (which reads the controls back) can never write a half-filled form over the
// saved settings — e.g. wiping the API key.
export function fillSettingsFields() {
  $('set-default-font').value = settings.defaultFont || 'sans';
  $('set-default-size').value = String(settings.defaultSize || DEFAULT_STYLE.size);
  $('set-default-line-height').value = String(settings.defaultLineHeight || DEFAULT_LINE_HEIGHT);
  $('set-provider').value = settings.provider;
  $('set-apikey').value = settings.apiKey || '';
  $('set-target-lang').value = settings.targetLang || 'de';
  $('set-source-lang').value = settings.sourceLang || 'auto';
  $('set-text-padding').value = String(textPadding());
  $('set-detect-overlap').value = String(detectOverlap());
  $('set-detect-tier').value = detectTier();
  $('set-cv-engine').value = cvEngine();
  $('set-ocr-engine').value = ocrEngine();
}

// The URL row is shown for every LibreTranslate server and is always editable: the
// instance's own address is just the default value, so a preset can be repointed at
// any server (the public ones come and go). The API key field likewise applies to
// any LibreTranslate server and is simply left empty when the server doesn't want one.
export function refreshSettingsRows() {
  const providerId = $('set-provider').value;
  const provider = translationProviders[providerId] || {};
  const isLibreTranslate = isLibreTranslateProvider(providerId);
  const endpointInput = $('set-endpoint');
  $('set-endpoint-row').hidden = !isLibreTranslate;
  $('set-apikey-row').hidden = !isLibreTranslate;
  if (isLibreTranslate) {
    endpointInput.readOnly = false;
    endpointInput.value = endpointForProvider(settings, providerId);
    endpointInput.title = provider.url
      ? `${provider.label} — the instance's address is filled in as a default; edit it to use another server${provider.needsKey ? '. This instance requires an API key (see below)' : ''}.`
      : 'URL of the LibreTranslate server to call (…/translate).';
  }
  $('set-chromeai-row').hidden = providerId !== 'chrome-ai';
  if (providerId === 'chrome-ai') refreshChromeAiStatus();
}

// chrome-ai needs no key or URL, but it is Chrome-only and downloads a model per
// language pair on first use — so show the user where they stand before they try.
export async function refreshChromeAiStatus() {
  const el = $('set-chromeai-status');
  if (!el) return;
  const token = ++chromeAiStatusToken;
  const set = (cls, text) => { if (token === chromeAiStatusToken) { el.className = cls; el.textContent = text; } };
  set('', 'checking…');
  const base = chromeAiStatus();
  if (!base.ok) { set('bad', `unavailable — ${base.reason}.`); return; }
  const target = ($('set-target-lang').value || '').trim();
  const src = sourceLangValue();
  if (src && src !== 'auto' && target) {
    let av;
    try { av = await chromeAiAvailability(src, target); }
    catch (e) { set('bad', `unavailable — ${e.message}.`); return; }
    if (av === 'unavailable') { set('bad', `unavailable — Chrome has no model for ${src} → ${target}. Pick another target language or another provider.`); return; }
    if (av === 'available') { set('ok', `available (${src} → ${target}) — runs on this device; no text leaves the browser.`); return; }
    set('warn', `the ${src} → ${target} model still needs its one-time download (~1–2 GB) before the first translation.`);
    return;
  }
  const hint = isChromeAiLanguage(target) ? '' : ` Chrome has no model for “${target}” as a target — pick another target language.`;
  set(hint ? 'warn' : 'ok', `available — on-device translation, Chrome only. Each language pair downloads its model once (~1–2 GB).${hint}`);
}

export function closeSettings() {
  settings.defaultFont = $('set-default-font').value;
  settings.defaultSize = clampFontSize($('set-default-size').value);
  settings.defaultLineHeight = clampLineHeight($('set-default-line-height').value);
  settings.provider = $('set-provider').value;
  // The URL box is editable for every LibreTranslate server, so keep whatever it
  // holds for the selected provider (and thus across provider switches).
  if (isLibreTranslateProvider(settings.provider)) setEndpointFor(settings.provider, $('set-endpoint').value);
  settings.apiKey = $('set-apikey').value.trim();
  settings.targetLang = $('set-target-lang').value || 'de';
  // The source language comes from the toolbar select, which the dialog's own
  // dropdown writes through to (and which openSettings re-syncs), so a stale
  // dialog field can never override a toolbar choice.
  settings.sourceLang = sourceLangValue();
  settings.textPadding = clampPadding($('set-text-padding').value);
  settings.detectOverlap = clampDetectOverlap($('set-detect-overlap').value);
  settings.detectTier = clampDetectTier($('set-detect-tier').value);
  settings.cvEngine = clampCvEngine($('set-cv-engine').value);
  settings.ocrEngine = clampOcrEngine($('set-ocr-engine').value);
  saveSettings();
  $('settings-modal').hidden = true;
  setStatus(`Translation provider: ${translationProviders[settings.provider]?.label || settings.provider}.`);
}

// The URL the Preferences… field shows for a provider: the value the user set, else the
// instance's built-in default. Stored per provider id so editing one server's URL
// never changes another's.
export function setEndpointFor(providerId, url) {
  if (!settings.endpoints) settings.endpoints = {};
  const urlValue = String(url || '').trim();
  if (urlValue) settings.endpoints[providerId] = urlValue; else delete settings.endpoints[providerId];
  if (providerId === 'libretranslate') settings.endpoint = urlValue;  // legacy mirror
}

export function initSettings() {
  // wire new UI
  if ($('settings-close')) $('settings-close').onclick = closeSettings;
  const prefTabs = [...document.querySelectorAll('[data-pref-tab]')];
  for (const tab of prefTabs) {
    tab.onclick = () => showPrefTab(tab.dataset.prefTab);
    tab.onkeydown = (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const i = prefTabs.indexOf(tab);
      const next = prefTabs[(i + (e.key === 'ArrowRight' ? 1 : -1) + prefTabs.length) % prefTabs.length];
      showPrefTab(next.dataset.prefTab);
      next.focus();
    };
  }
  showPrefTab('translation');
}

// Default font / size / line spacing from Preferences > General
export function defaultFont() { return settings.defaultFont || 'sans'; }
export function defaultSize() { return settings.defaultSize ?? DEFAULT_STYLE.size; }
export function defaultLineHeight() { return settings.defaultLineHeight ?? DEFAULT_LINE_HEIGHT; }

function clampFontSize(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 4 && n <= 200 ? n : DEFAULT_STYLE.size;
}
function clampLineHeight(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0.8 && n <= 3 ? n : DEFAULT_LINE_HEIGHT;
}