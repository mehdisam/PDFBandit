import { PdfViewer } from './pdf/viewer.js';
import { StageTransform } from './overlay/canvas.js';
import { Overlay } from './overlay/region_item.js';
import { ToolController, draftValid } from './editor/tools.js';
import { History } from './editor/history.js';
import { ensurePage, getPage, touch as touchMap, syncIdCounter } from './model/document.js';
import { createRegion, regionHasContent, regionIsMasked, contentText, firstTextItem, createTextItem, createImageItem, itemAbsBox, normalizeStyle, DEFAULT_BACKGROUND, itemBlocks, blocksText, itemText, normalizeBlocks, blocksFromValue, newTableBlock, normalizeCell, charStyles, DEFAULT_TABLE_BORDER, DEFAULT_COL_WIDTH, DEFAULT_ROW_HEIGHT, scaleTextItem, isRegionLocked, DEFAULT_LINE_HEIGHT, LINE_HEIGHT_MIN, LINE_HEIGHT_MAX, lineHeightOf } from './model/region.js';
import { applyFormatToRuns, FONT_CSS, spanCss } from './model/richtext.js';
import { compileFind, countInTextItem, replaceInTextItem } from './model/findreplace.js';
import { blocksToHtml, htmlToBlocks, flowBase } from './model/blocks.js';
import { clipboardToBlocks } from './import/clipboard.js';
import { bboxOf, polygonIsValid, pointInPolygon, regionRings, regionPoints, regionBBox, ringsBBox, geometryWithRings, rectInsideRings } from './model/geometry.js';
import { detectionFingerprint, isUntouchedAuto, clearDetection, refreshDetectedType, pairProposals, unmatchedAutoIds } from './model/detection.js';
import { sha256Hex } from './storage/hash.js';
import { serializeMap, parseMap, downloadText, matchSidecars } from './storage/pmap.js';
import { saveSessionPdf, loadSessionPdf, saveSessionProject, loadSessionMap, loadSessionContent, clearSession } from './storage/session.js';
import { parseContent, serializeContent, resolveProject, createEmptyProject, emptyContentVariant, matchContentFiles, isMapFileName, isContentFileName, defaultMapName, defaultContentName } from './storage/content-file.js';
import { splitProject, detectFileKind } from './storage/project-migrate.js';
import { unionRings, splitPolygonByLine, growRings } from './geometry-ops.js';
import { renderView, measureTextItem, itemOverflows } from './viewmode.js';
import { exportReconstruction } from './pdf/exporter.js';
import { exportDigitalizedPdf, digitalizedPdfName, digitalizationSummary } from './services/export_digital.js';
import { detectDir, detectDirStrong } from './pdf/textlayer.js';
import { extractRegionContent, isAwaitingOcr } from './services/extract.js';
import { makeTranslationService, translationProviders, isLibreTranslateProvider, endpointForProvider, countWords, DEFAULT_PROVIDER, DEFAULT_INSTANCE_URL } from './services/index.js';
import { chromeAiStatus, chromeAiAvailability, cancelChromeAiDownload, isChromeAiLanguage } from './services/translate_chromeai.js';
import { createMenubar } from './ui/menubar.js';
import { appDialog, confirmDialog, promptValue, promptSelect } from './ui/dialog.js';

const $ = (id) => document.getElementById(id);
const els = {
  pdfCanvas: $('pdf-canvas'), viewCanvas: $('view-canvas'), svg: $('overlay'),
  textLayer: $('textLayer'), stage: $('stage'), stageWrap: $('stage-wrap'), inlineEdit: $('inline-edit'),
  textModal: $('text-modal'),
  textSource: $('text-modal-source'), textSourceImg: $('text-modal-source-img'),
  textDone: $('text-done'), textCancel: $('text-cancel'),
  thumbs: $('thumbs'), zoomLabel: $('zoom-label'), status: $('status-msg'),
  filePdf: $('file-pdf'), filePmap: $('file-pmap'), fileItemImage: $('file-item-image'),
  propsEmpty: $('props-empty'), propsForm: $('props-form'),
  fId: $('f-id'), fBg: $('f-bg'), fOcr: $('f-ocr'), fKind: $('f-kind'),
  regionTools: $('region-tools'), regionAddTools: $('region-add-tools'), imageTools: $('image-tools'),
  itemTools: $('item-tools'),
  btnAddText: $('btn-add-text'), btnAddImage: $('btn-add-image'),
  btnItemFitText: $('btn-item-fit-text'), btnItemFront: $('btn-item-front'),
  btnItemBack: $('btn-item-back'), btnItemDelete: $('btn-item-delete'),
  textTools: $('text-tools'), ttBold: $('tt-bold'), ttItalic: $('tt-italic'),
  ttUnderline: $('tt-underline'), ttColor: $('tt-color'), ttFont: $('tt-font'),
  ttSize: $('tt-size'), ttAlign: $('tt-align'), ttDir: $('tt-dir'), ttLine: $('tt-line'),
  itemsList: $('items-list'), itemEditor: $('item-editor'),
  tableTools: $('table-tools'),
  tblBorderColor: $('tbl-border-color'), tblBorderWidth: $('tbl-border-width'),
  tblColW: $('tbl-col-w'), tblRowH: $('tbl-row-h'), tblWidth: $('tbl-width'),
  ttTable: $('tt-table'), ttUl: $('tt-ul'), ttOl: $('tt-ol'), ttHead: $('tt-head'),
  fItemSource: $('f-item-source'),
  fItemFit: $('f-item-fit'),
  mapInfo: $('map-info'),
  fTargetLang: $('f-target-lang'),
  fSourceLang: $('f-source-lang'),
  dlProgress: $('dl-progress'),
  dlProgressLabel: $('dl-progress-label'),
  statusProgress: $('status-progress'),
  statusCoverage: $('status-coverage'),
  lensSwitcher: $('lens-switcher'),
  menubar: $('menubar'),
  btnMakeSelectable: $('btn-make-selectable'),
  reviewSection: $('review-section'),
  reviewHeading: $('review-heading'),
  reviewList: $('review-list'),
  findModal: $('find-modal'), findScope: $('find-scope'), findText: $('find-text'),
  replaceText: $('replace-text'), findRegex: $('find-regex'), findCase: $('find-case'),
  findStatus: $('find-status'), findReplaceAll: $('find-replace-all'), findClose: $('find-close'),
};

// An automatically created text box is inset from its region's edge by this many PDF
// points, so the first/last line never sits flush against the mask boundary. The value
// is editable in Preferences settings (0 = flush with the region).
const DEFAULT_TEXT_PADDING = 4;
// Re-detection overlap threshold (spec 1.5 §21): the IoU at or above which a proposal and an
// existing region are treated as the same block and reviewed. Editable in Preferences…; the
// dialog's input is the same 0.30…0.95 range, in 0.05 steps.
const DEFAULT_DETECT_OVERLAP = 0.5;

const settings = loadSettings();

// Languages offered by the region language dropdown (Translate's destination,
// or Improve's source).
const LANGUAGES = [
  ['en','English'], ['ar','Arabic'], ['az','Azerbaijani'], ['bg','Bulgarian'], ['bn','Bengali'],
  ['ca','Catalan'], ['cs','Czech'], ['da','Danish'], ['de','German'], ['el','Greek'],
  ['es','Spanish'], ['et','Estonian'], ['fa','Persian'], ['fi','Finnish'], ['fr','French'],
  ['ga','Irish'], ['he','Hebrew'], ['hi','Hindi'], ['hu','Hungarian'], ['id','Indonesian'],
  ['it','Italian'], ['ja','Japanese'], ['ko','Korean'], ['lt','Lithuanian'], ['lv','Latvian'],
  ['ms','Malay'], ['nb','Norwegian'], ['nl','Dutch'], ['pl','Polish'], ['pt','Portuguese'],
  ['ro','Romanian'], ['ru','Russian'], ['sk','Slovak'], ['sl','Slovenian'], ['sq','Albanian'],
  ['sr','Serbian'], ['sv','Swedish'], ['th','Thai'], ['tr','Turkish'], ['uk','Ukrainian'],
  ['ur','Urdu'], ['vi','Vietnamese'], ['zh','Chinese'],
];

// The two workflows are intents, not data states. They use the same engine and the same
// variants; only the framing, entry points and default variant change. Every user-facing
// string that differs by lens lives here so the switch cannot leave a stale label behind.
const LENS_COPY = {
  translate: {
    label: 'Translate',
    sourceVariant: 'Source text',
    missing: 'source text not readable',
    filledTag: 'has source text',
    missingTag: 'source text not readable',
    selectedAction: 'Extract source text',
    pageAction: 'Extract source text on this page',
    allAction: 'Extract source text on all pages',
    showStatus: 'Show source-text status',
    selectMissing: 'Select regions without source text',
    noMissing: 'No text regions without source text on this page.',
    selectedMissing: (n) => `${n} text region${n === 1 ? '' : 's'} without source text selected.`,
    reviewHeading: 'Confirm translations',
    reviewEmpty: 'No translations pending review on this page.',
    prefsTab: 'translation',
    actionLabel: 'Extract source text',
    actionPast: 'Extracted',
    ocrAction: 'Read with OCR',
  },
  improve: {
    label: 'Improve',
    sourceVariant: 'Selectable text',
    missing: 'not selectable yet',
    filledTag: 'selectable',
    missingTag: 'not selectable yet',
    selectedAction: 'Make this selectable',
    pageAction: 'Make this selectable on this page',
    allAction: 'Make this selectable on all pages',
    showStatus: 'Show selectability status',
    selectMissing: 'Select regions not yet selectable',
    noMissing: 'Every text region on this page is already selectable.',
    selectedMissing: (n) => `${n} text region${n === 1 ? '' : 's'} not yet selectable selected.`,
    reviewHeading: 'Confirm extracted text',
    reviewEmpty: 'No extracted text pending review on this page.',
    prefsTab: 'ocr',
    actionLabel: 'Make this selectable',
    actionPast: 'Made selectable',
    ocrAction: 'Read with OCR',
  },
};
const lensCopy = () => LENS_COPY[S.lens] || LENS_COPY.translate;

const viewer = new PdfViewer();
const stage = new StageTransform();
const history = new History(() => { refreshChrome(); if (viewer.doc && S.pmap) renderCurrent(); });

const S = {
  pdfBytes: null, pdfName: '', sha256: '',
  pdfLanguage: null, // the PDF's own language, asked once when extraction first needs it (spec 1.5 §22)
  pmap: null, page: 1, zoom: 1.2,
  // The v2 project identity of the loaded map: the shared map's id + the two files'
  // metadata, plus the last-saved canonical JSON of each side (so the UI can say which
  // half has unsaved changes). `pmap` above stays the *resolved* object the editor
  // works on; these two are what the storage layer writes back.
  project: null, dirtySides: { map: false, content: false },
  // Content variants touched this session, so translation can read the PDF-language
  // variant while writing into a target (spec 1.5 §22). In memory only: a variant is
  // still an ordinary file on disk and is never written here.
  variants: [],
  selected: new Set(),
  // Every content item selected by Ctrl/Cmd+A in Content mode, as `${regionId}\u0000${index}`.
  // Single-item selection keeps using itemIndex/itemSelected; this set is only non-empty for
  // the page-wide selection (and is cleared by the next single-item or single-region pick).
  itemSelection: new Set(),
  // Regions classified "awaiting OCR" (spec 1.5 §20): the PDF has no usable selectable
  // text under them (a scan, a raster figure, or a broken text layer), so extraction
  // cannot fill them and OCR is the only way they ever will. A runtime-only editing aid
  // — never written to the map or a content variant, cleared when the region gains
  // content and invisible outside the editing modes.
  awaitingOcr: new Set(),
  // Workflow intent (rev 1.6). This is a view state, not project data: switching it never
  // writes to the map or a content file. `lensVariant` remembers the variant each workflow
  // was last working in, so moving Translate → Improve → Translate returns to the target
  // variant the translator was editing.
  lens: 'translate',
  lensVariant: { translate: null, improve: null },
  suppressLensVariantRemember: false,
  // The IndexedDB slot the *currently active* content variant belongs to. This follows the
  // lens for within-lens switches but is pinned to the target lens during a lens switch, so
  // the outgoing variant is never written into the incoming lens's slot.
  activeSlot: 'translate',
  tool: 'select', mode: 'region', itemIndex: 0,
  itemSelected: false, // true when an item (not just its region) is the current selection
  draft: [], splitPts: [], cursor: null, marquee: null, marqueeBase: null, marqueeAdditive: false,
  marqueeItems: false, // the band is sweeping items inside the selected region (Content mode)
  dragPreview: null,
  selectedVertex: null, // { id, idx } — a vertex picked for Delete
  overlayVisible: true,
  // Show the status labels on regions (heading/text/selectable/unreadable). Runtime-only,
  // like the overlay itself; Improve ▸ Show selectability status and Shift+D toggle it.
  showDigital: true,
  bgPreview: false, // the background colour picker has focus: preview the mask on the selected region
};

// ---- per-document intent (local only) ------------------------------------------------
// The workflow choice and the PDF's own language belong to the document, not to a map or
// content file. Keeping them in localStorage means reopening the same PDF restores the
// user's intent without adding a new field to .pmap or .content.json.
const DOC_PREFS_KEY = 'pmap.docPrefs';
function loadDocPrefs(sha) {
  if (!sha) return {};
  try {
    const all = JSON.parse(localStorage.getItem(DOC_PREFS_KEY) || '{}');
    return all[sha] || {};
  } catch { return {}; }
}
function saveDocPrefs() {
  if (!S.sha256) return;
  try {
    const all = JSON.parse(localStorage.getItem(DOC_PREFS_KEY) || '{}');
    all[S.sha256] = { lens: S.lens, pdfLanguage: S.pdfLanguage || null };
    localStorage.setItem(DOC_PREFS_KEY, JSON.stringify(all));
  } catch {}
}
// Close and "Forget saved session" both mean this document starts fresh next time.
// Drop only this PDF's intent entry; global translation/detection preferences stay.
function clearDocPrefsFor(sha) {
  if (!sha) return;
  try {
    const all = JSON.parse(localStorage.getItem(DOC_PREFS_KEY) || '{}');
    delete all[sha];
    localStorage.setItem(DOC_PREFS_KEY, JSON.stringify(all));
  } catch {}
}
function activeVariantKey() {
  const p = S.project;
  if (!p) return null;
  return `${p.mapId}\u0000${p.content.name || ''}\u0000${p.content.created || ''}`;
}
function keyForVariant(content) { return content ? variantKey(content) : null; }
function findVariantByKey(key) {
  if (!key) return null;
  return S.variants.find(v => v.key === key)?.content || null;
}
function rememberLensVariant() {
  if (S.suppressLensVariantRemember || !S.lens) return;
  const key = activeVariantKey();
  if (key) S.lensVariant[S.lens] = key;
}
// The lens a variant belongs to in IndexedDB. Translate owns the destination-language
// variant; Improve owns the source-language/selectable-text variant.
function contentSlotForLens(lens) { return lens === 'improve' ? 'improve' : 'translate'; }

// Persist the active variant to a lens's IndexedDB slot. Called before the variant is
// unloaded (switching lens) so work is never lost: the content leaves the active slot
// only after it is safe. A no-op when there is nothing to save.
async function saveActiveVariantToSlot(lens) {
  if (!S.pmap || !S.project) return false;
  try {
    const { mapText, contentText, changed } = await projectTexts();
    if (!(changed.map || changed.content)) return true; // nothing dirty to persist
    await saveSessionProject({
      slot: contentSlotForLens(lens),
      mapJson: mapText,
      mapName: S.project.map.name,
      contentJson: contentText,
      contentName: S.project.content.name,
    });
    return true;
  } catch { return false; }
}

// The variant a lens should work in. Translate works in the destination-language variant;
// Improve works in the PDF-language/selectable-text variant. Each lens's variant is loaded
// from its own IndexedDB slot (falling back to an empty variant when none exists yet), so
// the translated content never leaks into the Improve workflow and vice versa.
async function focusVariantForLens(next) {
  if (!S.project) return false;
  const slot = contentSlotForLens(next);
  let desired = findVariantByKey(S.lensVariant[next]);
  if (next === 'translate') {
    // Translate always works in the destination-language variant. A remembered key can
    // still point at the source variant when both lenses shared the initial base variant;
    // in that case it is not a translation, so ignore it.
    const targetLang = String(els.fTargetLang.value || settings.targetLang || 'de').toLowerCase();
    if (desired && String(desired.meta?.language || '').toLowerCase() !== targetLang) desired = null;
    if (!desired) desired = findRememberedVariant(targetLang);
    if (!desired) {
      // No translation exists yet: check the IndexedDB slot, then open an empty destination
      // variant rather than showing (and editing) the source text in the Translate workflow.
      const saved = await loadSessionContent(slot);
      if (saved?.json) {
        try {
          const parsed = parseContent(saved.json);
          if (parsed.mapId === S.project.mapId && String(parsed.meta?.language || '').toLowerCase() === targetLang) {
            desired = parsed;
          }
        } catch {}
      }
      if (!desired) return switchToTargetVariant(targetLang);
    }
  } else if (next === 'improve') {
    // Improve foregrounds the PDF-language/selectable-text variant, not whichever target
    // the translator happened to edit last. Prefer the in-memory cache, then the slot.
    const sourceLang = String(S.pdfLanguage || selectableLanguageDefault() || '').toLowerCase();
    if (sourceLang && sourceLang !== 'auto') {
      const source = findRememberedVariant(sourceLang);
      if (source) desired = source;
      else {
        const saved = await loadSessionContent(slot);
        if (saved?.json) {
          try {
            const parsed = parseContent(saved.json);
            if (parsed.mapId === S.project.mapId && String(parsed.meta?.language || '').toLowerCase() === sourceLang) desired = parsed;
          } catch {}
        }
      }
    }
  }
  if (!desired) return false;
  const key = keyForVariant(desired);
  if (key && key === activeVariantKey()) return false;
  S.suppressLensVariantRemember = true;
  try { return await switchContentVariant(desired, { guard: false, quiet: true }); }
  finally { S.suppressLensVariantRemember = false; }
}
function refreshLensSwitcher() {
  if (!els.lensSwitcher) return;
  for (const b of els.lensSwitcher.querySelectorAll('[data-lens]')) {
    const on = b.dataset.lens === S.lens;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  }
}
// Improve's "destination" language: the Selectable text variant's own language, which
// also feeds OCR. It is chosen from the same toolbar dropdown Translate uses for its
// target, so extraction never has to stop for a browser prompt. The two lenses keep
// separate remembered choices: switching workflows must not silently retarget either.
function selectableLanguageDefault() {
  const has = (code) => [...els.fTargetLang.options].some(o => o.value.toLowerCase() === code);
  // Do not fall back to the active variant: when the PDF's language is still unknown the
  // active variant is usually the translation target, not the document's own language.
  const candidates = [S.pdfLanguage, sourceLangValue(), 'en'];
  for (const raw of candidates) {
    const code = String(raw || '').toLowerCase();
    if (code && code !== 'auto' && has(code)) return code;
  }
  return 'en';
}
let improveLangGuessToken = 0;
async function refreshImproveLanguageGuess() {
  if (!viewer.doc || S.lens !== 'improve' || S.pdfLanguage) return;
  const token = ++improveLangGuessToken;
  let guess = '';
  try { guess = await viewer.documentLanguage(); } catch { /* fall through */ }
  if (!guess) {
    const src = sourceLangValue();
    if (src && src !== 'auto') guess = src;
  }
  if (token !== improveLangGuessToken || S.lens !== 'improve' || S.pdfLanguage) return;
  const code = String(guess || '').toLowerCase();
  if (code && [...els.fTargetLang.options].some(o => o.value.toLowerCase() === code)) els.fTargetLang.value = code;
}
function syncLensLanguageControl() {
  if (!els.fTargetLang) return;
  const label = $('lbl-target-lang-text');
  if (S.lens === 'improve') {
    if (label) label.textContent = 'Source';
    els.fTargetLang.title = 'Source language of the selectable text variant and its OCR';
    const want = selectableLanguageDefault();
    if ([...els.fTargetLang.options].some(o => o.value.toLowerCase() === want)) els.fTargetLang.value = want;
    refreshImproveLanguageGuess();
  } else {
    if (label) label.textContent = 'Destination';
    els.fTargetLang.title = 'Destination language for region translation';
    els.fTargetLang.value = settings.targetLang || 'de';
  }
}
function applyLensChrome() {
  document.body.classList.toggle('lens-translate', S.lens === 'translate');
  document.body.classList.toggle('lens-improve', S.lens === 'improve');
  syncLensLanguageControl();
  refreshLensSwitcher();
  menubar?.setMenus(menusForLens(S.lens));
  refreshChrome();
}
async function setLens(lens, { announce = false, switchVariant = true } = {}) {
  if (!LENS_COPY[lens]) return;
  if (S.lens === lens) {
    applyLensChrome();
    saveDocPrefs();
    return;
  }
  rememberLensVariant();
  const keepSelected = new Set(S.selected);
  const outgoingLens = S.lens;
  // Persist the outgoing variant to its own lens's slot before it is unloaded, so
  // switching back to this lens restores the work. This is a real save, not a discard:
  // the content leaves the active slot only after it is safe in IndexedDB.
  await saveActiveVariantToSlot(outgoingLens);
  S.lens = lens;
  applyLensChrome();
  syncPropsForm(); refreshMapInfo();
  rerender();
  saveDocPrefs();
  const switched = switchVariant ? await focusVariantForLens(lens) : false;
  // The active variant now belongs to the target lens; pin its slot so subsequent saves go
  // to the right place.
  S.activeSlot = contentSlotForLens(lens);
  // A lens may foreground a different content variant. Region ids belong to the shared map,
  // so the selection survives that switch even though the variant objects were rebuilt.
  if (switched && keepSelected.size) {
    const ids = new Set(currentRegions().map(r => r.id));
    S.selected = new Set([...keepSelected].filter(id => ids.has(id)));
    S.selectedVertex = null; S.itemIndex = 0; S.itemSelected = false; clearItemSelection();
  }
  if (!S.suppressLensVariantRemember) S.lensVariant[lens] = activeVariantKey() || S.lensVariant[lens];
  refreshChrome(); syncPropsForm(); refreshMapInfo();
  rerender();
  if (announce) {
    if (lens === 'improve' && !activeVariantIsSource()) {
      setStatus('Improve workflow — Make this selectable or Add text will create/switch to Selectable text.');
    } else {
      setStatus(`${LENS_COPY[lens].label} workflow — working in ${LENS_COPY[lens].sourceVariant}.`);
    }
  }
}
// No import question: a newly opened PDF goes straight into a workflow instead of being
// asked Translate-or-Improve. The workflow comes from Preferences… ▸ General ("Workflow
// when a PDF opens", default Translate) unless this browser already saved a per-document
// choice; both workflows share the map and variants, so the switch stays lossless.
function requestedLens() {
  return LENS_COPY[settings.defaultLens] ? settings.defaultLens : 'translate';
}
function maybeApplyDefaultLens() {
  const prefs = loadDocPrefs(S.sha256);
  if (LENS_COPY[prefs.lens]) { applyLensChrome(); return; }
  void setLens(requestedLens(), { announce: true });
}
for (const b of els.lensSwitcher?.querySelectorAll('[data-lens]') || []) {
  b.addEventListener('click', () => setLens(b.dataset.lens, { announce: true }));
}
document.body.classList.add('lens-translate');

// ---- the four global modes (spec §9a) -------------------------------------------------
// Two editing modes and two read-only ones, cycled with Tab:
//   region  — geometry: draw/move/reshape/merge/split/lock/delete polygons.
//   content — editorial: place and edit the region's content items.
//   view / text — read-only Preview and native text selection (Original).
// Each mode has one job, one tool set, one cursor vocabulary, so a mode check is what
// almost every gate below asks. `isEditMode` means "the overlay is interactive at all".
const MODE_ORDER = ['region', 'content', 'view', 'text'];
const EDIT_MODES = new Set(['region', 'content']);
const isEditMode = () => EDIT_MODES.has(S.mode);
const inRegion = () => S.mode === 'region';
const inContent = () => S.mode === 'content';

let lastVertexClick = null; // { id, idx, t } — manual dbl-click (overlay nodes are rebuilt on render)
let lastRegionClick = null; // { id, t }
let lastItemClick = null;   // { id, idx, t }

// A press on a region's polygon — or, with Option/Alt held, on the item that covers it
// (spec §9b: "Alt means the region, not the item"). It selects the region, then starts the
// drag the pointer asks for: the line it is on (inside the edge band), else the region.
// In Content mode (spec §9a) the polygon is a read-only outline: a press only *selects* the
// region (so the user can pick the one that receives new items), and Alt is the documented
// exception that also makes the region movable — the one geometry gesture left in this mode.
function regionPointerDown(e, id) {
  if (!isEditMode()) return;
  const p = stagePdfPoint(e);
  if (inRegion() && S.tool === 'split') { S.splitPts.push(p); rerender(); return; }
  if (inRegion() && S.draft.length) { S.draft.push(p); rerender(); return; } // keep drawing across a region
  const r = regionById(id);
  if (!r) return;
  if (inContent()) {
    lastRegionClick = null;
    S.selectedVertex = null;
    S.itemSelected = false; clearItemSelection();
    if (e.shiftKey) toggleSelect(id);
    else if (!S.selected.has(id)) selectSingle(id);
    if (e.altKey) {
      if (isRegionLocked(r)) setStatus(`${r.id} is locked — press L in Region mode to unlock it.`);
      else tools.startRegionDrag(e, id); // one undo step, exactly like a Region-mode move
    }
    rerender();
    return;
  }
  // Option/Alt+click cycles down through the regions under the pointer. A plain click can
  // only ever reach the topmost polygon, and a fully covered region may have no exposed
  // area at all; each Alt+click steps to the next region behind, wrapping round the stack.
  if (e.altKey && !e.shiftKey) { selectRegionBehind(id, p); return; }
  // A locked polygon can still be selected (its content stays editable) but is
  // never dragged, reshaped or given new vertices.
  if (isRegionLocked(r)) {
    lastRegionClick = null;
    S.selectedVertex = null;
    S.itemSelected = false; clearItemSelection();
    if (e.shiftKey) toggleSelect(id);
    else if (!S.selected.has(id)) selectSingle(id);
    setStatus(`${r.id} is locked — press L to unlock. Text and image items inside stay editable.`);
    rerender();
    return;
  }
  const edge = Overlay.nearestEdge(r, p, S.zoom);
  const now = performance.now();
  if (lastRegionClick && lastRegionClick.id === id && now - lastRegionClick.t < 400) {
    lastRegionClick = null;
    if (edge) { insertVertexOnRegion(id, p, edge.ring); return; } // dbl-click edge adds a vertex
  }
  lastRegionClick = { id, t: now };
  S.selectedVertex = null;
  S.itemSelected = false; clearItemSelection();
  if (e.shiftKey) toggleSelect(id);
  else if (!S.selected.has(id)) selectSingle(id);
  if (edge) tools.startEdgeDrag(e, id, edge.ring, edge.edge);
  else tools.startRegionDrag(e, id);
}

const overlay = new Overlay(els.svg, {
  onRegionPointerDown(e, id) { e.stopPropagation(); regionPointerDown(e, id); },
  onVertexPointerDown(e, id, ring, idx) {
    e.stopPropagation();
    // Vertex handles exist only in Region mode (spec §9a) — in Content mode the overlay
    // draws none, so this is just a belt-and-braces guard.
    if (!inRegion() || S.tool !== 'select' || S.draft.length) return;
    if (isRegionLocked(regionById(id))) { setStatus('Region is locked — press L to unlock before reshaping.'); return; }
    // Ctrl+click deletes the vertex. Option/Alt is *not* a delete: Alt means "the region, not
    // the item" (spec §9b) and a vertex already belongs to the region, so an Alt press on a
    // vertex is an ordinary vertex press — it grabs and moves that vertex, and the vertex
    // handle keeps its precedence over the line band.
    if (e.ctrlKey) { lastVertexClick = null; deleteVertex(id, ring, idx); return; }
    const now = performance.now();
    if (lastVertexClick && lastVertexClick.id === id && lastVertexClick.ring === ring && lastVertexClick.idx === idx && now - lastVertexClick.t < 400) {
      lastVertexClick = null;
      makeRightAngle(id, ring, idx); // dbl-click vertex => right angle
      return;
    }
    lastVertexClick = { id, ring, idx, t: now };
    selectSingle(id);
    S.selectedVertex = { id, ring, idx }; // Delete removes this vertex
    tools.startVertexDrag(e, id, ring, idx);
  },
  onItemPointerDown(e, id, index) {
    e.stopPropagation();
    if (!inContent()) return; // items are frozen outside Content mode (spec §9a)
    // Option/Alt: the press belongs to the region under the item, not to the item (spec
    // §9b) — the region's own rules then decide (its line, or the region itself).
    if (e.altKey) { regionPointerDown(e, id); return; }
    const r = regionById(id);
    if (!r) return;
    S.selectedVertex = null;
    if (!S.selected.has(id)) { S.selected.clear(); S.selected.add(id); }
    const item = r.content?.items?.[index];
    const now = performance.now();
    if (lastItemClick && lastItemClick.id === id && lastItemClick.idx === index && now - lastItemClick.t < 400) {
      lastItemClick = null;
      if (item?.type === 'text') { S.itemSelected = true; openInlineEditor(r, index, { box: item.box, style: item.style, blocks: itemBlocks(item) }); return; }
    }
    lastItemClick = { id, idx: index, t: now };
    S.itemIndex = index;
    S.itemSelected = true; clearItemSelection();
    tools.startItemDrag(e, id, index);
  },
  onItemHandlePointerDown(e, id, index, corner) {
    e.stopPropagation();
    if (!inContent()) return; // item handles exist only in Content mode (spec §9a)
    // Option/Alt hands the press back to the region under the handle (spec §9b).
    if (e.altKey) { regionPointerDown(e, id); return; }
    S.selectedVertex = null;
    if (!S.selected.has(id)) { S.selected.clear(); S.selected.add(id); }
    S.itemIndex = index;
    S.itemSelected = true; clearItemSelection();
    tools.startItemResize(e, id, index, corner);
  },
});
const tools = new ToolController(els.stageWrap || els.stage, overlay, {
  get tool() { return S.tool; },
  get mode() { return S.mode; },
  get editing() { return isEditMode(); },
  get regionMode() { return inRegion(); },
  get contentMode() { return inContent(); },
  get zoom() { return S.zoom; },
  drafting() { return S.draft.length >= 3; },
  drawing() { return S.draft.length > 0; },
  addDraftPoint(p) { S.selectedVertex = null; S.itemSelected = false; clearItemSelection(); S.draft.push(p); rerender(); },
  addSplitPoint(p) { S.splitPts.push(p); rerender(); },
  selectNone() { if (S.selected.size || S.selectedVertex || S.itemSelected || S.itemSelection.size) { S.selected.clear(); S.selectedVertex = null; S.itemSelected = false; clearItemSelection(); rerender(); } },
  deselect() { S.marquee = null; this.selectNone(); },
  // Rubber-band selection. beginMarquee captures the "base" selection (for additive
  // Shift-drags); setMarquee is called on every drag move and updates the selection
  // live, so regions highlight as they are swept over (and un-highlight when the band
  // leaves them). endMarquee just drops the rectangle, keeping the selection.
  // In Content mode (spec §9a) the band works *inside* the region the user is editing: it
  // selects the item it sweeps, so an editorial drag never rebuilds the region selection.
  // With no region selected there is nothing to sweep, so it falls back to picking regions.
  beginMarquee(additive) {
    S.marqueeAdditive = !!additive;
    if (inContent() && S.selected.size === 1) {
      S.marqueeItems = true;
      S.marqueeBase = new Set(S.selected);
      S.itemSelected = false; clearItemSelection();
      S.marquee = null;
      rerender();
      return;
    }
    S.marqueeItems = false;
    S.marqueeBase = additive ? new Set(S.selected) : new Set();
    if (!additive) { S.selected.clear(); S.selectedVertex = null; S.itemSelected = false; clearItemSelection(); }
    S.marquee = null;
    rerender();
  },
  setMarquee(rect) {
    if (rect) {
      const r = [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])];
      if (S.marqueeItems) {
        const reg = currentRegion();
        const items = reg?.content?.items || [];
        // Items paint in array order, so the last box the band touches is the topmost one:
        // the band picks the top box under it, the item the pointer would have clicked.
        let hit = -1;
        items.forEach((it, i) => {
          const [x, y, w, h] = itemAbsBox(regionPoints(reg.geometry), it);
          if (rectsIntersect([x, y, x + w, y + h], r)) hit = i;
        });
        S.itemSelected = hit >= 0; clearItemSelection();
        if (hit >= 0) S.itemIndex = hit;
        setStatus(hit >= 0
          ? `Item ${hit + 1} of ${items.length} selected.`
          : items.length ? 'Drag over a box in this region to select it.' : `${reg.id} has no items yet — press T to add text.`);
        S.marquee = rect; rerender(); return;
      }
      const pg = getPage(S.pmap, S.page);
      if (pg) {
        const hits = pg.regions.filter(x => rectsIntersect(regionBBox(x.geometry), r)).map(x => x.id);
        const want = S.marqueeAdditive ? new Set([...(S.marqueeBase || []), ...hits]) : new Set(hits);
        for (const id of [...S.selected]) if (!want.has(id)) S.selected.delete(id);
        for (const id of want) S.selected.add(id);
        S.selectedVertex = null; S.itemSelected = false; clearItemSelection();
        setStatus(want.size ? `${want.size} region${want.size === 1 ? '' : 's'} selected.` : 'Drag over regions to select them.');
      }
    }
    S.marquee = rect;
    rerender();
  },
  endMarquee() { S.marquee = null; S.marqueeBase = null; rerender(); },
  // A click (press + release with no movement) on empty space — outside every region — clears
  // the whole selection: the selected region(s) *and* the selected content item. It works in
  // both editing modes, so the properties panel goes back to "Nothing selected" from anywhere.
  // Shift-click is the exception: that press means "add to the selection".
  onEmptyClick(additive) {
    if (additive) return;
    if (!(S.selected.size || S.selectedVertex || S.itemSelected || S.itemSelection.size)) return;
    S.selected.clear(); S.selectedVertex = null; S.itemSelected = false; clearItemSelection();
    S.marqueeItems = false; S.marquee = null;
    setStatus('Selection cleared.');
    rerender();
  },
  setCursor(p) { S.cursor = [p[0], p[1]]; rerender(); },
  previewDrag(d, p) {
    // A click that becomes a drag must not count as the first half of a double-click.
    if (Math.hypot(p[0] - d.start[0], p[1] - d.start[1]) > 2) { lastVertexClick = null; lastRegionClick = null; lastItemClick = null; }
    S.dragPreview = { ...d, cur: [...p] };
    rerender();
  },
  commitDrag(d, p) { commitDrag(d, p); },
  finishDraw() { finishDraw(); },
  finishSplit() { finishSplit(); },
  cancelDraft() { S.draft = []; S.splitPts = []; S.dragPreview = null; S.cursor = null; S.marquee = null; S.marqueeBase = null; S.marqueeItems = false; if (S.tool === 'split' || S.tool === 'polygon') S.tool = 'select'; rerender(); },
  deleteSelection() { deleteSelection(); },
  deleteKey() { deleteKey(); },
  undo() { history.undo(); }, redo() { history.redo(); },
});

// pointer event -> PDF-point coords (top-left origin, scale 1)
function stagePdfPointXY(cx, cy) {
  const rect = els.svg.getBoundingClientRect();
  return [(cx - rect.left) / S.zoom, (cy - rect.top) / S.zoom];
}
function stagePdfPoint(e) { return stagePdfPointXY(e.clientX, e.clientY); }

// ---- overlay cursor feedback (spec §9) ----------------------------------------------
// The pointer says what a press would grab *before* the button goes down: the region's face
// (move), one of its lines (a resize cursor whose axis is perpendicular to that line), one of
// its vertices (grab — the round blue handles), or the text/image box on top (move, or its
// corner's own resize cursor — the square grey handles). Option/Alt means "the region, not
// the item", so while it is held the cursor describes the region even over an item, which is
// also the moment the press would reach the region through the item.
let lastHover = null; // the last pointer position over the overlay, so Alt can re-ask

function applyOverlayCursor(target, cx, cy, altKey) {
  if (tools.drag) return; // mid-drag the drag owns the gesture; leave the element's own cursor
  const cls = target?.classList;
  if (!cls) return;
  if (cls.contains('handle')) return;                     // region vertex: `grab` (CSS)
  const onItem = cls.contains('item-box') || cls.contains('item-handle');
  const region = (cls.contains('region') || cls.contains('region-band')) ? regionById(target.dataset.id)
    : onItem ? regionById(target.dataset.region) : null;
  if (!region) return;
  // An item keeps its own cursor unless Alt says the press goes to the region underneath.
  if (onItem && !altKey) { target.style.cursor = ''; return; }
  // Content mode (spec §9a): the polygon is a read-only outline, so it has neither the line
  // nor the vertex cursors — a plain press only selects the region, and the region's own
  // cursor appears exactly while Alt says the press will reach it (and then it is *move*:
  // Alt moves the region, it does not unlock edge dragging or reshape).
  if (inContent()) {
    target.style.cursor = altKey && !isRegionLocked(region) ? 'move' : 'pointer';
    return;
  }
  if (!inRegion()) { target.style.cursor = ''; return; }
  target.style.cursor = Overlay.regionCursor(region, stagePdfPointXY(cx, cy), S.zoom) || '';
}

els.svg.addEventListener('pointermove', (e) => {
  lastHover = { x: e.clientX, y: e.clientY };
  applyOverlayCursor(e.target, e.clientX, e.clientY, e.altKey);
});
// Alt changes what a press targets, so the feedback must follow the key, not the mouse:
// re-ask about whatever is under the pointer when Option/Alt is pressed or released.
function refreshOverlayCursor(altKey) {
  if (!lastHover) return;
  const el = document.elementFromPoint(lastHover.x, lastHover.y);
  if (el) applyOverlayCursor(el, lastHover.x, lastHover.y, altKey);
}
window.addEventListener('keydown', (e) => { if (e.key === 'Alt') refreshOverlayCursor(true); }, true);
window.addEventListener('keyup', (e) => { if (e.key === 'Alt') refreshOverlayCursor(false); }, true);

// ---- init static UI ----
els.fTargetLang.innerHTML = LANGUAGES.map(([code, name]) => `<option value="${code}">${name} (${code})</option>`).join('');
els.fTargetLang.value = settings.targetLang || 'de';

// Source language for translation. Most providers accept 'auto' (detect on the
// server); Chrome's on-device model can't, so the user can name it here.
els.fSourceLang.innerHTML = `<option value="auto">Auto-detect</option>`
  + LANGUAGES.map(([code, name]) => `<option value="${code}">${name} (${code})</option>`).join('');
els.fSourceLang.value = settings.sourceLang || 'auto';
els.fSourceLang.onchange = () => { settings.sourceLang = els.fSourceLang.value || 'auto'; saveSettings(); refreshChromeAiStatus(); };

// Preferences dialog: the same language lists, but as dropdowns. Both mirror the
// region toolbar and pre-select it when the dialog closes.
$('set-target-lang').innerHTML = LANGUAGES.map(([code, name]) => `<option value="${code}">${name} (${code})</option>`).join('');
$('set-target-lang').value = settings.targetLang || 'de';
$('set-source-lang').innerHTML = `<option value="auto">Auto-detect (let the provider decide)</option>`
  + LANGUAGES.map(([code, name]) => `<option value="${code}">${name} (${code})</option>`).join('');
$('set-source-lang').value = settings.sourceLang || 'auto';
$('set-source-lang').onchange = () => { settings.sourceLang = $('set-source-lang').value || 'auto'; els.fSourceLang.value = settings.sourceLang; saveSettings(); refreshChromeAiStatus(); };

// The URL field is editable for every LibreTranslate server: the instance's own
// address is only the default value, so any preset can be pointed elsewhere. Edits
// take effect at once so a custom server is never left without a URL.
$('set-endpoint').oninput = () => setEndpointFor($('set-provider').value, $('set-endpoint').value);

// Provider list comes from the service layer so the instances live in one place.
$('set-provider').innerHTML = Object.entries(translationProviders)
  .map(([id, p]) => `<option value="${id}">${p.label}</option>`).join('');
$('set-provider').value = settings.provider;
$('set-provider').onchange = refreshSettingsRows;
fillSettingsFields();

$('btn-zoom-in').onclick = () => setZoom(S.zoom * 1.2);
$('btn-zoom-out').onclick = () => setZoom(S.zoom / 1.2);
$('btn-zoom-fit').onclick = fitZoom;
for (const b of document.querySelectorAll('#mode-group button')) b.onclick = () => setMode(b.dataset.mode);
refreshModeIndicator();
$('btn-crop-img').onclick = cropImageForSelected;
$('btn-translate-page-text').onclick = () => translateFromPageText();
els.btnMakeSelectable.onclick = () => extractSelectedContent();
$('btn-lock-region').onclick = () => toggleLockSelected();
$('btn-add-text').onclick = () => addTextItem();
$('btn-add-image').onclick = () => addImageItem();
$('btn-item-fit-text').onclick = () => { if (selectedItem()) resizeItemToText(currentRegion().id, S.itemIndex); };
$('btn-item-front').onclick = () => moveItemTo('front');
$('btn-item-back').onclick = () => moveItemTo('back');
$('btn-item-delete').onclick = () => { if (selectedItem()) deleteItem(); };
els.filePdf.onchange = (e) => openFileList([...e.target.files]);
els.filePmap.onchange = (e) => { const fs = [...e.target.files]; e.target.value = ''; if (fs.length) openFileList(fs); };
els.fileItemImage.onchange = async (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) await addImageFromSource(await readFileDataUrl(f)); };

function readFileDataUrl(file) {
  return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => rej(fr.error); fr.readAsDataURL(file); });
}

// Ctrl/Cmd+V with a region selected creates an image item from the clipboard. Placing an
// item is editorial work, so — like T — the paste is live in Content mode only (spec §11.5).
window.addEventListener('paste', async (e) => {
  if (!inContent() || !currentRegion()) return;
  const it = [...(e.clipboardData?.items || [])].find(x => x.type.startsWith('image/'));
  const file = it?.getAsFile?.();
  if (!file) return;
  e.preventDefault();
  await addImageFromSource(await readFileDataUrl(file));
});
// Background colour. macOS's native <input type="color"> fires `change` only when its panel
// closes, so the region previews its own mask (bgPreview) and repaints live on `input`
// while the picker has focus — otherwise the selected region is exactly the one region whose
// mask is suppressed, and the chosen colour would not be visible. The previous colours are
// snapshotted at focus so `change` stays the *single* undoable commit; a blur without a
// change (the panel was dismissed) puts the live preview back.
let bgSnapshot = null; // Map(region id -> previous background) captured while #f-bg has focus
els.fBg.onfocus = () => {
  if (!bgSnapshot) bgSnapshot = new Map(selectedRegions().map(r => [r.id, r.content?.background ?? DEFAULT_BACKGROUND]));
  S.bgPreview = true; rerender();
};
els.fBg.oninput = () => {
  const v = els.fBg.value;
  for (const r of selectedRegions()) r.content.background = v; // live only; committed on change
  S.bgPreview = true; rerender();
};
els.fBg.onchange = () => {
  const v = els.fBg.value;
  const snap = bgSnapshot; bgSnapshot = null; S.bgPreview = false;
  const ids = new Set(selectedRegions().map(r => r.id));
  if (!ids.size) { rerender(); return; }
  const pg = getPage(S.pmap, S.page);
  const provenance = new Map(pg.regions.filter(r => ids.has(r.id)).map(r => [r.id, detectionSnapshot(r)]));
  const apply = () => pg.regions.filter(r => ids.has(r.id)).forEach(r => { r.content.background = v; clearDetection(r); });
  const restore = () => pg.regions.filter(r => ids.has(r.id)).forEach(r => {
    r.content.background = (snap && snap.get(r.id)) ?? DEFAULT_BACKGROUND;
    restoreDetection(r, provenance.get(r.id));
  });
  history.exec({ label: 'change background', do() { apply(); touch(S.pmap); rerender(); }, undo() { restore(); rerender(); } });
};
els.fBg.onblur = () => {
  if (bgSnapshot) { // focused, changed, but no `change` (the panel was dismissed): cancel the preview
    for (const r of selectedRegions()) if (bgSnapshot.has(r.id)) r.content.background = bgSnapshot.get(r.id);
    bgSnapshot = null;
  }
  S.bgPreview = false; rerender();
};
// `I` is the "pick a colour" key (spec §11): it opens the region background colour control the
// same way a click on the swatch does, so the native picker — and its eyedropper — comes up.
// The control only exists while a region is selected, so the key is gated on it being on screen
// (the contextual-keys rule), exactly like `Shift+T`.
function backgroundButtonVisible() {
  return !!els.fBg && !!els.regionTools && !els.regionTools.hidden && els.fBg.offsetParent !== null;
}
function openBackgroundPicker() {
  els.fBg.focus(); // starts the mask preview, then hand off to the picker
  try {
    if (typeof els.fBg.showPicker === 'function') { els.fBg.showPicker(); return; }
  } catch { /* fall through to click */ }
  els.fBg.click();
}
els.fTargetLang.onchange = () => {
  const value = els.fTargetLang.value || '';
  if (S.lens === 'improve') {
    settings.selectableLang = value || settings.selectableLang;
    if (value) S.pdfLanguage = value;
    saveSettings(); saveDocPrefs();
    setStatus(`Source language: ${languageName(value)} (${value}).`);
    rerender(); refreshChrome(); refreshMapInfo();
  } else {
    settings.targetLang = value || settings.targetLang;
    saveSettings();
  }
};
els.fItemSource.onchange = () => editItem(i => { i.source = els.fItemSource.value; }, 'edit image source');
els.fItemFit.onchange = () => editItem(i => { i.fit = els.fItemFit.value; }, 'item fit');
// A box's size (and position) is a page gesture: drag the box or its corner handles. The
// panel deliberately has no width/height fields — the numbers went stale the moment a
// handle moved, and typing them resized the content behind the user's back.

// ---- toolbar rich-text tools: format the editor selection (never the whole box) ----
for (const group of [els.textTools, els.tableTools]) {
  if (!group) continue;
  group.addEventListener('pointerdown', () => captureEditorSel());
}
for (const b of [els.ttBold, els.ttItalic, els.ttUnderline, els.ttTable, els.ttUl, els.ttOl, els.ttHead, els.textZoomIn, els.textZoomOut]) {
  if (b) b.addEventListener('mousedown', (e) => e.preventDefault());
}
els.ttBold.onclick = () => applyTextFormat('bold');
els.ttItalic.onclick = () => applyTextFormat('italic');
els.ttUnderline.onclick = () => applyTextFormat('underline');
els.ttColor.onchange = () => applyTextFormat('color', els.ttColor.value);
els.ttFont.onchange = () => applyTextFormat('font', els.ttFont.value);
els.ttSize.onchange = () => applyTextFormat('size', els.ttSize.value);
els.ttLine.onchange = () => applyLineSpacing(els.ttLine.value);
els.ttAlign.onchange = () => applyAlign(els.ttAlign.value);
els.ttDir.onchange = () => applyTextFormat('dir', els.ttDir.value);
if (els.ttTable) els.ttTable.onclick = () => blockOp('table');
if (els.ttUl) els.ttUl.onclick = () => blockOp('ul');
if (els.ttOl) els.ttOl.onclick = () => blockOp('ol');
if (els.ttHead) els.ttHead.onclick = () => blockOp('head');

// table tool group (only while editing inside a table cell)
const tblBtn = (id, fn) => { const b = $(id); if (b) b.onclick = fn; };
tblBtn('tbl-add-row', () => tableOp('addRow'));
tblBtn('tbl-del-row', () => tableOp('delRow'));
tblBtn('tbl-add-col', () => tableOp('addCol'));
tblBtn('tbl-del-col', () => tableOp('delCol'));
if (els.tblBorderColor) els.tblBorderColor.onchange = () => tableOp('border', { color: els.tblBorderColor.value });
if (els.tblBorderWidth) els.tblBorderWidth.onchange = () => tableOp('border', { width: Math.max(0, Math.min(12, Number(els.tblBorderWidth.value) || 0)) });
if (els.tblColW) els.tblColW.onchange = () => tableOp('colWidth', els.tblColW.value);
if (els.tblRowH) els.tblRowH.onchange = () => tableOp('rowHeight', els.tblRowH.value);
if (els.tblWidth) els.tblWidth.onchange = () => tableOp('tableWidth', els.tblWidth.value);

// drag-drop anywhere
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => { e.preventDefault(); if (e.dataTransfer?.files?.length) openFileList([...e.dataTransfer.files]); });

// Leaving the page mid-download: stop the on-device model download cleanly.
window.addEventListener('pagehide', () => { cancelChromeAiDownload(); flushSessionSave(); });

// ---- the project: a shared map + the active content variant ----
// On disk a project is two v2 files (spec §3–§4): a structure-only `.pmap` and one
// `<stem>.<variant>.content.json` keyed by the map's region ids. The editor holds them
// *resolved* into one object (S.pmap), so this section is the only place that knows
// about the split: it reads both halves in, and writes both halves back out.

// Comparison form of a file half, ignoring `meta.modified` (a timestamp, not data): two
// halves whose canonical forms match hold the same thing. `modified` is blanked in place for
// the stringify (JSON.stringify omits `undefined`) and restored immediately — synchronous,
// so no observer can see the temporary state.
function canonical(obj) {
  const meta = obj && obj.meta;
  const saved = meta && meta.modified;
  if (meta) meta.modified = undefined;
  const s = JSON.stringify(obj);
  if (meta) meta.modified = saved;
  return s;
}

// Rebuild both files from the current model. `meta.modified` moves only for the side
// whose data actually changed, so a content-only edit leaves the shared map's timestamp
// (and its bytes) alone — and the info line can say which half is unsaved.
async function projectTexts() {
  const p = S.project;
  const { map, content } = await splitProject(S.pmap, {
    mapId: p.mapId,
    mapName: p.map.name,
    contentName: p.content.name,
    variant: p.content.language,
    label: p.content.label,
    // A browser save is a download, so image sources stay inline. Externalizing them
    // into assets/ is the CLI's job (tools/pmap-migrate.mjs).
    externalizeDataUris: false,
  });
  // Identity and dates belong to the project, not to the split. installProject() has
  // already given both halves the same name/label/created the baseline was built from, so
  // what is written here is byte-for-byte what "unchanged" is measured against.
  map.meta.name = p.map.name;
  map.meta.label = p.map.label;
  map.meta.created = p.map.created;
  content.meta.name = p.content.name;
  content.meta.language = p.content.language;
  if (p.content.label) content.meta.label = p.content.label; else delete content.meta.label;
  content.meta.created = p.content.created;
  content.assets = p.content.assets;   // references the loaded variant already had
  const canon = { map: canonical(map), content: canonical(content) };
  const changed = { map: canon.map !== p.saved.map, content: canon.content !== p.saved.content };
  const now = new Date().toISOString();
  map.meta.modified = changed.map ? now : (p.map.modified || now);
  content.meta.modified = changed.content ? now : (p.content.modified || now);
  return { map, content, changed, mapText: serializeMap(map), contentText: serializeContent(content) };
}

// ---- the in-session variant cache (spec 1.5 §22) --------------------------------
// Only one content variant is active, but variant-to-variant translation must read the
// PDF-language variant while writing into a target. Variants switched away from are
// remembered here for the lifetime of the open document. This is a convenience, not
// storage: each variant still lives (or dies) as its own `.content.json` file, and the
// session only autosaves the active one.
function variantKey(c) {
  return `${c.mapId}\u0000${c.meta?.name || ''}\u0000${c.meta?.created || ''}`;
}
function rememberVariant(c) {
  if (!c?.meta) return;
  const key = variantKey(c);
  const hit = S.variants.find(v => v.key === key);
  if (hit) hit.content = c; else S.variants.push({ key, content: c });
}
// The most recently remembered variant of a language. The active variant always wins
// (spec §22: two variants with the same language are disambiguated by the active one).
function findRememberedVariant(language) {
  const want = String(language || '').toLowerCase();
  if (!want) return null;
  const mapId = S.project?.mapId;
  for (let i = S.variants.length - 1; i >= 0; i--) {
    const c = S.variants[i].content;
    if (mapId && c.mapId !== mapId) continue;
    if (String(c.meta?.language || '').toLowerCase() === want) return c;
  }
  return null;
}
// Where translation reads from: the active variant when it is the PDF's language, else
// a remembered variant of that language. `content` is null for the active one because
// the live model (S.pmap) is the authority there.
function sourceVariantFor(pdfLang) {
  const active = S.project?.content;
  if (active && String(active.language || '').toLowerCase() === String(pdfLang || '').toLowerCase()) {
    return { active: true, content: null };
  }
  const remembered = findRememberedVariant(pdfLang);
  return remembered ? { active: false, content: remembered } : null;
}
function activeVariantIsSource() {
  return !!S.project && !!S.pdfLanguage
    && String(S.project.content.language || '').toLowerCase() === String(S.pdfLanguage).toLowerCase();
}

// Make a resolved project the current one, remembering exactly what was loaded so
// nothing counts as unsaved until it actually changes.
function installProject(map, content) {
  const resolved = resolveProject(map, content);
  // The awaiting-OCR classification is keyed by region id and describes the PDF under
  // those regions, so it survives a variant switch (same map) but not a different map
  // or document (spec 1.5 §20).
  if (S.project && S.project.mapId !== resolved.map.mapId) S.awaitingOcr = new Set();
  // Fill in the few optional metadata fields a file may omit, on the halves themselves, so
  // the saved baseline below is exactly what projectTexts() would write back.
  const m = resolved.map.meta || (resolved.map.meta = {});
  const c = resolved.content.meta || (resolved.content.meta = {});
  m.name = m.name || defaultMapName(S.pdfName);
  m.label = m.label || 'Shared map';
  m.created = m.created || '';
  c.name = c.name || defaultContentName(S.pdfName, c.language);
  c.language = c.language || 'en';
  c.created = c.created || '';
  S.pmap = resolved.merged;
  S.project = {
    mapId: resolved.map.mapId,
    map: { name: m.name, label: m.label, created: m.created, modified: m.modified || '' },
    content: {
      name: c.name, language: c.language, label: c.label || '', created: c.created,
      modified: c.modified || '', assets: resolved.content.assets || [],
    },
    saved: { map: canonical(resolved.map), content: canonical(resolved.content) },
  };
  rememberVariant(resolved.content);
  rememberLensVariant();
  S.dirtySides = { map: false, content: false };
  return resolved;
}

// An empty project for the PDF that is already open (map + one empty content variant).
// The first page is part of the project from the start: adding it after installProject()
// would make the brand-new map look unsaved (and a Close PDF right after opening would
// have to ask about discarding changes nobody made).
function emptyProjectForPdf(size) {
  const { map, content } = createEmptyProject({ filename: S.pdfName, sha256: S.sha256, pageCount: viewer.pageCount });
  if (size) ensurePage(map, 1, size.width, size.height);
  installProject(map, content);
}

// Read a content variant file and check it is really for this map: a variant that names
// another map (or one that carries entries for regions this map does not have, which
// joinProject refuses) is reported rather than loaded with content silently dropped.
async function readContentFile(file, map) {
  const content = parseContent(await file.text());
  if (content.mapId !== map.mapId) {
    throw new Error(`“${file.name}” belongs to map ${content.mapId}, not ${map.mapId}`);
  }
  return content;
}

// Switch the active content variant, keeping the shared map exactly as it is: the map
// half is rebuilt from the current model, so geometry edits made while the previous
// variant was active are not lost.
// A remembered variant can outlive a region the user deleted while another variant was
// active. The deleted region's entry is inert data (spec §22) and must not block the
// switch; drop it from the in-memory copy. The file on disk keeps it until it is saved.
function pruneVariantToMap(content, map) {
  const ids = new Set();
  for (const p of map.pages || []) for (const r of p.regions || []) ids.add(r.id);
  for (const id of Object.keys(content.regions || {})) if (!ids.has(id)) delete content.regions[id];
}

async function switchContentVariant(next, { guard = true, quiet = false } = {}) {
  if (!S.pmap || !S.project) return false;
  const { map, content, changed } = await projectTexts();
  if (guard && changed.content
    && !(await confirmDialog({
      title: 'Unexported changes in this variant',
      text: `“${S.project.content.name}” has unexported changes. They stay in this session’s memory and IndexedDB, but they are not written to a file unless you export them first.`,
      confirmLabel: 'Switch anyway', cancelLabel: 'Keep editing',
    }))) {
    setStatus(`Kept ${S.project.content.name} (switch cancelled).`);
    return false;
  }
  // Save the outgoing variant to IndexedDB before unloading (§22).
  await flushSessionSave();
  // Keep the outgoing variant available for variant-to-variant translation. A
  // switch is not a delete: the content is still here, just not active.
  rememberVariant(content);
  pruneVariantToMap(next, map);
  installProject(map, next);
  history.clear(); S.selected.clear(); S.itemIndex = 0; S.itemSelected = false; clearItemSelection();
  rememberLensVariant();
  refreshChrome(); renderCurrent(); refreshMapInfo();
  if (!quiet) setStatus(`Active content variant: ${S.project.content.name} (${S.project.content.language}).`);
  scheduleSessionSave();
  return true;
}

// Open a content variant from disk for the map that is already loaded.
async function openContentFile(file) {
  try {
    if (!S.pmap || !S.project) { setStatus(`Open the shared map first — “${file.name}” is a content variant.`); return; }
    const { map } = await projectTexts();
    await switchContentVariant(await readContentFile(file, map));
  } catch (err) { setStatus('Cannot load content variant: ' + err.message); }
}

// A new language/variant of the same map. Empty by default; copying is offered as a
// convenience, never as a claim of translation — copied text comes back flagged for
// review (spec §3).
async function createContentVariant(language, label, copy) {
  const { map, content } = await projectTexts();
  const next = emptyContentVariant({
    mapId: map.mapId, language, label, name: defaultContentName(map.meta.name, language),
  });
  if (copy) {
    next.regions = JSON.parse(JSON.stringify(content.regions));
    for (const entry of Object.values(next.regions)) for (const it of entry.items || []) if (it.type === 'text') it.needsReview = true;
    next.assets = JSON.parse(JSON.stringify(content.assets || []));
  }
  if (await switchContentVariant(next)) setStatus(`Created content variant ${next.meta.name}${copy ? ' (copied, flagged for review)' : ''}.`);
}

// Switch to a content variant already loaded this session — the PDF-language source used
// by translation, a target, or any other variant switched away from. Variants on disk
// that were never opened are reached through File ▸ Open map or content… instead.
async function promptSwitchContentVariant() {
  if (!S.pmap || !S.project) { setStatus('Open a PDF first.'); return; }
  const { content } = await projectTexts();
  rememberVariant(content);   // the active variant's cache entry reflects the current edits
  const active = S.project.content;
  const choices = S.variants.filter(v => v.content.mapId === S.project.mapId);
  const modal = $('picker-modal'), list = $('picker-list');
  $('picker-title').textContent = 'Switch content variant';
  list.innerHTML = '';
  for (const v of choices) {
    const c = v.content;
    const isActive = c.meta.name === active.name && c.meta.created === active.created;
    const isSource = !!S.pdfLanguage && String(c.meta.language || '').toLowerCase() === String(S.pdfLanguage).toLowerCase();
    const role = isSource ? lensCopy().sourceVariant : 'translation';
    const b = document.createElement('button');
    b.textContent = `${c.meta.name} (${c.meta.language}) — ${role}${isActive ? ' — active' : ''}`;
    b.disabled = isActive;
    b.onclick = () => { modal.hidden = true; switchContentVariant(c); };
    list.appendChild(b);
  }
  modal.hidden = false;
  $('picker-cancel').textContent = 'Cancel';
  $('picker-cancel').onclick = () => { modal.hidden = true; };
}

function promptNewContentVariant() {
  if (!S.pmap || !S.project) { setStatus('Open a PDF first.'); return; }
  const modal = $('variant-modal'), lang = $('variant-lang'), label = $('variant-label'), copy = $('variant-copy');
  lang.value = ''; label.value = ''; copy.checked = true;
  modal.hidden = false; lang.focus();
  $('variant-create').onclick = () => {
    const language = lang.value.trim();
    if (!/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(language)) { setStatus('Enter a language code like “de” or “pt-BR”.'); lang.focus(); return; }
    modal.hidden = true;
    createContentVariant(language, label.value.trim(), copy.checked);
  };
  $('variant-cancel').onclick = () => { modal.hidden = true; };
}

// ---- last session (IndexedDB) ----
// A browser refresh would otherwise drop the open PDF and the whole project. We keep
// the source bytes, the shared map and the active content variant in IndexedDB, on this
// machine only, and restore them on load. The source PDF is still never modified.
let sessionActive = false;   // a PDF is open (or has been restored) — so saving is meaningful
let sessionTimer = null;
let sessionGen = 0;          // bumped by a new file open, to abandon a stale restore

function scheduleSessionSave() {
  if (sessionTimer) clearTimeout(sessionTimer);
  sessionTimer = setTimeout(flushSessionSave, 600);
}
async function flushSessionSave() {
  if (sessionTimer) { clearTimeout(sessionTimer); sessionTimer = null; }
  if (!S.pmap || !S.project) return;
  try {
    const { mapText, contentText, changed } = await projectTexts();
    // The debounced pass is the natural moment to notice which half is unsaved — and it must
    // keep happening even after File ▸ Forget saved session, which stops *storage*, not editing.
    S.dirtySides = changed;
    refreshMapInfo();
    if (!sessionActive) return;
    // Write to the slot the active variant belongs to. During a lens switch this is pinned
    // to the outgoing lens until the switch completes, so the outgoing variant never lands
    // in the incoming lens's slot.
    await saveSessionProject({ slot: S.activeSlot || contentSlotForLens(S.lens), mapJson: mapText, mapName: S.project.map.name, contentJson: contentText, contentName: S.project.content.name });
  } catch {}
}
// Every model mutation calls touch(); piggyback the (debounced) session save on it.
function touch(pmap) { touchMap(pmap); scheduleSessionSave(); }

async function clearSavedSession() {
  // Stop autosave before deleting, so a debounced pass cannot write the session back
  // after the user closed the document or asked to forget it.
  sessionActive = false;
  if (sessionTimer) { clearTimeout(sessionTimer); sessionTimer = null; }
  try { await clearSession(); } catch {}
}

// ---- file opening ----
async function openFileList(files) {
  // A new document means any on-device model download for the old one is moot.
  cancelChromeAiDownload();
  const pdfs = files.filter(f => /\.pdf$/i.test(f.name));
  const maps = files.filter(f => isMapFileName(f.name));
  const contents = files.filter(f => isContentFileName(f.name));
  if (!pdfs.length && (maps.length || contents.length) && S.pdfBytes) {
    // Dropped onto the open PDF: a map (with whatever content variant came along), or
    // just another content variant for the map that is already loaded.
    if (maps.length === 1) await loadMapFile(maps[0], matchContentFiles(S.pdfName, files));
    else if (maps.length > 1) {
      const pick = await pickFile(maps, { title: 'Multiple maps found — pick one', cancelLabel: 'Start empty' });
      if (pick) await loadMapFile(pick, matchContentFiles(S.pdfName, files));
      else startEmptyProject('Started with a new empty project.');
    } else if (contents.length === 1) await openContentFile(contents[0]);
    else if (contents.length > 1) {
      const pick = await pickFile(contents, { title: 'Multiple content variants found — pick one', cancelLabel: 'Keep the current variant' });
      if (pick) await openContentFile(pick);
    } else setStatus('Open or drop a .pdf, a .pmap map or a .content.json variant.');
    return;
  }
  if (!pdfs.length) { setStatus('Open or drop a .pdf file (optionally with its .pmap map and .content.json variant together).'); return; }
  sessionGen++; // an explicitly opened file wins over a startup restore
  const pdf = pdfs[0];
  await loadPdfFile(pdf);
  const mapCands = matchSidecars(pdf.name, maps);
  const contentCands = matchContentFiles(pdf.name, contents);
  if (mapCands.length === 1) await loadMapFile(mapCands[0], contentCands);
  else if (mapCands.length > 1) {
    const pick = await pickFile(mapCands, { title: 'Multiple maps found — pick one', cancelLabel: 'Start empty' });
    if (pick) await loadMapFile(pick, contentCands);
    else startEmptyProject('Started with a new empty project.');
  } else if (contentCands.length) {
    startEmptyProject('New empty project — a content variant needs the .pmap map it belongs to, so open both together.');
  } else {
    startEmptyProject('New empty project (map + one content variant).');
  }
  maybeApplyDefaultLens();
}

// A new empty project for the PDF that is already open, on screen and editable.
async function startEmptyProject(msg) {
  const s = await viewer.baseSize(1);
  emptyProjectForPdf(s);
  afterMapLoaded(msg || 'Started with a new empty project.');
}

async function loadPdfFile(file) {
  const buf = await file.arrayBuffer();
  S.pdfName = file.name;
  setStatus('Hashing PDF…');
  await new Promise(r => setTimeout(r, 0)); // let the status paint before the work
  // Hash and open concurrently. viewer.load() makes its own copy, so both can share `buf`
  // without extra full-file copies and without one detaching the other's data.
  const [sha] = await Promise.all([sha256Hex(buf), viewer.load(buf)]);
  S.sha256 = sha;
  S.pdfBytes = buf;
  const prefs = loadDocPrefs(sha);
  S.pdfLanguage = prefs.pdfLanguage || null;
  S.lens = LENS_COPY[prefs.lens] ? prefs.lens : 'translate';
  S.lensVariant = { translate: null, improve: null };
  S.variants = [];
  S.page = 1; S.selected.clear(); history.clear(); clearItemSelection();
  S.zoom = 1.2;
  // A new document must always repaint, even when it lands on the same page/zoom as the
  // previous one (otherwise the canvas would keep showing the old file's page).
  lastPdfRender = { page: 0, zoom: 0 };
  docGen++;
  // Remember it, so a refresh brings the document (and its map) back. The map (or the
  // sidecar) is installed by the caller, which paints the page and then starts the
  // background thumbnail build — so a long document never blocks the open.
  sessionActive = true;
  try { await saveSessionPdf(file.name, buf, sha); } catch {}
  setStatus(`Opened ${file.name} (${viewer.pageCount} pages).`);
}

// Load a v2 shared map (plus, when the selection brought one, its content variant).
async function loadMapFile(file, contentFiles = []) {
  try {
    const text = await file.text();
    const kind = detectFileKind(JSON.parse(text));
    if (kind === 'content') { setStatus(`“${file.name}” is a content variant, not a map — open the .pmap it belongs to.`); return; }
    if (kind === 'map-legacy') {
      throw new Error('this is a v1.1 single-file map (geometry and content in one file). Split it with '
        + 'tools/pmap-migrate.mjs first, then open the .pmap and its .content.json file together.');
    }
    const map = parseMap(text);
    const errs = [];
    if (map.source?.sha256 && map.source.sha256 !== S.sha256) errs.push(`hash differs (map for ${map.source.filename || 'another file'})`);
    if (map.source?.page_count && map.source.page_count !== viewer.pageCount) errs.push(`page count ${map.source.page_count} vs ${viewer.pageCount}`);
    if (errs.length) {
      const ok = await confirmMismatch(`This map “${file.name}” was made for a different file: ${errs.join('; ')}.`);
      if (!ok) { setStatus('Map load cancelled (mismatch).'); return; }
    }
    // The content variant that came with the map, or an empty one to start from: the map
    // is usable either way (regions without content simply show the source page). A
    // co-selected variant that belongs to another map is *not* allowed to sink the map:
    // it is dropped with a note, and the region set stays loaded and editable.
    let content = null;
    let why = '';
    try {
      if (contentFiles.length === 1) content = await readContentFile(contentFiles[0], map);
      else if (contentFiles.length > 1) {
        const pick = await pickFile(contentFiles, { title: 'Multiple content variants found — pick one', cancelLabel: 'No content variant' });
        if (pick) content = await readContentFile(pick, map);
      }
    } catch (err) { why = ` — ${err.message}, so it was not loaded`; }
    installProject(map, content || emptyContentVariant({ mapId: map.mapId, language: 'en', label: 'Base map', name: defaultContentName(map.meta?.name || file.name, 'en') }));
    afterMapLoaded(`Loaded ${map.meta?.name || file.name}${content ? ` + ${S.project.content.name}` : ' (no content variant — regions show the source page)'}${why}.`);
  } catch (err) { setStatus('Cannot load map: ' + err.message); }
}

function afterMapLoaded(msg) {
  syncIdCounter(S.pmap);
  history.clear(); S.selected.clear(); S.itemIndex = 0;
  setStatus(msg);
  applyLensChrome();
  gotoPage(1);
  // The map is on screen now; fill the page rail in the background (and only for a
  // document we have not built thumbs for yet).
  startThumbs();
  scheduleSessionSave();
}

// Re-open the last session from IndexedDB at startup. Best effort: any failure
// (no session, a cleared profile, a corrupt record) just leaves the app empty.
//
// Order matters: the map and the current page come *first*, so a refresh hands the work
// back immediately, and only then are the page thumbnails built in the background.
// Building them first (as this used to do) left a long document looking stuck — the
// status still said "Restoring…" and nothing on screen could be edited yet.
async function restoreSession() {
  const gen = sessionGen;
  let pdf = null, map = null, content = null;
  try {
    [pdf, map] = await Promise.all([loadSessionPdf(), loadSessionMap()]);
    if (pdf?.bytes) {
      // The content variant is loaded from the slot of the lens that was active when the
      // session was saved (the remembered lens), so a refresh returns to the same workflow.
      const prefs = loadDocPrefs(pdf.sha256 || '');
      const lens = LENS_COPY[prefs.lens] ? prefs.lens : 'translate';
      content = await loadSessionContent(contentSlotForLens(lens));
    }
  } catch { return false; }
  if (!pdf?.bytes || gen !== sessionGen) return false;
  try {
    setStatus(`Restoring your last session (${pdf.name})…`);
    await viewer.load(pdf.bytes);
    if (gen !== sessionGen) return false;
    S.pdfName = pdf.name || 'document.pdf';
    S.pdfBytes = pdf.bytes;
    S.sha256 = pdf.sha256 || await sha256Hex(pdf.bytes);
    const prefs = loadDocPrefs(S.sha256);
    S.pdfLanguage = prefs.pdfLanguage || null;
    S.lens = LENS_COPY[prefs.lens] ? prefs.lens : 'translate';
    S.lensVariant = { translate: null, improve: null };
    S.variants = [];
    S.page = 1; S.selected.clear(); history.clear(); S.zoom = 1.2; clearItemSelection();
    lastPdfRender = { page: 0, zoom: 0 };
    docGen++;
    sessionActive = true;
    // The map comes back even if the content variant is missing or unreadable: the map
    // is the user's work too, and an empty variant still leaves every region editable.
    let note = '';
    let restoredMap = null, restoredContent = null;
    if (map?.json) {
      try {
        restoredMap = parseMap(map.json);
        if (content?.json) { try { restoredContent = parseContent(content.json); } catch { restoredContent = null; } }
        if (restoredContent && restoredContent.mapId !== restoredMap.mapId) restoredContent = null;
        note = restoredContent ? '' : (content?.json
          ? ' — its content variant could not be restored, so the regions have no content'
          : ' — no content variant was saved, so the regions have no content');
      } catch { restoredMap = null; }
    }
    if (restoredMap) {
      installProject(restoredMap, restoredContent || emptyContentVariant({ mapId: restoredMap.mapId, language: 'en', label: 'Base map', name: defaultContentName(S.pdfName, 'en') }));
    } else {
      S.pmap = null;
      const size = await viewer.baseSize(1);
      emptyProjectForPdf(size);
      note = '';
    }
    if (gen !== sessionGen) return false;
    // Paints page 1 with its regions and kicks off the thumbnail build behind it.
    afterMapLoaded(`Restored ${S.pdfName}${restoredMap ? ` + ${S.project.map.name} + ${S.project.content.name}` : ''} from your last session${note}.`);
    return true;
  } catch (e) {
    // Never leave a half-restored app behind: whatever failed, drop back to the state a
    // fresh load would be in (empty map, empty overlay, nothing rendered) so the user can
    // still open the file by hand, and say what happened in the status bar.
    sessionActive = false;
    S.pmap = null;
    S.project = null;
    S.dirtySides = { map: false, content: false };
    lastPdfRender = { page: 0, zoom: 0 };
    try { overlay.clear(); } catch {}
    if (viewer.doc) renderCurrent();
    setStatus('Could not restore the last session (' + ((e && e.message) || e) + ') — open the file again to continue (closing a PDF clears its saved session).');
    return false;
  }
}

// A small modal picker (maps and content variants share it). Resolves with the chosen
// file, or null when the user cancels — the caller owns what cancelling means.
function pickFile(files, { title = 'Pick a file', cancelLabel = 'Cancel' } = {}) {
  return new Promise((resolve) => {
    const modal = $('picker-modal'), list = $('picker-list');
    $('picker-title').textContent = title;
    list.innerHTML = '';
    for (const f of files) {
      const b = document.createElement('button');
      b.textContent = f.name;
      b.onclick = () => { modal.hidden = true; resolve(f); };
      list.appendChild(b);
    }
    modal.hidden = false;
    $('picker-cancel').textContent = cancelLabel;
    $('picker-cancel').onclick = () => { modal.hidden = true; resolve(null); };
  });
}

function confirmMismatch(text) {
  return new Promise((res) => {
    $('warn-text').textContent = text;
    $('warn-modal').hidden = false;
    $('warn-load').onclick = () => { $('warn-modal').hidden = true; res(true); };
    $('warn-cancel').onclick = () => { $('warn-modal').hidden = true; res(false); };
  });
}

// ---- run decisions --------------------------------------------------------------
// The outward paths (extraction, translation, and later re-detection) can overwrite
// authored content, so they ask first. This is the one dialog they share: it offers
// the choices for the moment, plus an optional "apply to all" that stops the prompts
// for the rest of the run. A run's answer lives on its `run` object only — never in
// settings, the map, or the content file. Cancelling aborts the run, so nothing is
// written; callers must treat `null` that way.
//
// Re-detection (§21) additionally passes `preview`: both candidate polygons, drawn over a
// crop of the page. The page render is asynchronous and best-effort (a dialog must never
// wait on it to become usable): the shapes are painted first, the page image when it
// arrives. A token makes a late render of a previous dialog a no-op.
let choicePreviewToken = 0;
function showChoicePreview(preview) {
  const cv = $('choice-preview'), legend = $('choice-legend');
  const token = ++choicePreviewToken;
  if (!preview) { cv.hidden = true; legend.hidden = true; return; }
  cv.hidden = false; legend.hidden = false;
  const { page, existing, proposed } = preview;
  const a = regionBBox(existing), b = regionBBox(proposed);
  const x0 = Math.min(a[0], b[0]), y0 = Math.min(a[1], b[1]);
  const x1 = Math.max(a[2], b[2]), y1 = Math.max(a[3], b[3]);
  const grow = Math.max(4, 0.06 * Math.max(x1 - x0, y1 - y0));
  const view = [Math.max(0, x0 - grow), Math.max(0, y0 - grow), x1 + grow, y1 + grow];
  const paint = (img) => {
    if (token !== choicePreviewToken) return;
    const W = 380, H = 170;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    cv.style.width = `${W}px`; cv.style.height = `${H}px`;
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
    const vw = Math.max(1e-6, view[2] - view[0]), vh = Math.max(1e-6, view[3] - view[1]);
    const pad = 5;
    const scale = Math.min((W - 2 * pad) / vw, (H - 2 * pad) / vh);
    const ox = (W - vw * scale) / 2 - view[0] * scale;
    const oy = (H - vh * scale) / 2 - view[1] * scale;
    if (img) ctx.drawImage(img, ox + view[0] * scale, oy + view[1] * scale, vw * scale, vh * scale);
    const sx = (x) => ox + x * scale, sy = (y) => oy + y * scale;
    drawPreviewShape(ctx, regionRings(existing), sx, sy, '#2f6fbf', 'rgba(74,144,217,.26)', false);
    drawPreviewShape(ctx, regionRings(proposed), sx, sy, '#d97706', 'rgba(217,119,6,.16)', true);
  };
  paint(null);
  if (!viewer.doc) return;
  // A crop around the conflict, so both shapes are seen in the page's own context and
  // the review is about geometry, not two abstract outlines.
  viewer.cropDataUrl(page, view, 2).then((url) => {
    if (token !== choicePreviewToken) return;
    const img = new Image();
    img.onload = () => paint(img);
    img.src = url;
  }).catch(() => { /* the outline-only preview is still useful */ });
}
function drawPreviewShape(ctx, rings, sx, sy, stroke, fill, dashed) {
  ctx.save();
  ctx.beginPath();
  for (const ring of rings) {
    if (!ring || ring.length < 2) continue;
    ring.forEach(([x, y], i) => { if (i === 0) ctx.moveTo(sx(x), sy(y)); else ctx.lineTo(sx(x), sy(y)); });
    ctx.closePath();
  }
  ctx.fillStyle = fill;
  ctx.fill('evenodd');
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 2;
  if (dashed) ctx.setLineDash([6, 4]);
  ctx.stroke();
  ctx.restore();
}

function chooseDialog({ title, text, choices, applyLabel = '', preview = null }) {
  return new Promise((resolve) => {
    const modal = $('choice-modal'), box = $('choice-buttons');
    $('choice-title').textContent = title;
    $('choice-text').textContent = text;
    $('choice-apply').checked = false;
    $('choice-apply-row').hidden = !applyLabel;
    if (applyLabel) $('choice-apply-label').textContent = applyLabel;
    showChoicePreview(preview);
    box.innerHTML = '';
    const finish = (choice) => {
      ++choicePreviewToken; // a page crop still in flight must not paint a future dialog
      modal.hidden = true;
      resolve(choice === undefined ? null : { choice, applyAll: !$('choice-apply-row').hidden && $('choice-apply').checked });
    };
    for (const c of choices) {
      const b = document.createElement('button');
      b.textContent = c.label;
      if (c.primary) b.className = 'primary';
      b.onclick = () => finish(c.choice);
      box.appendChild(b);
    }
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.onclick = () => finish(undefined);
    box.appendChild(cancel);
    modal.hidden = false;
    (box.querySelector('button.primary') || box.firstElementChild)?.focus();
  });
}

function makeRunChoice() { return { decision: null }; }

async function runChoice(run, opts) {
  if (run?.decision) return { choice: run.decision, applyAll: false, remembered: true };
  const res = await chooseDialog(opts);
  if (!res) return null;
  if (run && res.applyAll) run.decision = res.choice;
  return res;
}

// ---- rendering ----
// Page thumbnails are a convenience, never a prerequisite. Rendering every page of a
// long document is expensive (a scanned book decodes one full image per page), so the
// rail is filled *after* the current page and its map are on screen — in the
// background, and abandoned the moment another document is loaded. `gen` is the
// document generation the caller observed; a newer load makes this pass a no-op.
let docGen = 0;        // bumped whenever a new document's bytes are loaded
let thumbsForGen = -1; // the document generation whose thumbnails were started
async function buildThumbs(gen) {
  for (let n = 1; n <= viewer.pageCount; n++) {
    if (gen !== docGen) return;   // the document changed under us: stop where we are
    const c = document.createElement('canvas');
    c.title = 'Page ' + n;
    c.onclick = () => gotoPage(n);
    c.dataset.page = n;
    els.thumbs.appendChild(c);
    try { await viewer.renderThumbnail(c, n); } catch {}
  }
}
// Start the (background) thumbnail build for the document loaded right now, once the
// visible page has been painted so it never competes with what the user is looking at.
// Called for every map load; it only ever builds once per document (loading a .pmap
// onto the document that is already open must not rebuild the whole rail).
function startThumbs() {
  if (thumbsForGen === docGen) return;
  thumbsForGen = docGen;
  const gen = docGen;
  els.thumbs.innerHTML = '';    // leftover thumbs belong to the previous document
  renderCurrent().then(() => { if (gen === docGen) buildThumbs(gen); });
}
async function gotoPage(n) {
  if (!viewer.doc) return;
  S.page = Math.max(1, Math.min(viewer.pageCount, n));
  S.selected.clear(); S.itemSelected = false; clearItemSelection();
  await renderCurrent();
}
function setZoom(z) { S.zoom = Math.max(0.2, Math.min(5, z)); renderCurrent(); }
async function fitZoom() {
  const wrap = $('stage-wrap');
  const s = await viewer.baseSize(S.page);
  S.zoom = Math.max(0.2, Math.min(3, (wrap.clientWidth - 60) / s.width));
  renderCurrent();
}

let lastPdfRender = { page: 0, zoom: 0 };
// Serialize renders: pdf.js forbids concurrent render() on the same canvas.
let renderQueue = Promise.resolve();
function renderCurrent() {
  renderQueue = renderQueue.then(doRenderCurrent).catch(err => { console.error(err); });
  return renderQueue;
}
async function doRenderCurrent() {
  if (!viewer.doc) return;
  els.pdfCanvas.hidden = false;
  const size = await viewer.baseSize(S.page);
  stage.setPageSize(size.width, size.height);
  // Skip expensive pdf.js re-render when page+zoom unchanged (selection, drag preview, typing).
  if (lastPdfRender.page !== S.page || lastPdfRender.zoom !== S.zoom) {
    await viewer.renderTo(els.pdfCanvas, S.page, S.zoom);
    try { await viewer.renderTextLayer(els.textLayer, S.page, S.zoom); } catch { els.textLayer.innerHTML = ''; }
    lastPdfRender = { page: S.page, zoom: S.zoom };
  }
  stage.applyToSvg(els.svg);
  els.svg.style.width = `${size.width * S.zoom}px`;
  els.svg.style.height = `${size.height * S.zoom}px`;
  els.textLayer.style.width = `${size.width * S.zoom}px`;
  els.textLayer.style.height = `${size.height * S.zoom}px`;
  applyTextLayerInteractivity();
  els.zoomLabel.textContent = Math.round(S.zoom * 100) + '%';
  document.querySelectorAll('#thumbs canvas').forEach(c => c.classList.toggle('active', +c.dataset.page === S.page));
  if (!S.pmap) { refreshChrome(); return; }
  ensurePage(S.pmap, S.page, size.width, size.height);
  const pg = getPage(S.pmap, S.page);
  let regions = pg ? pg.regions : [];
  if (S.dragPreview) regions = applyDragPreview(regions);
  const itemBoxes = inContent() && !S.draft.length
    ? regions.filter(r => S.selected.has(r.id)).flatMap(r => buildItemBoxes(r))
    : [];
  const digitalSource = digitalSourceState();
  const digitalFilled = new Set(regions.filter(r => hasDigitalContent(r, digitalSource)).map(r => r.id));
  overlay.render({ regions, selectedIds: S.selected, draftPoints: S.draft, draftCursor: inRegion() ? S.cursor : null, splitLine: S.splitPts, mode: S.mode, tool: S.tool, itemBoxes, selectedVertex: S.selectedVertex, marquee: isEditMode() ? S.marquee : null, clipWarn: clippedRegions(regions), showDigital: S.showDigital, digitalFilled, awaitingOcr: S.awaitingOcr, statusTags: { filled: lensCopy().filledTag, missing: lensCopy().missingTag } });
  // Preview canvas. Preview mode masks every region and draws its items. The two editing modes
  // render the very same thing (mask + items) for every region *except* the one being
  // edited, whose mask is dropped (maskExcept) so the source PDF stays visible under the
  // cursor. So a deselected region already looks exactly the way it will in Preview mode /
  // the export — in Region mode this is also how the frozen items are shown (spec §9a).
  const maskedRegions = regions.filter(regionIsMasked);
  // Skipped while a drag/marquee/draft is previewing: no region's content changes under
  // the pointer, and the canvas is rebuilt as soon as the gesture ends.
  const midGesture = !!(S.dragPreview || S.marquee || S.draft.length);
  const clearViewCanvas = () => { try { els.viewCanvas.getContext('2d').clearRect(0, 0, els.viewCanvas.width, els.viewCanvas.height); } catch {} };
  if (S.mode === 'view') {
    els.viewCanvas.hidden = false;
    els.viewCanvas.style.left = '0px'; els.viewCanvas.style.top = '0px';
    renderView({ viewCanvas: els.viewCanvas, baseCanvas: els.pdfCanvas, regions, zoom: S.zoom, mask: true });
  } else if (isEditMode()) {
    els.viewCanvas.hidden = maskedRegions.length === 0;
    if (maskedRegions.length && !midGesture) {
      els.viewCanvas.style.left = '0px'; els.viewCanvas.style.top = '0px';
      // The region being edited stays transparent so the user sees the page under it — except
      // while the background colour picker has focus, when the mask is previewed on it so the
      // chosen colour can actually be seen (macOS fires `change` only when the panel closes).
      renderView({ viewCanvas: els.viewCanvas, baseCanvas: els.pdfCanvas, regions, zoom: S.zoom, mask: true, maskExcept: S.bgPreview ? new Set() : S.selected });
    } else {
      clearViewCanvas();
    }
  } else {
    els.viewCanvas.hidden = true;
    clearViewCanvas();
  }
  refreshChrome(); syncPropsForm(); refreshMapInfo(); styleInlineEditor();
}

// PDF text selection is only enabled in the dedicated Original mode, so it
// never fights the polygon editing interactions.
function applyTextLayerInteractivity() {
  const active = S.mode === 'text';
  els.textLayer.style.pointerEvents = active ? 'auto' : 'none';
  els.textLayer.style.userSelect = active ? 'text' : 'none';
}

function rerender() { renderCurrent(); }

function refreshChrome() {
  const armed = inRegion() && S.tool === 'polygon';
  const drafting = S.draft.length > 0 && inRegion();
  const hint = $('draw-hint');
  hint.hidden = !(drafting || armed);
  if (drafting) hint.textContent = `Add polygon — drawing page ${S.page}: click to add points · Enter/double-click to close (${S.draft.length} pts) · Esc cancels`;
  else if (armed) hint.textContent = `Add polygon — page ${S.page}: click to place the first point · Esc cancels`;
  if (els.stage) els.stage.style.cursor = armed ? 'crosshair' : '';
  refreshModeIndicator();
  refreshContextTools();
  refreshCoverage();
  refreshNextAction();
  renderReviewList();
  menubar?.refresh();
}

// ================= next-step guide (right panel) =================
// The panel's first section: a short, state-driven checklist of what the active workflow
// does next. Derived on every chrome refresh (never stored), and the actionable entries
// are buttons, so the guide doubles as shortcuts. Only the workflow's spine is listed —
// map the page → select → extract/translate → review/fit → save — never the full feature
// set, and each entry disappears once the state it describes has moved on.
function nextActionItems() {
  const steps = [];
  const c = lensCopy();
  if (!viewer.doc) {
    steps.push({ text: 'Open a PDF to start (Ctrl/Cmd+O, or drop it here).', btn: ['Open PDF', () => els.filePdf.click()] });
    return steps;
  }
  const pg = S.pmap ? getPage(S.pmap, S.page) : null;
  const regions = pg?.regions || [];
  const textRegions = regions.filter(r => !isDetectedImage(r));
  const sel = selectedRegions().filter(r => !isDetectedImage(r));

  // 1 — map the page
  if (!regions.length) {
    steps.push({
      text: `Page ${S.page} has no regions yet. Detect them, or draw one (P).`,
      btn: ['Detect (D)', () => detectRegionsOnPage()],
    });
  } else if (!S.selected.size) {
    if (!isEditMode()) {
      steps.push({ text: 'Switch to an editing mode to work on this page (Tab cycles modes).', btn: ['Region mode', () => setMode('region')] });
    } else {
      const withoutSource = textRegions.filter(r => !firstTextItem(r.content)).length;
      if (withoutSource) {
        steps.push({
          text: `No region selected. Click one, or select the ${withoutSource === 1 ? 'region' : 'regions'} still missing ${S.lens === 'improve' ? 'selectable text' : 'source text'}.`,
          btn: [`${c.selectMissing} (Shift+A)`, () => selectTextRegionsWithoutContent()],
        });
      } else {
        steps.push({ text: 'No region selected — click one on the page to continue.' });
      }
    }
  } else {
    // 2 — the selection's next editorial move, per workflow
    if (S.lens === 'translate') {
      const withText = sel.filter(r => (r.content?.items || []).some(it => it.type === 'text')).length;
      const inSource = activeVariantIsSource();
      const target = els.fTargetLang?.value || settings.targetLang || 'de';
      if (inSource && withText) {
        // The source variant is on screen: the next move is a translation into the target
        // variant, never "review" (the source text is exactly what is supposed to be here).
        steps.push({
          text: `This is the ${languageName(S.pdfLanguage || S.project?.content?.language)} source variant — translate the selection into ${languageName(target)}.`,
          btn: ['Translate from page text (Shift+T)', () => translateFromPageText()],
        });
      } else if (!withText) {
        steps.push({
          text: 'Read the page text under the selection, then translate it into the destination language (Source ▸ Destination above).',
          btn: ['Translate from page text (Shift+T)', () => translateFromPageText()],
        });
      } else {
        steps.push({ text: 'Target text exists — review the flagged items below, or switch variant / continue on another page.' });
      }
    } else {
      const withText = sel.filter(r => firstTextItem(r.content)).length;
      if (!withText || !activeVariantIsSource()) {
        steps.push({
          text: activeVariantIsSource()
            ? 'Read the text under the selection into the Selectable text variant (the Source dropdown above names its language).'
            : 'Make this selectable: the extraction writes into the PDF-language Selectable text variant, creating or switching to it as needed.',
          btn: ['Make this selectable (Shift+T)', () => extractSelectedContent()],
        });
      } else {
        steps.push({ text: 'Selection is selectable — continue on another page, or check flagged items below.' });
      }
    }
  }

  // 3 — page-level follow-ups, whatever the selection
  const flagged = regions.reduce((n, r) => n + (r.content?.items || []).filter(it => it.type === 'text' && it.needsReview).length, 0);
  if (flagged) steps.push({ text: `${flagged} ${flagged === 1 ? 'item is' : 'items are'} flagged ${S.lens === 'improve' ? 'extract' : 'machine-translated'} text — read and confirm them in the list below.` });
  const overflowing = regions.reduce((n, r) => n + (r.content?.items || []).filter(it => it.type === 'text' && overflowsBox(it)).length, 0);
  if (overflowing) {
    steps.push({
      text: `${overflowing} text box${overflowing === 1 ? '' : 'es'} on this page overflow${overflowing === 1 ? 's' : ''} its region — fit them in one step.`,
      btn: ['Fit page text (R)', () => resizeAllTextInPage()],
    });
  }
  if (S.mode !== 'view') steps.push({ text: 'Check the result in Preview mode (Tab), then export from the File menu.', btn: ['Preview', () => setMode('view')] });

  // 4 — unsaved changes, always last (a project rows two files: map + content variant)
  if (S.dirtySides?.map || S.dirtySides?.content) {
    steps.push({
      text: `Unsaved ${S.dirtySides.map && S.dirtySides.content ? 'map + content' : S.dirtySides.map ? 'map' : 'content'} — the project is two files.`,
      btn: ['Save project (Ctrl/Cmd+S)', () => saveProjectPart('both')],
    });
  }
  return steps.slice(0, 5);
}

function refreshNextAction() {
  const sec = $('next-action'), list = $('next-action-list');
  if (!sec || !list) return;
  sec.hidden = false;
  list.innerHTML = '';
  const items = nextActionItems();
  items.forEach((st, i) => {
    const li = document.createElement('li');
    if (i === 0) li.className = 'current';
    const txt = document.createElement('span');
    txt.className = 'next-text';
    txt.textContent = st.text;
    li.appendChild(txt);
    if (st.btn) {
      const [label, fn, title] = st.btn;
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      if (title) b.title = title;
      b.onclick = () => { try { fn(); } finally { refreshChrome(); } };
      li.appendChild(b);
    }
    list.appendChild(li);
  });
}

// The page-level review queue. It is derived from the active content variant, exactly like
// the items panel, but grouped by region so reviewing a page does not require finding each
// flagged box on the canvas. Clicking a row selects the region, opens Content mode and
// focuses that flagged text item.
function renderReviewList() {
  if (!els.reviewList || !els.reviewHeading) return;
  const c = lensCopy();
  if (els.reviewSection) els.reviewSection.hidden = !S.pmap || !S.project;
  els.reviewHeading.textContent = c.reviewHeading;
  els.reviewList.innerHTML = '';
  if (!S.pmap || !S.project) return;
  // The queue follows the lens's own variant. Translate confirms target text, Improve
  // confirms source text; showing the other variant's flags under this heading would
  // mislabel exactly the state the lens exists to avoid.
  const activeIsSource = activeVariantIsSource();
  if ((S.lens === 'translate' && activeIsSource) || (S.lens === 'improve' && !activeIsSource)) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = c.reviewEmpty;
    els.reviewList.appendChild(p);
    return;
  }
  const rows = [];
  for (const r of currentRegions()) {
    const items = (r.content?.items || []).filter(it => it.type === 'text' && it.needsReview);
    if (!items.length) continue;
    const text = items.map(it => itemText(it) || '(empty)').join(' ');
    rows.push({ r, text, count: items.length });
  }
  if (!rows.length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = c.reviewEmpty;
    els.reviewList.appendChild(p);
    return;
  }
  for (const row of rows) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'review-row';
    b.title = `Review ${row.count} flagged text item${row.count === 1 ? '' : 's'} in ${row.r.id}`;
    const id = document.createElement('span');
    id.className = 'review-id';
    id.textContent = row.r.id;
    const txt = document.createElement('span');
    txt.className = 'review-text';
    txt.dir = 'auto';
    txt.textContent = row.text.length > 90 ? row.text.slice(0, 89) + '…' : row.text;
    const badge = document.createElement('span');
    badge.className = 'review-count';
    badge.textContent = String(row.count);
    b.append(id, txt, badge);
    b.onclick = () => {
      const items = row.r.content?.items || [];
      const idx = items.findIndex(it => it.type === 'text' && it.needsReview);
      S.selected = new Set([row.r.id]);
      S.selectedVertex = null;
      S.itemIndex = Math.max(0, idx);
      S.itemSelected = true;
      if (S.mode !== 'content') setMode('content');
      // Select the referenced content only — do not open the edit dialog here.
      // Review-flagged items in the Content items panel open the dialog instead.
      rerender();
    };
    els.reviewList.appendChild(b);
  }
}

// A one-line coverage summary in the header. It is derived, never saved: the current page's
// text regions, how many have PDF-language/selectable text, and — in Translate — how many
// have target text or review flags. Improves the intent without adding another panel.
function refreshCoverage() {
  const el = els.statusCoverage;
  if (!el) return;
  if (!S.pmap || !viewer.doc) { el.textContent = ''; return; }
  const regions = currentRegions();
  const source = digitalSourceState();
  const textRegions = regions.filter(r => !isDetectedImage(r));
  const sourceCount = textRegions.filter(r => hasDigitalContent(r, source)).length;
  const missing = textRegions.length - sourceCount;
  const figures = regions.length - textRegions.length;
  const c = lensCopy();
  if (S.lens === 'improve') {
    el.textContent = `Page ${S.page}: ${sourceCount} ${sourceCount === 1 ? 'region' : 'regions'} selectable · ${missing} not yet selectable${figures ? ` · ${figures} figure${figures === 1 ? '' : 's'}` : ''}.`;
    return;
  }
  const activeLang = String(S.project?.content?.language || '').toLowerCase();
  const activeIsSource = !!S.pdfLanguage && activeLang === String(S.pdfLanguage).toLowerCase();
  const translated = activeIsSource ? 0 : textRegions.filter(r => (r.content?.items || []).some(it => it.type === 'text')).length;
  const pending = activeIsSource ? 0 : textRegions.filter(r => (r.content?.items || []).some(it => it.type === 'text' && it.needsReview)).length;
  el.textContent = `Page ${S.page}: ${sourceCount} source read · ${translated} regions translated · ${pending} pending review.`;
}

function refreshModeIndicator() {
  for (const b of document.querySelectorAll('#mode-group button')) b.classList.toggle('active', b.dataset.mode === S.mode);
  // The body carries the mode too, so CSS can describe the mode's vocabulary (e.g. in
  // Content mode a polygon is a read-only outline, not a draggable shape).
  for (const m of MODE_ORDER) document.body.classList.toggle(`mode-${m}`, S.mode === m);
}

function refreshMapInfo() {
  if (!S.pmap) { els.mapInfo.textContent = 'No PDF loaded.'; return; }
  const n = S.pmap.pages.reduce((a, p) => a + (p.regions?.length || 0), 0);
  // The page count comes from the map's declared source (falling back to the pages it
  // actually holds), so the panel says how big the document is as well as how mapped it is.
  const pc = Number(S.pmap.source?.page_count) || S.pmap.pages.length || 0;
  // Which map and which content variant are active, and which half has unsaved changes
  // (spec §3: the two files are separate on disk, so saving them can differ).
  const p = S.project;
  const d = S.dirtySides || {};
  const dirty = [d.map ? 'map' : '', d.content ? 'content' : ''].filter(Boolean);
  const state = p ? (dirty.length ? `unsaved (${dirty.join(' + ')})` : 'saved') : '';
  const variant = p && p.content.label ? ` “${p.content.label}”` : '';
  const role = p ? (activeVariantIsSource() ? lensCopy().sourceVariant : 'translation') : '';
  els.mapInfo.textContent = p
    ? `${p.map.name} + ${p.content.name}${variant} — ${role} · ${state} · ${n} regions · ${pc} page${pc === 1 ? '' : 's'} · src ${S.pmap.source.filename} · sha ${String(S.pmap.source.sha256).slice(0, 10)}…`
    : `${S.pmap.meta.name} · ${n} regions · ${pc} page${pc === 1 ? '' : 's'} · src ${S.pmap.source.filename} · sha ${String(S.pmap.source.sha256).slice(0, 10)}…`;
}

function applyMode() {
  // A tool, a half-drawn draft or a picked vertex belongs to Region mode; leaving it (or
  // moving between the two editing modes) must not leave one behind. The *region* selection
  // survives a mode change in every mode (a region is selectable in Region and Content and
  // stays highlighted in the read-only ones); the *item* selection is an editorial state, so
  // it is dropped as soon as the mode is no longer Content (spec §9a).
  S.draft = []; S.splitPts = []; S.cursor = null; S.marquee = null; S.marqueeBase = null; S.marqueeItems = false;
  if (!inRegion()) { S.tool = 'select'; S.selectedVertex = null; }
  if (!inContent()) { S.itemSelected = false; clearItemSelection(); }
  applyTextLayerInteractivity();
  rerender();
}

// ---- toolbar / menu action helpers ----
// Tab steps forward through the modes, Shift+Tab steps back (spec §9a).
function cycleMode(back = false) {
  const n = MODE_ORDER.length;
  const i = MODE_ORDER.indexOf(S.mode);
  setMode(MODE_ORDER[((i + (back ? -1 : 1)) % n + n) % n]);
}
function setTool(t) {
  S.tool = t;
  S.draft = []; S.splitPts = []; S.cursor = null;
  applyTextLayerInteractivity();
  rerender();
}
// Arm/disarm the polygon drawing tool (Tools ▸ Add polygon, or the P shortcut). Drawing is
// geometry, so the tool lives in Region mode only (spec §9a/§11.1).
function armPolygon() {
  if (!inRegion()) { setStatus('Switch to Region mode to draw regions.'); return; }
  if (S.tool === 'polygon') { setTool('select'); setStatus('Add polygon: off.'); return; }
  setTool('polygon');
  setStatus('Add polygon: click to add points · Enter/double-click to close · Esc cancels.');
}
function setMode(m) {
  if (S.mode === m) return;
  S.mode = m;
  applyMode();
  refreshModeIndicator();
}
function toggleOverlay() {
  S.overlayVisible = !S.overlayVisible;
  overlay.visible = S.overlayVisible;
  rerender();
}
// The source/selectability on-page tags. They are an editing aid, not a content layer:
// turning them off leaves the polygons and ids exactly as they were.
function toggleDigitalVersion() {
  S.showDigital = !S.showDigital;
  rerender();
  const where = isEditMode() ? '.' : ' — visible in Region and Content mode.';
  const label = S.lens === 'improve' ? 'Selectability status tags' : 'Source-text status tags';
  setStatus(`${label} ${S.showDigital ? 'shown' : 'hidden'}${where}`);
}
async function gotoPagePrompt() {
  const answer = await promptValue({
    title: 'Go to page',
    text: `Page number (1–${viewer.pageCount}):`,
    value: String(S.page),
    okLabel: 'Go',
    validate: (v) => {
      const n = parseInt(v, 10);
      if (!/^\d+$/.test(String(v || '').trim()) || isNaN(n) || n < 1 || n > viewer.pageCount) return `Enter a page number between 1 and ${viewer.pageCount}.`;
      return null;
    },
  });
  if (answer === null) return;
  const n = parseInt(answer, 10);
  if (!isNaN(n)) gotoPage(n);
}
// ---- §10a tier-1 / §21 propose-only re-detection (digital PDFs) ----
// A detected region carries additive provenance in the map: `detected: true` plus a hash of
// page + normalized polygon. It is what makes re-detection idempotent (an identical proposal
// is a no-op), what biases the conflict dialog's default (an untouched auto region is
// replaceable by default; one the user drew/edited is not), and what rule 5 may remove.
// User edits clear it; storage keeps it only when present, exactly like `locked`. The
// fingerprint, matching and cleanup rules live in model/detection.js so they can be tested
// without the editor's state.
function autoRegion(page, prop) {
  const r = createRegion(page, prop.geom.points);
  r.detected = true;
  r.fingerprint = prop.fingerprint;
  r.detectedType = detectedKind(prop.type);
  return r;
}
// Detection's own vocabulary (HEADING|TEXT|IMAGE) as the lower-case provenance value stored
// in the map. It is a hint about an untouched proposal, never a region property the user
// edits: clearDetection() removes it together with the rest of the provenance.
function detectedKind(type) { return String(type || 'TEXT').toLowerCase(); }
// A detected IMAGE region is a figure, not a text candidate: it never needs OCR, so the
// awaiting-OCR classification and the harvest skip it. An old auto region without a class
// is treated as a text candidate, matching how detection/cleanup already treats it.
function isDetectedImage(r) { return !!(r?.detected && r.detectedType === 'image'); }
function isAutoTextRegion(r) { return !!(r?.detected && r.detectedType !== 'image'); }
// A failure only earns the badge for a text candidate. A manually drawn region has no
// class, so it is a text candidate; its extraction can still be told why it failed.
function regionNeedsOcr(r, reason) { return !isDetectedImage(r) && isAwaitingOcr(reason); }
// The whole provenance bundle, for undo. `detectedType` rides with it (§21 rule 4), so a
// geometry/content/lock edit that clears provenance can be undone back to exactly what the
// detector left, badge included.
function detectionSnapshot(region) {
  return region?.detected
    ? { fingerprint: region.fingerprint, detectedType: region.detectedType }
    : null;
}
function restoreDetection(region, snap) {
  if (!snap) { clearDetection(region); return; }
  region.detected = true;
  region.fingerprint = snap.fingerprint;
  if (snap.detectedType) region.detectedType = snap.detectedType;
  else delete region.detectedType;
}
// Replace keeps the region's content and identity. Items are stored relative to the region's
// bounding origin, so moving the origin moves them back to the same *absolute* spot (the same
// rule as Merge). An item that no longer fits is already surfaced by the orange region.
function setRegionGeometry(r, geom) {
  const old = regionBBox(r.geometry), next = regionBBox(geom);
  const dx = old[0] - next[0], dy = old[1] - next[1];
  if (dx || dy) for (const it of r.content?.items || []) {
    if (Array.isArray(it.box)) it.box = [it.box[0] + dx, it.box[1] + dy, it.box[2], it.box[3]];
  }
  r.geometry = structuredClone(geom);
}

function proposalGeometry(reg) {
  return { type: 'polygon', points: detectPoints(reg.points, reg.type) };
}

function detectionSummary(stats, scope) {
  const t = stats.types || {};
  const byType = (stats.added && (t.text || t.image)) ? ` (${t.text || 0} text, ${t.image || 0} image)` : '';
  const parts = [`${stats.added} added${byType}`, `${stats.replaced} replaced`, `${stats.skipped} skipped`, `${stats.removed} removed`];
  // Identical matches are not edits, but they are the difference between "found nothing"
  // and "the map already matches, including the image". Retypes are real (badge-only) edits.
  const u = stats.typesUnchanged || {};
  const byTypeUnchanged = (stats.unchanged && (u.text || u.image)) ? ` (${u.text || 0} text, ${u.image || 0} image)` : '';
  if (stats.retyped) parts.push(`${stats.retyped} retyped`);
  if (stats.unchanged) parts.push(`${stats.unchanged} unchanged${byTypeUnchanged}`);
  // "E extracted" belongs to a harvest (spec §21 rule 7). The awaiting-OCR count does
  // not: detection alone now probes text proposals, so the badge is useful before the
  // user decides whether to run the harvest. Both counters appear only when non-zero.
  if (stats.extractRan) parts.push(`${stats.extracted} extracted`);
  if (stats.awaiting) parts.push(`${stats.awaiting} ${lensCopy().missing}`);
  if (stats.failed) parts.push(`${stats.failed} failed`);
  const nothing = !stats.added && !stats.replaced && !stats.skipped && !stats.removed && !stats.retyped
    && !stats.extracted && !stats.awaiting;
  const label = stats.extractRan ? 'Detect and extract' : 'Re-detection';
  const tail = stats.failedMsg ? ` — ${stats.failedMsg}` : '';
  return `${label}${scope}: ${parts.join(', ')}${nothing ? ' — nothing changed, the map already matches the detector.' : '.'}${tail}`;
}

function detectionConflictText(page, region, iou, contain, untouched) {
  const why = contain && iou < detectOverlap()
    ? 'its bounding box is contained in the existing region'
    : `IoU ${(iou * 100).toFixed(0)}%`;
  const who = untouched
    ? 'This region is still an untouched auto-detection.'
    : 'This region was drawn or edited by hand, or already holds content.';
  return `Page ${page} · proposal overlaps region ${region.id} (${why}). ${who} Replace the polygon with the proposal (content is kept and re-based), or keep the existing region?`;
}

// Re-detection is propose-only (spec 1.5 §21). Every proposal is paired with at most one
// existing region by bbox IoU >= threshold or containment; identical proposals are no-ops;
// every other pair is reviewed. Nothing is mutated until all decisions are in, so Cancel
// writes nothing. The whole run is one undo step. An unpaired, still-untouched auto region
// that no proposal matches is removed by cleanup in the same step.
//
// With `extract` (spec 1.5 §20 "detect and extract"), the same undo step also harvests the
// PDF's own text into the PDF-language variant for every region still empty in it. The two
// passes share the step so Ctrl+Z after a run restores the page exactly (§21 rule 6).
async function detectCommand(pages, { extract = false } = {}) {
  const stats = { added: 0, replaced: 0, skipped: 0, removed: 0, retyped: 0, unchanged: 0, extracted: 0, awaiting: 0, extractRan: extract, types: { text: 0, image: 0 }, typesUnchanged: { text: 0, image: 0 } };
  // Detect-with-extract is an extraction run, so it must land in the PDF-language/source-text
  // variant exactly like every other harvest. Do it before the plans are built: the guard can
  // switch variants and rebuild S.pmap. Geometry proposals are variant-independent.
  if (extract && !(await ensureExtractionVariant('Detect and extract'))) return { cancelled: true, stats };
  const threshold = detectOverlap();
  const run = makeRunChoice();
  const plans = pages.map(({ page, res }) => {
    const pg = getPage(S.pmap, page);
    const before = structuredClone(pg?.regions || []);
    const after = structuredClone(before);
    // Stale provenance (the user edited the geometry since detection) is cleared now; the
    // region then counts as user involvement for both defaults and cleanup.
    for (const r of after) if (r.detected && r.fingerprint !== detectionFingerprint(page, r.geometry)) clearDetection(r);
    return {
      page, width: res.width, height: res.height, existed: !!pg,
      before, after,
      proposals: res.regions.map(reg => {
        const geom = proposalGeometry(reg);
        return { geom, bbox: regionBBox(geom), fingerprint: detectionFingerprint(page, geom), type: reg.type };
      }),
    };
  });

  // Pair proposals to existing regions, best score first (model/detection.js).
  for (const p of plans) p.matches = pairProposals(p.after, p.proposals, threshold);

  // Review pairs in page/reading order. A Cancel aborts the whole run before any write.
  for (const p of plans) {
    p.matchedIds = new Set();
    p.addedIds = new Set();
    p.replacedIds = new Set();
    p.retypedIds = new Set();
    for (let i = 0; i < p.proposals.length; i++) {
      const prop = p.proposals[i];
      const pair = p.matches.get(i);
      if (!pair) {
        const added = autoRegion(p.page, prop);
        p.after.push(added);
        p.addedIds.add(added.id);
        stats.added += 1;
        stats.types[prop.type === 'IMAGE' ? 'image' : 'text'] += 1;
        continue;
      }
      const region = p.after[pair.j];
      p.matchedIds.add(region.id);
      // Exactly the same polygon: the detector has nothing geometric to say. This is what
      // makes an unchanged second run a no-op rather than a wall of identical proposals.
      // The class still rides along, though: a region detected before `detectedType` existed
      // (or reclassified by a newer detector) gets its badge refreshed in place, and an
      // identical match is reported so a re-run does not read as "nothing was found".
      if (region.detected && region.fingerprint === prop.fingerprint) {
        if (refreshDetectedType(region, prop.type)) { p.retypedIds.add(region.id); stats.retyped += 1; }
        stats.unchanged += 1;
        stats.typesUnchanged[prop.type === 'IMAGE' ? 'image' : 'text'] += 1;
        continue;
      }
      const untouched = isUntouchedAuto(p.page, region);
      const res = await runChoice(run, {
        title: 'Re-detection conflict',
        text: detectionConflictText(p.page, region, pair.iou, pair.contain, untouched),
        choices: [
          { choice: 'replace', label: 'Replace', primary: untouched },
          { choice: 'keep', label: "Don't add", primary: !untouched },
        ],
        applyLabel: 'Apply this choice to every remaining conflict in this run',
        preview: { page: p.page, existing: region.geometry, proposed: prop.geom },
      });
      if (!res) return { cancelled: true, stats };
      if (res.choice === 'replace') {
        setRegionGeometry(region, prop.geom);
        region.detected = true;
        region.fingerprint = prop.fingerprint;
        region.detectedType = detectedKind(prop.type);
        p.replacedIds.add(region.id);
        stats.replaced += 1;
      } else {
        stats.skipped += 1;
      }
    }
  }

  // Cleanup: a still-untouched auto region that no proposal matched may be removed. Any
  // user involvement (geometry edit, content, lock) already disqualifies it.
  for (const p of plans) {
    const beforeIds = new Set(p.before.map(r => r.id));
    const removable = new Set(unmatchedAutoIds(p.page, p.after, p.matchedIds));
    const keep = [];
    p.removedIds = new Set();
    for (const r of p.after) {
      if (beforeIds.has(r.id) && removable.has(r.id)) { stats.removed += 1; p.removedIds.add(r.id); continue; }
      keep.push(r);
    }
    p.after = keep;
  }

  // Run 2 — harvest (spec §20). Only text regions still empty in the target variant are
  // filled; a region that already holds content is evidence the user authored it and is
  // left alone (the same guard the manual page run uses). A detected IMAGE region is a
  // figure, not a text candidate: it is never harvested and never earns the OCR badge.
  // Failures with no usable selectable text classify the region "awaiting OCR" instead of
  // being reported as errors.
  const beforeAwaiting = new Set(S.awaitingOcr);
  const extractedIds = [];
  const awaitingIds = [];
  const notAwaitingIds = [];
  const failed = [];
  if (extract) {
    for (const p of plans) {
      for (const r of p.after) {
        if (regionHasContent(r) || isDetectedImage(r)) notAwaitingIds.push(r.id);
      }
      const empties = p.after.filter(r => !regionHasContent(r) && !isDetectedImage(r));
      if (!empties.length) continue;
      let page;
      try { page = await viewer.doc.getPage(p.page); }
      catch (e) { failed.push({ id: `page ${p.page}`, msg: e.message }); continue; }
      const viewport = page.getViewport({ scale: 1 });
      try {
        for (const r of empties) {
          const h = await harvestRegion(page, viewport, r, false);
          if (h.cancelled) return { cancelled: true, stats };
          if (h.error) {
            if (regionNeedsOcr(r, h.reason)) awaitingIds.push(r.id);
            else failed.push({ id: r.id, msg: h.error });
            continue;
          }
          applyExtraction({ r, ex: h.ex, replace: false });
          extractedIds.push(r.id);
          stats.extracted += 1;
        }
      } finally { page.cleanup?.(); }
    }
  } else {
    // Detection alone still classifies its text proposals: extraction is the way to fill a
    // region, but the user needs the badge before choosing whether to extract. Probe only
    // auto text/heading regions; a figure is an image, not an OCR candidate. The probe is
    // a read-only text-layer read and never creates content.
    for (const p of plans) {
      for (const r of p.after) {
        if (regionHasContent(r) || isDetectedImage(r)) notAwaitingIds.push(r.id);
      }
      const probes = p.after.filter(r => !regionHasContent(r) && isAutoTextRegion(r));
      if (!probes.length) continue;
      let page;
      try { page = await viewer.doc.getPage(p.page); }
      catch (e) { failed.push({ id: `page ${p.page}`, msg: e.message }); continue; }
      const viewport = page.getViewport({ scale: 1 });
      try {
        // A page with no text layer at all is the common scanned case: every text
        // proposal needs OCR, so skip the per-region text-layer read. On a mixed page
        // (or a forced CV run over digital text), probe each proposal instead.
        if (!(await viewer.pageHasTextLayer(page))) {
          awaitingIds.push(...probes.map(r => r.id));
        } else {
          for (const r of probes) {
            let needs = false;
            try {
              const ex = await extractRegionContent({ kind: 'digital', page, viewport }, regionRings(r.geometry));
              needs = !ex.ok && isAwaitingOcr(ex.reason);
            } catch { /* a classification probe must never sink detection */ }
            (needs ? awaitingIds : notAwaitingIds).push(r.id);
          }
        }
      } finally { page.cleanup?.(); }
    }
  }

  stats.awaiting = awaitingIds.length;
  stats.failed = failed.length;
  stats.failedMsg = failed[0]?.msg;
  const changed = !!(stats.added || stats.replaced || stats.removed || stats.retyped);
  const flagsChanged = awaitingIds.some(id => !beforeAwaiting.has(id))
    || notAwaitingIds.some(id => beforeAwaiting.has(id))
    || plans.some(p => [...p.removedIds].some(id => beforeAwaiting.has(id)));
  if (!changed && !extractedIds.length) {
    if (!flagsChanged) return { cancelled: false, stats };
    // Detection-only classification changed, but not the map: keep the runtime badge out
    // of history and out of the dirty state, exactly like the manual extraction's badge.
    S.awaitingOcr = new Set(beforeAwaiting);
    for (const p of plans) for (const id of p.removedIds) S.awaitingOcr.delete(id);
    for (const id of notAwaitingIds) S.awaitingOcr.delete(id);
    for (const id of awaitingIds) S.awaitingOcr.add(id);
    rerender();
    return { cancelled: false, stats };
  }

  history.exec({
    label: extract ? 'detect and extract' : 'detect regions',
    do() {
      for (const p of plans) {
        const pg = ensurePage(S.pmap, p.page, p.width, p.height);
        pg.regions = structuredClone(p.after);
      }
      S.awaitingOcr = new Set(beforeAwaiting);
      for (const p of plans) for (const id of p.removedIds) S.awaitingOcr.delete(id);
      for (const id of notAwaitingIds) S.awaitingOcr.delete(id);
      for (const id of awaitingIds) S.awaitingOcr.add(id);
      for (const id of extractedIds) S.awaitingOcr.delete(id);
      const selected = plans.flatMap(p => [...p.addedIds, ...p.replacedIds, ...p.retypedIds]);
      // Select what the run produced (adds and replacements) so the canvas shows the result.
      S.selected = new Set(selected);
      S.itemSelected = false; clearItemSelection();
      touch(S.pmap); rerender();
    },
    undo() {
      for (const p of plans) {
        if (p.existed) { const pg = getPage(S.pmap, p.page); if (pg) pg.regions = structuredClone(p.before); }
        else S.pmap.pages = S.pmap.pages.filter(x => x.page !== p.page);
      }
      S.awaitingOcr = new Set(beforeAwaiting);
      S.selected.clear(); rerender();
    },
  });
  return { cancelled: false, stats };
}

// Reading a page's draw ops makes pdf.js decode every figure image, which can take many
// seconds on an image-heavy page. Tick the elapsed time in the status so a slow page never
// looks frozen; the work runs in pdf.js's worker and cannot be interrupted from here. The
// optional guard rejects (and stops the ticker) if the worker is wedged.
async function whileTicking(text, fn, ms = 0, message = '') {
  const t0 = Date.now();
  const paint = () => {
    const s = Math.floor((Date.now() - t0) / 1000);
    setStatus(s >= 1 ? `${text} ${s}s…` : text);
  };
  paint();
  const tick = setInterval(paint, 1000);
  let guard = null;
  const work = fn();
  const raced = ms > 0
    ? Promise.race([work, new Promise((_, reject) => { guard = setTimeout(() => reject(new Error(message)), ms); })])
    : work;
  try { return await raced; } finally { clearInterval(tick); if (guard) clearTimeout(guard); }
}
// Detection has had two return shapes (a regions array, then {regions, notes}). Unwrap either
// so a browser still holding a module from the other revision cannot fail with a TypeError.
function normalizeDetection(res) {
  let raw = res;
  for (let i = 0; i < 3 && raw && !Array.isArray(raw) && raw.regions !== undefined; i++) raw = raw.regions;
  const base = (res && !Array.isArray(res)) ? res : {};
  return { ...base, regions: Array.isArray(raw) ? raw : [], notes: Array.isArray(res?.notes) ? res.notes : [] };
}

async function detectRegionsOnPage() {
  if (!viewer.doc) { setStatus('Open a PDF first.'); return; }
  try {
    const engine = cvEngine();
    const guard = engine === 'opencv' ? 120000 : 60000;
    const res = normalizeDetection(await whileTicking(
      `Detecting regions on page ${S.page}…`, () => viewer.detectRegions(S.page, { tier: detectTier(), engine, onProgress: detectionProgress }),
      guard, `timed out after ${guard / 1000} s`).finally(() => clearProgress()));
    setStatus(`Reviewing ${res.regions.length} proposal${res.regions.length === 1 ? '' : 's'} on page ${S.page}…`);
    const out = await detectCommand([{ page: S.page, res }], { extract: detectExtract() });
    if (out.cancelled) { setStatus(`Detection cancelled — nothing on page ${S.page} changed.`); return; }
    const note = (res.notes && res.notes.length) ? ` — ${res.notes.join('; ')}` : '';
    setStatus(detectionSummary(out.stats, ` on page ${S.page}${tierNote([res])}`) + note);
  } catch (e) {
    setStatus('Detection failed: ' + ((e && e.message) || e));
  }
}

async function detectRegionsAllPages() {
  if (!viewer.doc) { setStatus('Open a PDF first.'); return; }
  try {
    const pages = [];
    for (let n = 1; n <= viewer.pageCount; n++) {
      await new Promise(r => setTimeout(r, 0)); // let the status paint
      try {
        const engine = cvEngine();
        const guard = engine === 'opencv' ? 120000 : 60000;
        const res = normalizeDetection(await whileTicking(
          `Detecting page ${n}/${viewer.pageCount}…`, () => viewer.detectRegions(n, { tier: detectTier(), engine, onProgress: detectionProgress }),
          guard, `page ${n} timed out after ${guard / 1000} s`).finally(() => clearProgress()));
        pages.push({ page: n, res });
      } catch (e) { setStatus(`Detection failed on page ${n}: ${e.message}`); return; }
    }
    setStatus(`Reviewing proposals across ${viewer.pageCount} pages…`);
    const out = await detectCommand(pages, { extract: detectExtract() });
    if (out.cancelled) { setStatus('Detection cancelled — the map was not changed.'); return; }
    const notes = pages.flatMap(p => (p.res.notes || []).map(n => `page ${p.page}: ${n}`));
    const note = notes.length ? ` — ${notes.join('; ')}` : '';
    setStatus(detectionSummary(out.stats, ` across ${viewer.pageCount} pages${tierNote(pages.map(p => p.res))}`) + note);
  } catch (e) {
    setStatus('Detection failed: ' + ((e && e.message) || e));
  }
}

// ---- selection & props ----
const itemKey = (id, index) => `${id}\u0000${index}`;
function clearItemSelection() { S.itemSelection.clear(); }
function isItemSelected(regionId, index) {
  // Preserve the pre-existing single-item behavior: the active item index is drawn as a box
  // handle even when the toolbar selection was handed back to the region (Alt press, mode
  // switch). The explicit page-wide set takes over only when Ctrl/Cmd+A filled it.
  if (S.itemSelection.size) return S.itemSelection.has(itemKey(regionId, index));
  return currentRegion()?.id === regionId && S.itemIndex === index;
}
function selectSingle(id) { S.selected.clear(); S.selected.add(id); S.selectedVertex = null; S.itemIndex = 0; S.itemSelected = false; clearItemSelection(); rerender(); }
function toggleSelect(id) { S.selectedVertex = null; S.itemSelected = false; clearItemSelection(); S.selected.has(id) ? S.selected.delete(id) : S.selected.add(id); rerender(); }
// Where the PDF-language ("digital") content lives right now. The active variant is the
// source when its language is the PDF's; otherwise a variant switched away from is read from
// the session cache. If that source was never loaded, no region has a digital version yet.
function digitalSourceState() {
  const pdfLang = String(S.pdfLanguage || '').toLowerCase();
  // No known PDF language means no identified source-text variant: the active variant is
  // some variant, not necessarily the source. Treating it as the source would make a target
  // translation wear a "has source text" badge.
  return pdfLang ? (sourceVariantFor(pdfLang) || { active: false, content: null }) : { active: false, content: null };
}
function hasDigitalContent(r, source = digitalSourceState()) {
  return source.active ? regionHasContent(r) : !!source.content?.regions?.[r.id]?.items?.length;
}
// A text-convertible region is anything the detector did not call a figure and that has no
// source text yet — including one waiting for OCR. This is the set the extraction workflow
// can still fill, so it is also what the "select regions without source text" command returns.
function isTextConvertible(r, source = digitalSourceState()) {
  return !isDetectedImage(r) && !hasDigitalContent(r, source);
}
function selectTextRegionsWithoutContent() {
  if (!S.pmap || !isEditMode()) return;
  const source = digitalSourceState();
  const c = lensCopy();
  const regions = currentRegions().filter(r => isTextConvertible(r, source));
  if (!regions.length) { setStatus(c.noMissing); return; }
  clearItemSelection();
  S.selected = new Set(regions.map(r => r.id));
  S.selectedVertex = null; S.itemIndex = 0; S.itemSelected = false;
  setStatus(c.selectedMissing(regions.length));
  rerender();
}
// Ctrl/Cmd+A: geometry in Region mode, every text/image item on the page in Content mode.
function selectAll() {
  if (!S.pmap || !isEditMode()) return;
  const regions = currentRegions();
  if (inRegion()) {
    if (!regions.length) { setStatus('No regions on this page.'); return; }
    clearItemSelection();
    S.selected = new Set(regions.map(r => r.id));
    S.selectedVertex = null; S.itemIndex = 0; S.itemSelected = false;
    setStatus(`${regions.length} region${regions.length === 1 ? '' : 's'} selected.`);
    rerender();
    return;
  }
  const withItems = regions.filter(r => (r.content?.items || []).length);
  const count = withItems.reduce((n, r) => n + r.content.items.length, 0);
  if (!count) { setStatus('No content items on this page.'); return; }
  clearItemSelection();
  for (const r of withItems) r.content.items.forEach((_, i) => S.itemSelection.add(itemKey(r.id, i)));
  S.selected = new Set(withItems.map(r => r.id));
  S.selectedVertex = null; S.itemIndex = 0; S.itemSelected = true;
  setStatus(`${count} content item${count === 1 ? '' : 's'} selected on this page.`);
  rerender();
}
// Do two axis-aligned [x0,y0,x1,y1] boxes overlap? (used by the selection marquee)
function rectsIntersect(a, b) { return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1]; }
function currentRegions() { return S.pmap ? (getPage(S.pmap, S.page)?.regions || []) : []; }
function selectedRegions() { return currentRegions().filter(r => S.selected.has(r.id)); }

function currentRegion() { return selectedRegions()[0] || null; }
function regionById(id) { return currentRegions().find(r => r.id === id) || null; }

// Regions under a page point, bottom to top in the overlay's own paint order (the array
// order; the selected region is drawn last, which is why a plain click reaches it first).
function regionsUnderPoint(point) {
  return currentRegions()
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => regionRings(r.geometry).some(ring => pointInPolygon(point, ring)))
    .sort((a, b) => a.i - b.i);
}

// Option/Alt+click steps to the region behind the pressed one. A plain click always reaches
// the topmost polygon, and when regions overlap the ones below may be fully covered, so this
// is the only way to reach them. Repeated Alt+clicks walk down the stack and wrap around;
// the selected region is painted on top, so each step lands on the next one visibly behind.
function selectRegionBehind(id, point) {
  const cur = regionById(id);
  if (!cur) return;
  const stack = regionsUnderPoint(point);
  const curIdx = currentRegions().indexOf(cur);
  // Below the pressed region in paint order; wrapping to the topmost when it is the bottom.
  const below = stack.filter(x => x.i < curIdx);
  const target = (below.length ? below[below.length - 1] : stack[stack.length - 1])?.r;
  if (!target || target.id === id) {
    // Nothing behind: Alt behaves like a plain click so the pressed region still gets picked.
    if (!S.selected.has(id)) selectSingle(id);
    setStatus(`${id} is the only region under the pointer.`);
    return;
  }
  lastRegionClick = null;
  selectSingle(target.id);
  setStatus(`Selected ${target.id} behind ${id} — Alt/Option+click again to cycle through the regions here.`);
}

function syncPropsForm() {
  const r = currentRegion();
  if (!r) { els.propsEmpty.hidden = false; els.propsForm.hidden = true; return; }
  els.propsEmpty.hidden = true; els.propsForm.hidden = false;
  els.fId.value = r.id;
  els.fBg.value = r.content?.background || DEFAULT_BACKGROUND;
  // What the detector thought this was, while its provenance is still intact. Read-only:
  // the first user edit (geometry, content, lock, background) clears the provenance and
  // this with it. Editing modes only — the read-only views have no props panel anyway.
  if (els.fKind) {
    const kind = isEditMode() ? (r.detected && r.detectedType) || '' : '';
    els.fKind.hidden = !kind;
    els.fKind.textContent = kind ? `detected: ${kind}` : '';
    els.fKind.dataset.kind = kind;
  }
  // "Awaiting OCR" is an editing-mode aid (spec §20): shown in the region properties while
  // the region has no usable selectable text to extract from, hidden in the read-only modes.
  if (els.fOcr) {
    els.fOcr.hidden = !(isEditMode() && S.awaitingOcr.has(r.id));
    els.fOcr.textContent = lensCopy().missing;
    els.fOcr.title = S.lens === 'improve'
      ? 'No usable selectable text under this region — the source is a scan, an image, or a broken text layer. Right-click the region and choose Read with OCR.'
      : 'No usable source text under this region — the source is a scan, an image, or a broken text layer. Right-click the region and choose Read with OCR.';
  }
  const items = r.content?.items || [];
  if (S.itemIndex >= items.length) S.itemIndex = items.length - 1;
  if (S.itemIndex < 0) S.itemIndex = 0;
  renderItemsPanel(items);
  syncItemEditor(items[S.itemIndex] || null);
}

// "The text does not fit its own box": the renderer's own measurement (the same call that
// decides whether to draw the amber corner marker). The items list badges it so an
// overlength translation is visible without hunting for the marker on the page
// (spec 1.5 §23). Derived at render time, so it clears as soon as the box is fitted.
function overflowsBox(it) {
  if (!it || it.type !== 'text') return false;
  const b = it.box || [0, 0, 0, 0];
  return b[2] > 0 && b[3] > 0 && itemOverflows(it, b[2], b[3]);
}

function renderItemsPanel(items) {
  els.itemsList.innerHTML = '';
  if (!items.length) {
    const d = document.createElement('div');
    d.className = 'hint';
    d.textContent = 'No content items — original shows through.';
    els.itemsList.appendChild(d);
    return;
  }
  const r = currentRegion();
  items.forEach((it, idx) => {
    const b = document.createElement('button');
    if (r && isItemSelected(r.id, idx)) b.classList.add('active');
    const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = it.type;
    const val = document.createElement('span'); val.className = 'val';
    val.textContent = it.type === 'image' ? (it.source ? '(image)' : '(empty)') : (itemText(it) || '(empty)');
    b.append(tag, val);
    if (it.needsReview) {
      const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = 'review';
      b.append(badge);
    }
    if (overflowsBox(it)) {
      const badge = document.createElement('span');
      badge.className = 'badge badge-overlength';
      badge.textContent = 'overlength';
      badge.title = 'The text does not fit this box — use Resize to text (R) or tighten the line spacing.';
      b.append(badge);
    }
    b.onclick = () => {
      S.itemIndex = idx; S.itemSelected = true; clearItemSelection(); syncPropsForm(); refreshContextTools();
      // A review-flagged text item under Content items opens the edit dialog so the
      // translation can be confirmed; other items are only selected.
      if (it.needsReview && it.type === 'text') {
        const r = currentRegion();
        if (r) openInlineEditor(r, idx, { box: it.box, style: it.style, blocks: itemBlocks(it) });
      }
    };
    els.itemsList.appendChild(b);
  });
}

function syncItemEditor(item) {
  if (!item) { els.itemEditor.hidden = true; return; }
  const isText = item.type === 'text';
  // The sidebar's only item field is the image source: a text item keeps its box on the
  // page (drag / corner handles) and its words in the text dialog, so it has nothing here.
  els.itemEditor.hidden = isText;
  if (!isText) els.fItemSource.value = item.source || '';
}

// ---- content item editing ----
function regionSize(r) {
  const [x0, y0, x1, y1] = regionBBox(r.geometry);
  return [Math.max(1, Math.round(x1 - x0)), Math.max(1, Math.round(y1 - y0))];
}

function mutateContent(label, fn) { mutateContentFor(currentRegion(), label, fn); }

function mutateContentFor(r, label, fn) {
  if (!r) return;
  const before = structuredClone(r.content);
  const provenance = detectionSnapshot(r);
  history.exec({
    label,
    do() { fn(r.content); clearDetection(r); S.awaitingOcr.delete(r.id); touch(S.pmap); rerender(); },
    undo() {
      r.content = structuredClone(before);
      restoreDetection(r, provenance);
      rerender();
    },
  });
}

function editItem(fn, label) {
  const r = currentRegion();
  if (!r) return;
  const idx = S.itemIndex;
  mutateContent(label, (c) => { const it = c.items[idx]; if (it) fn(it); });
}

// Absolute PDF boxes for the selected region's items, for overlay rendering.
function buildItemBoxes(region) {
  if (!region || !S.overlayVisible) return [];
  const items = region.content?.items || [];
  return items.map((it, index) => {
    const [x, y, w, h] = itemAbsBox(regionPoints(region.geometry), it);
    return { id: region.id, index, type: it.type, x, y, w, h, selected: isItemSelected(region.id, index) };
  });
}

// Regions whose content the renderer will cut. Every item is clipped to its region's polygon
// (Edit mode, Preview mode and the export all draw the content only where the polygon is), so a
// box that is not fully inside the polygon loses whatever overhangs. The overlay paints those
// regions orange (spec §9b) so the crop is never silent: the user enlarges the region or
// shortens the text. The *box* is what the renderer clips, so the box is what is tested here;
// the tolerance keeps a box fitted flush against a polygon edge from flickering orange.
const CLIP_WARN_TOL = 0.6;
function clippedRegions(regions) {
  const out = new Set();
  for (const r of regions) {
    const items = r.content?.items || [];
    if (!items.length) continue;
    const rings = regionRings(r.geometry);
    if (!rings.length) continue;
    const pts = regionPoints(r.geometry);
    if (items.some(it => !rectInsideRings(rings, itemAbsBox(pts, it), CLIP_WARN_TOL))) out.add(r.id);
  }
  return out;
}

// ---- item placement: automatic initial layout (no overlap) ----
function itemsOverlap(items) {
  const b = items.map(i => i.box);
  for (let i = 0; i < b.length; i++) for (let j = i + 1; j < b.length; j++) {
    const a = b[i], c = b[j];
    if (a[0] < c[0] + c[2] && c[0] < a[0] + a[2] && a[1] < c[1] + c[3] && c[1] < a[1] + a[3]) return true;
  }
  return false;
}
// Text box padding, in PDF points, from Preferences settings. Kept whole and tame: a
// stored value that is missing, negative or absurd resolves to something usable.
function clampPadding(v) {
  if (v == null || String(v).trim() === '') return DEFAULT_TEXT_PADDING;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return DEFAULT_TEXT_PADDING;
  return Math.max(0, Math.min(72, n));
}
function textPadding() { return clampPadding(settings.textPadding); }
// Re-detection overlap threshold from Preferences settings. Missing/nonsense falls back to the
// default; the value is held to the 0.30…0.95 range the dialog's input allows, rounded to the
// input's 0.05 step so a stored value always matches what the field can show.
function clampDetectOverlap(v) {
  if (v == null || String(v).trim() === '') return DEFAULT_DETECT_OVERLAP;
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_DETECT_OVERLAP;
  const stepped = Math.round(n / 0.05) * 0.05;
  return Math.max(0.3, Math.min(0.95, Math.round(stepped * 100) / 100));
}
function detectOverlap() { return clampDetectOverlap(settings.detectOverlap); }
// Per-page detection tier (spec 1.5 §19): `auto` picks tier-1 digital when the page has a
// text layer and the classical-CV detector when it does not; `digital`/`cv` force one. The
// heavy ONNX `detect_layout` tier is not built yet.
function clampDetectTier(v) { return v === 'digital' || v === 'cv' ? v : 'auto'; }
function detectTier() { return clampDetectTier(settings.detectTier); }
// CV engine (spec 1.5 §19): classical is dependency-free and the default; opencv is an
// experimental alternative that lazily downloads the ~10 MB OpenCV.js build on the first
// scanned page detected with it.
function clampCvEngine(v) { return v === 'opencv' ? 'opencv' : 'classical'; }
function cvEngine() { return clampCvEngine(settings.cvEngine); }
function clampOcrEngine(v) { return v === 'off' ? 'off' : 'tesseract'; }
function ocrEngine() { return clampOcrEngine(settings.ocrEngine); }
function ocrEnabled() { return ocrEngine() === 'tesseract'; }
function tierNote(results) {
  const cv = results.filter(r => r && r.tier === 'cv');
  if (!cv.length) return '';
  const engines = [...new Set(cv.map(r => r.engine === 'opencv' ? 'OpenCV.js' : 'classical CV'))];
  const label = engines.length > 1 ? 'CV' : engines[0];
  return results.length > 1 ? ` (${cv.length}/${results.length} pages ${label})` : ` (${label})`;
}
// Show the one-time OpenCV.js module load/download/initialization on the existing header
// progress bar; the detection ticker owns the status text, so the bar carries the byte
// fraction when known and an indeterminate state otherwise.
function detectionProgress(p) {
  if (!p) return;
  if (p.phase === 'module') {
    setIndeterminateProgress('OpenCV.js — loading module…');
  } else if (p.phase === 'download') {
    if (p.total) setProgress(p.fraction, 'OpenCV.js WASM');
    else setIndeterminateProgress(`OpenCV.js WASM — ${(p.received / 1048576).toFixed(1)} MB`);
  } else if (p.phase === 'init') {
    setIndeterminateProgress('OpenCV.js — initializing…');
  }
}
// "Detect and extract" (spec 1.5 §20): after a Detect run, also run the harvest pass over
// the page's still-empty regions. A persisted toggle (Tools ▸ Extract content after
// detecting) rather than a per-run dialog, because the run is per-page and the answer is
// stable across runs; the spec's "checkbox on the Detect dialog" is satisfied by this
// checked menu item while detection has no options dialog of its own.
function detectExtract() { return !!settings.extractAfterDetect; }
function toggleDetectExtract() {
  settings.extractAfterDetect = !detectExtract();
  saveSettings();
  setStatus(`Detect will ${settings.extractAfterDetect ? 'also extract PDF text into the PDF-language variant' : 'only propose regions'}.`);
}
// Detected regions carry the configured text-box padding (Preferences… ▸ Region Detection):
// a text box is the region interior inset by that padding (textRect), so the polygon gains
// it *here* — when the region is detected and still empty — and the mapping geometry is
// decided once, at detection, instead of moving under the user when a text box is added
// (spec §7). The region gains its mask margin this way too, before any replacement text
// exists. An **image** detection is left as detected: an image fills its region, so the
// padding would enlarge the image rather than leave a margin around text. A folded offset
// (growRings declining) simply leaves the polygon as detected.
function detectPoints(points, type) {
  const pad = textPadding();
  if (!(pad > 0) || type === 'IMAGE') return points;
  const rings = [points];
  const grown = growRings(rings, pad);
  return grown === rings ? points : grown[0];
}
// The box a new *text* item is auto-placed in: the region's bounding box inset by the
// padding on all four sides, so the replacement text keeps a margin from the polygon edge
// (spec §7). Nothing is taken from the text: the padding is the same for every item and the
// polygon is never touched here — a detected region already gained it when it was detected.
// The inset is capped at half the region's short side so a small region still yields a
// usable (>= 1 x 1 pt) box instead of an inverted one.
function textRect(r) {
  const [w, h] = regionSize(r);
  const p = Math.max(0, Math.min(textPadding(), Math.floor((Math.min(w, h) - 1) / 2)));
  return [p, p, Math.max(1, w - 2 * p), Math.max(1, h - 2 * p)];
}
// Add a text item to the region as one undo step. The item is placed in textRect() and the
// region's geometry is left exactly as it is. Callers that own their step (the page-text
// translation batch) call commitTextPlacement() instead.
function placeTextItem(r, label, makeItem, opts = {}) {
  const item = makeItem(textRect(r));
  const fit = !!opts.fit;
  const beforeContent = structuredClone(r.content);
  history.exec({
    label,
    do() { commitTextPlacement(r, item, fit); touch(S.pmap); rerender(); },
    undo() { r.content = structuredClone(beforeContent); rerender(); },
  });
}
function commitTextPlacement(r, item, fit) {
  r.content.items.push(item);
  clearDetection(r); // content add is user involvement (§21 rule 4)
  S.awaitingOcr.delete(r.id); // a region with content is not awaiting OCR any more (§20)
  autoLayout(r.content, item.box);
  // A text box is fitted to its text the moment it is added: the "Resize to text" the item
  // context menu offers, run automatically, in the same undo step as the add, so what the
  // user typed is never cropped by the default box (and no dead space is left either). The
  // fit may tighten the line spacing (never a row height) to keep the text inside the
  // region, and grows the box past the polygon rather than crop the text.
  if (fit && item.type === 'text') {
    const info = fitBoxToText(r, item, undefined, { tighten: true });
    if (info.changed) item.box = info.box;
    if (info.spacingChanged) item.style = normalizeStyle({ ...item.style, lineHeight: info.spacing });
    setStatus(fitStatus(info, 'added'));
  }
  S.itemIndex = r.content.items.indexOf(item);
  S.itemSelected = true; clearItemSelection();
}
function stackItems(items, [x, y, w, h]) {
  const n = items.length;
  const rh = Math.max(1, Math.floor(h / n));
  items.forEach((it, i) => { it.box = [x, y + i * rh, w, i === n - 1 ? h - i * rh : rh]; });
}
function autoLayout(content, rect) {
  if (content.items.length >= 2 && itemsOverlap(content.items)) stackItems(content.items, rect);
}

// `rect` is the free area inside the region ([x, y, w, h] from the region's own origin)
// that automatic layout may use — the full interior for images. Text items go through
// commitTextPlacement(), which places them inset by the text box padding.
function addItem(content, item, rect) {
  content.items.push(item);
  autoLayout(content, rect);
  S.itemIndex = content.items.indexOf(item);
  S.itemSelected = true; clearItemSelection();
}

async function addTextItem() {
  let r = currentRegion();
  if (!r) { setStatus('Select a region first, then add text.'); return; }
  // Improve edits source text. If the active variant is a translation (or its language is
  // still unknown), establish the PDF-language/Selectable-text variant before opening the
  // editor; otherwise the words typed here would land in the target variant. The guard is
  // the normal extraction-language flow, so it asks at most once and never silently changes
  // a variant the user is editing.
  if (S.lens === 'improve' && !activeVariantIsSource()) {
    const ids = selectedRegions().map(x => x.id);
    if (!(await ensureExtractionVariant('Add source text'))) return;
    const sel = ids.map(regionById).filter(Boolean);
    if (!sel.length) { setStatus('The selected region is no longer available.'); return; }
    S.selected = new Set(sel.map(x => x.id));
    S.selectedVertex = null;
    r = sel[0];
  }
  // Placing an item is editorial work, so the region menu's Add text / Add image drop the
  // user into Content mode with the new item selected and its dialog open (spec §9a).
  if (!inContent()) setMode('content');
  openInlineEditor(r, null, { box: textRect(r), style: {} });
}

// Add image: file picker is the explicit path; Ctrl+V is handled globally.
function addImageItem() {
  if (!currentRegion()) { setStatus('Select a region first, then add an image.'); return; }
  if (!inContent()) setMode('content');
  els.fileItemImage.click();
}

async function addImageFromSource(source) {
  const r = currentRegion();
  if (!r) { setStatus('Select a region first, then add an image.'); return; }
  if (!inContent()) setMode('content');
  const [w, h] = regionSize(r);
  mutateContentFor(r, 'add image item', (c) => addItem(c, createImageItem({ source, box: [0, 0, w, h] }), [0, 0, w, h]));
}

function deleteItem() {
  const r = currentRegion();
  if (!r || !regionHasContent(r)) return;
  clearItemSelection();
  const idx = S.itemIndex;
  mutateContent('delete item', (c) => { c.items.splice(idx, 1); S.itemIndex = Math.max(0, Math.min(idx, c.items.length - 1)); S.itemSelected = c.items.length > 0; });
}

// Delete every item picked by Ctrl/Cmd+A in Content mode, across regions, as one undo step.
// The page-wide selection is an editorial convenience; it deliberately does not bulk-run any
// other item command (fit, z-order), whose result is only meaningful for one active item.
function selectedItemRefs() {
  const refs = [];
  for (const r of currentRegions()) {
    (r.content?.items || []).forEach((it, i) => {
      if (S.itemSelection.has(itemKey(r.id, i))) refs.push({ r, i });
    });
  }
  return refs;
}

function deleteSelectedItems() {
  const refs = selectedItemRefs();
  if (!refs.length) return;
  const regions = [...new Set(refs.map(x => x.r))];
  const before = regions.map(r => ({ r, content: structuredClone(r.content), det: detectionSnapshot(r) }));
  const count = refs.length;
  history.exec({
    label: 'delete content items',
    do() {
      const byRegion = new Map();
      for (const { r, i } of refs) {
        if (!byRegion.has(r)) byRegion.set(r, []);
        byRegion.get(r).push(i);
      }
      for (const [r, idxs] of byRegion) {
        idxs.sort((a, b) => b - a);
        for (const i of idxs) r.content.items.splice(i, 1);
        clearDetection(r);
        S.awaitingOcr.delete(r.id);
      }
      S.selected.clear(); S.selectedVertex = null; S.itemIndex = 0;
      S.itemSelected = false; clearItemSelection();
      touch(S.pmap);
      setStatus(`Deleted ${count} content item${count === 1 ? '' : 's'}.`);
      rerender();
    },
    undo() {
      for (const { r, content, det } of before) {
        r.content = structuredClone(content);
        restoreDetection(r, det);
      }
      rerender();
    },
  });
}

// Z-order only: the item keeps its box (and its place in the panel list); its paint
// order changes. Items are drawn in array order, so the last one paints on top (spec §7).
function moveItemTo(where) {
  const r = currentRegion();
  const items = r?.content?.items || [];
  clearItemSelection();
  const idx = S.itemIndex;
  const j = where === 'front' ? items.length - 1 : 0;
  if (idx < 0 || idx >= items.length || idx === j) return;
  mutateContent(where === 'front' ? 'bring item to front' : 'send item to back', (c) => {
    const [it] = c.items.splice(idx, 1);
    c.items.splice(j, 0, it);
    S.itemIndex = j;
  });
}

// The box "Resize to text" would pick for a text item: exactly the room its text needs,
// measured with the same layout code Preview mode and the export use (1 unit = 1 PDF point).
// The width only grows (to fit a token no smaller box could hold, or a table's own width);
// the height becomes what the text occupies, so the box itself never crops its text. When
// the text needs more room than the region has, the box grows *past* the polygon instead of
// cutting the text — the renderer clips every item to the polygon, so that overhang is
// exactly what the orange region warns about (spec §9b: clippedRegions) and `clipped`
// reports it here. `changed` is false when the box and the spacing already match the text.
//
// `opts.tighten` adds the first lever fitting has: the *line spacing*. A text a line or two
// too tall at the spacing its item carries often comes inside the region at a tighter one
// (down to LINE_HEIGHT_MIN) without growing anything, so the fit takes the largest spacing
// that fits the region and only then grows the box. The add path and Resize to text ask for
// it (they are the "make this fit" actions); the fit that follows the user's *own* spacing
// change must not undo it, so there the spacing is taken as given. A table's rows are the
// user's own and do not follow the spacing, so for one there is never anything to win.
function withLineHeight(item, lh) {
  return { ...item, style: { ...(item.style || {}), lineHeight: lh } };
}
function fitBoxToText(r, item, box, opts = {}) {
  const [rw, rh] = regionSize(r);
  const b = (box || item.box || [0, 0, rw, rh]).map(v => +v || 0);
  const availW = Math.max(1, rw - b[0]);
  const availH = Math.max(1, rh - b[1]);
  const measure = (w, lh) => measureTextItem(lh == null ? item : withLineHeight(item, lh), Math.max(1, w));
  const w = Math.max(b[2], Math.ceil(measure(b[2]).minWidth));
  // The fit writes whole points, so "fits the region" is judged on the box it would write: a
  // spacing that only fits until the height is rounded up is not a fit (it would overhang).
  const fitsRegion = (h) => Math.ceil(h) <= availH + 0.5;
  const cur = lineHeightOf(item.style);
  let lh = cur, needH = measure(w, cur).height;
  if (opts.tighten && !fitsRegion(needH) && fitsRegion(measure(w, LINE_HEIGHT_MIN).height)) {
    // The tightest spacing fits: walk down from the item's own and take the first that does,
    // which is the *largest* one that does — the least tightening that still fits.
    lh = LINE_HEIGHT_MIN; needH = measure(w, lh).height;
    for (let sp = cur - 0.05; sp > LINE_HEIGHT_MIN + 1e-6; sp -= 0.05) {
      const s = Math.round(sp * 100) / 100;
      const h = measure(w, s).height;
      if (fitsRegion(h)) { lh = s; needH = h; break; }
    }
  }
  const wantW = Math.ceil(w), wantH = Math.max(6, Math.ceil(needH));
  const out = [Math.round(b[0]), Math.round(b[1]), wantW, wantH];
  return {
    box: out, w: out[2], h: out[3], spacing: lh,
    spacingChanged: lh !== cur,
    clipped: wantW > availW + 0.5 || wantH > availH + 0.5,
    changed: out[2] !== Math.round(b[2]) || out[3] !== Math.round(b[3]) || lh !== cur,
  };
}
function fitStatus(info, what) {
  const size = `${info.w}×${info.h} pt`;
  const lh = info.spacingChanged ? ` at ${info.spacing}× line spacing` : '';
  const fs = info.sizeChanged ? `, with the font reduced to ${info.size} pt to make it fit` : '';
  const big = 'the text is bigger than this region, so the polygon clips the overhang (it is painted orange) — enlarge the region or shorten the text';
  if (what === 'added') {
    return info.clipped
      ? `Text box added — its text needs more room than this region has (${size}${lh}); ${big}.`
      : `Text box added and fitted to its text (${size}${lh}).`;
  }
  return info.clipped
    ? `Text box resized to ${size}${lh}${fs} — ${big}.`
    : `Text box resized to ${size}${lh}${fs} — the text now fits.`;
}

// The explicit two-lever fit, used by the item context menu's Resize to text and by
// Tools ▸ Resize to text in page (R). It adds two things to the automatic fit on add:
//
//   1. It judges "fits" by the *polygon* the renderer actually clips to
//      (rectInsideRings), not by the region's bounding box — so a box that would be
//      painted orange on a slanted or concave region is not called fitted.
//   2. After the line spacing has been tightened to its floor (LINE_HEIGHT_MIN), it
//      reduces the *font size* (in FIT_SIZE_STEP steps, down to FIT_MIN_SIZE), scaling
//      the base size and every run together. It may also narrow a box that is wider
//      than its region, down to the longest unbreakable token.
//
// When even the floor cannot fit, it falls back to the automatic fit's behaviour —
// keep the font, take the spacing the region allows, and grow the box past the polygon
// so the text is never cropped by its own box; the orange warning carries the message.
const FIT_MIN_SIZE = 6;      // pt — the font lever's floor
const FIT_SIZE_STEP = 0.5;   // pt — the font search step
const FIT_WIDTH_SAMPLES = 12; // width-shrink samples between the box's own width and its longest token

function regionOrigin(r) {
  const bb = regionBBox(r.geometry);
  return [bb[0], bb[1]];
}

// Is this region-local box wholly inside the region's polygon (the same test the orange
// warning uses, so "the fit says it fits" and "no orange" cannot disagree)?
function boxInsideRegion(r, box) {
  if (!box) return false;
  const [ox, oy] = regionOrigin(r);
  return rectInsideRings(regionRings(r.geometry), [ox + box[0], oy + box[1], box[2], box[3]], CLIP_WARN_TOL);
}

// A measuring copy of the item at a candidate font size and spacing (the real item is
// never mutated during the search).
function scaledForFit(item, k, spacing) {
  const copy = structuredClone(item);
  if (k && Math.abs(k - 1) > 1e-9) scaleTextItem(copy, k);
  copy.style = normalizeStyle({ ...copy.style, lineHeight: spacing });
  return copy;
}

// Widths to try, widest first: the box's own width, then samples down to the longest
// token. Widest is tried first because a wider box wraps into fewer lines.
function widthCandidates(natural, minWidth) {
  const hi = Math.max(1, Math.round(natural));
  const lo = Math.max(1, Math.round(minWidth));
  const out = [hi];
  if (hi > lo) {
    for (let i = 1; i <= FIT_WIDTH_SAMPLES; i++) {
      const w = Math.max(lo, Math.round(hi - (hi - lo) * (i / FIT_WIDTH_SAMPLES)));
      if (!out.includes(w)) out.push(w);
    }
    if (!out.includes(lo)) out.push(lo);
  }
  return out;
}

// One (font size, spacing) attempt: the widest box whose measured rectangle is wholly
// inside the polygon. Returns `{ box, w, h }` or null.
function fitAttempt(r, item, base, size, spacing, b) {
  const k = base > 0 ? size / base : 1;
  const cand = scaledForFit(item, k, spacing);
  const minWidth = Math.ceil(measureTextItem(cand, Math.max(1, b[2])).minWidth);
  const natural = Math.max(Math.round(b[2]), minWidth);
  for (const w of widthCandidates(natural, minWidth)) {
    const h = Math.max(6, Math.ceil(measureTextItem(cand, w).height));
    const box = [Math.round(b[0]), Math.round(b[1]), w, h];
    if (boxInsideRegion(r, box)) return { box, w, h };
  }
  return null;
}

function fitToRegion(r, item) {
  const b = (item.box || [0, 0, 0, 0]).map(v => +v || 0);
  const base = normalizeStyle(item.style).size;
  const cur = lineHeightOf(item.style);
  const accept = (size, spacing, hit) => {
    const spacingChanged = Math.abs(spacing - cur) > 1e-6;
    const sizeChanged = Math.abs(size - base) > 1e-6;
    return {
      box: hit.box, w: hit.w, h: hit.h, spacing, spacingChanged,
      size, sizeChanged, k: base > 0 ? size / base : 1, clipped: false,
      changed: sizeChanged || spacingChanged
        || hit.box[2] !== Math.round(b[2]) || hit.box[3] !== Math.round(b[3]),
    };
  };
  // 1. line spacing, at the item's own font size (the least tightening that works).
  for (let sp = Math.round(cur * 100) / 100; sp >= LINE_HEIGHT_MIN - 1e-6; sp -= 0.05) {
    const s = Math.max(LINE_HEIGHT_MIN, Math.round(sp * 100) / 100);
    const hit = fitAttempt(r, item, base, base, s, b);
    if (hit) return accept(base, s, hit);
    if (s <= LINE_HEIGHT_MIN + 1e-6) break;
  }
  // 2. font size, at the tightest spacing.
  for (let size = Math.round((base - FIT_SIZE_STEP) * 10) / 10; size >= FIT_MIN_SIZE - 1e-6; size -= FIT_SIZE_STEP) {
    const s = Math.max(FIT_MIN_SIZE, Math.round(size * 10) / 10);
    const hit = fitAttempt(r, item, base, s, LINE_HEIGHT_MIN, b);
    if (hit) return accept(s, LINE_HEIGHT_MIN, hit);
  }
  // 3. fallback: the automatic fit (keep the font, grow past the polygon).
  const info = fitBoxToText(r, item, undefined, { tighten: true });
  const [ox, oy] = regionOrigin(r);
  const polyOk = rectInsideRings(regionRings(r.geometry), [ox + info.box[0], oy + info.box[1], info.box[2], info.box[3]], CLIP_WARN_TOL);
  return { ...info, size: base, sizeChanged: false, k: 1, clipped: info.clipped || !polyOk };
}

// Fit a box to its text but only ever *grow* it: used when a formatting change (line
// spacing) can have cropped content — the box grows so every line stays visible, while
// leaving a smaller box to the user's own choice (each drag is one undo step back).
function growBoxToFit(r, item) {
  const info = fitBoxToText(r, item);
  const b = (item.box || [0, 0, 0, 0]).map(v => +v || 0);
  const box = [b[0], b[1], Math.max(b[2], info.box[2]), Math.max(b[3], info.box[3])];
  return { box, w: box[2], h: box[3], clipped: info.clipped, changed: box[2] !== b[2] || box[3] !== b[3] };
}

// The automatic half of "Resize to text": a freshly translated or extracted item is
// fitted to its own text the moment it lands, so machine output is readable without a
// manual pass — the same fit rules as the menu command (tighten the line spacing first,
// then grow the box past the polygon rather than crop). Returns the fit info so callers
// can still report the rare overhang (a clipped fit needs a bigger region).
function autoFitItemToRegion(r, item) {
  if (!r || !item || item.type !== 'text') return null;
  const info = fitToRegion(r, item);
  if (info.changed) {
    item.box = info.box.slice();
    item.style = normalizeStyle({ ...item.style, lineHeight: info.spacing });
    if (Math.abs((info.k || 1) - 1) > 1e-9) scaleTextItem(item, info.k);
  }
  return info;
}

// "Resize to text" in the item context menu.
function resizeItemToText(id, idx) {
  const r = regionById(id);
  const it = r?.content?.items?.[idx];
  if (!r || !it || it.type !== 'text') return;
  const info = fitToRegion(r, it);
  if (!info.changed) {
    setStatus(info.clipped
      ? 'This text needs a bigger region — the polygon clips its overhang (it is painted orange); enlarge the region or shorten the text.'
      : 'Text box already matches its text.');
    return;
  }
  S.selected.clear(); S.selected.add(id);
  S.itemIndex = idx; S.itemSelected = true; clearItemSelection();
  mutateContentFor(r, 'resize text box to text', (c) => {
    const t = c.items[idx];
    if (!t) return;
    t.box = info.box.slice();
    // Tightening the line spacing and reducing the font size are part of the same undo
    // step: one Ctrl+Z puts the box, the spacing and the size back together.
    t.style = normalizeStyle({ ...t.style, lineHeight: info.spacing });
    if (Math.abs(info.k - 1) > 1e-9) scaleTextItem(t, info.k);
  });
  setStatus(fitStatus(info, 'resized'));
}

// Tools ▸ Resize to text in page (R): the item context menu's Resize to text, run on every
// text box of the current page at once — one undo step, so one Ctrl+Z puts every box (and
// every line spacing the fit tightened, or font size it reduced, spec §9b) back. Each box
// is fitted inside its own region by tightening the line spacing first and, when even that
// is not enough, reducing the font size; a box that still cannot fit grows past the polygon
// rather than losing its text. A box is never moved and text is never silently cropped. A
// locked region's content is still editable — that is what locking means here.
function pageTextItemCount() {
  const pg = getPage(S.pmap, S.page);
  return (pg?.regions || []).reduce((n, r) => n + (r.content?.items || []).filter(it => it.type === 'text').length, 0);
}
function resizeAllTextInPage() {
  const pg = getPage(S.pmap, S.page);
  if (!pg) { setStatus('No page loaded.'); return; }
  const plans = [];
  let boxes = 0, clipped = 0, tightened = 0, shrunk = 0;
  // A deep enough snapshot to undo the fit exactly: the box, the style (spacing and, when
  // the font lever fired, size) and the blocks (whose run sizes scale with the font). The
  // snapshot keeps its own arrays so the plan never aliases the live model.
  const snap = (it) => {
    const s = { box: it.box.map(v => +v || 0), style: normalizeStyle(structuredClone(it.style)) };
    if (Array.isArray(it.blocks)) s.blocks = structuredClone(it.blocks);
    return s;
  };
  for (const r of pg.regions) {
    const items = r.content?.items || [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].type !== 'text') continue;
      boxes++;
      const info = fitToRegion(r, items[i]);
      if (info.clipped) clipped++;
      if (!info.changed) continue;
      if (info.spacingChanged) tightened++;
      if (info.sizeChanged) shrunk++;
      const afterItem = structuredClone(items[i]);
      afterItem.box = info.box.slice();
      afterItem.style = normalizeStyle({ ...afterItem.style, lineHeight: info.spacing });
      if (Math.abs(info.k - 1) > 1e-9) scaleTextItem(afterItem, info.k);
      plans.push({ regionId: r.id, i, before: snap(items[i]), after: snap(afterItem) });
    }
  }
  if (!boxes) { setStatus(`No text boxes on page ${S.page}.`); return; }
  if (!plans.length) {
    setStatus(clipped
      ? `All ${boxes} text box(es) on page ${S.page} already match their text, but ${clipped} still need a bigger region (the polygon clips the overhang and is painted orange).`
      : `All ${boxes} text box(es) on page ${S.page} already match their text.`);
    return;
  }
  const apply = (key) => {
    for (const p of plans) {
      const r = pg.regions.find(x => x.id === p.regionId);
      const it = r?.content?.items?.[p.i];
      if (!it) continue;
      const v = p[key];
      it.box = v.box.slice();
      it.style = normalizeStyle({ ...v.style });
      if (v.blocks) it.blocks = structuredClone(v.blocks);
    }
  };
  history.exec({
    label: 'resize text boxes to text',
    do() { apply('after'); touch(S.pmap); rerender(); },
    undo() { apply('before'); rerender(); },
  });
  setStatus(`Resized ${plans.length} of ${boxes} text box(es) on page ${S.page}${tightened ? `, tightening the line spacing of ${tightened}` : ''}${shrunk ? `, reducing the font of ${shrunk}` : ''}${clipped ? ` — ${clipped} still need a bigger region (the polygon clips the overhang and is painted orange)` : ''}.`);
}

// ---- inline on-page rich-text editing (double-click / Add text) ----
// A text item is a document of blocks. The editor renders the document into
// #inline-edit; character formatting is applied to the *selected text only*
// (per-run overrides), and a collapsed caret sets a pending style for the next
// typed characters. Alignment is a block property. See src/model/blocks.js.
let inlineState = null; // { regionId, index, box, blocks, style, active, pending }
let capturedSel = null;      // the editor selection captured when a toolbar control is engaged
let textDialogDrag = null;   // { el, startX, startY, startLeft, startTop } — drag-to-move the edit dialog

// The dialog is an *editor*, not a preview of the box: its text area fills the dialog (it is
// as big as the dialog, never as big as the box) and shows the text at its real size in PDF
// points (1 pt = 1 px), with no magnification. Sizing the box is done on the page, where the
// box is — drag its handles in Edit mode, or use "Resize to text" / `R` to fit it to the text.
// Only the text's *appearance* (font, size, colour, alignment, line spacing) is mirrored here;
// the wrapping is the dialog's own, so the page shows the page's wrap.

function captureEditorSel() {
  const sel = window.getSelection();
  if (sel && sel.rangeCount && els.inlineEdit.contains(sel.getRangeAt(0).commonAncestorContainer)) {
    capturedSel = sel.getRangeAt(0).cloneRange();
  } else capturedSel = null;
}

// The live selection in the editor, falling back to the one captured on toolbar pointerdown.
function liveRange() {
  const sel = window.getSelection();
  if (sel && sel.rangeCount && els.inlineEdit.contains(sel.getRangeAt(0).commonAncestorContainer)) return sel.getRangeAt(0);
  if (capturedSel && els.inlineEdit.contains(capturedSel.commonAncestorContainer)) return capturedSel;
  return null;
}

// ---- block/flow helpers (a "flow" = paragraph / heading / list item / table cell) ----
function flowsInEditor() { return [...els.inlineEdit.querySelectorAll('[data-flow]')]; }
function closestFlow(node) {
  const el = node && node.nodeType === 1 ? node : (node ? node.parentElement : null);
  return (el && el.closest) ? el.closest('[data-flow]') : null;
}
function pathOf(el) { return (el && el.dataset) ? el.dataset.flow : null; }
function flowAt(blocks, path) {
  const parts = String(path || '').split('.').map(Number);
  const b = blocks[parts[0]];
  if (!b) return null;
  if (b.type === 'list') return b.items[parts[1]] ? { block: b, flow: b.items[parts[1]] } : null;
  if (b.type === 'table') { const c = b.rows?.[parts[1]]?.cells?.[parts[2]]; return c ? { block: b, flow: c } : null; }
  return { block: b, flow: b };
}
function baseForFlow(block, flow) {
  const s = inlineState.style;
  if (block.type === 'heading') return flowBase(s, 'heading', block.level, block.align, block.direction);
  if (block.type === 'table') return flowBase(s, 'paragraph', null, flow.align, flow.direction);
  if (block.type === 'list') return flowBase(s, 'paragraph', null, null, block.direction);
  return flowBase(s, 'paragraph', null, block.align, block.direction);
}
function renderEditor() { els.inlineEdit.innerHTML = blocksToHtml(inlineState.blocks, inlineState.style); }
function readEditor() {
  if (!inlineState) return;
  inlineState.blocks = htmlToBlocks(els.inlineEdit, inlineState.style);
  ensureTrailingParagraph(inlineState.blocks, inlineState.style);
}

// A document whose last block is a table needs an empty paragraph after it so
// the caret has somewhere to go (spec §7). It is editor-only: dropped on commit
// if it was never typed into.
function ensureTrailingParagraph(blocks, style) {
  const last = blocks[blocks.length - 1];
  if (last && last.type === 'table') {
    const s = normalizeStyle(style || {});
    blocks.push({ type: 'paragraph', value: '', runs: [], align: s.align || 'left', direction: s.direction || 'ltr' });
  }
  return blocks;
}
function trimTrailingAfterTable(blocks) {
  const n = blocks.length;
  const last = blocks[n - 1];
  if (n >= 2 && last?.type === 'paragraph' && !last.value && !(last.runs || []).length && blocks[n - 2]?.type === 'table') {
    return blocks.slice(0, n - 1);
  }
  return blocks;
}

function updateActiveFlow() {
  if (!inlineState) return;
  const range = liveRange();
  const el = range ? closestFlow(range.startContainer) : null;
  if (!el) { inlineState.active = null; return; }
  const parts = String(pathOf(el)).split('.').map(Number);
  inlineState.active = { path: pathOf(el), block: parts[0], row: parts[1] ?? null, col: parts[2] ?? null };
}

function offsetToDom(root, off) { return locateOffset(root, collectUnits(root), off); }
function setCaretInFlow(path, off) {
  const el = els.inlineEdit.querySelector(`[data-flow="${path}"]`);
  if (!el) return;
  const [n, o] = offsetToDom(el, off);
  const r = document.createRange();
  try { r.setStart(n, o); r.collapse(true); } catch { return; }
  const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
}
function caretToEnd() {
  const flows = flowsInEditor();
  const last = flows[flows.length - 1];
  if (!last) return;
  const path = pathOf(last);
  const hit = flowAt(inlineState.blocks, path);
  setCaretInFlow(path, String(hit?.flow?.value || '').length);
}
function saveSelection() {
  const range = liveRange();
  if (!range) return null;
  const sEl = closestFlow(range.startContainer), eEl = closestFlow(range.endContainer);
  if (!sEl || !eEl) return null;
  return {
    sPath: pathOf(sEl), sOff: domPointToOffset(sEl, range.startContainer, range.startOffset),
    ePath: pathOf(eEl), eOff: domPointToOffset(eEl, range.endContainer, range.endOffset),
  };
}
function restoreSelection(save) {
  if (!save) return;
  const sEl = els.inlineEdit.querySelector(`[data-flow="${save.sPath}"]`);
  const eEl = els.inlineEdit.querySelector(`[data-flow="${save.ePath}"]`) || sEl;
  if (!sEl) return;
  const [sn, so] = offsetToDom(sEl, save.sOff);
  const [en, eo] = offsetToDom(eEl, save.eOff);
  const range = document.createRange();
  try { range.setStart(sn, so); range.setEnd(en, eo); } catch { return; }
  const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
}

function splitRuns(runs, off) {
  const a = [], b = [];
  for (const r of (runs || [])) {
    const e = Math.min(r.end, off);
    if (e > r.start) a.push({ ...r, start: r.start, end: e });
    const s2 = Math.max(r.start, off);
    if (r.end > s2) b.push({ ...r, start: s2 - off, end: r.end - off });
  }
  return [a, b];
}

// ---- Edit text dialog: drag to move (handles inside the header still work normally) ----
function textDialogDragStart(e, el) {
  const target = e.target;
  // Never drag when pressing a button, input, select, color picker or the editor itself.
  if (target.closest('button, input, select, textarea, [contenteditable]')) return;
  if (textDialogDrag) return;
  const rect = el.getBoundingClientRect();
  textDialogDrag = {
    el, startX: e.clientX, startY: e.clientY,
    startLeft: rect.left, startTop: rect.top,
  };
  el.style.position = 'fixed';
  el.style.left = rect.left + 'px';
  el.style.top = rect.top + 'px';
  el.style.width = rect.width + 'px';
  el.style.height = rect.height + 'px';
  el.style.cursor = 'grabbing';
  document.addEventListener('pointermove', textDialogDragMove);
  document.addEventListener('pointerup', textDialogDragEnd);
}

function textDialogDragMove(e) {
  if (!textDialogDrag) return;
  const dx = e.clientX - textDialogDrag.startX;
  const dy = e.clientY - textDialogDrag.startY;
  textDialogDrag.el.style.left = (textDialogDrag.startLeft + dx) + 'px';
  textDialogDrag.el.style.top = (textDialogDrag.startTop + dy) + 'px';
}

function textDialogDragEnd() {
  if (!textDialogDrag) return;
  textDialogDrag.el.style.cursor = '';
  textDialogDrag = null;
  document.removeEventListener('pointermove', textDialogDragMove);
  document.removeEventListener('pointerup', textDialogDragEnd);
}

function openInlineEditor(region, index, { box, style, blocks } = {}) {
  S.selected.clear(); S.selected.add(region.id);
  S.itemSelected = true; clearItemSelection();
  if (index != null) S.itemIndex = index;
  const st = normalizeStyle(style);
  inlineState = {
    regionId: region.id, index: index ?? null, box: box || textRect(region),
    style: st, blocks: ensureTrailingParagraph(normalizeBlocks(blocks), st), active: null, pending: null,
  };
  els.inlineEdit.hidden = false;
  if (els.textModal) {
    els.textModal.hidden = false;
    // Attach drag-to-move on the dialog header (tm-head). Toolbar buttons, inputs and the
    // editor itself still handle their own presses normally.
    const head = els.textModal.querySelector('.tm-head');
    if (head && !head.dataset.textDrag) {
      head.dataset.textDrag = '1';
      head.addEventListener('pointerdown', (e) => textDialogDragStart(e, els.textModal.querySelector('.text-box-modal')));
    }
    // The double-click that opens this dialog also sends its matching mouse press to
    // whatever is under the pointer — now a dialog control, which would steal focus (and
    // could even trigger it). Keep the dialog out of hit-testing for that one frame, then
    // hand focus to the editor.
    els.textModal.style.pointerEvents = 'none';
    requestAnimationFrame(() => {
      if (!els.textModal || els.textModal.hidden) return;
      els.textModal.style.pointerEvents = '';
      // Center the dialog in the viewport (it is position:fixed so it can be dragged).
      const box = els.textModal.querySelector('.text-box-modal');
      if (box && !box.style.left) {
        const rect = box.getBoundingClientRect();
        box.style.left = Math.max(0, (window.innerWidth - rect.width) / 2) + 'px';
        box.style.top = Math.max(0, (window.innerHeight - rect.height) / 2) + 'px';
      }
      if (inlineState && !els.inlineEdit.hidden) { els.inlineEdit.focus(); caretToEnd(); }
    });
  }
  renderEditor();
  styleInlineEditor();
  loadEditorSourceImage(region);
  rerender();
  els.inlineEdit.focus();
  caretToEnd();
  updateActiveFlow();
  refreshContextTools();
}

// Open the editor for the currently selected text item (used when a format
// control is used without an open editor, so formatting has a target).
function ensureEditorOpen() {
  if (inlineState && !els.inlineEdit.hidden) return true;
  const item = currentTextItem();
  const r = currentRegion();
  if (!item || !r) return false;
  openInlineEditor(r, S.itemIndex, { box: item.box, style: item.style, blocks: itemBlocks(item) });
  return true;
}

// Mirror the item's *look* in the dialog's text area: the font size is the item's real size in
// PDF points (1 pt = 1 px, never magnified), with its family, colour, direction and line
// spacing, so what is typed looks like what the page will hold. The area's size is the
// dialog's, not the box's (the box is sized on the page — see the note above); the header
// still reports the box's real size so it is never a mystery.
function styleInlineEditor() {
  if (!inlineState || els.inlineEdit.hidden) return;
  const r = getPage(S.pmap, S.page)?.regions.find(x => x.id === inlineState.regionId);
  if (!r) { closeInlineEditor(); return; }
  const st = inlineState.style;
  const ta = els.inlineEdit;
  ta.style.fontSize = `${st.size || 12}px`;
  ta.style.lineHeight = String(lineHeightOf(st));
  ta.style.fontFamily = FONT_CSS[st.font] || FONT_CSS.sans;
  ta.style.color = st.color || '#111';
  ta.style.direction = st.direction || 'ltr';
}

// ---- editor offset <-> DOM mapping (a <br> counts as one newline char;
// the zero-width caret marker used for pending styles is not a character) ----
function ignoreChar(ch) { return ch === '\u200b'; }
function countChars(s) { let n = 0; for (const ch of s) if (!ignoreChar(ch)) n++; return n; }
function subtreeUnits(n) {
  if (n.nodeType === 3) return countChars(n.nodeValue);
  if (n.nodeType === 1) {
    if (n.tagName === 'BR') return 1;
    let s = 0; for (const c of n.childNodes) s += subtreeUnits(c); return s;
  }
  return 0;
}
function domPointToOffset(root, node, offset) {
  // The boundary can be the flow element itself (e.g. selectNodeContents):
  // count whole children up to the child index.
  if (node === root && node.nodeType === 1) {
    let count = 0;
    for (let m = 0; m < offset && m < node.childNodes.length; m++) count += subtreeUnits(node.childNodes[m]);
    return count;
  }
  let count = 0, done = false;
  const visit = (n) => {
    for (let k = 0; k < n.childNodes.length && !done; k++) {
      const c = n.childNodes[k];
      if (c === node) {
        if (c.nodeType === 3) count += countChars(c.nodeValue.slice(0, offset));
        else for (let m = 0; m < offset && m < c.childNodes.length; m++) count += subtreeUnits(c.childNodes[m]);
        done = true; return;
      }
      if (c.nodeType === 3) count += countChars(c.nodeValue);
      else if (c.nodeType === 1) { if (c.tagName === 'BR') count += 1; else visit(c); }
    }
  };
  visit(root);
  return count;
}

function collectUnits(root) {
  const units = [];
  const walk = (n) => {
    for (const c of n.childNodes) {
      if (c.nodeType === 3) { for (let i = 0; i < c.nodeValue.length; i++) { if (ignoreChar(c.nodeValue[i])) continue; units.push({ node: c, i }); } }
      else if (c.nodeType === 1) { if (c.tagName === 'BR') units.push({ node: c, br: true }); else walk(c); }
    }
  };
  walk(root);
  return units;
}
function indexInParent(node) { return Array.prototype.indexOf.call(node.parentNode.childNodes, node); }
function locateOffset(root, units, off) {
  if (!units.length) return [root, 0];
  if (off <= 0) { const u = units[0]; return u.br ? [u.node.parentNode, indexInParent(u.node)] : [u.node, 0]; }
  if (off >= units.length) { const u = units[units.length - 1]; return u.br ? [u.node.parentNode, indexInParent(u.node) + 1] : [u.node, u.node.nodeValue.length]; }
  const u = units[off];
  return u.br ? [u.node.parentNode, indexInParent(u.node) + 1] : [u.node, u.i];
}

// ---- formatting: always scoped to the selection (or pending for next keystrokes) ----
function baseOfBlocks() {
  if (!inlineState || !inlineState.blocks.length) return normalizeStyle(inlineState?.style || {});
  const b = inlineState.blocks[0];
  if (b.type === 'table') return normalizeStyle(inlineState.style);
  if (b.type === 'list') return flowBase(inlineState.style, 'paragraph', null, null, b.direction);
  return flowBase(inlineState.style, 'paragraph', null, b.align, b.direction);
}

// Effective character style at the caret / selection start (drives toolbar state).
function editorCurrentStyle() {
  if (!inlineState) return {};
  if (inlineState.pending) return normalizeStyle(inlineState.pending);
  const range = liveRange();
  const el = range ? closestFlow(range.startContainer) : null;
  const hit = el ? flowAt(inlineState.blocks, pathOf(el)) : null;
  if (!hit) return baseOfBlocks();
  const base = baseForFlow(hit.block, hit.flow);
  const value = String(hit.flow.value || '');
  if (!value.length) return normalizeStyle(base);
  const cs = charStyles({ value, style: base, runs: hit.flow.runs });
  const off = range ? domPointToOffset(el, range.startContainer, range.startOffset) : 0;
  return cs[Math.max(0, Math.min(value.length - 1, off))] || normalizeStyle(base);
}

function applyTextFormat(kind, value) {
  if (!ensureEditorOpen()) return;
  inlineState.pending = null;
  readEditor();
  const range = liveRange();
  const sFlow = range ? closestFlow(range.startContainer) : null;
  const eFlow = range ? closestFlow(range.endContainer) : null;
  if (!range || !sFlow || !eFlow) { caretToEnd(); const r2 = liveRange(); if (r2) insertPending(kind, value); refreshContextTools(); return; }

  if (range.collapsed && sFlow === eFlow) { insertPending(kind, value); refreshContextTools(); return; }

  const flows = flowsInEditor();
  let si = flows.indexOf(sFlow), ei = flows.indexOf(eFlow);
  if (si < 0 || ei < 0) return;
  if (si > ei) { const t = si; si = ei; ei = t; }
  const save = saveSelection();
  for (let i = si; i <= ei; i++) {
    const el = flows[i];
    const hit = flowAt(inlineState.blocks, pathOf(el));
    if (!hit) continue;
    const { block, flow } = hit;
    const base = baseForFlow(block, flow);
    const n = String(flow.value || '').length;
    let s = 0, e = n;
    if (i === si) s = domPointToOffset(el, range.startContainer, range.startOffset);
    if (i === ei) e = domPointToOffset(el, range.endContainer, range.endOffset);
    if (e < s) { const t = s; s = e; e = t; }
    if (e <= s) continue;
    flow.runs = applyFormatToRuns(flow.value, base, flow.runs, s, e, kind, value);
    if (kind === 'dir' && s === 0 && e === n) {
      if (block.type === 'paragraph' || block.type === 'heading') block.direction = value === 'rtl' ? 'rtl' : 'ltr';
      else if (block.type === 'table') flow.direction = value === 'rtl' ? 'rtl' : 'ltr';
    }
  }
  renderEditor();
  restoreSelection(save);
  refreshContextTools();
}

// Collapsed caret: carry the format into the next typed characters only.
function insertPending(kind, value) {
  const range = liveRange();
  const el = range ? closestFlow(range.startContainer) : null;
  const hit = el ? flowAt(inlineState.blocks, pathOf(el)) : null;
  if (!hit) return;
  const { block, flow } = hit;
  const base = baseForFlow(block, flow);
  const n = String(flow.value || '').length;
  const off = range ? domPointToOffset(el, range.startContainer, range.startOffset) : n;
  const cs = n ? charStyles({ value: flow.value, style: base, runs: flow.runs }) : null;
  const at = n ? (cs[Math.max(0, Math.min(n - 1, off))] || normalizeStyle(base)) : normalizeStyle(base);
  const pend = { ...normalizeStyle(base) };
  if (kind === 'bold') pend.bold = !at.bold;
  else if (kind === 'italic') pend.italic = !at.italic;
  else if (kind === 'underline') pend.underline = !at.underline;
  else if (kind === 'color') pend.color = value;
  else if (kind === 'font') pend.font = value;
  else if (kind === 'size') pend.size = Math.max(4, Math.min(200, Number(value) || 12));
  else if (kind === 'dir') pend.direction = value === 'rtl' ? 'rtl' : 'ltr';
  inlineState.pending = pend;
  if (range && !range.collapsed) return;
  const span = document.createElement('span');
  span.setAttribute('data-pending', '1');
  span.setAttribute('style', spanCss(pend));
  span.appendChild(document.createTextNode('\u200b'));
  try { range.deleteContents(); range.insertNode(span); } catch { return; }
  const r2 = document.createRange();
  r2.setStart(span.firstChild, 1); r2.collapse(true);
  const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r2);
  els.inlineEdit.focus();
}

// Alignment is a block property (applies to every block the selection touches).
function applyAlign(value) {
  if (!ensureEditorOpen()) return;
  inlineState.pending = null;
  readEditor();
  const range = liveRange();
  const sEl = range ? closestFlow(range.startContainer) : null;
  const eEl = range ? closestFlow(range.endContainer) : null;
  const save = saveSelection();
  const blocks = inlineState.blocks;
  const si = +(sEl ? pathOf(sEl).split('.')[0] : 0);
  const ei = +(eEl ? pathOf(eEl).split('.')[0] : si);
  for (let bi = Math.min(si, ei); bi <= Math.max(si, ei); bi++) {
    const b = blocks[bi];
    if (!b) continue;
    if (b.type === 'paragraph' || b.type === 'heading') b.align = value;
    else if (b.type === 'table') {
      const parts = String(pathOf(sEl || eEl || '')).split('.').map(Number);
      const cell = b.rows?.[parts[1]]?.cells?.[parts[2]];
      if (cell) cell.align = value;
    }
  }
  renderEditor();
  restoreSelection(save);
  refreshContextTools();
}

// Line spacing (spec §9b): a property of the *whole* box, not of a selection — the multiple
// of the font size between its lines. Unlike the character tools it needs no selection: it
// goes on the item's style, the dialog's editor follows it live, the measured height of the
// box follows it (so "Resize to text" accounts for it) and it is saved with the item on Done.
// Table rows keep their own height, so spacing inside a cell is clipped like any other
// cell text that does not fit.
function lineSpacingClamp(value) {
  const v = Number(value);
  const ok = Number.isFinite(v) && v > 0 ? v : DEFAULT_LINE_HEIGHT;
  return Math.round(Math.min(LINE_HEIGHT_MAX, Math.max(LINE_HEIGHT_MIN, ok)) * 100) / 100;
}
function applyLineSpacing(value) {
  if (!ensureEditorOpen()) return;
  const v = lineSpacingClamp(value);
  inlineState.style.lineHeight = v;
  styleInlineEditor(); // the editor's own line boxes follow the item's spacing
  refreshContextTools();
  setStatus(v === DEFAULT_LINE_HEIGHT
    ? `Line spacing: default (${DEFAULT_LINE_HEIGHT} × the font size).`
    : `Line spacing: ${v} × the font size for the whole box.`);
}

// ---- block operations: insert table / toggle list / cycle heading ----
function blockOp(kind) {
  if (!ensureEditorOpen()) return;
  inlineState.pending = null;
  readEditor();
  const range = liveRange();
  const el = range ? closestFlow(range.startContainer) : null;
  const parts = String(el ? pathOf(el) : '0').split('.').map(Number);
  const bi = parts[0];
  const b = inlineState.blocks[bi];
  const save = saveSelection();
  if (kind === 'table') {
    inlineState.blocks.splice(bi + 1, 0, newTableBlock(2, 2));
    ensureTrailingParagraph(inlineState.blocks, inlineState.style);
  } else if (kind === 'ul' || kind === 'ol') {
    if (b && b.type === 'list') b.ordered = kind === 'ol';
    else if (b) {
      const items = b.type === 'paragraph' || b.type === 'heading'
        ? [{ value: b.value || '', runs: b.runs || [], level: 0 }]
        : [{ value: '', runs: [], level: 0 }];
      inlineState.blocks[bi] = { type: 'list', ordered: kind === 'ol', direction: b.direction || 'ltr', items };
    }
  } else if (kind === 'head') {
    if (b && (b.type === 'paragraph' || b.type === 'heading')) {
      const next = b.type === 'paragraph' ? 1 : (b.level >= 3 ? null : b.level + 1);
      inlineState.blocks[bi] = next
        ? { type: 'heading', level: next, value: b.value || '', runs: b.runs || [], align: b.align, direction: b.direction }
        : { type: 'paragraph', value: b.value || '', runs: b.runs || [], align: b.align, direction: b.direction };
    }
  }
  renderEditor();
  restoreSelection(save);
  if (kind === 'table') {
    const flows = flowsInEditor();
    const t = flows.find(f => pathOf(f).startsWith(`${bi + 1}.`));
    if (t) setCaretInFlow(pathOf(t), 0);
  }
  updateActiveFlow();
  refreshContextTools();
}

// ---- table structure / sizing operations (on the active cell) ----
function tableTarget() {
  if (!inlineState || !inlineState.active) return null;
  const { block: bi, row, col } = inlineState.active;
  const b = inlineState.blocks[bi];
  if (!b || b.type !== 'table' || row == null || col == null) return null;
  return { bi, row, col, block: b };
}

function tableOp(kind, arg) {
  if (!inlineState) return;
  readEditor();
  const t = tableTarget();
  if (!t) return;
  const { bi, row, col, block: b } = t;
  const mkCell = () => normalizeCell({ value: '', align: 'left', direction: b.dir });
  if (kind === 'addRow') {
    b.rows.splice(row + 1, 0, { height: b.rows[row]?.height || DEFAULT_ROW_HEIGHT, cells: b.columns.map(mkCell) });
  } else if (kind === 'delRow') {
    if (b.rows.length > 1) b.rows.splice(row, 1);
  } else if (kind === 'addCol') {
    b.columns.splice(col + 1, 0, { width: b.columns[col]?.width || DEFAULT_COL_WIDTH });
    for (const r of b.rows) r.cells.splice(col + 1, 0, mkCell());
  } else if (kind === 'delCol') {
    if (b.columns.length > 1) { b.columns.splice(col, 1); for (const r of b.rows) r.cells.splice(col, 1); }
  } else if (kind === 'border') {
    b.border = { ...b.border, ...arg };
  } else if (kind === 'colWidth') {
    if (b.columns[col]) b.columns[col].width = Math.max(8, Math.min(4000, Number(arg) || DEFAULT_COL_WIDTH));
  } else if (kind === 'rowHeight') {
    if (b.rows[row]) b.rows[row].height = Math.max(8, Math.min(4000, Number(arg) || DEFAULT_ROW_HEIGHT));
  } else if (kind === 'tableWidth') {
    // Scale every column so the table's overall width matches the value.
    const cur = b.columns.reduce((a, c) => a + Math.max(8, Number(c.width) || DEFAULT_COL_WIDTH), 0) || DEFAULT_COL_WIDTH;
    const target = Math.max(20, Math.min(12000, Number(arg) || cur));
    const k = target / cur;
    for (const c of b.columns) c.width = Math.max(8, Math.round((Number(c.width) || DEFAULT_COL_WIDTH) * k * 100) / 100);
  } else if (kind === 'cellDir') {
    const c = b.rows[row]?.cells?.[col];
    if (c) c.direction = arg === 'rtl' ? 'rtl' : 'ltr';
  } else if (kind === 'cellAlign') {
    const c = b.rows[row]?.cells?.[col];
    if (c) c.align = arg;
  }
  renderEditor();
  const nr = Math.max(0, Math.min(row, b.rows.length - 1));
  const nc = Math.max(0, Math.min(col, b.columns.length - 1));
  inlineState.active = { path: `${bi}.${nr}.${nc}`, block: bi, row: nr, col: nc };
  setCaretInFlow(inlineState.active.path, 0);
  refreshContextTools();
}

// ---- Enter / Tab / Backspace inside the editor ----
function handleEnter() {
  readEditor();
  const range = liveRange();
  const el = range ? closestFlow(range.startContainer) : null;
  const hit = el ? flowAt(inlineState.blocks, pathOf(el)) : null;
  if (!hit) { insertEditorNewline(); return; }
  const { block, flow } = hit;
  const parts = String(pathOf(el)).split('.').map(Number);
  if (block.type === 'table') { insertEditorNewline(); return; } // Enter = newline inside a cell
  const value = String(flow.value || '');
  const off = domPointToOffset(el, range.startContainer, range.startOffset);
  const [runsA, runsB] = splitRuns(flow.runs, off);
  const before = value.slice(0, off), after = value.slice(off);
  if (block.type === 'list') {
    const idx = parts[1];
    if (!before && !after && flow.level > 0) { flow.level -= 1; renderEditor(); setCaretInFlow(pathOf(el), 0); return; }
    flow.value = before; flow.runs = runsA;
    block.items.splice(idx + 1, 0, { value: after, runs: runsB, level: flow.level || 0 });
    renderEditor();
    setCaretInFlow(`${parts[0]}.${idx + 1}`, 0);
    return;
  }
  const bi = parts[0];
  const nb = { type: block.type, value: after, runs: runsB, align: block.align, direction: block.direction };
  if (block.type === 'heading') nb.type = 'heading', nb.level = block.level;
  flow.value = before; flow.runs = runsA;
  inlineState.blocks.splice(bi + 1, 0, nb);
  renderEditor();
  setCaretInFlow(`${bi + 1}`, 0);
}

function handleTab(back) {
  readEditor();
  const range = liveRange();
  const el = range ? closestFlow(range.startContainer) : null;
  if (!el) return;
  const parts = String(pathOf(el)).split('.').map(Number);
  const b = inlineState.blocks[parts[0]];
  if (!b) return;
  if (b.type === 'table') {
    const nCols = b.columns.length, total = b.rows.length * nCols;
    let flat = parts[1] * nCols + parts[2] + (back ? -1 : 1);
    flat = Math.max(0, Math.min(total - 1, flat));
    const path = `${parts[0]}.${Math.floor(flat / nCols)}.${flat % nCols}`;
    setCaretInFlow(path, 0);
    const p = path.split('.').map(Number);
    inlineState.active = { path, block: p[0], row: p[1], col: p[2] };
    refreshContextTools();
    return;
  }
  if (b.type === 'list' && b.items[parts[1]]) {
    const it = b.items[parts[1]];
    it.level = Math.max(0, Math.min(3, (it.level || 0) + (back ? -1 : 1)));
    renderEditor();
    setCaretInFlow(pathOf(el), 0);
  }
}

function handleBackspace() {
  readEditor();
  const range = liveRange();
  const el = range ? closestFlow(range.startContainer) : null;
  const hit = el ? flowAt(inlineState.blocks, pathOf(el)) : null;
  if (!hit || hit.block.type !== 'list') return false;
  if (String(hit.flow.value || '').length) return false;
  const off = range ? domPointToOffset(el, range.startContainer, range.startOffset) : 0;
  if (off > 0) return false;
  if (hit.flow.level > 0) {
    hit.flow.level -= 1;
    renderEditor();
    setCaretInFlow(pathOf(el), 0);
    return true;
  }
  return false;
}

// The item currently selected — requires an explicit item selection, not just its region.
// Items are frozen outside Content mode (spec §9a), so an item is only ever "selected" there.
function selectedItem() {
  if (!S.pmap || !S.itemSelected || !inContent()) return null;
  return currentRegion()?.content?.items?.[S.itemIndex] || null;
}

function currentTextItem() {
  const it = selectedItem();
  return it?.type === 'text' ? it : null;
}

// Contextual toolbar: show only the tool group that matches the current selection and mode
// (spec §9a). Region mode shows the region actions; Content mode adds the item-place buttons
// next to them and swaps to the item actions once an item is selected. The rich-text tools
// live in the text dialog's header, so they are visible exactly while that dialog is open
// (and nowhere else).
function refreshContextTools() {
  const editing = isEditMode() && !!S.pmap;
  const item = editing ? selectedItem() : null;
  const r = editing ? currentRegion() : null;
  const inlineText = !!(editing && inlineState && !els.inlineEdit.hidden);
  const textSel = inlineText;
  const imgSel = !!(item && item.type === 'image') && !inlineText;
  const regionSel = !!(editing && r && !item && !inlineText);
  const itemSel = !!(editing && item && !inlineText);
  els.textTools.hidden = !textSel;
  els.imageTools.hidden = !imgSel;
  els.regionTools.hidden = !regionSel;
  if (els.itemTools) els.itemTools.hidden = !itemSel;
  // Add text / Add image place items, so they are the two Content-mode-only buttons of the
  // region group (spec §9a).
  if (els.regionAddTools) els.regionAddTools.hidden = !(regionSel && inContent());
  const textSelection = regionSel && selectedRegions().some(x => !isDetectedImage(x));
  if ($('btn-translate-page-text')) $('btn-translate-page-text').hidden = S.lens !== 'translate' || !textSelection;
  if (els.btnMakeSelectable) els.btnMakeSelectable.hidden = S.lens !== 'improve' || !textSelection;
  const tbl = inlineText ? tableTarget() : null;
  if (els.tableTools) els.tableTools.hidden = !tbl;
  if (textSel) {
    const st = editorCurrentStyle();
    els.ttBold.classList.toggle('active', !!st.bold);
    els.ttItalic.classList.toggle('active', !!st.italic);
    els.ttUnderline.classList.toggle('active', !!st.underline);
    els.ttColor.value = st.color || '#111111';
    els.ttFont.value = st.font || 'sans';
    // Half-point steps: the fit's font lever works in 0.5 pt increments, and the dialog
    // must show the size it chose rather than rounding it.
    els.ttSize.value = Math.round((st.size ?? 12) * 2) / 2;
    if (els.ttLine) els.ttLine.value = String(lineHeightOf(inlineState.style));
    const align = tbl ? (tbl.block.rows[tbl.row]?.cells?.[tbl.col]?.align) : st.align;
    els.ttAlign.value = align || 'left';
    els.ttDir.value = st.direction || 'ltr';
  } else if (imgSel) {
    els.fItemFit.value = item.fit || 'contain';
  } else if (regionSel) {
    els.fBg.value = r.content?.background || DEFAULT_BACKGROUND;
    // Keep the region toolbar's language control on its lens: Translate's destination,
    // or Improve's source. Setting Translate's value here would silently retarget
    // Improve's extraction to the translation language.
    syncLensLanguageControl();
    const lk = $('btn-lock-region');
    if (lk) { lk.textContent = isRegionLocked(r) ? 'Unlock polygon' : 'Lock polygon'; lk.classList.toggle('active', isRegionLocked(r)); }
  }
  if (itemSel && els.itemTools) {
    const n = r?.content?.items?.length || 0;
    if (els.btnItemFitText) els.btnItemFitText.disabled = item.type !== 'text';
    if (els.btnItemFront) els.btnItemFront.disabled = !(n > 1 && S.itemIndex < n - 1);
    if (els.btnItemBack) els.btnItemBack.disabled = !(n > 1 && S.itemIndex > 0);
  }
  if (tbl && els.tableTools) {
    els.tblBorderColor.value = tbl.block.border?.color || DEFAULT_TABLE_BORDER.color;
    els.tblBorderWidth.value = tbl.block.border?.width ?? DEFAULT_TABLE_BORDER.width;
    els.tblColW.value = Math.round(tbl.block.columns[tbl.col]?.width || DEFAULT_COL_WIDTH);
    els.tblRowH.value = Math.round(tbl.block.rows[tbl.row]?.height || DEFAULT_ROW_HEIGHT);
    if (els.tblWidth) els.tblWidth.value = Math.round(tbl.block.columns.reduce((a, c) => a + Math.max(8, Number(c.width) || DEFAULT_COL_WIDTH), 0));
  }
}

// Spec §9b: when the text the user committed is strongly RTL in an LTR box (or the
// reverse), offer the flip instead of letting the wrong layout reach Preview mode. Short or
// letter-less text is left alone (`detectDirStrong`), and declining changes nothing — the
// answer joins the very same undo step as the edit.
function directionFlip(blocks, style) {
  const detected = detectDirStrong(blocksText(blocks));
  if (!detected) return null;
  const cur = style?.direction === 'rtl' ? 'rtl' : 'ltr';
  if (detected === cur) return null;
  const label = detected === 'rtl' ? 'RTL' : 'LTR';
  return confirmDialog({
    title: `Switch this text box to ${label}?`,
    text: `The text you just entered reads ${label}. The box’s direction can stay ${cur}, but Preview and the export will lay it out ${cur}. Flip the direction (and its left/right alignment) to match the text; declining changes nothing.`,
    confirmLabel: `Use ${label}`,
    cancelLabel: `Keep ${cur}`,
  }).then((yes) => (yes ? detected : null));
}

// Flipping a box's direction takes its left/right alignment with it (an RTL box aligns
// right); an explicit centre is the user's own choice and is kept.
function flippedAlign(align, dir) {
  const a = align || 'left';
  if (a === 'center') return a;
  return dir === 'rtl' ? 'right' : 'left';
}

async function commitInlineEditor() {
  if (!inlineState) return;
  readEditor();
  const { regionId, index } = inlineState;
  let style = inlineState.style;
  let blocks = trimTrailingAfterTable(inlineState.blocks);
  const r = getPage(S.pmap, S.page)?.regions.find(x => x.id === regionId);
  const cur = index == null ? null : r?.content?.items?.[index];
  // The offer belongs to *entering* text (spec §9b: "when strongly RTL text is entered"):
  // it fires for a new box or when the text itself changed, never for merely re-opening a
  // box and closing it again.
  const textChanged = index == null || (cur && blocksText(itemBlocks(cur)).trim() !== blocksText(blocks).trim());
  const flip = textChanged ? await directionFlip(blocks, style) : null;
  if (flip) {
    blocks = blocks.map(b => ({ ...b, direction: flip, align: flippedAlign(b.align, flip) }));
    style = { ...style, direction: flip };
  }
  const text = blocksText(blocks);
  closeInlineEditor();
  if (!r) return;
  if (index == null) {
    if (!text.trim()) { rerender(); return; } // no orphan item when nothing typed
    placeTextItem(r, 'add text item', (b) => createTextItem({ blocks, box: b, style }), { fit: true });
  } else {
    if (!cur) { rerender(); return; }
    const nextStyle = normalizeStyle(style);
    const blocksChanged = JSON.stringify(itemBlocks(cur)) !== JSON.stringify(normalizeBlocks(blocks));
    const styleChanged = JSON.stringify(normalizeStyle(cur.style)) !== JSON.stringify(nextStyle);
    if (blocksChanged || styleChanged) {
      // Text and box formatting are one undo step. A style change can make the box too
      // short for its text (taller line spacing), and nothing is ever silently cropped
      // (spec §9b): the box grows to show every line — it is never shrunk here, so a
      // deliberately small box stays the user's own choice.
      mutateContentFor(r, 'edit text item', (c) => {
        const it = c.items[index]; if (!it) return;
        if (blocksChanged) { it.blocks = normalizeBlocks(blocks); delete it.value; delete it.runs; delete it.needsReview; }
        if (styleChanged) {
          // The user has been through it, so the review badge is cleared by *any* edit —
          // text or styling, not only a text change (spec §7: the flag is "cleared when
          // the user edits it"; a re-read of the text is not implied).
          delete it.needsReview;
          it.style = nextStyle;
          if (it.type === 'text') { const g = growBoxToFit(r, it); if (g.changed) it.box = g.box; }
        }
      });
    } else rerender();
    if (styleChanged) {
      const it = r.content?.items?.[index];
      const info = it ? fitBoxToText(r, it) : null;
      if (info && info.clipped) setStatus(`Line spacing ${lineHeightOf(nextStyle)} — the box still needs a bigger region to show every line (the polygon clips the overhang and is painted orange; enlarge the region or shorten the text).`);
      else setStatus(`Line spacing ${lineHeightOf(nextStyle)} × the font size for the whole box.`);
    }
  }
}

// The dialog shows what the page holds under this box — the same polygon crop as
// "Copy underlying content as image" — so the source text is readable while editing or
// translating. Rendering is async: a token drops a crop that arrives after the dialog
// closed or moved on to another box, and the object URL is revoked when it goes away.
let editorSourceToken = 0;
let editorSourceUrl = null;

async function loadEditorSourceImage(region) {
  const token = ++editorSourceToken;
  if (editorSourceUrl) { URL.revokeObjectURL(editorSourceUrl); editorSourceUrl = null; }
  if (!els.textSource || !els.textSourceImg) return;
  els.textSource.hidden = true;
  els.textSourceImg.removeAttribute('src');
  if (!viewer.doc) return;
  try {
    const blob = await viewer.cropPolygonBlob(S.page, regionRings(region.geometry), 2);
    if (token !== editorSourceToken) return;
    if (!inlineState || inlineState.regionId !== region.id) return;
    const url = URL.createObjectURL(blob);
    editorSourceUrl = url;
    els.textSourceImg.src = url;
    els.textSource.hidden = false;
  } catch {
    // No crop (no document, empty polygon …): the dialog simply opens without the reference.
  }
}

function clearEditorSourceImage() {
  editorSourceToken++;
  if (editorSourceUrl) { URL.revokeObjectURL(editorSourceUrl); editorSourceUrl = null; }
  if (els.textSourceImg) els.textSourceImg.removeAttribute('src');
  if (els.textSource) els.textSource.hidden = true;
}

function closeInlineEditor() {
  inlineState = null;
  capturedSel = null;
  textDialogDrag = null;
  clearEditorSourceImage();
  els.inlineEdit.hidden = true;
  els.inlineEdit.blur();
  if (els.textModal) { els.textModal.hidden = true; els.textModal.style.pointerEvents = ''; }
  if (els.tableTools) els.tableTools.hidden = true;
  if (els.textTools) els.textTools.hidden = true;
}

els.inlineEdit.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); handleEnter(); }
  else if (e.key === 'Tab') { e.preventDefault(); handleTab(e.shiftKey); }
  else if (e.key === 'Backspace') { if (handleBackspace()) e.preventDefault(); }
  else if (e.key === 'Escape') { e.preventDefault(); commitInlineEditor(); }
  e.stopPropagation();
});

// Enter inserts a line break (used inside a table cell).
function insertEditorNewline() {
  if (document.execCommand) {
    try {
      if (document.execCommand('insertLineBreak')) return;
      if (document.execCommand('insertText', false, '\n')) return;
    } catch {}
  }
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  range.deleteContents();
  const br = document.createElement('br');
  range.insertNode(br);
  range.setStartAfter(br); range.collapse(true);
  sel.removeAllRanges(); sel.addRange(range);
}

// ---- paste (Word / LibreOffice HTML, spreadsheets as TSV, images as items) ----
els.inlineEdit.addEventListener('paste', (e) => {
  if (!inlineState) return;
  const dt = e.clipboardData;
  if (!dt) return;
  e.preventDefault();
  readEditor();
  const html = dt.getData ? (dt.getData('text/html') || '') : '';
  const text = dt.getData ? (dt.getData('text/plain') || '') : '';
  const blocks = clipboardToBlocks({ html, text }, inlineState.style).map(b => normalizeBlockSafe(b));
  if (blocks.length) {
    const range = liveRange();
    const el = range ? closestFlow(range.startContainer) : null;
    const bi = el ? +String(pathOf(el)).split('.')[0] : inlineState.blocks.length - 1;
    const cur = inlineState.blocks[bi];
    if (cur && cur.type === 'paragraph' && !cur.value && blocks.length === 1) inlineState.blocks.splice(bi, 1, ...blocks);
    else inlineState.blocks.splice(bi + 1, 0, ...blocks);
    ensureTrailingParagraph(inlineState.blocks, inlineState.style);
    renderEditor();
    const flows = flowsInEditor();
    const last = flows[flows.length - 1];
    if (last) { const hit = flowAt(inlineState.blocks, pathOf(last)); setCaretInFlow(pathOf(last), String(hit?.flow?.value || '').length); }
  }
  for (const file of [...(dt.items || [])].filter(i => i.type && i.type.startsWith('image/')).map(i => i.getAsFile?.()).filter(Boolean)) {
    readFileDataUrl(file).then(src => addPastedImage(src));
  }
  updateActiveFlow();
  refreshContextTools();
});

function normalizeBlockSafe(b) {
  const arr = normalizeBlocks([b]);
  return arr[0];
}

// Pasted images become separate image items in the region.
function addPastedImage(source) {
  const r = currentRegion();
  if (r) addImageFromSource(source);
}

document.addEventListener('selectionchange', () => {
  if (!inlineState || els.inlineEdit.hidden) return;
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !els.inlineEdit.contains(sel.getRangeAt(0).commonAncestorContainer)) return;
  captureEditorSel();
  updateActiveFlow();
  refreshContextTools();
});

// ---- table column / row resize by dragging the grips ----
els.inlineEdit.addEventListener('pointerdown', (e) => {
  if (!inlineState) return;
  const t = e.target;
  const colGrip = t.closest && t.closest('.rt-colgrip');
  const rowGrip = !colGrip && t.closest && t.closest('.rt-rowgrip');
  if (!colGrip && !rowGrip) return;
  e.preventDefault();
  e.stopPropagation();
  const cellEl = (colGrip || rowGrip).closest('.rt-cell');
  const parts = String(pathOf(cellEl)).split('.').map(Number);
  const tableEl = (colGrip || rowGrip).closest('table');
  const startPos = colGrip ? e.clientX : e.clientY;
  // The pointer moves in screen pixels and the column width / row height is in layout pixels
  // (the editor lays out at 1 pt = 1 px, unmagnified), so the pointer delta is the size delta.
  let liveEl = null, startSize = 0;
  if (colGrip) {
    liveEl = tableEl.querySelectorAll('colgroup > col')[parts[2]];
    startSize = Math.max(8, parseFloat(liveEl && liveEl.style.width) || DEFAULT_COL_WIDTH);
  } else {
    liveEl = tableEl.querySelectorAll('tbody > tr')[parts[1]];
    startSize = Math.max(8, parseFloat(liveEl && liveEl.style.height) || DEFAULT_ROW_HEIGHT);
  }
  const move = (ev) => {
    const delta = (colGrip ? ev.clientX : ev.clientY) - startPos;
    const size = Math.max(24, Math.round(startSize + delta));
    if (liveEl) { if (colGrip) liveEl.style.width = `${size}px`; else liveEl.style.height = `${size}px`; }
    if (colGrip) {
      const sum = [...tableEl.querySelectorAll('colgroup > col')].reduce((a, c) => a + (parseFloat(c.style.width) || 0), 0);
      tableEl.style.width = `${Math.round(sum)}px`;
    }
  };
  const up = () => {
    window.removeEventListener('pointermove', move, true);
    window.removeEventListener('pointerup', up, true);
    readEditor(); // capture the new column width / row height from the DOM
    inlineState.active = { path: pathOf(cellEl), block: parts[0], row: parts[1], col: parts[2] };
    renderEditor();
    refreshContextTools();
  };
  window.addEventListener('pointermove', move, true);
  window.addEventListener('pointerup', up, true);
});

// The text dialog is the editing context, so the editor losing focus to one of its own
// controls must not end the edit (it used to: the editor lived on the page, where a click
// elsewhere meant "finished"). Only the dialog's own actions end the edit.
if (els.textDone) els.textDone.onclick = () => commitInlineEditor();
if (els.textCancel) els.textCancel.onclick = () => { closeInlineEditor(); rerender(); setStatus('Text edit discarded.'); };
if (els.textModal) els.textModal.addEventListener('pointerdown', (e) => {
  if (e.target === els.textModal) commitInlineEditor(); // clicking outside the dialog finishes, as before
});

// mutate all selected regions of current page as ONE undo step (redo-safe: look up by id)
function mutateSelected(fn, label) {
  const ids = new Set(selectedRegions().map(r => r.id));
  if (!ids.size) return;
  const pg = getPage(S.pmap, S.page);
  const before = pg.regions.filter(r => ids.has(r.id)).map(r => structuredClone(r));
  const apply = () => { pg.regions.filter(r => ids.has(r.id)).forEach(fn); };
  const restore = () => { before.forEach(b => { const i = pg.regions.findIndex(r => r.id === b.id); if (i >= 0) pg.regions[i] = structuredClone(b); }); };
  history.exec({ label, do() { apply(); touch(S.pmap); rerender(); }, undo() { restore(); rerender(); } });
}

// ---- region locking ----
// One shortcut (L) freezes the selected region's polygon: it can no longer be
// moved, reshaped, split, merged or deleted. Its content items (text, images)
// stay fully editable, movable and resizable. Returns the selection to its
// previous lock state so the toggle is a single undo step.
function toggleLockSelected() {
  const sel = selectedRegions();
  if (!sel.length) { setStatus('Select a region first, then press L to lock it.'); return; }
  const lock = sel.some(r => !isRegionLocked(r)); // any unlocked region in the mix => lock them all
  const ids = new Set(sel.map(r => r.id));
  const pg = getPage(S.pmap, S.page);
  const before = pg.regions.filter(r => ids.has(r.id)).map(r => ({ id: r.id, locked: isRegionLocked(r), provenance: detectionSnapshot(r) }));
  const setAll = (v) => {
    for (const b of before) {
      const r = pg.regions.find(x => x.id === b.id);
      if (!r) continue;
      if (v) { r.locked = true; clearDetection(r); } else delete r.locked;
    }
  };
  S.selectedVertex = null; // a picked vertex makes no sense on a frozen polygon
  history.exec({
    label: lock ? 'lock region(s)' : 'unlock region(s)',
    do() { setAll(lock); touch(S.pmap); rerender(); },
    undo() {
      for (const b of before) {
        const r = pg.regions.find(x => x.id === b.id);
        if (!r) continue;
        if (b.locked) r.locked = true; else delete r.locked;
        restoreDetection(r, b.provenance);
      }
      rerender();
    },
  });
  setStatus(`${sel.length} region${sel.length > 1 ? 's' : ''} ${lock ? 'locked — polygon frozen, content still editable' : 'unlocked — polygon editable again'}.`);
}

// ---- create / delete / drag ----
function finishDraw() {
  // dedupe consecutive duplicates (dblclick adds a point then closes)
  const dedup = [];
  for (const p of S.draft) {
    const last = dedup[dedup.length - 1];
    if (!last || Math.hypot(last[0] - p[0], last[1] - p[1]) > 0.5) dedup.push(p);
  }
  if (dedup.length > 1) {
    const f = dedup[0], l = dedup[dedup.length - 1];
    if (Math.hypot(f[0] - l[0], f[1] - l[1]) < 0.5) dedup.pop();
  }
  if (!draftValid(dedup)) { setStatus('Polygon needs ≥3 points.'); return; }
  const pts = dedup.map(p => [...p]);
  S.draft = [];
  S.itemSelected = false; clearItemSelection();
  S.tool = 'select'; // one-shot: polygon tool disarms after a successful draw
  const pg = getPage(S.pmap, S.page);
  const r = createRegion(S.page, pts);
  history.exec({
    label: 'create region',
    do() { pg.regions.push(r); S.selected.clear(); S.selected.add(r.id); touch(S.pmap); rerender(); },
    undo() { pg.regions = pg.regions.filter(x => x.id !== r.id); S.selected.clear(); rerender(); },
  });
}

function deleteSelection() {
  const sel = selectedRegions();
  if (!sel.length) return;
  const locked = sel.filter(isRegionLocked);
  if (locked.length) {
    setStatus(`Cannot delete locked region${locked.length > 1 ? 's' : ''} ${locked.map(r => r.id).join(', ')} — press L to unlock first.`);
    return;
  }
  const pg = getPage(S.pmap, S.page);
  const ids = new Set(sel.map(r => r.id));
  const removed = sel.map(r => ({ r: structuredClone(r), idx: pg.regions.findIndex(x => x.id === r.id) }));
  history.exec({
    label: 'delete region(s)',
    do() { pg.regions = pg.regions.filter(r => !ids.has(r.id)); for (const id of ids) S.awaitingOcr.delete(id); S.selected.clear(); S.selectedVertex = null; S.itemSelected = false; clearItemSelection(); touch(S.pmap); rerender(); },
    undo() { for (const { r, idx } of removed) pg.regions.splice(Math.min(idx, pg.regions.length), 0, structuredClone(r)); rerender(); },
  });
}

// Delete key (spec §11.4): Content mode removes the selected item and is inert on a
// region-only selection — deleting a polygon is geometry work and needs Region mode. Region
// mode deletes the picked vertex, else the whole selected region(s).
function deleteKey() {
  if (inContent()) {
    if (S.itemSelection.size) deleteSelectedItems();
    else if (S.itemSelected && selectedItem()) deleteItem();
    return;
  }
  if (!inRegion()) return;
  const v = S.selectedVertex;
  if (v) {
    const r = currentRegions().find(x => x.id === v.id);
    const ring = r && regionRings(r.geometry)[v.ring ?? 0];
    if (ring && ring.length > 3) { S.selectedVertex = null; deleteVertex(v.id, v.ring ?? 0, v.idx); return; }
  }
  deleteSelection();
}

function applyDragPreview(regions) {
  const d = S.dragPreview;
  if (!d) return regions;
  return regions.map(r => {
    if (r.id !== d.id) return r;
    const rings = regionRings(r.geometry);
    if (d.kind === 'region') {
      const dx = d.cur[0] - d.start[0], dy = d.cur[1] - d.start[1];
      return { ...r, geometry: geometryWithRings(r.geometry, rings.map(ring => ring.map(p => [p[0] + dx, p[1] + dy]))) };
    }
    if (d.kind === 'vertex') {
      const ri = d.ring ?? 0;
      const next = rings.map((ring, k) => (k === ri ? ring.map((p, i) => (i === d.idx ? [...d.cur] : [...p])) : ring.map(p => [...p])));
      return { ...r, geometry: geometryWithRings(r.geometry, next) };
    }
    if (d.kind === 'edge') {
      const dx = d.cur[0] - d.start[0], dy = d.cur[1] - d.start[1];
      const ri = d.ring ?? 0;
      const next = rings.map((ring, k) => {
        if (k !== ri) return ring.map(p => [...p]);
        const n = ring.length, i = d.idx, j = (d.idx + 1) % n;
        return ring.map((p, ki) => (ki === i || ki === j ? [p[0] + dx, p[1] + dy] : [p[0], p[1]]));
      });
      return { ...r, geometry: geometryWithRings(r.geometry, next) };
    }
    if (d.kind === 'item' || d.kind === 'item-resize') {
      const dx = d.cur[0] - d.start[0], dy = d.cur[1] - d.start[1];
      const items = (r.content?.items || []).map((it, i) => (i === d.idx ? { ...it, box: d.kind === 'item' ? moveBox(it.box, dx, dy) : resizeBox(it.box, d.corner, dx, dy) } : it));
      return { ...r, content: { ...r.content, items } };
    }
    return r;
  });
}
function moveBox(box, dx, dy) { return [box[0] + dx, box[1] + dy, box[2], box[3]]; }
// Replace a region's rings, keeping its single/multi-part kind.
function applyRings(region, rings) {
  region.geometry = geometryWithRings(region.geometry, rings);
  clearDetection(region); // a user geometry edit takes the region out of the detector's hands (§21)
}
function resizeBox(box, corner, dx, dy) {
  let [x, y, w, h] = box;
  const min = 6;
  if (corner === 'nw') { x += dx; y += dy; w -= dx; h -= dy; }
  else if (corner === 'ne') { y += dy; w += dx; h -= dy; }
  else if (corner === 'sw') { x += dx; w -= dx; h += dy; }
  else { w += dx; h += dy; }
  w = Math.max(min, w); h = Math.max(min, h);
  return [Math.round(x), Math.round(y), Math.round(w), Math.round(h)];
}
function commitDrag(d, endPt) {
  const preview = S.dragPreview;
  S.dragPreview = null;
  const dx = endPt[0] - d.start[0], dy = endPt[1] - d.start[1];
  // Geometry drags on a locked region are refused (it may have been locked mid-drag).
  if (d.kind !== 'item' && d.kind !== 'item-resize') {
    const lockedTarget = getPage(S.pmap, S.page)?.regions.find(r => r.id === d.id && isRegionLocked(r));
    if (lockedTarget) { setStatus(`${lockedTarget.id} is locked — press L to unlock before reshaping.`); rerender(); return; }
  }
  if (Math.hypot(dx, dy) * S.zoom < 3) {
    // A click (not a drag) on an item only selects it: the selection's own handles are
    // what you grab to move/resize it, and editing a text box happens in its dialog on
    // double-click (spec §9b). A click must never open the editor.
    rerender(); return;
  } // click, not drag
  const pg = getPage(S.pmap, S.page);
  if (d.kind === 'region') {
    const target = pg.regions.find(r => r.id === d.id);
    if (!target) return;
    const before = structuredClone(regionRings(target.geometry));
    const after = before.map(ring => ring.map(p => [p[0] + dx, p[1] + dy]));
    history.exec({ label: 'move region', do() { applyRings(target, after); touch(S.pmap); rerender(); }, undo() { applyRings(target, before); rerender(); } });
  } else if (d.kind === 'vertex') {
    const target = pg.regions.find(r => r.id === d.id);
    if (!target) return;
    const ri = d.ring ?? 0;
    const before = structuredClone(regionRings(target.geometry));
    const after = before.map((ring, k) => (k === ri ? ring.map((p, i) => (i === d.idx ? [endPt[0], endPt[1]] : p)) : ring));
    if (!polygonIsValid(after[ri])) { setStatus('Invalid polygon — vertex move rejected.'); rerender(); return; }
    history.exec({ label: 'move vertex', do() { applyRings(target, after); touch(S.pmap); rerender(); }, undo() { applyRings(target, before); rerender(); } });
  } else if (d.kind === 'edge') {
    const target = pg.regions.find(r => r.id === d.id);
    if (!target) return;
    const ri = d.ring ?? 0;
    const before = structuredClone(regionRings(target.geometry));
    const n = before[ri].length, i = d.idx, j = (d.idx + 1) % n;
    const after = before.map((ring, k) => (k === ri ? ring.map((p, ki) => (ki === i || ki === j ? [p[0] + dx, p[1] + dy] : [p[0], p[1]])) : ring));
    if (!polygonIsValid(after[ri])) { setStatus('Invalid polygon — edge move rejected.'); rerender(); return; }
    history.exec({ label: 'move edge', do() { applyRings(target, after); touch(S.pmap); rerender(); }, undo() { applyRings(target, before); rerender(); } });
  } else if (d.kind === 'item' || d.kind === 'item-resize') {
    const target = pg.regions.find(r => r.id === d.id);
    const it = target?.content?.items?.[d.idx];
    if (!it) { rerender(); return; }
    const before = [...it.box];
    const after = d.kind === 'item' ? moveBox(before, dx, dy) : resizeBox(before, d.corner, dx, dy);
    // Resizing a text box scales its content as a unit (fonts + table geometry),
    // so the text and any tables keep their relative sizes and don't spill.
    const scaleK = (d.kind === 'item-resize' && it.type === 'text' && before[2] > 0 && after[2] > 0) ? after[2] / before[2] : 1;
    const beforeContent = scaleK !== 1 ? structuredClone(it) : null;
    const label = d.kind === 'item' ? 'move item' : 'resize item';
    history.exec({
      label,
      do() {
        it.box = after.map(v => v);
        if (scaleK !== 1) scaleTextItem(it, scaleK);
        touch(S.pmap); rerender();
      },
      undo() {
        it.box = before;
        if (beforeContent) { Object.keys(it).forEach(k => delete it[k]); Object.assign(it, beforeContent); }
        rerender();
      },
    });
  }
  void preview;
}

function nearestEdgeIndex(pts, pdfPt) {
  let best = -1, bestD = Infinity, bestT = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const dx = b[0]-a[0], dy = b[1]-a[1], L2 = dx*dx+dy*dy || 1;
    let t = ((pdfPt[0]-a[0])*dx + (pdfPt[1]-a[1])*dy) / L2;
    t = Math.max(0, Math.min(1, t));
    const dd = Math.hypot(pdfPt[0]-(a[0]+t*dx), pdfPt[1]-(a[1]+t*dy));
    if (dd < bestD) { bestD = dd; best = i; bestT = t; }
  }
  return { edge: best, dist: bestD, t: bestT };
}

// Double-click an edge -> insert a vertex at the click point.
function insertVertexOnRegion(id, pdfPt, ring = 0) {
  const r = currentRegions().find(x => x.id === id);
  if (!r) return;
  if (isRegionLocked(r)) { setStatus(`${r.id} is locked — press L to unlock before adding vertices.`); return; }
  const rings = regionRings(r.geometry);
  const pts = rings[ring];
  if (!pts) return;
  const { edge, dist, t } = nearestEdgeIndex(pts, pdfPt);
  if (dist * S.zoom >= 12) return;
  const a = pts[edge], b = pts[(edge + 1) % pts.length];
  const np = [a[0] + (b[0]-a[0]) * t, a[1] + (b[1]-a[1]) * t];
  const before = structuredClone(rings);
  const after = rings.map((rg, k) => (k === ring ? [...rg.slice(0, edge + 1), np, ...rg.slice(edge + 1)] : rg.map(p => [...p])));
  history.exec({ label: 'add vertex', do() { applyRings(r, after); touch(S.pmap); rerender(); }, undo() { applyRings(r, before); rerender(); } });
}

// Double-click a vertex -> snap that corner to a right angle (90°).
function makeRightAngle(id, ring, idx) {
  const r = currentRegions().find(x => x.id === id);
  if (!r) return;
  if (isRegionLocked(r)) { setStatus(`${r.id} is locked — press L to unlock before reshaping.`); return; }
  const rings = regionRings(r.geometry);
  const pts = rings[ring];
  if (!pts) return;
  const n = pts.length;
  if (n < 3) return;
  const v = pts[idx], prev = pts[(idx - 1 + n) % n], next = pts[(idx + 1) % n];
  const cands = [[prev[0], next[1]], [next[0], prev[1]]];
  const dist2 = (c) => Math.hypot(v[0] - c[0], v[1] - c[1]);
  const np = dist2(cands[0]) <= dist2(cands[1]) ? cands[0] : cands[1];
  const before = structuredClone(rings);
  const afterPts = pts.map((p, i) => (i === idx ? [np[0], np[1]] : [...p]));
  if (!polygonIsValid(afterPts)) { setStatus('Right angle rejected.'); rerender(); return; }
  const after = rings.map((rg, k) => (k === ring ? afterPts : rg));
  history.exec({ label: 'right angle', do() { applyRings(r, after); touch(S.pmap); rerender(); }, undo() { applyRings(r, before); rerender(); } });
}

function deleteVertex(id, ring, idx) {
  const pg = getPage(S.pmap, S.page);
  const r = pg.regions.find(x => x.id === id);
  if (!r) return;
  if (isRegionLocked(r)) { setStatus(`${r.id} is locked — press L to unlock before deleting vertices.`); return; }
  const rings = regionRings(r.geometry);
  const pts = rings[ring];
  if (!pts) return;
  if (pts.length <= 3) { setStatus('A polygon needs ≥3 vertices.'); return; }
  const before = structuredClone(rings);
  const after = rings.map((rg, k) => (k === ring ? rg.filter((_, i) => i !== idx) : rg));
  history.exec({ label: 'delete vertex', do() { applyRings(r, after); touch(S.pmap); rerender(); }, undo() { applyRings(r, before); rerender(); } });
}

// ---- merge / split ----
function mergeSelected() {
  if (!inRegion()) { setStatus('Merging regions is geometry work — switch to Region mode (Tab).'); return; }
  const sel = selectedRegions();
  if (sel.length < 2) return;
  const locked = sel.filter(isRegionLocked);
  if (locked.length) {
    setStatus(`Cannot merge: ${locked.map(r => r.id).join(', ')} locked — press L to unlock first.`);
    return;
  }
  const pg = getPage(S.pmap, S.page);
  // Union of every selected region, whether or not they overlap: the result is one
  // ring (they touch) or several (a multi-part region). unionRings() reports every
  // part, so nothing is ever silently dropped.
  let rings;
  try { rings = unionRings(sel.flatMap(r => regionRings(r.geometry))).filter(r => r.length >= 3); }
  catch (err) { setStatus('Merge failed: ' + err.message); return; }
  if (!rings.length) { setStatus('Merge failed: empty result.'); return; }
  // The regions' contents are NOT merged: each item keeps its absolute position, just
  // re-based onto the merged region's bbox origin, and now belongs to the merged region.
  const [X0, Y0] = ringsBBox(rings);
  const items = [];
  for (const r of sel) {
    const [rx0, ry0] = bboxOf(regionPoints(r.geometry));
    for (const it of (r.content?.items || [])) {
      const b = Array.isArray(it.box) ? it.box : [0, 0, 1, 1];
      items.push({ ...structuredClone(it), box: [b[0] + rx0 - X0, b[1] + ry0 - Y0, b[2], b[3]] });
    }
  }
  const ids = new Set(sel.map(r => r.id));
  const removed = sel.map(r => ({ r: structuredClone(r), idx: pg.regions.findIndex(x => x.id === r.id) }));
  const nr = createRegion(S.page, rings.length === 1 ? rings[0] : rings, rings.length === 1 ? 'polygon' : 'multipolygon');
  nr.content = { background: sel[0].content?.background || DEFAULT_BACKGROUND, items };
  history.exec({
    label: 'merge regions',
    do() { pg.regions = pg.regions.filter(r => !ids.has(r.id)); for (const id of ids) S.awaitingOcr.delete(id); pg.regions.push(nr); S.selected.clear(); S.selected.add(nr.id); touch(S.pmap); rerender(); },
    undo() { pg.regions = pg.regions.filter(r => r.id !== nr.id); for (const { r, idx } of removed) pg.regions.splice(Math.min(idx, pg.regions.length), 0, structuredClone(r)); S.selected.clear(); sel.forEach(r => S.selected.add(r.id)); rerender(); },
  });
  setStatus(`Merged ${sel.length} regions into ${nr.id}${rings.length > 1 ? ` (${rings.length} parts)` : ''}.`);
}

function finishSplit() {
  if (S.splitPts.length < 2) { setStatus('Split: click 2+ points for the dividing line, then Enter.'); return; }
  const sel = selectedRegions();
  if (sel.length !== 1) { setStatus('Split: select exactly one region first.'); S.splitPts = []; S.tool = 'select'; rerender(); return; }
  const r = sel[0];
  if (isRegionLocked(r)) { setStatus(`${r.id} is locked — press L to unlock before splitting.`); S.splitPts = []; S.tool = 'select'; rerender(); return; }
  if (regionRings(r.geometry).length > 1) { setStatus('Split needs a single-part region (this one was merged from separate areas).'); S.splitPts = []; S.tool = 'select'; rerender(); return; }
  const A = S.splitPts[0], B = S.splitPts[S.splitPts.length - 1];
  S.splitPts = [];
  let parts;
  try { parts = splitPolygonByLine(regionRings(r.geometry)[0], A, B); } catch (e) { parts = null; }
  if (!parts) { setStatus('Split failed — line must cross the polygon.'); S.tool = 'select'; rerender(); return; }
  const pg = getPage(S.pmap, S.page);
  const orig = structuredClone(r);
  const idx = pg.regions.findIndex(x => x.id === r.id);
  const a = createRegion(S.page, parts[0]); a.content = structuredClone(r.content);
  const b = createRegion(S.page, parts[1]); b.content = structuredClone(r.content);
  history.exec({
    label: 'split region',
    do() { pg.regions.splice(idx, 1, a, b); S.awaitingOcr.delete(r.id); S.selected.clear(); S.selected.add(a.id); S.selected.add(b.id); touch(S.pmap); rerender(); },
    undo() { pg.regions = pg.regions.filter(x => x.id !== a.id && x.id !== b.id); pg.regions.splice(Math.min(idx, pg.regions.length), 0, orig); S.selected.clear(); S.selected.add(orig.id); rerender(); },
  });
  S.tool = 'select';
}

// ---- image content ----
async function cropImageForSelected() {
  const r = currentRegion();
  if (!r) { setStatus('Select exactly one region.'); return; }
  const [x0, y0, x1, y1] = regionBBox(r.geometry);
  const cur = r.content?.items?.[S.itemIndex];
  let bbox = [x0, y0, x1, y1];
  if (cur && cur.type === 'image') {
    const b = cur.box || [0, 0, x1 - x0, y1 - y0];
    bbox = [x0 + b[0], y0 + b[1], x0 + b[0] + b[2], y0 + b[1] + b[3]];
  }
  try {
    const url = await viewer.cropDataUrl(S.page, bbox);
    if (cur && cur.type === 'image') {
      editItem(i => { i.source = url; }, 'set image crop');
    } else {
      const [w, h] = regionSize(r);
      mutateContent('add image crop', (c) => { c.items.push(createImageItem({ source: url, box: [0, 0, w, h] })); S.itemIndex = c.items.length - 1; S.itemSelected = true; clearItemSelection(); });
    }
    setStatus('Cropped page area into an image item.');
  } catch (e) { setStatus('Crop failed: ' + e.message); }
}

// ---- save / export ----
// A project is two files on disk, so they can be saved together or separately:
//   'both'    Ctrl/Cmd+S — the whole project
//   'map'     the shared structure only
//   'content' the active content variant only
async function saveProjectPart(what = 'both') {
  if (!S.pmap || !S.project) return;
  try {
    const { map, content, changed, mapText, contentText } = await projectTexts();
    const names = [];
    if (what !== 'content') {
      downloadText(map.meta.name, mapText);
      S.project.map = { ...S.project.map, modified: map.meta.modified };
      S.project.saved.map = canonical(map);
      names.push(map.meta.name);
    }
    if (what !== 'map') {
      downloadText(content.meta.name, contentText);
      S.project.content = { ...S.project.content, modified: content.meta.modified };
      S.project.saved.content = canonical(content);
      names.push(content.meta.name);
    }
    if (what !== 'content') S.dirtySides.map = false;
    if (what !== 'map') S.dirtySides.content = false;
    // Only say which half had changed when the save covered both: a single-file save is
    // asked for explicitly, so which one changed is not interesting then.
    const only = what === 'both' && changed.map !== changed.content ? ` (only the ${changed.map ? 'shared map' : 'content variant'} had changed)` : '';
    setStatus(`Exported ${names.join(' + ')}.${only}`);
    refreshMapInfo();
  } catch (e) { setStatus('Export failed: ' + e.message); }
}

// Export one lens's content variant straight from its IndexedDB slot as a file, regardless
// of which lens is active. This is an export of what is persisted for that lens.
async function exportContentSlot(slot) {
  if (!S.pmap || !S.project) return;
  try {
    const saved = await loadSessionContent(slot);
    if (!saved?.json) { setStatus(`No ${slot} content variant saved yet — switch to the ${slot} workflow to create one.`); return; }
    downloadText(saved.name || `${defaultContentName(S.project.map.name, slot)}.content.json`, saved.json);
    setStatus(`Exported ${saved.name || 'content'} (${slot} content variant).`);
  } catch (e) { setStatus('Export failed: ' + e.message); }
}

async function doExport() {
  if (!S.pmap) return;
  setStatus('Exporting…');
  try {
    const bytes = await exportReconstruction({ pmap: S.pmap, viewer, onProgress: (n, t) => setStatus(`Exporting ${n}/${t}…`) });
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (S.pdfName || 'document.pdf').replace(/\.pdf$/i, '') + '.recon.pdf';
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    setStatus('Exported reconstructed PDF (source untouched).');
  } catch (e) { setStatus('Export failed: ' + e.message); }
}

// Digitalization (spec §22.1): a source copy plus an invisible, selectable layer built
// from the PDF-language variant. If that variant is not in the session yet, run the same
// §22 language/harvest flow as Extract content on all pages first; the export itself
// never changes the source PDF or the active variant.
// What the export's pre-flight states when the source-text variant is not loaded: how
// much the harvest will read before the file is built (spec 1.6 §10.3). Figures are not
// text candidates, so they are counted but never extracted.
function sourceExtractionPreflight() {
  let regions = 0, figures = 0;
  const pages = new Set();
  for (const pg of S.pmap?.pages || []) {
    let textRegions = 0;
    for (const r of pg.regions || []) {
      if (isDetectedImage(r)) figures += 1;
      else { regions += 1; textRegions += 1; }
    }
    if (textRegions) pages.add(pg.page);
  }
  return { regions, figures, pages: pages.size };
}

async function doExportDigital() {
  if (!S.pdfBytes || !S.pmap || !S.project) { setStatus('Open a PDF first.'); return; }
  let source = S.pdfLanguage ? sourceVariantFor(S.pdfLanguage) : null;
  if (!source) {
    const n = sourceExtractionPreflight();
    const count = n.regions
      ? `${n.regions} region${n.regions === 1 ? '' : 's'} on ${n.pages} page${n.pages === 1 ? '' : 's'}`
      : 'the mapped text regions';
    const res = await chooseDialog({
      title: 'Export digitalized PDF',
      text: `Selectable text isn’t loaded for this PDF. Export first extracts the PDF’s own text into ${count} (using OCR where needed), then adds the invisible selectable layer.${n.figures ? ` ${n.figures} figure${n.figures === 1 ? ' stays' : 's stay'} uncovered.` : ''} Continue?`,
      choices: [{ choice: 'export', label: 'Extract and export', primary: true }],
    });
    if (!res) { setStatus('Export cancelled — nothing was written.'); return; }
    try { await extractAllPagesContent(); }
    catch (e) { setStatus('Export failed: ' + e.message); return; }
    if (!S.pdfLanguage) { setStatus('Export cancelled — no extraction ran.'); return; }
    source = sourceVariantFor(S.pdfLanguage);
    if (!source) {
      setStatus('Export cancelled — Selectable text is not loaded.');
      return;
    }
  }
  let content;
  try {
    if (source.active) ({ content } = await projectTexts());
    else content = source.content;
  } catch (e) {
    setStatus('Export failed: ' + e.message);
    return;
  }
  const name = digitalizedPdfName(S.pdfName);
  setStatus('Exporting digitalized PDF…');
  try {
    const result = await exportDigitalizedPdf({
      pdfBytes: S.pdfBytes, pmap: S.pmap, content, awaitingOcr: S.awaitingOcr,
      onProgress: (n, t) => setStatus(`Exporting digitalized PDF ${n}/${t}…`),
    });
    downloadBlob(new Blob([result.bytes], { type: 'application/pdf' }), name);
    const notes = [];
    if (result.unsupported) notes.push(`${result.unsupported} text run(s) could not be embedded`);
    if (result.fontWarning) notes.push(result.fontWarning);
    const summary = digitalizationSummary(result.stats).replace('awaiting OCR', lensCopy().missing);
    setStatus(`Exported ${name} — ${summary}${notes.length ? `; ${notes.join('; ')}` : ''}; source untouched.`);
  } catch (e) {
    setStatus('Export failed: ' + e.message);
  }
}

function setStatus(t) { els.status.textContent = t; }

// Download progress for long provider work (chrome-ai's one-time model download).
function setProgress(fraction, label) {
  const f = Math.max(0, Math.min(1, Number(fraction) || 0));
  els.statusProgress.hidden = false;
  els.dlProgress.value = f;
  els.dlProgressLabel.textContent = label ? `${label} — ${Math.round(f * 100)}%` : `${Math.round(f * 100)}%`;
}
// The OpenCV.js loader reports bytes when the CDN supplies a length, but the module
// import and WASM initialization have no meaningful fraction: show an indeterminate bar.
function setIndeterminateProgress(label) {
  els.statusProgress.hidden = false;
  els.dlProgress.removeAttribute('value');
  els.dlProgressLabel.textContent = label;
}
function clearProgress() {
  els.statusProgress.hidden = true;
  els.dlProgress.value = 0;
  els.dlProgressLabel.textContent = '';
}

// ================= copy / context menu / translation =================

function loadSettings() {
  let s = { provider: DEFAULT_PROVIDER, endpoint: '', endpoints: {}, apiKey: '', targetLang: 'de', selectableLang: '', sourceLang: 'auto', textPadding: DEFAULT_TEXT_PADDING, detectOverlap: DEFAULT_DETECT_OVERLAP, extractAfterDetect: false, detectTier: 'auto', cvEngine: 'classical', ocrEngine: 'tesseract', defaultLens: 'translate' };
  try { Object.assign(s, JSON.parse(localStorage.getItem('pmap.settings') || '{}')); } catch {}
  if (!s.endpoints || typeof s.endpoints !== 'object') s.endpoints = {};
  // A missing (older build) or nonsense padding falls back to the default; the value
  // is kept in the same 0…72 pt range the dialog's number input allows.
  s.textPadding = clampPadding(s.textPadding);
  s.detectOverlap = clampDetectOverlap(s.detectOverlap);
  s.detectTier = clampDetectTier(s.detectTier);
  s.cvEngine = clampCvEngine(s.cvEngine);
  s.ocrEngine = clampOcrEngine(s.ocrEngine);
  // The general tab's own value: an unknown workflow name falls back to Translate, the
  // same default a fresh install starts with. (loadSettings() runs before LENS_COPY is
  // initialized, so the check is the literal list, not the shared table.)
  if (s.defaultLens !== 'translate' && s.defaultLens !== 'improve') s.defaultLens = 'translate';
  // Earlier builds kept a single URL (used by the custom-URL provider). Move it to
  // the per-provider map so it survives switching servers.
  if (String(s.endpoint || '').trim()) s.endpoints.libretranslate = s.endpoint;
  if (s.provider === 'libretranslate' && !String(s.endpoint || '').trim()) s.endpoint = DEFAULT_INSTANCE_URL;
  // A saved provider whose server was retired (public instances come and go) would
  // leave the Preferences… dropdown blank and the app unable to translate: reset it.
  if (!translationProviders[s.provider]) s.provider = DEFAULT_PROVIDER;
  return s;
}
function saveSettings() { try { localStorage.setItem('pmap.settings', JSON.stringify(settings)); } catch {} }

// The URL the Preferences… field shows for a provider: the value the user set, else the
// instance's built-in default. Stored per provider id so editing one server's URL
// never changes another's.
function setEndpointFor(id, url) {
  if (!settings.endpoints) settings.endpoints = {};
  const v = String(url || '').trim();
  if (v) settings.endpoints[id] = v; else delete settings.endpoints[id];
  if (id === 'libretranslate') settings.endpoint = v;  // legacy mirror
}

// Source language for translation: the toolbar's choice, else the saved one.
function sourceLangValue() { return els.fSourceLang?.value || settings.sourceLang || 'auto'; }

function firstSelected() { return selectedRegions()[0] || null; }

// --- item 17: copy region as image / text ---
async function copySelectedAsImage() {
  const r = firstSelected();
  if (!r || !viewer.doc) { setStatus('Select a region first.'); return; }
  try {
    const blob = await viewer.cropPolygonBlob(S.page, regionRings(r.geometry), 2);
    if (!window.ClipboardItem || !navigator.clipboard?.write) {
      downloadBlob(blob, `${r.id}.png`); setStatus('Clipboard unsupported — downloaded PNG instead.'); return;
    }
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    setStatus(`Copied region ${r.id} as image (PNG).`);
  } catch (e) { setStatus('Copy image failed: ' + e.message); }
}

async function copySelectedText() {
  const r = firstSelected();
  if (!r) { setStatus('Select a region first.'); return; }
  const txt = contentText(r.content);
  if (!txt) { setStatus('No text content.'); return; }
  try { await navigator.clipboard.writeText(txt); setStatus(`Copied text of ${r.id} to clipboard.`); }
  catch (e) { setStatus('Copy text failed: ' + e.message); }
}

function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

// --- context menus (region / vertex / content item) ---
const ctxMenu = $('ctx-menu');
function hideCtxMenu() { ctxMenu.hidden = true; ctxMenu.innerHTML = ''; }
window.addEventListener('pointerdown', (e) => { if (!ctxMenu.contains(e.target)) hideCtxMenu(); }, true);

function buildCtxMenu(e, items) {
  ctxMenu.innerHTML = '';
  for (const it of items) {
    if (it.sep) { ctxMenu.appendChild(Object.assign(document.createElement('div'), { style: 'height:1px;background:#555;margin:4px 0' })); continue; }
    const b = document.createElement('button');
    b.textContent = it.label; b.disabled = it.enabled === false;
    b.onclick = () => { hideCtxMenu(); it.fn(); };
    ctxMenu.appendChild(b);
  }
  ctxMenu.style.left = `${e.clientX}px`; ctxMenu.style.top = `${e.clientY}px`;
  ctxMenu.hidden = false;
}

function showRegionContextMenu(e, id) {
  e.preventDefault();
  if (!S.selected.has(id)) selectSingle(id);
  // Content mode (spec §9a): the region menu is only the two "place an item" entries —
  // copy/translate/merge/split/lock/delete are geometry or whole-region work and belong to
  // Region mode, so an editorial right-click can never split or delete the polygon.
  if (inContent()) {
    buildCtxMenu(e, [
      { label: 'Add text', fn: addTextItem },
      { label: 'Add image', fn: addImageItem },
    ]);
    return;
  }
  const r = firstSelected();
  const hasText = !!(r && contentText(r.content));
  // The context menu keeps a multi-selection for merge/split, but Make it Digital is an explicit
  // one-region action: it targets the region that was right-clicked, never the rest of the
  // selection. That is what "for that region only" means in the UI.
  const ocrTarget = regionById(id);
  const targetAwaiting = !!ocrTarget && S.awaitingOcr.has(id) && !isDetectedImage(ocrTarget);
  const anyUnlocked = selectedRegions().some(x => !isRegionLocked(x));
  const targetLang = els.fTargetLang.value || settings.targetLang || 'de';
  buildCtxMenu(e, [
    { label: 'Add text', fn: addTextItem },
    { label: 'Add image', fn: addImageItem },
    { sep: true },
    { label: 'Copy underlying content as image', fn: copySelectedAsImage },
    { label: 'Copy underlying content as text', fn: copySelectedText, enabled: hasText },
    ...(S.lens === 'translate' ? [
      { label: `Translate to “${targetLang}”`, fn: () => translateSelected(), enabled: hasText },
      { label: 'Translate from page text…', fn: () => translateFromPageText() },
    ] : []),
    ...(targetAwaiting ? [{ label: lensCopy().ocrAction, fn: () => ocrRegions([ocrTarget]) }] : []),
    { sep: true },
    { label: anyUnlocked ? 'Lock polygon (L)' : 'Unlock polygon (L)', fn: toggleLockSelected },
    { label: 'Merge selected regions', fn: mergeSelected, enabled: S.selected.size >= 2 },
    { label: 'Split region…', fn: startSplit, enabled: S.selected.size === 1 },
    { sep: true },
    { label: 'Delete region(s)', fn: deleteSelection },
  ]);
}

function showVertexContextMenu(e, id, ring, idx) {
  e.preventDefault();
  if (!inRegion()) return; // vertex handles are a Region-mode thing (spec §9a)
  const r = regionById(id);
  if (!r) return;
  selectSingle(id);
  S.selectedVertex = { id, ring, idx };
  rerender();
  const pts = regionRings(r.geometry)[ring] || [];
  buildCtxMenu(e, [
    { label: 'Make right angle (90°)', fn: () => makeRightAngle(id, ring, idx) },
    { label: 'Delete vertex', fn: () => deleteVertex(id, ring, idx), enabled: pts.length > 3 },
  ]);
}

function showItemContextMenu(e, id, idx) {
  e.preventDefault();
  if (!inContent()) return; // the item menu exists only in Content mode (spec §9a)
  if (!S.selected.has(id)) selectSingle(id);
  S.itemSelected = true; S.itemIndex = idx; clearItemSelection();
  rerender();
  const items = regionById(id)?.content?.items || [];
  const n = items.length;
  const isText = items[idx]?.type === 'text';
  const menu = [];
  if (isText) menu.push({ label: 'Resize to text', fn: () => resizeItemToText(id, idx) }, { sep: true });
  menu.push(
    { label: 'Bring to front', fn: () => { S.itemIndex = idx; moveItemTo('front'); }, enabled: n > 1 && idx < n - 1 },
    { label: 'Send to back', fn: () => { S.itemIndex = idx; moveItemTo('back'); }, enabled: n > 1 && idx > 0 },
    { sep: true },
    { label: 'Delete item', fn: () => { S.itemIndex = idx; deleteItem(); } },
  );
  buildCtxMenu(e, menu);
}

function startSplit() {
  if (!inRegion() || S.selected.size !== 1) return;
  const r = currentRegion();
  if (r && isRegionLocked(r)) { setStatus(`${r.id} is locked — press L to unlock before splitting.`); return; }
  setTool('split');
  setStatus('Split: click 2 points for the dividing line, then Enter (Esc cancels).');
}

// --- item 19: optional translation service ---

// Languages written right-to-left. A translated item's direction follows the
// language we translated *into*, never the source we came from.
const RTL_LANGS = new Set(['ar', 'fa', 'he', 'iw', 'ur', 'yi', 'dv', 'ps', 'sd', 'ug', 'ckb']);
function isRtlLang(code) {
  return RTL_LANGS.has(String(code || '').trim().toLowerCase().split(/[-_]/)[0]);
}
// A named RTL target wins; otherwise trust the returned text (some providers
// translate into a language the picker doesn't list).
function translationDirection(text, targetLang) {
  return isRtlLang(targetLang) || detectDir(text) === 'rtl' ? 'rtl' : 'ltr';
}

// A named status-bar sentence for translations that do not fit their box (spec 1.5 §23).
// The badge in the items list shows *which* items; this tells the user what to do about
// them, and is omitted entirely when everything fits.
function overlengthNote(items) {
  const n = (items || []).filter(overflowsBox).length;
  if (!n) return '';
  return ` — ${n} translated item${n === 1 ? ' does' : 's do'} not fit ${n === 1 ? 'its' : 'their'} box: use Resize to text / R, or tighten the line spacing.`;
}

async function translateSelected() {
  const sel = selectedRegions().filter(r => firstTextItem(r.content));
  if (!sel.length) { setStatus('Select region(s) with a text item.'); return; }
  const targetLang = els.fTargetLang.value || settings.targetLang || 'de';
  const sourceLang = sourceLangValue();
  if (settings.provider === 'none') { setStatus('Set a translation provider in Preferences…, or use the manual copy/paste workflow.'); return; }
  const svc = makeTranslationService(settings, { onProgress: setProgress });
  setStatus(`Translating ${sel.length} region(s) → ${targetLang}…`);
  const results = [];
  try {
    for (const r of sel) {
      const it = firstTextItem(r.content);
      try {
        const srcText = itemText(it);
        const { text } = await svc.translate(srcText, sourceLang, targetLang, { maxWords: countWords(srcText) });
        results.push({ id: r.id, text });
      } catch (e) { results.push({ id: r.id, error: e.message }); }
    }
  } finally { clearProgress(); }
  const ok = results.filter(x => !x.error);
  if (!ok.length) { setStatus('Translation failed: ' + (results[0]?.error || 'unknown')); return; }
  const pg = getPage(S.pmap, S.page);
  const before = [];
  const apply = () => {
    for (const { id, text } of ok) {
      const r = pg.regions.find(x => x.id === id);
      if (!r) continue;
      before.push({ id, content: structuredClone(r.content) });
      const it = firstTextItem(r.content);
      if (it) {
        // Same rule as "Translate from page text": the direction (and the default
        // alignment that goes with it) follows the target language.
        const dir = translationDirection(text, targetLang);
        const align = dir === 'rtl' ? 'right' : 'left';
        it.blocks = blocksFromValue(text, []).map(b => ({ ...b, align, direction: dir }));
        it.style = normalizeStyle({ ...it.style, align, direction: dir });
        // A translated item is machine output: it lands flagged for review (spec §10),
        // exactly like the page-text path. Any later user edit clears the flag.
        it.needsReview = true;
        // Fitted as it lands, like every other machine write.
        autoFitItemToRegion(r, it);
      }
    }
    touch(S.pmap);
  };
  const restore = () => {
    for (const b of before) { const r = pg.regions.find(x => x.id === b.id); if (r) r.content = b.content; }
  };
  history.exec({ label: 'translate regions', do() { before.length = 0; apply(); rerender(); }, undo() { restore(); rerender(); } });
  const affected = ok.map(({ id }) => firstTextItem(pg.regions.find(x => x.id === id)?.content));
  setStatus(`Translated ${ok.length} region(s) → ${targetLang}.` + overlengthNote(affected));
}

// --- Translate from page text (extract the PDF text under a region, translate it) ---
function extractReasonMessage(reason, id, ex = {}) {
  if (reason === 'no-text-layer' || reason === 'no-layer') return 'This page has no extractable text layer (likely a scan). Enable OCR in Preferences… or use “Copy underlying content as image”.';
  if (reason === 'garbage-text' || reason === 'garbage') return ex.viaOcr
    ? `OCR could not read ${id} reliably. Try a higher-resolution scan or use “Copy underlying content as image”.`
    : `The text under ${id} isn’t usable (broken encoding). OCR may recover it in Preferences…, or use “Copy underlying content as image”.`;
  if (reason === 'ocr-unavailable') return `OCR could not read ${id} (the engine may be off, still downloading, or unable to load). Check Preferences… and try again.`;
  return ex.viaOcr
    ? `OCR found no usable text under ${id}. Use “Copy underlying content as image” if the region is a figure.`
    : `No text found under ${id}. Enable OCR in Preferences… or use “Copy underlying content as image”.`;
}

// The toolbar target, or a different one when the active variant is the source. The
// toolbar already is a target picker, so this only asks when it names the source — with
// a language dropdown (never a native prompt), prefilled with the current target.
function askTargetLanguage(sourceLang) {
  const source = String(sourceLang || '').toLowerCase();
  const suggested = String(els.fTargetLang.value || settings.targetLang || 'de').toLowerCase();
  const fallback = suggested !== source ? suggested : (source === 'de' ? 'fr' : 'de');
  return promptSelect({
    title: 'Translate into which language?',
    text: `The active variant already holds the source text (${source}), so pick a different target language for the translation.`,
    options: LANGUAGES.map(([code, name]) => ({ value: code, label: `${name} (${code})` })),
    value: fallback,
    okLabel: 'Translate',
    validate: (code) => {
      const v = String(code || '').trim().toLowerCase();
      if (!/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(v)) return 'Pick a language code like “de” or “pt-BR”.';
      if (v === source) return 'The target language must differ from the source variant’s language.';
      return null;
    },
  }).then((answer) => {
    if (answer === null) { setStatus('Translation cancelled — no target language given.'); return null; }
    return String(answer).trim().toLowerCase();
  });
}

function hintsFromSourceItem(it, sourceLang, text) {
  const style = it?.style || {};
  return {
    size: style.size,
    heading: !!style.bold,
    direction: style.direction === 'rtl' ? 'rtl' : 'ltr',
    lineCount: String(text || '').split('\n').length,
    sourceLang,
  };
}

// Extraction into the source variant, part of a translation run. Active writes are an
// undo step (visible immediately); writes into a remembered variant are not on screen,
// so they go straight into its content-file entry.
function applySourceWrites(writes) {
  const active = writes.filter(w => w.active);
  if (active.length) {
    const before = active.map(w => ({ r: w.r, content: structuredClone(w.r.content) }));
    history.exec({
      label: 'extract content',
      do() { for (const w of active) applyExtraction(w); touch(S.pmap); rerender(); },
      undo() { for (const b of before) b.r.content = structuredClone(b.content); rerender(); },
    });
  }
  for (const w of writes) {
    if (w.active) continue;
    const entry = w.content.regions[w.r.id] || (w.content.regions[w.r.id] = { items: [] });
    applyExtractionToEntry(entry, w.r, w.ex, w.replace);
  }
}

// Switch to a target variant, reusing a remembered one; create an empty one when the
// session has none. This is an app-initiated switch: the outgoing source is cached by
// switchContentVariant(), so it is not a discard and does not stop to ask.
async function switchToTargetVariant(targetLang) {
  const remembered = findRememberedVariant(targetLang);
  if (remembered) return switchContentVariant(remembered, { guard: false });
  const { map } = await projectTexts();
  const next = emptyContentVariant({
    mapId: map.mapId,
    language: targetLang,
    label: languageName(targetLang),
    name: defaultContentName(map.meta.name, targetLang),
  });
  return switchContentVariant(next, { guard: false });
}

// Read the PDF-language variant's text for one region, extracting into it when the entry
// is still empty (spec 1.5 §22). Returns { text, hints } or { error }.
async function translateFromVariant(sel, { pdfLang, source, targetLang, chosenSource }) {
  const activeIsSource = source.active;
  const sourceName = activeIsSource ? S.project.content.name : (source.content.meta?.name || `${pdfLang} variant`);
  const target = activeIsSource && targetLang === pdfLang ? askTargetLanguage(pdfLang) : targetLang;
  if (!target) return { cancelled: true };

  setStatus(`Reading ${sourceName} under ${sel.length} region(s)…`);
  let page = null, viewport = null;
  const openPage = async () => {
    if (!page) {
      page = await viewer.doc.getPage(S.page);
      viewport = page.getViewport({ scale: 1 });
    }
    return { page, viewport };
  };
  const writes = [];
  const readSource = async (r) => {
    const entry = source.active ? r.content : (source.content.regions[r.id] || (source.content.regions[r.id] = { items: [] }));
    const it = (entry.items || []).find(x => x.type === 'text');
    const existing = it ? itemText(it) : '';
    if (existing.trim()) return { text: existing, hints: hintsFromSourceItem(it, pdfLang, existing) };
    let ex;
    try {
      const pg = await openPage();
      ex = await readRegionFromPage(pg.page, pg.viewport, r, { lang: pdfLang });
    } catch (e) { return { error: `Reading text under ${r.id} failed: ${e.message}` }; }
    if (!ex.ok) return { error: extractReasonMessage(ex.reason, r.id, ex) };
    const text = blocksText(ex.blocks);
    if (!text.trim()) return { error: extractReasonMessage('no-text-layer', r.id, ex) };
    writes.push({ active: source.active, content: source.active ? null : source.content, r, ex, replace: !!it });
    return { text, hints: { ...ex.styleHints, sourceLang: pdfLang, lineCount: text.split('\n').length } };
  };

  const svc = makeTranslationService(settings, { onProgress: setProgress });
  const srcLang = chosenSource !== 'auto' ? chosenSource : pdfLang;
  const done = [], failed = [];
  try {
    for (const r of sel) {
      const s = await readSource(r);
      if (s.error) { failed.push({ id: r.id, msg: s.error }); continue; }
      let translation = '';
      try { translation = String((await svc.translate(s.text, srcLang, target, { maxWords: countWords(s.text) }))?.text ?? ''); }
      catch (e) { failed.push({ id: r.id, msg: `Translating ${r.id} failed: ${e.message}` }); continue; }
      if (!translation.trim()) { failed.push({ id: r.id, msg: `The provider returned no text for ${r.id}.` }); continue; }
      done.push({ id: r.id, translation, hints: s.hints });
    }
  } finally { page?.cleanup?.(); clearProgress(); }

  // Keep the extraction even when some regions failed: it is the source of truth for
  // the next translation.
  applySourceWrites(writes);

  if (!done.length) {
    const first = failed[0]?.msg || 'Nothing to translate.';
    const extra = failed.length > 1 ? ` (+${failed.length - 1} more)` : '';
    setStatus(first + extra);
    return { translated: 0, failed: failed.length, errors: failed };
  }

  // If the active variant is the source, the target is elsewhere. Switch only after the
  // source text has been read (and any extraction written), so nothing is lost.
  if (activeIsSource) {
    if (!(await switchToTargetVariant(target))) {
      setStatus('Translation cancelled — the target variant was not opened.');
      return { cancelled: true };
    }
  }

  // Re-resolve the target regions after a possible switch: installProject() replaced
  // S.pmap's objects, so the selection's region objects no longer belong to the model.
  const targetPage = getPage(S.pmap, S.page);
  const run = makeRunChoice();
  const plan = [];
  for (const d of done) {
    const r = targetPage?.regions.find(x => x.id === d.id);
    if (!r) { failed.push({ id: d.id, msg: `Region ${d.id} is missing from the active variant.` }); continue; }
    let replace = false;
    if (firstTextItem(r.content)) {
      const res = await runChoice(run, {
        title: 'Region already has text',
        text: `Region ${r.id} already has a text item. Replace it with the translation, or add the translation as a new item?`,
        choices: [
          { choice: 'replace', label: 'Replace', primary: true },
          { choice: 'add', label: 'Add as a new item' },
        ],
        applyLabel: 'Apply to all remaining regions in this translation',
      });
      if (!res) { setStatus('Translation cancelled — nothing was translated.'); return { cancelled: true }; }
      replace = res.choice === 'replace';
    }
    plan.push({ r, translation: d.translation, ex: { styleHints: d.hints }, targetLang: target, replace });
  }
  if (!plan.length) { setStatus('Translation failed: ' + (failed[0]?.msg || 'nothing to write.')); return { translated: 0, failed: failed.length, errors: failed }; }

  // A variant switch cleared the selection: select the regions the translation landed
  // in, so the canvas and the items panel show the result instead of the source's old
  // rows. (Without a switch the selection is already the one the user made.)
  if (activeIsSource) {
    S.selected = new Set(plan.map(d => d.r.id));
    S.itemIndex = 0; S.itemSelected = false; clearItemSelection();
  }

  // One undo step covers the whole batch, region growth included.
  const before = plan.map(d => ({ r: d.r, content: structuredClone(d.r.content), rings: structuredClone(regionRings(d.r.geometry)) }));
  history.exec({
    label: 'translate from page text',
    do() { for (const d of plan) d.item = applyTranslation(d); touch(S.pmap); rerender(); },
    undo() { for (const b of before) { b.r.content = structuredClone(b.content); applyRings(b.r, b.rings); } rerender(); },
  });

  const lines = done.reduce((a, d) => a + (d.hints.lineCount || 0), 0);
  const into = plan.length === 1 ? plan[0].r.id : `${plan.length} regions (${plan.map(d => d.r.id).join(', ')})`;
  let msg = `Translated ${lines} ${lines === 1 ? 'line' : 'lines'} (${srcLang} → ${target}) into ${into} from ${sourceName}`;
  if (failed.length) msg += ` — ${failed.length} failed: ${failed.map(f => f.id).join(', ')} (${failed[0].msg})`;
  setStatus(msg + overlengthNote(plan.map(d => d.item)));
  return { translated: plan.length, failed: failed.length, errors: failed, lines };
}

// The direct page path: extract and translate straight from the PDF into the active
// variant. Used before the PDF's language is known (no source variant role yet) and as
// a fallback when the PDF-language variant is not loaded in this session.
async function translateFromPageDirect(sel, { targetLang, chosenSource, pdfLang }) {
  const note = pdfLang ? ` (the ${pdfLang} source variant isn’t loaded — read the page directly)` : '';
  setStatus(`Reading page text under ${sel.length} region(s)${note}…`);
  let page;
  try { page = await viewer.doc.getPage(S.page); }
  catch (e) { setStatus(`Could not read the page: ${e.message}`); return { cancelled: true }; }
  const viewport = page.getViewport({ scale: 1 });
  const svc = makeTranslationService(settings, { onProgress: setProgress });
  const done = [], failed = [];
  const run = makeRunChoice();
  let cancelled = false;
  try {
    for (const r of sel) {
      let ex;
      try { ex = await readRegionFromPage(page, viewport, r, { lang: chosenSource }); }
      catch (e) { failed.push({ id: r.id, msg: `Reading text under ${r.id} failed: ${e.message}` }); continue; }
      if (!ex.ok) { failed.push({ id: r.id, msg: extractReasonMessage(ex.reason, r.id, ex) }); continue; }
      const text = blocksText(ex.blocks);
      // The toolbar's source wins; otherwise fall back to what the text layer guessed.
      const srcLang = chosenSource !== 'auto' ? chosenSource : (ex.styleHints.sourceLang || 'auto');
      let translation = '';
      try { translation = String((await svc.translate(text, srcLang, targetLang, { maxWords: countWords(text) }))?.text ?? ''); }
      catch (e) { failed.push({ id: r.id, msg: `Translating ${r.id} failed: ${e.message}` }); continue; }
      if (!translation.trim()) { failed.push({ id: r.id, msg: `The provider returned no text for ${r.id}.` }); continue; }
      const existing = firstTextItem(r.content);
      let replace = false;
      if (existing) {
        const res = await runChoice(run, {
          title: 'Region already has text',
          text: `Region ${r.id} already has a text item. Replace it with the translation, or add the translation as a new item?`,
          choices: [
            { choice: 'replace', label: 'Replace', primary: true },
            { choice: 'add', label: 'Add as a new item' },
          ],
          applyLabel: 'Apply to all remaining regions in this translation',
        });
        if (!res) { cancelled = true; break; }
        replace = res.choice === 'replace';
      }
      done.push({ r, translation, ex, targetLang, replace });
    }
  } finally { page.cleanup?.(); clearProgress(); }

  if (cancelled) { setStatus('Translation cancelled — nothing was written.'); return { cancelled: true }; }

  if (!done.length) {
    const first = failed[0]?.msg || 'Nothing to translate.';
    const extra = failed.length > 1 ? ` (+${failed.length - 1} more)` : '';
    setStatus(first + extra);
    return { translated: 0, failed: failed.length, errors: failed };
  }

  // One undo step covers the whole batch, region growth included.
  const before = done.map(d => ({ r: d.r, content: structuredClone(d.r.content), rings: structuredClone(regionRings(d.r.geometry)) }));
  history.exec({
    label: 'translate from page text',
    do() { for (const d of done) d.item = applyTranslation(d); touch(S.pmap); rerender(); },
    undo() { for (const b of before) { b.r.content = structuredClone(b.content); applyRings(b.r, b.rings); } rerender(); },
  });

  const lines = done.reduce((a, d) => a + (d.ex.styleHints.lineCount || 0), 0);
  const src = chosenSource !== 'auto'
    ? chosenSource
    : (done.find(d => d.ex.styleHints.sourceLang && d.ex.styleHints.sourceLang !== 'auto')?.ex.styleHints.sourceLang || 'auto');
  const into = done.length === 1 ? done[0].r.id : `${done.length} regions (${done.map(d => d.r.id).join(', ')})`;
  let msg = `Translated ${lines} ${lines === 1 ? 'line' : 'lines'} (${src} → ${targetLang}) into ${into}`;
  if (failed.length) msg += ` — ${failed.length} failed: ${failed.map(f => f.id).join(', ')} (${failed[0].msg})`;
  setStatus(msg + overlengthNote(done.map(d => d.item)));
  return { translated: done.length, failed: failed.length, errors: failed, lines };
}

// Pick the source: variant-to-variant once the PDF's language is known and its variant
// is available; the direct page path before that, or when a restored session only has
// the target variant. The same core serves a selection, a page and the document.
async function translateRegions(sel, { scope = 'selection' } = {}) {
  sel = (sel || []).filter(r => r && !isDetectedImage(r));
  if (!sel.length) {
    setStatus(scope === 'document' ? 'There are no text regions to translate in this document.' : 'Select text region(s) first.');
    return { translated: 0, failed: 0 };
  }
  if (!viewer.doc) { setStatus('Load a PDF first.'); return { cancelled: true }; }
  if (!S.pmap || !S.project) { setStatus('Open a PDF first.'); return { cancelled: true }; }
  if (settings.provider === 'none') {
    setStatus('No translation provider configured. Set one in Preferences…, or use “Copy underlying content as text”, translate it, then paste it back.');
    return { cancelled: true };
  }
  const targetLang = String(els.fTargetLang.value || settings.targetLang || 'de').toLowerCase();
  const chosenSource = sourceLangValue();
  let pdfLang = S.pdfLanguage;
  let source = pdfLang ? sourceVariantFor(pdfLang) : null;
  // Translate's happy path keeps extraction invisible (spec 1.6 §4.1): establish the
  // PDF's own language and the source-text variant first, then translateFromVariant()
  // fills any empty source entries from the page. Only a declined language question —
  // before the source variant can exist — falls back to reading the page directly, as
  // §7.2 permits.
  if (!source) {
    pdfLang = await ensurePdfLanguage('Translation');
    // A declined language pick cancels the run: falling back to a direct page read here
    // would translate with an unknown source right after the user said no.
    if (!pdfLang) return { cancelled: true };
    source = sourceVariantFor(pdfLang);
  }
  if (!source) {
    if (!(await ensureExtractionVariant('Translation', { confirmSwitch: false }))) return { cancelled: true };
    pdfLang = S.pdfLanguage;
    source = pdfLang ? sourceVariantFor(pdfLang) : null;
  }
  if (source) return translateFromVariant(sel, { pdfLang, source, targetLang, chosenSource });
  return translateFromPageDirect(sel, { targetLang, chosenSource, pdfLang });
}
async function translateFromPageText() {
  const sel = selectedRegions().filter(r => !isDetectedImage(r));
  if (!sel.length) { setStatus('Select text region(s) first.'); return; }
  return translateRegions(sel, { scope: 'selection' });
}
// Detection is invisible to the Translate workflow: if a page has no regions yet, ask the
// detector for geometry only, then translate. It never extracts into the source variant
// first; the translation path reads/extracts as needed.
async function detectMissingPages(pageNos) {
  const pages = [];
  for (const n of pageNos) {
    await new Promise(r => setTimeout(r, 0));
    try {
      const engine = cvEngine();
      const guard = engine === 'opencv' ? 120000 : 60000;
      const res = normalizeDetection(await whileTicking(
        `Finding text regions on page ${n}…`, () => viewer.detectRegions(n, { tier: detectTier(), engine, onProgress: detectionProgress }),
        guard, `page ${n} timed out after ${guard / 1000} s`).finally(() => clearProgress()));
      pages.push({ page: n, res });
    } catch (e) {
      setStatus(`Detection failed on page ${n}: ${e.message}`);
      return false;
    }
  }
  if (!pages.length) return true;
  setStatus(`Reviewing proposals on ${pages.length} page${pages.length === 1 ? '' : 's'}…`);
  const out = await detectCommand(pages, { extract: false });
  if (out.cancelled) { setStatus('Detection cancelled — nothing was applied.'); return false; }
  return true;
}
async function translatePageText() {
  if (!viewer.doc) { setStatus('Load a PDF first.'); return; }
  if (!S.pmap || !S.project) { setStatus('Open a PDF first.'); return; }
  if (settings.provider === 'none') {
    setStatus('No translation provider configured. Set one in Preferences…, or use “Copy underlying content as text”, translate it, then paste it back.');
    return;
  }
  let regions = currentRegions().filter(r => r && !isDetectedImage(r));
  if (!currentRegions().length) {
    if (!(await detectMissingPages([S.page]))) return;
    regions = currentRegions().filter(r => r && !isDetectedImage(r));
  }
  if (!regions.length) { setStatus(`No text regions to translate on page ${S.page}.`); return; }
  S.selected = new Set(regions.map(r => r.id));
  S.itemIndex = 0; S.itemSelected = false; clearItemSelection();
  return translateRegions(regions, { scope: 'page' });
}
async function translateDocumentText() {
  if (!viewer.doc) { setStatus('Load a PDF first.'); return; }
  if (!S.pmap || !S.project) { setStatus('Open a PDF first.'); return; }
  if (settings.provider === 'none') {
    setStatus('No translation provider configured. Set one in Preferences…, or use “Copy underlying content as text”, translate it, then paste it back.');
    return;
  }
  const startPage = S.page;
  const startSelection = [...S.selected];
  const empty = [];
  for (let p = 1; p <= viewer.pageCount; p++) {
    if (!(getPage(S.pmap, p)?.regions || []).length) empty.push(p);
  }
  if (empty.length && !(await detectMissingPages(empty))) {
    S.page = startPage; S.selected = new Set(startSelection); rerender(); refreshChrome();
    return;
  }
  let pagesTouched = 0, translated = 0, failed = 0;
  let cancelled = false;
  for (let p = 1; p <= viewer.pageCount; p++) {
    const regions = (getPage(S.pmap, p)?.regions || []).filter(r => r && !isDetectedImage(r));
    if (!regions.length) continue;
    S.page = p;
    S.selected = new Set(regions.map(r => r.id));
    const res = await translateRegions(regions, { scope: 'document' });
    if (res?.cancelled) { cancelled = true; break; }
    if (res?.translated) pagesTouched += 1;
    translated += res?.translated || 0;
    failed += res?.failed || 0;
  }
  S.page = Math.min(Math.max(1, startPage), viewer.pageCount);
  S.selected = new Set(startSelection.filter(id => !!regionById(id)));
  S.itemIndex = 0; S.itemSelected = false; clearItemSelection();
  rerender(); refreshChrome();
  if (cancelled) {
    setStatus(`Document translation cancelled — ${translated} region(s) written.`);
    return;
  }
  if (!translated) { setStatus('Nothing was translated.'); return; }
  setStatus(`Translated ${translated} region(s) across ${pagesTouched} page${pagesTouched === 1 ? '' : 's'}${failed ? ` — ${failed} failed` : ''}.`);
  return { translated, failed };
}
// Store a translation as a rich-text item. Every item keeps its own position; a
// replaced item keeps its box. Items start flagged for review.
function applyTranslation({ r, translation, ex, targetLang, replace }) {
  // The item's direction follows the translation (the target language), not the
  // source text's direction — an en → ar job must end up right-to-left.
  const dir = translationDirection(translation, targetLang);
  const align = dir === 'rtl' ? 'right' : 'left';
  const hints = ex.styleHints || {};
  const style = { size: hints.size, bold: !!hints.heading, italic: false, underline: false, font: 'sans', color: '#111111', align, direction: dir };
  const blocks = translation.split('\n').map(line => ({ type: 'paragraph', value: line, runs: [], align, direction: dir }));
  if (replace) {
    const it = firstTextItem(r.content);
    if (it) {
      it.blocks = normalizeBlocks(blocks);
      delete it.value; delete it.runs;
      it.style = normalizeStyle({ ...it.style, ...style });
      it.needsReview = true;
      // The translation is fitted as it lands — no "does not fit its box" round trip.
      autoFitItemToRegion(r, it);
      return it;
    }
  }
  const item = createTextItem({ box: textRect(r), style, blocks });
  item.needsReview = true;
  commitTextPlacement(r, item);
  autoFitItemToRegion(r, item);
  return item;
}

// --- Extract content (spec 1.5 §20) ------------------------------------------------
// The outward, manual path: harvest the PDF's own text into regions, as their own
// review-flagged text items. It writes into the *content variant for the PDF's own
// language* (spec §22) — a normal variant, created/switched to through the same flow
// as File ▸ New content variant… when the active one is some other language.

function languageName(code) {
  const hit = LANGUAGES.find(([c]) => c.toLowerCase() === String(code || '').toLowerCase());
  return hit ? hit[1] : String(code || '');
}

// Fallback guess for the document's language when the PDF itself does not declare one:
// the configured source wins (the user already told us), else the active variant, else
// English. `initialPdfLanguageGuess()` adds the document metadata ahead of all of these.
function pdfLanguageGuess() {
  const src = sourceLangValue();
  if (src && src !== 'auto') return src;
  return S.project?.content?.language || 'en';
}

// What to pre-fill the one-time PDF-language question with (spec 1.6 §7.2): the PDF's
// /Lang or XMP dc:language, then the Translation Service default source language, then
// the active variant, then English.
async function initialPdfLanguageGuess() {
  try {
    const declared = await viewer.documentLanguage();
    if (declared) return declared;
  } catch { /* metadata unreadable: use the settings fallback */ }
  return pdfLanguageGuess();
}

// OCR language: the PDF's own language when known, otherwise the same best guess the
// language prompt uses. `auto` is not an OCR language; English is the safe fallback.
function ocrLanguage(explicit) {
  const code = String(explicit || S.pdfLanguage || pdfLanguageGuess() || 'en').toLowerCase();
  return code === 'auto' ? 'en' : code;
}

// The system may need the PDF's language (spec §22). We ask once per open PDF and
// remember the answer; cancelling aborts the extraction rather than guessing. In Improve
// the language is already visible in the toolbar as a destination dropdown, so the
// extraction reads it from there instead of interrupting at all. In Translate the
// region toolbar's Source dropdown is used the same way: it is prefilled with what the
// PDF declares (or the settings' source), and focused so the pick is one keystroke away —
// no native prompt ever appears.
const LANGUAGE_CODE_RE = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i;
function languageCodeValid(code) {
  return LANGUAGE_CODE_RE.test(String(code || '').trim());
}

// Prefill + focus the region toolbar's Source dropdown and wait for a pick (Esc or a
// click anywhere else cancels). Only callable when the dropdown is actually on screen.
function pickSourceLanguageInline(guess, what) {
  const sel = els.fSourceLang;
  if (!sel || sel.offsetParent === null) return null;
  const options = [...sel.options];
  const pre = String(guess || '').toLowerCase();
  if (pre && options.some(o => o.value.toLowerCase() === pre)) sel.value = pre;
  return new Promise((resolve) => {
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      sel.removeEventListener('change', onChange);
      sel.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown, true);
      resolve(val);
    };
    const onChange = () => finish(sel.value && sel.value !== 'auto' ? sel.value : null);
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(null); } };
    const onDown = (e) => { if (!sel.contains(e.target) && !(sel.closest('label')?.contains(e.target))) finish(null); };
    const label = languageName(sel.value || pre || guess);
    setStatus(`${what} needs this PDF's language — the Source dropdown is prefilled as ${label || '(unknown)'}; pick the language, or press Esc to cancel.`);
    sel.addEventListener('change', onChange);
    sel.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown, true);
    sel.focus();
  });
}

async function ensurePdfLanguage(what = 'Extraction', { preferToolbar = false } = {}) {
  if (S.pdfLanguage) return S.pdfLanguage;
  if (preferToolbar) {
    const code = String(els.fTargetLang?.value || settings.selectableLang || '').trim().toLowerCase();
    if (code && code !== 'auto') {
      S.pdfLanguage = code;
      settings.selectableLang = code;
      saveSettings(); saveDocPrefs();
      return code;
    }
  }
  const guess = await initialPdfLanguageGuess();
  // Translate keeps its Source dropdown in sync with the answer either way, so the
  // pick is stored once and reused by translation, OCR and the export workflows.
  const viaToolbar = pickSourceLanguageInline(guess, what);
  if (viaToolbar) {
    const code = await viaToolbar;
    if (!code) { setStatus(`${what} cancelled — no language given for this PDF.`); return null; }
    if (!languageCodeValid(code)) { setStatus(`${what} cancelled — “${code}” is not a language code like “fr”.`); return null; }
    S.pdfLanguage = code;
    saveDocPrefs();
    return code;
  }
  // The region toolbar is not on screen (no region selected / not an editing mode):
  // the same dropdown is offered in a dialog.
  const options = LANGUAGES.map(([code, name]) => ({ value: code, label: `${name} (${code})` }));
  const pre = String(guess || '').toLowerCase();
  const answer = await promptSelect({
    title: `What language is this PDF written in?`,
    text: `${what} needs the document's own language — it names the source variant and the OCR language. ${pre && pre !== 'auto' && languageCodeValid(pre) ? `It looks like ${languageName(pre)}. ` : ''}The choice is remembered for this PDF.`,
    options,
    value: pre && languageCodeValid(pre) ? pre : 'en',
    okLabel: 'Continue',
    cancelLabel: 'Cancel',
  });
  if (answer === null) { setStatus(`${what} cancelled — no language given for this PDF.`); return null; }
  const code = String(answer).trim().toLowerCase();
  if (!languageCodeValid(code)) { setStatus(`${what} cancelled — “${code}” is not a language code like “fr”.`); return null; }
  S.pdfLanguage = code;
  saveDocPrefs();
  return code;
}

// The style an extraction lands with, whether it goes into the active model or into a
// remembered (non-active) variant. Kept in one place so the two writes cannot drift.
function extractionStyle(ex) {
  const hints = ex.styleHints || {};
  const dir = hints.direction === 'rtl' ? 'rtl' : 'ltr';
  const align = dir === 'rtl' ? 'right' : 'left';
  return { size: hints.size, bold: !!hints.heading, italic: false, underline: false, font: 'sans', color: '#111111', align, direction: dir };
}

// Store one extraction as a review-flagged text item, exactly like a translation:
// same box rule (padded textRect), same replace-or-add choice, base style from the hints.
function applyExtraction({ r, ex, replace }) {
  const style = extractionStyle(ex);
  const blocks = ex.blocks;
  if (replace) {
    const it = firstTextItem(r.content);
    if (it) {
      it.blocks = normalizeBlocks(blocks);
      delete it.value; delete it.runs;
      it.style = normalizeStyle({ ...it.style, ...style });
      it.needsReview = true;
      return;
    }
  }
  const item = createTextItem({ box: textRect(r), style, blocks });
  item.needsReview = true;
  commitTextPlacement(r, item);
  autoFitItemToRegion(r, item);
}

// The same write into a remembered variant's content-file entry (not the active model).
// The region's geometry is shared, so `r` still supplies the padded box. The active
// selection and status are left alone: this variant is not on screen.
function applyExtractionToEntry(entry, r, ex, replace) {
  const style = extractionStyle(ex);
  const blocks = ex.blocks;
  entry.items = Array.isArray(entry.items) ? entry.items : [];
  if (replace) {
    const it = entry.items.find(x => x.type === 'text');
    if (it) {
      it.blocks = normalizeBlocks(blocks);
      delete it.value; delete it.runs;
      it.style = normalizeStyle({ ...it.style, ...style });
      it.needsReview = true;
      autoFitItemToRegion(r, it);
      return;
    }
  }
  const item = createTextItem({ box: textRect(r), style, blocks });
  item.needsReview = true;
  entry.items.push(item);
  autoFitItemToRegion(r, item);
}

// Ask for the PDF's language if we have not yet, and make sure the active content
// variant is the one that language names — creating/switching through the normal
// variant flow otherwise (spec §22). Returns the language code, or null if declined.
async function ensureExtractionVariant(what = 'Extraction', { confirmSwitch = true } = {}) {
  if (!viewer.doc) { setStatus('Load a PDF first.'); return null; }
  if (!S.pmap || !S.project) { setStatus('Open a PDF first.'); return null; }
  const pdfLang = await ensurePdfLanguage(what, { preferToolbar: S.lens === 'improve' });
  if (!pdfLang) return null;
  if (String(S.project.content.language || '').toLowerCase() !== pdfLang) {
    // Re-running extraction updates the same PDF-language variant, even after the user
    // switched to a target: never create a second empty one (§22).
    const remembered = findRememberedVariant(pdfLang);
    const decline = () => {
      setStatus(`${what} cancelled — the active variant is ${S.project.content.language}, not the PDF's ${pdfLang}.`);
      return null;
    };
    if (remembered) {
      // Translate's happy path passes confirmSwitch:false: establish the source variant
      // invisibly, leaving only the ordinary unsaved-changes guard inside the switch.
      if (confirmSwitch && !(await confirmDialog({
        title: `Extract into “${remembered.meta.name}”?`,
        text: `This PDF is written in ${languageName(pdfLang)} (${pdfLang}), and its variant “${remembered.meta.name}” is still loaded from this session — but the active variant is “${S.project.content.name}” (${S.project.content.language}). Switch back to the ${pdfLang} variant and extract there? Your current edits stay in memory and are untouched by the switch.`,
        confirmLabel: `Switch to “${remembered.meta.name}”`,
        cancelLabel: 'Cancel',
      }))) return decline();
      if (!(await switchContentVariant(remembered))) return null;
    } else {
      if (confirmSwitch && !(await confirmDialog({
        title: `Create the ${pdfLang} variant?`,
        text: `This PDF is written in ${languageName(pdfLang)} (${pdfLang}), but the active content variant is “${S.project.content.name}” (${S.project.content.language}). The extracted source text must live in a ${pdfLang} variant — a new, empty one will be created and opened. Your current variant stays in memory and is untouched.`,
        confirmLabel: `Create ${pdfLang} variant`,
        cancelLabel: 'Cancel',
      }))) return decline();
      await createContentVariant(pdfLang, languageName(pdfLang), false);
      if (!S.project || String(S.project.content.language || '').toLowerCase() !== pdfLang) return null;
    }
  }
  return pdfLang;
}

// Read one region through the §18 primitive. A page with a text layer is tried first;
// on a scan, or when the digital read finds no usable text under the polygon, OCR reads
// a white-background crop clipped exactly to the polygon. Every caller (harvest,
// translate, Detect-with-extract) goes through here, so the text layer and OCR cannot
// drift into separate extraction rules.
async function readRegionFromPage(page, viewport, r, { lang, forceOcr = false } = {}) {
  const rings = regionRings(r.geometry);
  let digital = null;
  // The explicit region OCR action means exactly that: do not fall back to a text layer
  // that a stale awaiting-OCR badge may no longer describe. Page harvests keep the
  // digital-first order (spec 1.5 §22.2) and only pay for OCR when it finds nothing.
  if (!forceOcr && await viewer.pageHasTextLayer(page)) {
    try { digital = await extractRegionContent({ kind: 'digital', page, viewport, fonts: await viewer.fontStyleMap(page) }, rings); }
    catch { digital = { ok: false, reason: 'no-text-layer' }; }
    if (digital.ok) return digital;
  }
  if (!ocrEnabled()) return forceOcr ? { ok: false, reason: 'ocr-unavailable' } : (digital || { ok: false, reason: 'ocr-unavailable' });
  let shot;
  try { shot = await viewer.cropRegionForOcr(page.pageNumber, rings); }
  catch { return { ok: false, reason: 'ocr-unavailable' }; }
  const onProgress = (fraction, label) => {
    const text = label ? `OCR — ${label.toLowerCase()}` : 'OCR';
    setStatus(`${text}…`);
    if (Number.isFinite(fraction)) setProgress(fraction, text);
    else setIndeterminateProgress(text);
  };
  try {
    const ex = await extractRegionContent({
      kind: 'scanned', image: shot.image, scale: shot.scale,
      lang: ocrLanguage(lang), onProgress,
    }, rings);
    return ex.ok ? ex : { ...ex, viaOcr: true };
  } finally { clearProgress(); }
}

// Harvest one region: extract, then decide replace-vs-add. Returns `{ ex, replace }`,
// `{ cancelled: true }` when the user aborts the run, or `{ error, reason }`; it never
// throws, so a page run cannot be sunk by one bad region. `reason` is the §18 vocabulary
// so the caller can tell "awaiting OCR" (no usable selectable text) from a plain failure.
async function harvestRegion(page, viewport, r, promptReplace, run, opts = {}) {
  let ex;
  try { ex = await readRegionFromPage(page, viewport, r, opts); }
  catch (e) { return { error: `Reading ${r.id} failed: ${e.message}`, reason: 'no-text-layer' }; }
  if (!ex.ok) return { error: extractReasonMessage(ex.reason, r.id, ex), reason: ex.reason };
  const existing = firstTextItem(r.content);
  let replace = false;
  if (existing && promptReplace) {
    const res = await runChoice(run, {
      title: 'Region already has text',
      text: `Region ${r.id} already has a text item. Replace it with the extracted text, or add the extraction as a new item?`,
      choices: [
        { choice: 'replace', label: 'Replace', primary: true },
        { choice: 'add', label: 'Add as a new item' },
      ],
      applyLabel: 'Apply to all remaining regions in this extraction',
    });
    if (!res) return { cancelled: true };
    replace = res.choice === 'replace';
  }
  return { ex, replace };
}

// Apply a finished harvest as one undo step and report what it did. The awaiting-OCR
// classification is part of the same step (spec §20): it is runtime-only state, so undo
// puts the previous classification back.
function finishExtraction({ done, skipped, failed, awaiting = [], label, action = 'Extracted' }) {
  const beforeAwaiting = new Set(S.awaitingOcr);
  if (done.length || awaiting.length) {
    const before = done.map(d => ({ r: d.r, content: structuredClone(d.r.content), rings: structuredClone(regionRings(d.r.geometry)) }));
    history.exec({
      label,
      do() {
        for (const d of done) applyExtraction(d);
        S.awaitingOcr = new Set(beforeAwaiting);
        for (const id of awaiting) S.awaitingOcr.add(id);
        for (const d of done) S.awaitingOcr.delete(d.r.id);
        touch(S.pmap); rerender();
      },
      undo() {
        for (const b of before) { b.r.content = structuredClone(b.content); applyRings(b.r, b.rings); }
        S.awaitingOcr = new Set(beforeAwaiting);
        rerender();
      },
    });
  }
  const c = lensCopy();
  let msg = done.length
    ? `${action} ${done.length} region(s) into ${S.project.content.name} (${S.project.content.language})`
    : `Nothing extracted into ${c.sourceVariant.toLowerCase()}`;
  if (awaiting.length) msg += ` — ${awaiting.length} ${c.missing}`;
  if (skipped.length) msg += ` — ${skipped.length} skipped (already has content)`;
  if (failed.length) msg += ` — ${failed.length} failed: ${failed[0].msg}`;
  setStatus(msg + '.');
}

// Extract content for the selected region(s): the manual, per-region outward action.
// A region that already has a text item asks replace-vs-add (spec §20 guard).
async function extractSelectedContent() {
  const ids = selectedRegions().map(r => r.id);
  if (!ids.length) { setStatus('Select region(s) first.'); return; }
  if (!(await ensureExtractionVariant(lensCopy().actionLabel))) return;
  // The variant guard can switch to the PDF-language variant; that rebuilds the page's
  // region objects, so re-resolve the ids instead of writing into the old variant's copies.
  const sel = ids.map(regionById).filter(Boolean);
  if (!sel.length) { setStatus('The selected regions are no longer available.'); return; }
  S.selected = new Set(sel.map(r => r.id));
  let page;
  try { page = await viewer.doc.getPage(S.page); }
  catch (e) { setStatus(`Could not read the page: ${e.message}`); return { cancelled: true }; }
  const viewport = page.getViewport({ scale: 1 });
  setStatus(`Reading ${sel.length} region(s) into ${S.project.content.name}…`);
  const done = [], skipped = [], failed = [], awaiting = [];
  const run = makeRunChoice();
  try {
    for (const r of sel) {
      const h = await harvestRegion(page, viewport, r, true, run);
      if (h.cancelled) { setStatus('Extraction cancelled — nothing was written.'); return; }
      if (h.error) { (regionNeedsOcr(r, h.reason) ? awaiting : failed).push({ id: r.id, msg: h.error }); continue; }
      done.push({ r, ex: h.ex, replace: h.replace });
    }
  } finally { page.cleanup?.(); }
  finishExtraction({ done, skipped, failed, awaiting: awaiting.map(a => a.id), label: 'extract content', action: lensCopy().actionPast });
}

// OCR only the supplied regions that are marked awaiting OCR. This is deliberately
// narrower than a page harvest: it never touches another region, never falls back to the
// digital layer, and writes into the PDF-language ("digital") variant through the same
// extraction variant guard and undo step as every other harvest.
async function ocrRegions(regions) {
  const ids = (regions || []).filter(r => r && S.awaitingOcr.has(r.id) && !isDetectedImage(r)).map(r => r.id);
  if (!ids.length) { setStatus(`Select region(s) marked ${lensCopy().missing} first.`); return; }
  if (!ocrEnabled()) { setStatus('OCR is off — enable it in Preferences… ▸ OCR Service.'); return; }
  if (!(await ensureExtractionVariant(lensCopy().actionLabel))) return;
  // The guard may have switched to the PDF-language variant, which rebuilds the region
  // objects; resolve the ids again so OCR writes into the active source variant, not a
  // stale copy from the variant the user right-clicked in.
  const sel = ids.map(regionById).filter(r => r && S.awaitingOcr.has(r.id) && !isDetectedImage(r));
  if (!sel.length) { setStatus(`Those regions are no longer ${lensCopy().missing}.`); return; }
  S.selected = new Set(sel.map(r => r.id));
  let page;
  try { page = await viewer.doc.getPage(S.page); }
  catch (e) { setStatus(`Could not read the page: ${e.message}`); return { cancelled: true }; }
  const viewport = page.getViewport({ scale: 1 });
  setStatus(`Reading ${sel.length} region${sel.length === 1 ? '' : 's'} with OCR into ${S.project.content.name}…`);
  const done = [], failed = [], awaiting = [];
  const run = makeRunChoice();
  try {
    for (const r of sel) {
      const h = await harvestRegion(page, viewport, r, true, run, { forceOcr: true });
      if (h.cancelled) { setStatus(`${lensCopy().actionLabel} cancelled — nothing was written.`); return; }
      if (h.error) { (regionNeedsOcr(r, h.reason) ? awaiting : failed).push({ id: r.id, msg: h.error }); continue; }
      done.push({ r, ex: h.ex, replace: h.replace });
    }
  } finally { page.cleanup?.(); }
  finishExtraction({ done, skipped: [], failed, awaiting: awaiting.map(a => a.id), label: 'ocr region(s)', action: 'OCR wrote' });
}

// Every region on the current page that is still empty (spec §20 guard: never
// overwrite without a per-region choice, and a page run makes no such choice).
async function extractPageContent() {
  if (!currentRegions().length) { setStatus('This page has no regions to extract into.'); return; }
  if (!(await ensureExtractionVariant(lensCopy().actionLabel))) return;
  // Re-read after the guard: it may have switched variants and rebuilt these objects.
  const regions = currentRegions();
  let page;
  try { page = await viewer.doc.getPage(S.page); }
  catch (e) { setStatus(`Could not read the page: ${e.message}`); return { cancelled: true }; }
  const viewport = page.getViewport({ scale: 1 });
  setStatus(`Reading page ${S.page} into ${S.project.content.name}…`);
  const done = [], skipped = [], failed = [], awaiting = [];
  try {
    for (const r of regions) {
      if (regionHasContent(r)) { skipped.push(r.id); continue; }
      // A detected figure has no text to harvest; it is not a failure and not an OCR case.
      if (isDetectedImage(r)) continue;
      const h = await harvestRegion(page, viewport, r, false);
      if (h.error) { (regionNeedsOcr(r, h.reason) ? awaiting : failed).push({ id: r.id, msg: h.error }); continue; }
      done.push({ r, ex: h.ex, replace: false });
    }
  } finally { page.cleanup?.(); }
  finishExtraction({ done, skipped, failed, awaiting: awaiting.map(a => a.id), label: 'extract content on page', action: lensCopy().actionPast });
}

// The document-wide run: a loop over pages with progress in the status bar, empty
// regions only, and one undo step for the whole run (spec §20/§21).
async function extractAllPagesContent() {
  if (!(await ensureExtractionVariant(lensCopy().actionLabel))) return;
  setStatus(`Reading all pages into ${S.project.content.name}…`);
  const done = [], skipped = [], failed = [], awaiting = [];
  for (let p = 1; p <= viewer.pageCount; p++) {
    const regions = S.pmap.pages.find(pg => pg.page === p)?.regions || [];
    if (!regions.some(r => !regionHasContent(r))) { skipped.push(...regions.map(r => r.id)); continue; }
    let page;
    try { page = await viewer.doc.getPage(p); }
    catch (e) { failed.push({ id: `page ${p}`, msg: e.message }); continue; }
    const viewport = page.getViewport({ scale: 1 });
    try {
      for (const r of regions) {
        if (regionHasContent(r)) { skipped.push(r.id); continue; }
        if (isDetectedImage(r)) continue;
        const h = await harvestRegion(page, viewport, r, false);
        if (h.error) { (regionNeedsOcr(r, h.reason) ? awaiting : failed).push({ id: r.id, msg: h.error }); continue; }
        done.push({ r, ex: h.ex, replace: false });
      }
    } finally { page.cleanup?.(); }
  }
  finishExtraction({ done, skipped, failed, awaiting: awaiting.map(a => a.id), label: 'extract content on all pages', action: lensCopy().actionPast });
}

// Improve's page/document entry points. A page that has never been detected gets geometry
// first (the same detector, the same proposals/review rules); then the normal extraction
// guard writes the PDF's text into the PDF-language/selectable-text variant.
async function makeSelectablePage() {
  if (!viewer.doc) { setStatus('Load a PDF first.'); return; }
  if (!S.pmap || !S.project) { setStatus('Open a PDF first.'); return; }
  if (!(await ensureExtractionVariant('Make this selectable'))) return;
  let regions = currentRegions();
  if (!regions.length) {
    if (!(await detectMissingPages([S.page]))) return;
    regions = currentRegions();
    if (!regions.length) { setStatus(`Detection found no regions to make selectable on page ${S.page}.`); return; }
  }
  return extractPageContent();
}
async function makeSelectableAllPages() {
  if (!viewer.doc) { setStatus('Load a PDF first.'); return; }
  if (!S.pmap || !S.project) { setStatus('Open a PDF first.'); return; }
  if (!(await ensureExtractionVariant('Make this selectable'))) return;
  const empty = [];
  for (let p = 1; p <= viewer.pageCount; p++) {
    if (!(getPage(S.pmap, p)?.regions || []).length) empty.push(p);
  }
  if (empty.length && !(await detectMissingPages(empty))) return;
  return extractAllPagesContent();
}

// Preferences tabs. Kept in the session only. Each intent has a default section —
// Translate opens Translation Service, Improve opens OCR Service — and remembering the
// last tab per intent keeps a detour into Region Detection from changing the other lens.
const activePrefTabByLens = { translate: 'translation', improve: 'ocr' };
function showPrefTab(name) {
  const tabs = [...document.querySelectorAll('[data-pref-tab]')];
  if (!tabs.some(t => t.dataset.prefTab === name)) name = activePrefTabByLens[S.lens] || LENS_COPY[S.lens]?.prefsTab || 'translation';
  activePrefTabByLens[S.lens] = name;
  for (const tab of tabs) {
    const on = tab.dataset.prefTab === name;
    tab.classList.toggle('active', on);
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    const panel = $(`pref-panel-${tab.dataset.prefTab}`);
    if (panel) panel.hidden = !on;
  }
}
function openSettings() {
  fillSettingsFields();
  refreshSettingsRows();
  showPrefTab(activePrefTabByLens[S.lens] || lensCopy().prefsTab);
  $('settings-modal').hidden = false;
}
// Fill the dialog's controls from the settings. Also called once at startup, so a
// close (which reads the controls back) can never write a half-filled form over the
// saved settings — e.g. wiping the API key.
function fillSettingsFields() {
  $('set-provider').value = settings.provider;
  $('set-apikey').value = settings.apiKey || '';
  $('set-target-lang').value = settings.targetLang || 'de';
  $('set-source-lang').value = settings.sourceLang || 'auto';
  $('set-text-padding').value = String(textPadding());
  $('set-detect-overlap').value = String(detectOverlap());
  $('set-detect-tier').value = detectTier();
  $('set-cv-engine').value = cvEngine();
  $('set-ocr-engine').value = ocrEngine();
  $('set-default-lens').value = settings.defaultLens || 'translate';
}
// The URL row is shown for every LibreTranslate server and is always editable: the
// instance's own address is just the default value, so a preset can be repointed at
// any server (the public ones come and go). The API key field likewise applies to
// any LibreTranslate server and is simply left empty when the server doesn't want one.
function refreshSettingsRows() {
  const id = $('set-provider').value;
  const p = translationProviders[id] || {};
  const lt = isLibreTranslateProvider(id);
  const box = $('set-endpoint');
  $('set-endpoint-row').hidden = !lt;
  $('set-apikey-row').hidden = !lt;
  if (lt) {
    box.readOnly = false;
    box.value = endpointForProvider(settings, id);
    box.title = p.url
      ? `${p.label} — the instance's address is filled in as a default; edit it to use another server${p.needsKey ? '. This instance requires an API key (see below)' : ''}.`
      : 'URL of the LibreTranslate server to call (…/translate).';
  }
  $('set-chromeai-row').hidden = id !== 'chrome-ai';
  if (id === 'chrome-ai') refreshChromeAiStatus();
}

// chrome-ai needs no key or URL, but it is Chrome-only and downloads a model per
// language pair on first use — so show the user where they stand before they try.
let chromeAiStatusToken = 0;
async function refreshChromeAiStatus() {
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

function closeSettings() {
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
  settings.defaultLens = LENS_COPY[$('set-default-lens').value] ? $('set-default-lens').value : 'translate';
  saveSettings();
  els.fTargetLang.value = settings.targetLang;
  els.fSourceLang.value = settings.sourceLang;
  $('settings-modal').hidden = true;
  setStatus(`Translation provider: ${translationProviders[settings.provider]?.label || settings.provider}.`);
}

// wire new UI
$('settings-close').onclick = closeSettings;
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
function openHelp() {
  $('help-modal').hidden = false;
  $('help-modal').querySelector('.modal-box').scrollTop = 0;
}
function openAbout() {
  $('about-modal').hidden = false;
}

// ---- find & replace ---------------------------------------------------------------
// The active content variant is the model's whole document, not just the visible page, so
// a search covers every page whose text is currently loaded. Transitional flows (paragraph,
// list item, table cell) are separate search units; a match never crosses one.
function activeFindEntries() {
  return (S.pmap?.pages || []).flatMap(pg => (pg.regions || []).map(r => ({
    id: r.id,
    page: pg.page,
    region: r,
    get: () => r.content,
    set: (c) => { r.content = c; },
  }))).filter(e => (e.get()?.items || []).some(it => it.type === 'text'));
}
function variantFindEntries(content) {
  return Object.keys(content?.regions || {}).map(id => ({
    id,
    page: null,
    region: null,
    get: () => content.regions[id],
    set: (c) => { content.regions[id] = c; },
  })).filter(e => (e.get()?.items || []).some(it => it.type === 'text'));
}
function findReplaceTarget() {
  if (!S.pmap || !S.project) return null;
  if (S.lens === 'improve') {
    const source = digitalSourceState();
    if (source.active) {
      return { entries: activeFindEntries(), label: `Selectable text · ${S.project.content.name} (${S.project.content.language}) · all pages` };
    }
    if (source.content) {
      return { entries: variantFindEntries(source.content), label: `Selectable text · ${source.content.meta?.name || 'source variant'} (${source.content.meta?.language || '?'}) · all pages` };
    }
    // No PDF-language variant has been identified yet. Improve is working in the only
    // loaded variant; searching it is more useful than refusing, and the label says so.
    if (!S.pdfLanguage) {
      return { entries: activeFindEntries(), label: `Current content · ${S.project.content.name} (${S.project.content.language}) · all pages` };
    }
    return null;
  }
  return { entries: activeFindEntries(), label: `Translate content · ${S.project.content.name} (${S.project.content.language}) · all pages` };
}
function findOptions() {
  return { regex: !!els.findRegex?.checked, matchCase: !!els.findCase?.checked };
}
function findStats(target, regex) {
  let matches = 0, items = 0, regions = 0;
  for (const entry of target.entries) {
    const content = entry.get();
    if (!content) continue;
    let entryMatches = 0, entryItems = 0;
    for (const item of content.items || []) {
      if (item.type !== 'text') continue;
      const n = countInTextItem(item, regex);
      if (n) { entryMatches += n; entryItems += 1; }
    }
    if (entryMatches) { matches += entryMatches; items += entryItems; regions += 1; }
  }
  return { matches, items, regions };
}
let findUpdateTimer = null;
function updateFindStatus() {
  if (!els.findStatus) return;
  const target = findReplaceTarget();
  if (els.findScope) els.findScope.textContent = target
    ? `${target.label}.`
    : 'No Selectable text content is loaded yet. Run Improve ▸ Make this selectable first.';
  const set = (text, canReplace = false) => {
    els.findStatus.textContent = text;
    if (els.findReplaceAll) els.findReplaceAll.disabled = !canReplace;
  };
  if (!target) return set('');
  const pattern = els.findText?.value || '';
  if (!pattern) return set('Type text to search the loaded content.');
  const regex = compileFind(pattern, findOptions());
  if (!regex) return set('Invalid regular expression.');
  const s = findStats(target, regex);
  if (!s.matches) return set('No matches.');
  const noun = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  set(`${noun(s.matches, 'match', 'matches')} in ${noun(s.items, 'text item', 'text items')} across ${noun(s.regions, 'region', 'regions')}.`, true);
}
function scheduleFindUpdate() {
  clearTimeout(findUpdateTimer);
  findUpdateTimer = setTimeout(updateFindStatus, 100);
}
function openFindReplace() {
  if (!els.findModal) return;
  els.findModal.hidden = false;
  updateFindStatus();
  els.findText?.focus();
  els.findText?.select();
}
function closeFindReplace() {
  if (!els.findModal) return;
  els.findModal.hidden = true;
  // A hidden input would otherwise keep focus, and the global shortcut guard ignores
  // every key while a field is focused.
  if (els.findModal.contains(document.activeElement)) document.activeElement.blur();
}
function replaceAllFound() {
  const target = findReplaceTarget();
  if (!target || !els.findText?.value) { updateFindStatus(); return; }
  const options = findOptions();
  const regex = compileFind(els.findText.value, options);
  if (!regex) { updateFindStatus(); return; }
  const replacement = els.replaceText?.value || '';
  const changes = [];
  let total = 0, itemCount = 0;
  for (const entry of target.entries) {
    const before = entry.get();
    if (!before) continue;
    const after = structuredClone(before);
    let entryMatches = 0, entryItems = 0;
    for (const item of after.items || []) {
      if (item.type !== 'text') continue;
      const n = replaceInTextItem(item, regex, replacement, { regex: options.regex });
      if (n) {
        // A find/replace is a deliberate user edit: the item no longer needs review.
        delete item.needsReview;
        entryMatches += n;
        entryItems += 1;
      }
    }
    if (entryMatches) {
      changes.push({ entry, before: structuredClone(before), after });
      total += entryMatches;
      itemCount += entryItems;
    }
  }
  if (!total) { setStatus('No matches to replace.'); updateFindStatus(); return; }
  const commit = (side) => {
    for (const c of changes) c.entry.set(structuredClone(c[side]));
    rerender();
  };
  history.exec({
    label: 'find and replace',
    do() { commit('after'); touch(S.pmap); refreshChrome(); },
    undo() { commit('before'); refreshChrome(); },
  });
  const noun = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  setStatus(`Replaced ${noun(total, 'match', 'matches')} in ${noun(itemCount, 'text item', 'text items')} across ${noun(changes.length, 'region', 'regions')}.`);
  updateFindStatus();
}
$('help-close').onclick = () => { $('help-modal').hidden = true; };
$('about-close').onclick = () => { $('about-modal').hidden = true; };
if (els.findText) {
  els.findText.oninput = scheduleFindUpdate;
  els.findText.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); els.replaceText?.focus(); }
  };
}
if (els.replaceText) {
  els.replaceText.oninput = scheduleFindUpdate;
  els.replaceText.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); replaceAllFound(); }
  };
}
els.findRegex.onchange = updateFindStatus;
els.findCase.onchange = updateFindStatus;
els.findReplaceAll.onclick = replaceAllFound;
els.findClose.onclick = closeFindReplace;
els.findModal.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); closeFindReplace(); }
});
els.findModal.addEventListener('pointerdown', (e) => {
  if (e.target === els.findModal) closeFindReplace();
});
els.svg.addEventListener('contextmenu', (e) => {
  if (!isEditMode()) return; // no context menus in the read-only modes
  const t = e.target;
  const handle = t.closest?.('circle.handle');
  // A Ctrl+click is the vertex delete (macOS reports it as a secondary click rather than a
  // left button press): don't also open the vertex menu. A plain right-click still opens it.
  if (handle?.dataset.region != null && e.ctrlKey) { e.preventDefault(); return; }
  if (handle?.dataset.region != null) { showVertexContextMenu(e, handle.dataset.region, +(handle.dataset.ring || 0), +handle.dataset.vertex); return; }
  const box = t.closest?.('rect.item-box');
  if (box?.dataset.region != null && inContent()) { showItemContextMenu(e, box.dataset.region, +box.dataset.index); return; }
  const poly = t.closest?.('polygon.region');
  if (poly?.dataset.id) showRegionContextMenu(e, poly.dataset.id);
});

// ================= menu bar =================
function pageNavItems() {
  if (!viewer.doc) return [{ type: 'header', label: 'Pages' }, { label: 'No PDF loaded', enabled: () => false, run: () => {} }, { type: 'sep' }];
  return [
    { type: 'header', label: `Page ${S.page} / ${viewer.pageCount}` },
    { label: 'Previous page', enabled: () => S.page > 1, run: () => gotoPage(S.page - 1) },
    { label: 'Next page', enabled: () => S.page < viewer.pageCount, run: () => gotoPage(S.page + 1) },
    { label: 'Go to page…', run: gotoPagePrompt },
    { label: 'First page', enabled: () => S.page > 1, run: () => gotoPage(1) },
    { label: 'Last page', enabled: () => S.page < viewer.pageCount, run: () => gotoPage(viewer.pageCount) },
    { type: 'sep' },
  ];
}

function fileMenuItems(lens) {
  const exportItem = lens === 'improve'
    ? { label: 'Export digitalized PDF…', enabled: () => !!S.pdfBytes && !!S.pmap, run: doExportDigital }
    : { label: 'Export reconstructed PDF', enabled: () => !!S.pmap, run: doExport };
  return [
    { label: 'Open PDF…', shortcut: 'Ctrl/Cmd+O', run: () => els.filePdf.click() },
    { label: 'Open map or content…', run: () => els.filePmap.click() },
    { label: 'Close PDF', enabled: () => !!viewer.doc, run: closePdf },
    { type: 'sep' },
    { label: 'Export project', shortcut: 'Ctrl/Cmd+S', enabled: () => !!S.pmap, run: () => saveProjectPart('both') },
    { label: 'Export map', enabled: () => !!S.pmap, run: () => saveProjectPart('map') },
    { label: 'Export translated content', enabled: () => !!S.pmap, run: () => exportContentSlot('translate') },
    { label: 'Export improved content', enabled: () => !!S.pmap, run: () => exportContentSlot('improve') },
    exportItem,
    { type: 'sep' },
    { label: 'New content variant…', enabled: () => !!S.pmap, run: promptNewContentVariant },
    { label: 'Switch content variant…', enabled: () => !!S.pmap && S.variants.some(v => v.content.mapId === S.project?.mapId), run: promptSwitchContentVariant },
    { type: 'sep' },
    { label: 'Preferences…', run: openSettings },
  ];
}
function toolsMenuItems() {
  return [
    { label: 'Undo', shortcut: 'Ctrl/Cmd+Z', enabled: () => history.canUndo, run: () => history.undo() },
    { label: 'Redo', shortcut: 'Ctrl/Cmd+Shift+Z', enabled: () => history.canRedo, run: () => history.redo() },
    { type: 'sep' },
    { label: 'Find & replace…', shortcut: 'Ctrl/Cmd+F', enabled: () => !!S.pmap && !!S.project, run: openFindReplace },
    { label: 'Select all', shortcut: 'Ctrl/Cmd+A', enabled: () => isEditMode() && !!S.pmap, run: selectAll },
    { label: 'Add polygon', shortcut: 'P', checked: () => S.tool === 'polygon', enabled: () => inRegion(), run: armPolygon },
    { label: 'Lock / unlock region', shortcut: 'L', enabled: () => isEditMode() && S.selected.size > 0, run: toggleLockSelected },
    { label: 'Merge selected', enabled: () => inRegion() && S.selected.size >= 2, run: mergeSelected },
    { type: 'sep' },
    { label: 'Resize to text in page', shortcut: 'R', enabled: () => inContent() && pageTextItemCount() > 0, run: resizeAllTextInPage },
    { label: 'Delete region(s)', shortcut: 'Del', enabled: () => inRegion() && S.selected.size > 0, run: deleteSelection },
    { label: 'Split selected region…', enabled: () => inRegion() && S.selected.size === 1, run: startSplit },
    { type: 'sep' },
    { label: 'Detect regions on this page', shortcut: 'D', enabled: () => !!viewer.doc, run: detectRegionsOnPage },
    { label: 'Detect regions on all pages', enabled: () => !!viewer.doc, run: detectRegionsAllPages },
    { label: 'Extract content after detecting', checked: () => detectExtract(), run: toggleDetectExtract },
  ];
}
function translateMenuItems() {
  return [
    { label: 'Translate this page', enabled: () => !!viewer.doc && !!S.pmap, run: translatePageText },
    { label: 'Translate selected region(s)', enabled: () => !!viewer.doc && S.selected.size > 0, run: translateFromPageText },
    { label: 'Translate document', enabled: () => !!viewer.doc && !!S.pmap, run: translateDocumentText },
  ];
}
function improveMenuItems() {
  const c = lensCopy();
  return [
    { label: c.pageAction, enabled: () => !!viewer.doc && !!S.pmap, run: makeSelectablePage },
    { label: c.allAction, enabled: () => !!viewer.doc && !!S.pmap, run: makeSelectableAllPages },
    { label: c.selectedAction, enabled: () => !!viewer.doc && S.selected.size > 0, run: extractSelectedContent },
    { type: 'sep' },
    { label: c.showStatus, shortcut: 'Shift+D', checked: () => S.showDigital, enabled: () => !!viewer.doc, run: toggleDigitalVersion },
    { label: c.selectMissing, shortcut: 'Shift+A', enabled: () => !!viewer.doc && !!S.pmap && isEditMode(), run: selectTextRegionsWithoutContent },
  ];
}
function viewMenuItems() {
  return [
    { label: 'Region mode', shortcut: 'Tab', checked: () => S.mode === 'region', run: () => setMode('region') },
    { label: 'Content mode', checked: () => S.mode === 'content', run: () => setMode('content') },
    { label: 'Preview mode', checked: () => S.mode === 'view', run: () => setMode('view') },
    { label: 'Original mode', checked: () => S.mode === 'text', run: () => setMode('text') },
    { type: 'sep' },
    { label: 'Show overlay', shortcut: '0', checked: () => S.overlayVisible, run: toggleOverlay },
    { type: 'sep' },
    ...pageNavItems(),
    { label: 'Zoom in', run: () => setZoom(S.zoom * 1.2) },
    { label: 'Zoom out', run: () => setZoom(S.zoom / 1.2) },
    { label: 'Fit width', run: fitZoom },
  ];
}
function helpMenuItems() {
  return [
    { label: 'Shortcuts & workflow', run: () => openHelp() },
    { label: 'About PDFBandit', run: () => openAbout() },
  ];
}
function menusForLens(lens) {
  const common = [
    { label: 'File', items: () => fileMenuItems(lens) },
    { label: 'Tools', items: toolsMenuItems },
    { label: 'View', items: viewMenuItems },
    { label: 'Help', items: helpMenuItems },
  ];
  return lens === 'improve'
    ? [
        common[0],
        { label: 'Improve', items: improveMenuItems },
        ...common.slice(1),
      ]
    : [
        common[0],
        { label: 'Translate', items: translateMenuItems },
        ...common.slice(1),
      ];
}
const menubar = createMenubar(els.menubar, () => menusForLens(S.lens));
// Paint the initial lens chrome (active header button, body class, empty review section)
// before a document arrives, so the empty app already says which workflow is active.
applyLensChrome();


async function closePdf() {
  if (!viewer.doc) return;
  let dirty = !!(S.dirtySides?.map || S.dirtySides?.content);
  if (S.pmap && S.project) {
    try {
      const { changed } = await projectTexts();
      dirty = !!(changed.map || changed.content);
    } catch { /* if the check fails, keep the last known dirty state */ }
  }
  if (dirty) {
    // The close question is a real decision, not a roadblock: save the project first,
    // discard, or stop. "Save & close" writes both files exactly as Ctrl/Cmd+S does; a
    // failed save keeps the document open, so nothing is lost silently.
    const what = await appDialog({
      title: 'Export before closing?',
      text: `${S.pdfName || 'This PDF'} has unsaved map or content changes. Closing discards them unless the project is exported first.`,
      buttons: [
        { value: 'save', label: 'Export & close', primary: true },
        { value: 'discard', label: 'Discard changes' },
      ],
      cancelLabel: 'Cancel',
    });
    if (!what || what === 'cancel') { setStatus('Close cancelled — the PDF stays open.'); return; }
    if (what === 'save') {
      await saveProjectPart('both');
      // Compare against the just-saved state again: if the save failed (or anything
      // changed underneath), stay open rather than close with a "saved" status.
      try {
        const { changed } = await projectTexts();
        if (changed.map || changed.content) return;
      } catch { return; }
    }
  }

  const name = S.pdfName || 'PDF';
  const sha = S.sha256;
  docGen++;
  sessionGen++;
  await clearSavedSession();
  clearDocPrefsFor(sha);
  cancelChromeAiDownload();
  if (inlineState) closeInlineEditor();
  try { await viewer.close(); } catch {}

  // Drop every piece of state that belongs to the closed document. The empty app keeps
  // only global preferences; this PDF's lens/language entry is cleared above.
  S.pdfBytes = null; S.pdfName = ''; S.sha256 = ''; S.pdfLanguage = null;
  S.pmap = null; S.project = null; S.variants = [];
  S.dirtySides = { map: false, content: false };
  S.lensVariant = { translate: null, improve: null };
  S.suppressLensVariantRemember = false;
  S.lens = 'translate';
  S.activeSlot = 'translate';
  S.page = 1; S.zoom = 1.2;
  S.selected.clear(); clearItemSelection(); S.awaitingOcr.clear();
  S.itemIndex = 0; S.itemSelected = false; S.selectedVertex = null;
  S.draft = []; S.splitPts = []; S.cursor = null;
  S.marquee = null; S.marqueeBase = null; S.marqueeItems = false;
  S.dragPreview = null; S.bgPreview = false;
  S.tool = 'select'; S.mode = 'region';
  S.overlayVisible = true; overlay.visible = true;
  S.showDigital = true;
  history.clear();

  lastPdfRender = { page: 0, zoom: 0 };
  thumbsForGen = -1;
  els.thumbs.innerHTML = '';
  els.pdfCanvas.hidden = true;
  els.viewCanvas.hidden = true;
  els.textLayer.innerHTML = '';
  els.textLayer.style.width = '';
  els.textLayer.style.height = '';
  overlay.clear();
  els.svg.removeAttribute('width');
  els.svg.removeAttribute('height');
  els.svg.removeAttribute('viewBox');
  stage.setPageSize(0, 0);
  stage.zoom = 1;
  els.zoomLabel.textContent = '100%';
  syncPropsForm();
  applyLensChrome();
  refreshMapInfo();
  setStatus(`Closed ${name}.`);
}

// Closing the PDF is the only session reset the app offers now: it clears the IndexedDB
// session and this PDF's per-document prefs (see clearSavedSession above), so the saved
// "session" never outlives the document it belongs to and no separate menu command is
// needed. Opening another PDF overwrites the session with the new document instead.

// The "Translate from page text" button lives in the *contextual* region toolbar, so the
// button — and therefore its shortcut — only exists while a region is selected and neither an
// item nor the text dialog has taken over (Section 9b). The shortcut is gated on the button
// actually being on screen, not on a re-derivation of those conditions, so Shift+T means
// "translate this region" exactly when a click on the button would, and does nothing otherwise.
function translateButtonVisible() {
  const b = $('btn-translate-page-text');
  return S.lens === 'translate' && !!b && !b.hidden && !!els.regionTools && !els.regionTools.hidden;
}
function makeSelectableButtonVisible() {
  const b = els.btnMakeSelectable;
  return S.lens === 'improve' && !!b && !b.hidden && !!els.regionTools && !els.regionTools.hidden;
}

// global keyboard shortcuts (ignore while typing in a field)
window.addEventListener('keydown', (e) => {
  const ae = document.activeElement;
  const tag = ae?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || ae?.isContentEditable) return;
  // A custom dialog (confirm/prompt replacement) is modal for the page shortcuts too.
  if (document.body.dataset.dialogOpen) return;
  // The text dialog is modal: while it is open it owns the keyboard, so focus sitting on
  // the dialog (not the editor) can't reach the page shortcuts behind it. Esc finishes
  // editing, like Esc in the editor itself.
  if (els.textModal && !els.textModal.hidden) {
    if (e.key === 'Escape') { e.preventDefault(); commitInlineEditor(); }
    return;
  }
  // The find dialog is modal for the page, but its inputs keep their own editing keys.
  if (els.findModal && !els.findModal.hidden) {
    if (e.key === 'Escape') { e.preventDefault(); closeFindReplace(); }
    return;
  }
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'f' && S.pmap && S.project) { e.preventDefault(); openFindReplace(); }
  else if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); els.filePdf.click(); }
  else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); if (S.pmap) saveProjectPart('both'); }
  else if (mod && e.key.toLowerCase() === 'a' && S.pmap && (inRegion() || inContent())) { e.preventDefault(); selectAll(); }
  else if (e.key === 'Tab') { e.preventDefault(); cycleMode(e.shiftKey); }
  else if (e.key === '0') toggleOverlay();
  else if ((e.key === 'p' || e.key === 'P') && inRegion() && !mod && !e.altKey) { e.preventDefault(); armPolygon(); }
  else if (e.shiftKey && !mod && !e.altKey && e.key.toLowerCase() === 't' && (translateButtonVisible() || makeSelectableButtonVisible())) {
    e.preventDefault();
    if (S.lens === 'improve') extractSelectedContent(); else translateFromPageText();
  }
  else if ((e.key === 'i' || e.key === 'I') && !mod && !e.altKey && backgroundButtonVisible()) { e.preventDefault(); openBackgroundPicker(); }
  else if ((e.key === 't' || e.key === 'T') && !e.shiftKey && inContent() && currentRegion()) { e.preventDefault(); addTextItem(); }
  else if ((e.key === 'l' || e.key === 'L') && isEditMode() && !mod && !e.altKey) { e.preventDefault(); toggleLockSelected(); }
  else if (e.shiftKey && !mod && !e.altKey && e.key.toLowerCase() === 'd' && viewer.doc) { e.preventDefault(); toggleDigitalVersion(); }
  else if (e.shiftKey && !mod && !e.altKey && e.key.toLowerCase() === 'a' && S.pmap && isEditMode()) { e.preventDefault(); selectTextRegionsWithoutContent(); }
  else if ((e.key === 'd' || e.key === 'D') && viewer.doc && !mod && !e.altKey && !e.shiftKey) { e.preventDefault(); detectRegionsOnPage(); }
  else if ((e.key === 'r' || e.key === 'R') && isEditMode() && !mod && !e.altKey) { e.preventDefault(); resizeAllTextInPage(); }
});

// Bring back the last session (the PDF and its map) from IndexedDB, if there is one.
restoreSession().catch(() => {});
