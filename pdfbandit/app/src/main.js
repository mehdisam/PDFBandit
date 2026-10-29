import { PdfViewer } from './pdf/viewer.js';
import { StageTransform } from './overlay/canvas.js';
import { Overlay } from './overlay/region_item.js';
import { ToolController, draftValid } from './editor/tools.js';
import { History } from './editor/history.js';
import { ensurePage, getPage, touch as touchMap, syncIdCounter } from './model/document.js';
import { createRegion, regionHasContent, regionIsMasked, isDefaultBackground, contentText, firstTextItem, createTextItem, createImageItem, itemAbsBox, normalizeStyle, itemBlocks, blocksText, itemText, normalizeBlocks, blocksFromValue, newTableBlock, normalizeCell, charStyles, DEFAULT_TABLE_BORDER, DEFAULT_COL_WIDTH, DEFAULT_ROW_HEIGHT, scaleTextItem, isRegionLocked, DEFAULT_LINE_HEIGHT, LINE_HEIGHT_MIN, LINE_HEIGHT_MAX, lineHeightOf, normalizeRegion, DEFAULT_BACKGROUND, DEFAULT_STYLE } from './model/region.js';
import { applyFormatToRuns, FONT_CSS, spanCss } from './model/richtext.js';
import { compileFind, countInTextItem, replaceInTextItem } from './model/findreplace.js';
import { blocksToHtml, htmlToBlocks, flowBase } from './model/blocks.js';
import { clipboardToBlocks } from './import/clipboard.js';
import { bboxOf, polygonIsValid, pointInPolygon, regionRings, regionPoints, regionBBox, ringsBBox, geometryWithRings, rectInsideRings } from './model/geometry.js';
import { detectionFingerprint, isUntouchedAuto, clearDetection, refreshDetectedType, pairProposals, unmatchedAutoIds } from './model/detection.js';
import { sha256Hex } from './storage/hash.js';
import { serializeMap, parseMap, matchSidecars } from './storage/pmap.js';
import { saveSessionPdf, loadSessionPdf, saveSessionProject, loadSessionMap, loadSessionContent, clearSession } from './storage/session.js';
import { parseContent, serializeContent, resolveProject, createMap, emptyContentVariant, matchContentFiles, isMapFileName, isContentFileName, defaultMapName, defaultContentName } from './storage/content-file.js';
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
import { mainMenuItems } from './ui/menu.js';

const $ = (id) => document.getElementById(id);

// Lazy-loaded modules
let JSZipModule = null;
async function getJSZip() {
  if (!JSZipModule) {
    JSZipModule = (await import('jszip')).default;
  }
  return JSZipModule;
}

// App context — replaces all the file-scope S, els, M, and constants
import {
  els, appState, moduleState, viewer, stage, history,
  LANGUAGES,
  DEFAULT_TEXT_PADDING, DEFAULT_DETECT_OVERLAP,
  FIT_MIN_SIZE, FIT_SIZE_STEP, FIT_WIDTH_SAMPLES, CLIP_WARN_TOL,
  MODE_ORDER, EDIT_MODES, isEditMode, inRegion, inContent,
  initEls
} from './app.js';

// Re-export functions from model/region.js and model/detection.js for background.js
export { DEFAULT_BACKGROUND, isRegionLocked } from './model/region.js';
export { clearDetection } from './model/detection.js';
export { getPage } from './model/document.js';
export { history } from './app.js';

// These are defined in main.js - re-export for background.js, menu.js, keyboard.js, find-replace.js
export { detectionSnapshot, restoreDetection, regionById, selectedRegions, regionsUnderPoint, stagePdfPoint };
export { saveProjectNow };
export { armPolygon, closePdf, newRegionFile, exportProjectPart, promptNewContentVariant, openSettings };
export { selectAll, toggleLockSelected, mergeSelected, resizeAllTextInPage, deleteSelection, startSplit };
export { detectRegionsOnPage, detectRegionsAllPages, toggleDetectExtract, detectExtract };
export { extractSelectedContent, translateFromPageText, toggleDigitalVersion, selectTextRegionsWithoutContent };
export { setMode, toggleOverlay, setZoom, fitZoom, openHelp, openAbout, openFindReplace, closeFindReplace, commitInlineEditor, cycleMode, ensureContentFile };
export { contentIsImprove, pageTextItemCount, inRegion, inContent, isEditMode, gotoPage, gotoPagePrompt, currentRegion, currentRegions };
export { addTextItem };
export { langLabel, digitalSourceState, touchMap as touch, refreshChrome };
export { workflowCopy, sourceLangValue, textPadding, detectOverlap, detectTier, cvEngine, ocrEngine, ocrEnabled };
export { defaultFont, defaultSize, defaultLineHeight };
export { clampPadding, clampDetectOverlap, clampDetectTier, clampCvEngine, clampOcrEngine };
export { loadSettings, saveSettings, setEndpointFor };
export { translationProviders };
export { doExport };
export function rerender() { renderCurrent(); }
export function setStatus(t, type = 'info') {
  const toolbarStatus = els.status;
  const bar2Status = els.statusBar2;
  
  function applyType(el) {
    if (!el) return;
    el.textContent = t;
    el.dataset.type = type;
    el.classList.remove('status-error', 'status-warning', 'status-info', 'status-success');
    if (type === 'error') el.classList.add('status-error');
    else if (type === 'warning') el.classList.add('status-warning');
    else if (type === 'success') el.classList.add('status-success');
    else el.classList.add('status-info');
  }
  
  applyType(toolbarStatus);
  applyType(bar2Status);
}

// Background color picker & coloring mode
import { initBackgroundPicker, toggleColoringMode, backgroundButtonVisible, openBackgroundPicker, startEyedropper, cancelEyedropper } from './editor/background.js';

// Keyboard shortcuts
import { initKeyboardShortcuts, initColoringClickHandler } from './ui/keyboard.js';

// Find & replace
import { initFindReplace } from './ui/find-replace.js';

// Settings
import { initSettings, defaultFont, defaultSize, defaultLineHeight } from './settings.js';

// Initialize DOM element references
initEls();

// Initialize keyboard handlers
initKeyboardShortcuts();
initColoringClickHandler();

// Initialize find & replace
initFindReplace();

// Initialize settings
initSettings();

// Load settings from localStorage
const settings = loadSettings();
export { settings };

// The content variant's source/destination language defines the workflow:
//   source === destination → improve (make the PDF selectable/searchable)
//   source !== destination → translate (source language → target language)
// There is no separate lens concept — the content file is the source of truth.
function langLabel(contentVariant) {
  const meta = contentVariant && (contentVariant.sourceLanguage !== undefined ? contentVariant : contentVariant.meta);
  if (!meta) return '?';
  const src = String(meta.sourceLanguage || '').toLowerCase();
  const dst = String(meta.destinationLanguage || '').toLowerCase();
  return src === dst ? src : `${src} → ${dst}`;
}
function contentIsImprove() {
  const content = appState.content;
  return !!content && String(content.sourceLanguage || '').toLowerCase() === String(content.destinationLanguage || '').toLowerCase();
}
function contentIsTranslate() {
  return !contentIsImprove();
}
// User-facing labels derived from the active variant's workflow.
function workflowLabel() {
  return contentIsImprove() ? 'Improve' : 'Translate';
}
function workflowSourceLabel() {
  return contentIsImprove() ? 'Selectable text' : 'Source text';
}
function workflowMissingLabel() {
  return contentIsImprove() ? 'not selectable yet' : 'source text not readable';
}
function workflowFilledLabel() {
  return contentIsImprove() ? 'selectable' : 'has source text';
}
function workflowMissingTag() {
  return contentIsImprove() ? 'not selectable yet' : 'source text not readable';
}
function workflowActionLabel() {
  return contentIsImprove() ? 'Make this selectable' : 'Extract source text';
}
function workflowActionPast() {
  return contentIsImprove() ? 'Made selectable' : 'Extracted';
}
function workflowOcrAction() {
  return 'Read with OCR';
}
function workflowReviewHeading() {
  return contentIsImprove() ? 'Confirm extracted text' : 'Confirm translations';
}
function workflowReviewEmpty() {
  return contentIsImprove() ? 'No extracted text pending review on this page.' : 'No translations pending review on this page.';
}
function workflowSelectMissing() {
  return contentIsImprove() ? 'Select regions not yet selectable' : 'Select regions without source text';
}
function workflowNoMissing() {
  return contentIsImprove() ? 'Every text region on this page is already selectable.' : 'No text regions without source text on this page.';
}
function workflowSelectedMissing(n) {
  return `${n} text region${n === 1 ? '' : 's'} ${contentIsImprove() ? 'not yet selectable' : 'without source text'} selected.`;
}

// Workflow copy derived from the active variant's source/destination languages.
// Mirrors the old LENS_COPY shape so callers can keep using .label, .missing, etc.
function workflowCopy() {
  return contentIsImprove()
    ? {
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
        actionLabel: 'Make this selectable',
        actionPast: 'Made selectable',
        ocrAction: 'Read with OCR',
        prefsTab: 'ocr',
      }
    : {
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
        actionLabel: 'Extract source text',
        actionPast: 'Extracted',
        ocrAction: 'Read with OCR',
        prefsTab: 'translation',
      };
}


// ---- per-document intent (local only) ------------------------------------------------
// The PDF's own language belongs to the document, not to a map or content file. Keeping
// it in localStorage means reopening the same PDF restores the language choice without
// adding a new field to .pmap or .content.json. The workflow (improve vs translate) is
// derived from the active content variant's source/destination languages — there is no
// separate lens setting to persist.
const DOC_PREFS_KEY = 'pmap.docPrefs';
function loadDocPrefs(sha) {
  if (!sha) return {};
  try {
    const all = JSON.parse(localStorage.getItem(DOC_PREFS_KEY) || '{}');
    return all[sha] || {};
  } catch { return {}; }
}
function saveDocPrefs() {
  if (!appState.sha256) return;
  try {
    const all = JSON.parse(localStorage.getItem(DOC_PREFS_KEY) || '{}');
    all[appState.sha256] = { pdfLanguage: appState.pdfLanguage || null };
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
  const p = appState.content;
  if (!p) return null;
  return `${p.mapId}\u0000${p.name || ''}\u0000${p.created || ''}`;
}
function keyForVariant(content) { return content ? variantKey(content) : null; }
function findVariantByKey(key) {
  if (!key) return null;
  return appState.variants.find(v => v.key === key)?.content || null;
}

// ---- the four global modes (spec §9a) -------------------------------------------------
// Two editing modes and two read-only ones, cycled with Tab:
//   region  — geometry: draw/move/reshape/merge/split/lock/delete polygons.
//   content — editorial: place and edit the region's content items.
//   view / text — read-only Preview and native text selection (Original).
// Each mode has one job, one tool set, one cursor vocabulary, so a mode check is what
// almost every gate below asks. `isEditMode` means "the overlay is interactive at all".

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
  // Coloring mode (toggled with C in Region mode): dragging inside a region samples
  // the colour under the pointer and sets the region background on release. Normal
  // region operations are disabled while coloring is on.
  if (appState.coloringMode && !e.altKey && !e.shiftKey) {
    const r = regionById(id);
    if (r && !isRegionLocked(r)) {
      e.stopPropagation();
      startEyedropper(e, r);
      return;
    }
    // Clicking empty space in coloring mode: do nothing (eyedropper only starts from inside a region).
    if (!r) { return; }
    return;
  }
  const p = stagePdfPoint(e);
  if (inRegion() && appState.tool === 'split') { appState.splitPts.push(p); rerender(); return; }
  if (inRegion() && appState.draft.length) { appState.draft.push(p); rerender(); return; } // keep drawing across a region
  const r = regionById(id);
  if (!r) return;
  if (inContent()) {
    lastRegionClick = null;
    appState.selectedVertex = null;
    appState.itemSelected = false; clearItemSelection();
    if (e.shiftKey) toggleSelect(id);
    else if (!appState.selected.has(id)) selectSingle(id);
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
    appState.selectedVertex = null;
    appState.itemSelected = false; clearItemSelection();
    if (e.shiftKey) toggleSelect(id);
    else if (!appState.selected.has(id)) selectSingle(id);
    setStatus(`${r.id} is locked — press L to unlock. Text and image items inside stay editable.`);
    rerender();
    return;
  }
  const edge = Overlay.nearestEdge(r, p, appState.zoom);
  const now = performance.now();
  if (lastRegionClick && lastRegionClick.id === id && now - lastRegionClick.t < 400) {
    lastRegionClick = null;
    if (edge) { insertVertexOnRegion(id, p, edge.ring); return; } // dbl-click edge adds a vertex
  }
  lastRegionClick = { id, t: now };
  appState.selectedVertex = null;
  appState.itemSelected = false; clearItemSelection();
  if (e.shiftKey) toggleSelect(id);
  else if (!appState.selected.has(id)) selectSingle(id);
  if (edge) tools.startEdgeDrag(e, id, edge.ring, edge.edge);
  else tools.startRegionDrag(e, id);
}


const overlay = new Overlay(els.svg, {
  onRegionPointerDown(e, id) { e.stopPropagation(); regionPointerDown(e, id); },
  onVertexPointerDown(e, id, ring, idx) {
    e.stopPropagation();
    // Vertex handles exist only in Region mode (spec §9a) — in Content mode the overlay
    // draws none, so this is just a belt-and-braces guard.
    if (!inRegion() || appState.tool !== 'select' || appState.draft.length) return;
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
    appState.selectedVertex = { id, ring, idx }; // Delete removes this vertex
    tools.startVertexDrag(e, id, ring, idx);
  },
  onItemPointerDown(e, id, index) {
    e.stopPropagation();
    const r = regionById(id);
    if (!r) return;
    const item = r.content?.items?.[index];
    // Option/Alt: the press belongs to the region under the item, not to the item (spec
    // §9b) — the region's own rules then decide (its line, or the region itself).
    if (e.altKey) { regionPointerDown(e, id); return; }
    appState.selectedVertex = null;
    if (!appState.selected.has(id)) { appState.selected.clear(); appState.selected.add(id); }
    const now = performance.now();
    // Double-click detection works in both Region and Content mode.
    // In Region mode, a double-click on a text item switches to Content mode and opens the editor.
    if (lastItemClick && lastItemClick.id === id && lastItemClick.idx === index && now - lastItemClick.t < 400) {
      lastItemClick = null;
      if (item?.type === 'text') {
        if (!inContent()) setMode('content');
        appState.itemSelected = true;
        openInlineEditor(r, index, { box: item.box, style: item.style, blocks: itemBlocks(item) });
        return;
      }
    }
    lastItemClick = { id, idx: index, t: now };
    if (!inContent()) {
      // In Region mode, single click just selects the region (already done above).
      // Don't start item drag or select the item.
      rerender();
      return;
    }
    appState.itemIndex = index;
    appState.itemSelected = true; clearItemSelection();
    tools.startItemDrag(e, id, index);
  },
  onItemHandlePointerDown(e, id, index, corner) {
    e.stopPropagation();
    if (!inContent()) return; // item handles exist only in Content mode (spec §9a)
    // Option/Alt hands the press back to the region under the handle (spec §9b).
    if (e.altKey) { regionPointerDown(e, id); return; }
    appState.selectedVertex = null;
    if (!appState.selected.has(id)) { appState.selected.clear(); appState.selected.add(id); }
    appState.itemIndex = index;
    appState.itemSelected = true; clearItemSelection();
    tools.startItemResize(e, id, index, corner);
  },
});
const tools = new ToolController(els.stageWrap || els.stage, overlay, {
  get tool() { return appState.tool; },
  get mode() { return appState.mode; },
  get editing() { return isEditMode(); },
  get regionMode() { return inRegion(); },
  get contentMode() { return inContent(); },
  get zoom() { return appState.zoom; },
  drafting() { return appState.draft.length >= 3; },
  drawing() { return appState.draft.length > 0; },
  addDraftPoint(p) { appState.selectedVertex = null; appState.itemSelected = false; clearItemSelection(); appState.draft.push(p); rerender(); },
  addSplitPoint(p) { appState.splitPts.push(p); rerender(); },
  selectNone() { if (appState.selected.size || appState.selectedVertex || appState.itemSelected || appState.itemSelection.size) { appState.selected.clear(); appState.selectedVertex = null; appState.itemSelected = false; clearItemSelection(); rerender(); } },
  deselect() { appState.marquee = null; this.selectNone(); },
  // Rubber-band selection. beginMarquee captures the "base" selection (for additive
  // Shift-drags); setMarquee is called on every drag move and updates the selection
  // live, so regions highlight as they are swept over (and un-highlight when the band
  // leaves them). endMarquee just drops the rectangle, keeping the selection.
  // In Content mode (spec §9a) the band works *inside* the region the user is editing: it
  // selects the item it sweeps, so an editorial drag never rebuilds the region selection.
  // With no region selected there is nothing to sweep, so it falls back to picking regions.
  beginMarquee(additive) {
    appState.marqueeAdditive = !!additive;
    if (inContent() && appState.selected.size === 1) {
      appState.marqueeItems = true;
      appState.marqueeBase = new Set(appState.selected);
      appState.itemSelected = false; clearItemSelection();
      appState.marquee = null;
      rerender();
      return;
    }
    appState.marqueeItems = false;
    appState.marqueeBase = additive ? new Set(appState.selected) : new Set();
    if (!additive) { appState.selected.clear(); appState.selectedVertex = null; appState.itemSelected = false; clearItemSelection(); }
    appState.marquee = null;
    rerender();
  },
  setMarquee(rect) {
    if (rect) {
      const r = [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])];
      if (appState.marqueeItems) {
        const reg = currentRegion();
        const items = reg?.content?.items || [];
        // Items paint in array order, so the last box the band touches is the topmost one:
        // the band picks the top box under it, the item the pointer would have clicked.
        let hit = -1;
        items.forEach((it, i) => {
          const [x, y, w, h] = itemAbsBox(regionPoints(reg.geometry), it);
          if (rectsIntersect([x, y, x + w, y + h], r)) hit = i;
        });
        appState.itemSelected = hit >= 0; clearItemSelection();
        if (hit >= 0) appState.itemIndex = hit;
        setStatus(hit >= 0
          ? `Item ${hit + 1} of ${items.length} selected.`
          : items.length ? 'Drag over a box in this region to select it.' : `${reg.id} has no items yet — press T to add text.`);
        appState.marquee = rect; rerender(); return;
      }
      const pg = getPage(appState.pmap, appState.page);
      if (pg) {
        const hits = pg.regions.filter(x => rectsIntersect(regionBBox(x.geometry), r)).map(x => x.id);
        const want = appState.marqueeAdditive ? new Set([...(appState.marqueeBase || []), ...hits]) : new Set(hits);
        for (const id of [...appState.selected]) if (!want.has(id)) appState.selected.delete(id);
        for (const id of want) appState.selected.add(id);
        appState.selectedVertex = null; appState.itemSelected = false; clearItemSelection();
        setStatus(want.size ? `${want.size} region${want.size === 1 ? '' : 's'} selected.` : 'Drag over regions to select them.');
      }
    }
    appState.marquee = rect;
    rerender();
  },
  endMarquee() { appState.marquee = null; appState.marqueeBase = null; rerender(); },
  // A click (press + release with no movement) on empty space — outside every region — clears
  // the whole selection: the selected region(s) *and* the selected content item. It works in
  // both editing modes, so the properties panel goes back to "Nothing selected" from anywhere.
  // Shift-click is the exception: that press means "add to the selection".
  onEmptyClick(additive) {
    if (additive) return;
    if (!(appState.selected.size || appState.selectedVertex || appState.itemSelected || appState.itemSelection.size)) return;
    appState.selected.clear(); appState.selectedVertex = null; appState.itemSelected = false; clearItemSelection();
    appState.marqueeItems = false; appState.marquee = null;
    setStatus('Selection cleared.');
    rerender();
  },
  setCursor(p) { appState.cursor = [p[0], p[1]]; rerender(); },
  previewDrag(d, p) {
    // A click that becomes a drag must not count as the first half of a double-click.
    if (Math.hypot(p[0] - d.start[0], p[1] - d.start[1]) > 2) { lastVertexClick = null; lastRegionClick = null; lastItemClick = null; }
    appState.dragPreview = { ...d, cur: [...p] };
    rerender();
  },
  commitDrag(d, p) { commitDrag(d, p); },
  finishDraw() { finishDraw(); },
  finishSplit() { finishSplit(); },
  cancelDraft() { appState.draft = []; appState.splitPts = []; appState.dragPreview = null; appState.cursor = null; appState.marquee = null; appState.marqueeBase = null; appState.marqueeItems = false; if (appState.tool === 'split' || appState.tool === 'polygon') appState.tool = 'select'; rerender(); },
  deleteSelection() { deleteSelection(); },
  deleteKey() { deleteKey(); },
  undo() { history.undo(); }, redo() { history.redo(); },
});

// pointer event -> PDF-point coords (top-left origin, scale 1)
function stagePdfPointXY(cx, cy) {
  const rect = els.svg.getBoundingClientRect();
  return [(cx - rect.left) / appState.zoom, (cy - rect.top) / appState.zoom];
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
  target.style.cursor = Overlay.regionCursor(region, stagePdfPointXY(cx, cy), appState.zoom) || '';
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

// ---- init static UI ----
// Preferences dialog: the same language lists, but as dropdowns. Both mirror the
// region toolbar and pre-select it when the dialog closes.
$('set-target-lang').innerHTML = LANGUAGES.map(([code, name]) => `<option value="${code}">${name} (${code})</option>`).join('');
$('set-target-lang').value = settings.targetLang || 'de';
$('set-source-lang').innerHTML = `<option value="auto">Auto-detect (let the provider decide)</option>`
  + LANGUAGES.map(([code, name]) => `<option value="${code}">${name} (${code})</option>`).join('');
$('set-source-lang').value = settings.sourceLang || 'auto';
$('set-source-lang').onchange = () => { settings.sourceLang = $('set-source-lang').value || 'auto'; saveSettings(); refreshChromeAiStatus(); };

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

$('btn-zoom-in').onclick = () => setZoom(appState.zoom * 1.2);
$('btn-zoom-out').onclick = () => setZoom(appState.zoom / 1.2);
$('btn-zoom-fit').onclick = fitZoom;
for (const b of document.querySelectorAll('#mode-group button')) b.onclick = () => setMode(b.dataset.mode);
refreshModeIndicator();
$('btn-crop-img').onclick = cropImageForSelected;
$('btn-lock-region').onclick = () => toggleLockSelected();
els.btnColoringMode.onclick = () => toggleColoringMode(); // eyedropper toggle: on = color mode (like C), off = out of color mode
$('btn-add-text').onclick = () => addTextItem();
$('btn-add-image').onclick = () => addImageItem();
$('btn-item-fit-text').onclick = () => { if (selectedItem()) resizeItemToText(currentRegion().id, appState.itemIndex); };
$('btn-item-front').onclick = () => moveItemTo('front');
$('btn-item-back').onclick = () => moveItemTo('back');
$('btn-item-delete').onclick = () => { if (selectedItem()) deleteItem(); };
els.filePdf.onchange = (e) => openFileList([...e.target.files]);
els.filePmap.onchange = (e) => { const fs = [...e.target.files]; e.target.value = ''; if (fs.length) openFileList(fs); };
els.fileContentVariant.onchange = async (e) => { const fs = [...e.target.files]; e.target.value = ''; if (fs.length) { await openContentFile(fs[0]); } };
els.fileItemImage.onchange = async (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) await addImageFromSource(await readFileDataUrl(f)); };

function readFileDataUrl(file) {
  return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => rej(fr.error); fr.readAsDataURL(file); });
}

// Initialize background color picker handlers
initBackgroundPicker();

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
els.fItemFit.onchange = () => editItem(i => { i.fit = els.fItemFit.value; }, 'item fit');
// A box's size (and position) is a page gesture: drag the box or its corner handles. The
// panel deliberately has no width/height fields — the numbers went stale the moment a
// handle moved, and typing them resized the content behind the user's back.

// ---- toolbar rich-text tools: format the editor selection (never the whole box) ----
for (const group of [els.textTools]) {
  if (!group) continue;
  group.addEventListener('pointerdown', () => captureEditorSel());
}
for (const b of [els.ttBold, els.ttItalic, els.ttUnderline, els.ttTable, els.ttUl, els.ttOl, els.ttHead, els.textZoomIn, els.textZoomOut, els.ttTableAddRow, els.ttTableAddCol, els.ttTableDelRow, els.ttTableDelCol]) {
  if (b) b.addEventListener('mousedown', (e) => e.preventDefault());
}
// Toggle Bold/Italic/Underline against the style of the *current* editor content. The model
// is synced from the DOM first so the target state matches what the user sees, then passed
// explicitly (rather than leaving the formatting layer to infer a toggle).
function toggleTextFormat(kind) {
  if (!ensureEditorOpen()) return;
  readEditor();
  applyTextFormat(kind, !editorCurrentStyle()[kind]);
}
els.ttBold.onclick = () => toggleTextFormat('bold');
els.ttItalic.onclick = () => toggleTextFormat('italic');
els.ttUnderline.onclick = () => toggleTextFormat('underline');
if (els.ttColorInput) els.ttColorInput.onchange = () => applyTextFormat('color', els.ttColorInput.value);
els.ttFont.onchange = () => applyTextFormat('font', els.ttFont.value);
if (els.ttSize) {
  els.ttSize.onchange = () => { applyTextFormat('size', els.ttSize.value); };
}
if (els.ttLine) {
  els.ttLine.onchange = () => { applyLineSpacing(els.ttLine.value); };
}
if (els.ttAlignLeft) els.ttAlignLeft.onclick = () => applyAlign('left');
if (els.ttAlignCenter) els.ttAlignCenter.onclick = () => applyAlign('center');
if (els.ttAlignRight) els.ttAlignRight.onclick = () => applyAlign('right');
if (els.ttAlignJustify) els.ttAlignJustify.onclick = () => applyAlign('justify');
// Direction buttons (LTR/RTL)
if (els.ttDirLtr) els.ttDirLtr.onclick = () => { setDirection('ltr'); };
if (els.ttDirRtl) els.ttDirRtl.onclick = () => { setDirection('rtl'); };
// Fullscreen toggle for text editor
if (els.tmFullscreen) {
  els.tmFullscreen.onclick = () => toggleTextEditorFullscreen();
}
// Table buttons
if (els.ttTable) els.ttTable.onclick = () => blockOp('table');
if (els.ttTableAddRow) els.ttTableAddRow.onclick = () => { tableOp('addRow'); };
if (els.ttTableAddCol) els.ttTableAddCol.onclick = () => { tableOp('addCol'); };
if (els.ttTableDelRow) els.ttTableDelRow.onclick = () => { tableOp('delRow'); };
if (els.ttTableDelCol) els.ttTableDelCol.onclick = () => { tableOp('delCol'); };
if (els.ttUl) els.ttUl.onclick = () => blockOp('ul');
if (els.ttOl) els.ttOl.onclick = () => blockOp('ol');
if (els.ttHead) els.ttHead.onclick = () => blockOp('head');
if (els.ttColor) {
  els.ttColor.onclick = () => { els.ttColorInput?.click(); };
}
if (els.ttColorInput) {
  els.ttColorInput.onchange = () => {
    applyTextFormat('color', els.ttColorInput.value);
    // Update the A letter color
    const letter = els.ttColor?.querySelector('.letter');
    if (letter) letter.style.color = els.ttColorInput.value;
  };
}
// Table border tools (in toolbar row 1)
if (els.tblBorder) {
  els.tblBorder.onclick = () => { els.tblBorderColor?.click(); };
}
if (els.tblBorderColor) {
  els.tblBorderColor.onchange = () => {
    if (els.tblBorderSwatch) els.tblBorderSwatch.style.backgroundColor = els.tblBorderColor.value;
    tableOp('border', { color: els.tblBorderColor.value });
  };
}
if (els.tblBorderWidth) {
  els.tblBorderWidth.onchange = () => {
    tableOp('border', { width: Math.max(0, Math.min(12, Number(els.tblBorderWidth.value) || 0)) });
  };
}

// ---- direction setter ----
function setDirection(dir) {
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
    if (b.type === 'paragraph' || b.type === 'heading') b.direction = dir;
    else if (b.type === 'table') {
      const parts = String(pathOf(sEl || eEl || '')).split('.').map(Number);
      const cell = b.rows?.[parts[1]]?.cells?.[parts[2]];
      if (cell) cell.direction = dir;
    }
  }
  renderEditor();
  restoreSelection(save);
  refreshContextTools();
  // Update active button state
  if (els.ttDirLtr) els.ttDirLtr.classList.toggle('active', dir === 'ltr');
  if (els.ttDirRtl) els.ttDirRtl.classList.toggle('active', dir === 'rtl');
}

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
window.addEventListener('pagehide', async () => { cancelChromeAiDownload(); await saveProjectNow(); });

// Closing the browser tab / window (or refreshing): saves are now immediate on every
// change, and pagehide awaits the final save. No beforeunload warning needed.
// The File ▸ Close PDF dialog handles export-dirty changes explicitly.

// ---- the project: a shared map + the active content variant ----
// On disk a project is two v2 files (spec §3–§4): a structure-only `.pmap` and one
// `<stem>.<variant>.content.json` keyed by the map's region ids. The editor holds them
// *resolved* into one object (appState.pmap), so this section is the only place that knows
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
  // Map-only serialization when no content variant is loaded.
  if (!appState.content) {
    const mapMeta = appState.pmap.meta || {};
    const mm = appState.mapMeta || {};
    const map = { ...appState.pmap, meta: { ...mapMeta, name: mm.name || mapMeta.name || defaultMapName(appState.pdfName), label: mm.label || mapMeta.label || 'Shared map', created: mm.created || mapMeta.created || '' } };
    const changed = { map: appState.savedMap ? canonical(map) !== appState.savedMap : true, content: false };
    const now = new Date().toISOString();
    map.meta.modified = changed.map ? now : (appState.mapModified || now);
    return { map, content: null, changed, mapText: serializeMap(map), contentText: '' };
  }
  const c = appState.content;
  const { map, content } = await splitProject(appState.pmap, {
    mapId: c.mapId,
    mapName: appState.pmap.meta?.name || c.name,
    contentName: c.name,
    sourceLanguage: c.sourceLanguage,
    destinationLanguage: c.destinationLanguage,
    label: c.label,
    // A browser save is a download, so image sources stay inline. Externalizing them
    // into assets/ is the CLI's job (tools/pmap-migrate.mjs).
    externalizeDataUris: false,
  });
  // Identity and dates belong to the project, not to the split. installProject() has
  // already given both halves the same name/label/created the baseline was built from, so
  // what is written here is byte-for-byte what "unchanged" is measured against.
  // The map half keeps its own identity: the joined (legacy-shaped) model mixes the
  // content variant's label/created into its meta, which must not leak into the map file
  // or the baseline would not match what was loaded.
  const mm = appState.mapMeta || {};
  map.meta.name = mm.name || defaultMapName(appState.pdfName);
  map.meta.label = mm.label || 'Shared map';
  map.meta.created = mm.created || '';
  content.meta.name = c.name;
  content.meta.sourceLanguage = c.sourceLanguage;
  content.meta.destinationLanguage = c.destinationLanguage;
  if (c.label) content.meta.label = c.label; else delete content.meta.label;
  content.meta.created = c.created;
  content.assets = c.assets;   // references the loaded variant already had
  const canon = { map: canonical(map), content: canonical(content) };
  const changed = { map: canon.map !== c.savedMap, content: canon.content !== c.savedContent };
  const now = new Date().toISOString();
  map.meta.modified = changed.map ? now : (c.mapModified || now);
  content.meta.modified = changed.content ? now : (c.modified || now);
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
  const hit = appState.variants.find(v => v.key === key);
  if (hit) hit.content = c;
  else appState.variants.push({ key, content: c, saved: canonical(c) });
}
// A variant is the source-text variant of a language when it is an *improve* variant of
// that language (source === destination, spec 1.7 §7.2). A translate variant also carries
// the PDF's language as its source, but its entries hold the translation, so it must never
// be read as — or extracted into — the source text.
function isSourceTextVariant(c, pdfLang) {
  if (!c) return false;
  const lang = String(pdfLang || '').toLowerCase();
  if (!lang) return false;
  const src = String(c.sourceLanguage || '').toLowerCase();
  const dst = String(c.destinationLanguage || '').toLowerCase();
  return src === lang && dst === src;
}
// The most recently remembered source-text variant of a language. The active variant always
// wins (spec §22: two variants with the same language are disambiguated by the active one).
function findRememberedSourceVariant(language) {
  const want = String(language || '').toLowerCase();
  if (!want) return null;
  const mapId = appState.content?.mapId;
  for (let i = appState.variants.length - 1; i >= 0; i--) {
    const c = appState.variants[i].content;
    if (mapId && c.mapId !== mapId) continue;
    if (String(c.meta?.sourceLanguage || '').toLowerCase() !== want) continue;
    if (String(c.meta?.destinationLanguage || '').toLowerCase() !== want) continue;
    return c;
  }
  return null;
}
// Where translation reads from: the active variant when it is the PDF's source-text
// variant, else a remembered source-text variant of that language. `content` is null for
// the active one because the live model (appState.pmap) is the authority there.
function sourceVariantFor(pdfLang) {
  if (isSourceTextVariant(appState.content, pdfLang)) return { active: true, content: null };
  const remembered = findRememberedSourceVariant(pdfLang);
  return remembered ? { active: false, content: remembered } : null;
}
function activeVariantIsSource() {
  return isSourceTextVariant(appState.content, appState.pdfLanguage);
}
// The language the source text is in. The active variant owns the language pair, so its
// source language wins over the preferences default; before any variant exists there is
// nothing to read and the preference (Auto by default) applies.
function activeSourceLanguage() {
  const src = String(appState.content?.sourceLanguage || '').toLowerCase();
  return src || sourceLangValue();
}
// The language translation writes into. The active variant owns the language pair: a
// translate variant (source ≠ destination) names its own target, whether it is on screen
// or is the variant Translate returns to. A source-text/improve variant has no target of
// its own, so the user's default target language applies.
function activeTargetLanguage() {
  const fallback = String(els.fTargetLang?.value || settings.targetLang || 'de').toLowerCase();
  const c = appState.content;
  if (!c) return fallback;
  const src = String(c.sourceLanguage || '').toLowerCase();
  const dst = String(c.destinationLanguage || '').toLowerCase();
  return dst && dst !== src ? dst : fallback;
}

// Make a resolved project the current one, remembering exactly what was loaded so
// nothing counts as unsaved until it actually changes.
function installProject(map, content) {
  const resolved = resolveProject(map, content);
  // The awaiting-OCR classification is keyed by region id and describes the PDF under
  // those regions, so it survives a variant switch (same map) but not a different map
  // or document (spec 1.5 §20).
  if (appState.content && appState.content.mapId !== resolved.map.mapId) appState.awaitingOcr = new Set();
  // Fill in the few optional metadata fields a file may omit, on the halves themselves, so
  // the saved baseline below is exactly what projectTexts() would write back.
  const m = resolved.map.meta || (resolved.map.meta = {});
  const c = resolved.content.meta || (resolved.content.meta = {});
  m.name = m.name || defaultMapName(appState.pdfName);
  m.label = m.label || 'Shared map';
  m.created = m.created || '';
  c.name = c.name || defaultContentName(appState.pdfName, c.sourceLanguage, c.destinationLanguage);
  c.sourceLanguage = c.sourceLanguage || 'en';
  c.destinationLanguage = c.destinationLanguage || c.sourceLanguage;
  c.created = c.created || '';
  appState.pmap = resolved.merged;
  appState.mapMeta = { name: m.name, label: m.label, created: m.created };
  // The variant names the PDF's own language (its source). Adopting it here means a
  // variant loaded from a file is honoured exactly like one created in this session:
  // extraction and translation use its language pair instead of asking again or falling
  // back to the preferences default.
  const variantLang = String(c.sourceLanguage || '').toLowerCase();
  if (variantLang && appState.sha256 && variantLang !== String(appState.pdfLanguage || '').toLowerCase()) {
    appState.pdfLanguage = variantLang;
    saveDocPrefs();
  }
  appState.content = {
    mapId: resolved.map.mapId,
    name: c.name, sourceLanguage: c.sourceLanguage, destinationLanguage: c.destinationLanguage,
    label: c.label || '', created: c.created, modified: c.modified || '',
    assets: resolved.content.assets || [],
    savedMap: canonical(resolved.map),
    savedContent: canonical(resolved.content),
    mapModified: m.modified || '',
  };
  rememberVariant(resolved.content);
  appState.savedMap = null;
  appState.dirtySides = { map: false, content: false };
  return resolved;
}

// Make a region map the current piece with no content variant loaded. Map and content are
// separate loadable pieces: opening/creating a .pmap, or detecting regions before any
// variant exists, leaves the app in this map-only state. It is still a real piece of work,
// so projectTexts() keeps a baseline for it and Save writes the map on its own.
function installMapOnly(map) {
  const m = map.meta || (map.meta = {});
  m.name = m.name || defaultMapName(appState.pdfName);
  m.label = m.label || 'Shared map';
  m.created = m.created || '';
  // Normalize regions so content.background is properly structured (same as resolveProject does)
  for (const p of map.pages) for (const r of p.regions) normalizeRegion(r);
  appState.pmap = map;
  appState.content = null;
  // Sync the region-ID counter *before* capturing the saved baseline, so a freshly
  // created map is not immediately flagged as unsaved (syncIdCounter mutates the map's
  // internal counter state after canonical() would otherwise have snapshotted it).
  syncIdCounter(appState.pmap);
  appState.savedMap = canonical(map);
  appState.mapModified = m.modified || '';
  appState.mapMeta = { name: m.name, label: m.label, created: m.created };
  appState.variants = [];
  appState.awaitingOcr = new Set();
  appState.dirtySides = { map: false, content: false };
  history.clear(); appState.selected.clear(); appState.itemIndex = 0; appState.itemSelected = false; clearItemSelection();
}

// An empty region map for the PDF that is already open. Map and content are separate
// pieces: no content variant is created here — it is created or loaded on demand when
// the user first needs one (Translate, Make Selectable, Add Text, Add Image).
function emptyMapForPdf(size) {
  const map = createMap({ filename: appState.pdfName, sha256: appState.sha256, pageCount: viewer.pageCount });
  if (size) ensurePage(map, 1, size.width, size.height);
  installMapOnly(map);
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

function pruneVariantToMap(content, map) {
  const ids = new Set();
  for (const p of map.pages || []) for (const r of p.regions || []) ids.add(r.id);
  for (const id of Object.keys(content.regions || {})) if (!ids.has(id)) delete content.regions[id];
}

// Ask to export or discard the current content variant's unsaved changes before it is
// unloaded (replaced by a new or imported variant). "Export" writes the variant to a file
// on the user's file system. Returns true if it is safe to proceed.
async function confirmContentUnload() {
  if (!appState.content) return true;
  let changed;
  try {
    ({ changed } = await projectTexts());
    if (!changed.content) return true; // nothing dirty
  } catch {
    // projectTexts() can throw if the resolved project can't be split. Fall back to the
    // runtime dirty flags so we never silently proceed over unsaved work.
    if (!(appState.dirtySides?.content)) return true;
  }
  const what = await appDialog({
    title: 'Export or Discard',
    text: `Current content: “${appState.content.name}” has unsaved changes. Export it before switching content?`,
    buttons: [
      { value: 'export', label: 'Export', primary: true },
      { value: 'discard', label: 'Discard' },
    ],
    cancelLabel: 'Cancel',
  });
  const choice = what ? what.value : null;
  if (!choice) return false;
  if (choice === 'export') {
    await exportProjectPart('content');
    try {
      const { changed: again } = await projectTexts();
      if (again.content) return false; // export failed
    } catch { return false; }
  }
  return true;
}

// Replace the active content variant with an empty one. Prompts to export or discard the
// current variant's unsaved changes first.
async function newEmptyContentVariant() {
  if (!(await confirmContentUnload())) return;
  if (!appState.pmap || !appState.content) return;
  const { map } = await projectTexts();
  const next = emptyContentVariant({
    mapId: map.mapId,
    sourceLanguage: appState.pdfLanguage || 'en',
    destinationLanguage: appState.pdfLanguage || 'en',
    label: 'New variant',
  });
  pruneVariantToMap(next, map);
  installProject(map, next);
  history.clear(); appState.selected.clear(); appState.itemIndex = 0; appState.itemSelected = false; clearItemSelection();
  refreshChrome(); renderCurrent(); refreshMapInfo();
  saveProjectNow();
  setStatus(`New empty content variant: ${appState.content.name}.`);
}

// Import a content variant from the user's file system and make it active. Prompts to
// export or discard the current variant's unsaved changes first. Validated via readContentFile
// (must belong to the current map).
async function importContentFile(file) {
  if (!appState.pmap) { setStatus('Load a region map first.'); return; }
  if (!(await confirmContentUnload())) return;
  try {
    const { map, content: outgoing } = await projectTexts();
    if (outgoing) rememberVariant(outgoing);
    const content = await readContentFile(file, map);   // throws unless it belongs to this map
    pruneVariantToMap(content, map);
    installProject(map, content);
    history.clear(); appState.selected.clear(); appState.itemIndex = 0; appState.itemSelected = false; clearItemSelection();
    refreshChrome(); renderCurrent(); refreshMapInfo();
    saveProjectNow();
    setStatus(`Loaded content variant “${content.meta.name}”.`);
  } catch (err) { setStatus('Cannot load content variant: ' + err.message); }
}

// A new content variant for the same map: empty, with source/destination languages chosen
// in the dialog. Prompts to save or discard the current variant first. Resolves true when
// the variant was created, false when the user cancelled.
async function createContentVariant(sourceLanguage, destinationLanguage, label) {
  if (!(await confirmContentUnload())) return false;
  if (!appState.pmap) return false;
  const { map, content: outgoing } = await projectTexts();
  // Keep the variant being replaced in the session cache: switching back is instant and an
  // app-initiated source-variant switch (Translate) must not drop the target it will write.
  if (outgoing) rememberVariant(outgoing);
  const next = emptyContentVariant({
    mapId: map.mapId, sourceLanguage, destinationLanguage, label,
    name: defaultContentName(map.meta.name, sourceLanguage, destinationLanguage),
  });
  // Preserve backgrounds from map-only regions: copy non-default backgrounds
  // from the map's regions into the new content variant so they don't reset.
  for (const p of map.pages) {
    for (const r of p.regions) {
      const bg = r.content?.background;
      if (bg && bg !== DEFAULT_BACKGROUND) {
        next.regions[r.id] = { background: bg, items: [] };
      }
    }
  }
  pruneVariantToMap(next, map);
  installProject(map, next);
  // The source language chosen for a variant is the document's own language; remember it
  // so the next extraction/translation does not ask for it again.
  appState.pdfLanguage = sourceLanguage;
  saveDocPrefs();
  history.clear(); appState.selected.clear(); appState.itemIndex = 0; appState.itemSelected = false; clearItemSelection();
  refreshChrome(); renderCurrent(); refreshMapInfo();
  saveProjectNow();
  setStatus(`Created content variant ${next.meta.name} (${sourceLanguage} → ${destinationLanguage}).`);
  return true;
}

// Prompt for a new content variant: choose source and destination language. When they are
// equal this is an improve variant; otherwise a translate variant.
// `showOpenFile` also offers loading a .content.json variant from disk; hidden by default
// because "New content variant…" from the menu is create-only. The ensureContentFile path
// shows this same dialog with the Open button instead of a separate load/create chooser.
// Resolves true when a content variant was created/loaded, false when cancelled.
async function promptNewContentVariant({ showOpenFile = false } = {}) {
  if (!appState.pmap) { setStatus('Load a region map first.'); return false; }
  return new Promise((resolve) => {
    const modal = $('variant-modal');
    const src = $('variant-source-lang'), dst = $('variant-dest-lang');
    const opts = LANGUAGES.map(([code, name]) => `<option value="${code}">${name}</option>`).join('');
    src.innerHTML = opts; dst.innerHTML = opts;
    const defaultLang = appState.pdfLanguage || 'en';
    // Source: the PDF's detected language (or English fallback).
    src.value = [...src.options].some(o => o.value === defaultLang) ? defaultLang : 'en';
    // Destination: the operating system's local language (or English fallback).
    const sysLang = (navigator.language || 'en').split('-')[0].toLowerCase();
    const dstLang = LANGUAGES.some(([c]) => c === sysLang) ? sysLang : 'en';
    dst.value = [...dst.options].some(o => o.value === dstLang) ? dstLang : 'en';
    $('variant-open-file').hidden = !showOpenFile;
    modal.hidden = false; src.focus();
    let settled = false;
    const done = (ok) => { if (settled) return; settled = true; modal.hidden = true; resolve(ok); };
    $('variant-create').onclick = async () => {
      const sourceLanguage = src.value;
      const destinationLanguage = dst.value;
      const label = destinationLanguage === sourceLanguage
        ? (src.options[src.selectedIndex]?.text || sourceLanguage)
        : `${src.options[src.selectedIndex]?.text || sourceLanguage} → ${dst.options[dst.selectedIndex]?.text || destinationLanguage}`;
      modal.hidden = true;
      let created = false;
      try { created = await createContentVariant(sourceLanguage, destinationLanguage, label); }
      catch (err) { setStatus('Cannot create content variant: ' + err.message); }
      done(!!created && !!appState.content);
    };
    $('variant-open-file').onclick = async () => {
      modal.hidden = true;
      if (await pickContentFile()) { done(true); return; }
      // If loading was cancelled, re-open the dialog so the user can still create.
      modal.hidden = false;
    };
    $('variant-cancel').onclick = () => { done(false); };
  });
}

// Switch the active content variant to another variant of the same map. Prompts to save
// or discard the current variant's unsaved changes first; the outgoing variant is kept in
// the in-session cache (appState.variants) so switching back to it is instant.
async function switchContentVariant(next, { guard = true } = {}) {
  // App-initiated switches (Translating to the target variant after the source text was
  // extracted) pass guard:false: the extraction is intentional and the outgoing variant
  // stays in the in-session cache, so there is nothing to lose and nothing to ask.
  if (guard && !(await confirmContentUnload())) return false;
  if (!appState.pmap || !appState.content) return false;
  const { map, content } = await projectTexts();
  if (content) rememberVariant(content);   // keep the outgoing variant switchable-back
  pruneVariantToMap(next, map);
  installProject(map, next);
  history.clear(); appState.selected.clear(); appState.itemIndex = 0; appState.itemSelected = false; clearItemSelection();
  refreshChrome(); renderCurrent(); refreshMapInfo();
  saveProjectNow();
  setStatus(`Switched to content variant “${appState.content.name}”.`);
  return true;
}

// Prompt the user to pick a loaded variant and switch to it.
async function promptSwitchContentVariant() {
  if (!appState.pmap || !appState.content) { setStatus('Open a PDF first.'); return; }
  const mine = appState.variants.filter(v => v.content.mapId === appState.content?.mapId);
  if (!mine.length) { setStatus('No other content variants are loaded.'); return; }
  const list = mine.map(v => `<li>${v.content.meta.name} — ${v.content.meta.sourceLanguage} → ${v.content.meta.destinationLanguage}</li>`).join('');
  const choice = await promptSelect({ title: 'Switch content variant', text: 'Pick the variant to make active:', options: mine.map(v => v.content.meta.name) });
  if (!choice) return;
  const target = mine.find(v => v.content.meta.name === choice);
  if (target) await switchContentVariant(target.content);
}

// Open a content variant dropped onto the open PDF (or picked when several are present).
async function openContentFile(file) {
  if (!appState.pmap) { setStatus('Load a region map first.'); return; }
  if (!(await confirmContentUnload())) return;
  try {
    const { map, content: outgoing } = await projectTexts();
    if (outgoing) rememberVariant(outgoing);
    const content = await readContentFile(file, map);   // throws unless it belongs to this map
    pruneVariantToMap(content, map);
    installProject(map, content);
    history.clear(); appState.selected.clear(); appState.itemIndex = 0; appState.itemSelected = false; clearItemSelection();
    refreshChrome(); renderCurrent(); refreshMapInfo();
    saveProjectNow();
    setStatus(`Loaded content variant “${content.meta.name}”.`);
  } catch (err) { setStatus('Cannot load content variant: ' + err.message); }
}

// ---- last session (IndexedDB) ----
// A browser refresh would otherwise drop the open PDF and the whole project. We keep
// the source bytes, the shared map and the active content variant in IndexedDB, on this
// machine only, and restore them on load. The source PDF is still never modified.
let sessionActive = false;   // a PDF is open (or has been restored) — so saving is meaningful
let sessionGen = 0;          // bumped by a new file open, to abandon a stale restore

// Save the current project state to IndexedDB immediately (no debounce).
async function saveProjectNow() {
  if (!sessionActive) return;
  if (!appState.pmap) return;
  try {
    const { mapText, contentText, changed } = await projectTexts();
    if (!sessionActive || !appState.pmap) return;
    if (appState.content) {
      await saveSessionProject({ mapJson: mapText, mapName: appState.pmap.meta?.name, contentJson: contentText, contentName: appState.content.name });
    } else {
      await saveSessionProject({ mapJson: mapText, mapName: appState.pmap.meta?.name, contentJson: null, contentName: null });
    }
    // dirtySides reflects "changed since last export to file system" — updated by
    // saveProjectNow (autosave) and exportProjectPart (user-initiated export).
    appState.dirtySides = changed;
    refreshMapInfo();
  } catch (e) {
    console.error('IndexedDB session save failed:', e);
    // Don't reschedule; the next mutation will retry.
  }
}

// Every model mutation calls touch(); persist to IndexedDB immediately.
function touch(pmap) { touchMap(pmap); saveProjectNow(); }

async function clearSavedSession() {
  // Stop any pending save before deleting, so a save that started before
  // closePdf() cannot rewrite the session after the user closed the document.
  sessionActive = false;
  try { await clearSession(); } catch {}
}

// ---- file opening ----
async function openFileList(files) {
  // A new document means any on-device model download for the old one is moot.
  cancelChromeAiDownload();
  const pdfs = files.filter(f => /\.pdf$/i.test(f.name));
  const maps = files.filter(f => isMapFileName(f.name));
  const contents = files.filter(f => isContentFileName(f.name));
  if (!pdfs.length && (maps.length || contents.length) && appState.pdfBytes) {
    // Dropped onto the open PDF: a map (with whatever content variant came along), or
    // just another content variant for the map that is already loaded.
    if (maps.length === 1) await openRegionFile(maps[0]);
    else if (maps.length > 1) {
      const pick = await pickFile(maps, { title: 'Multiple maps found — pick one', cancelLabel: 'Start empty' });
      if (pick) await openRegionFile(pick);
      else newRegionFile();
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
  // Load the PDF directly without prompting. Region map and content variant are
  // created/loaded on demand when the user first needs them (Detect, Add Polygon,
  // Translate, Make Selectable, Add Text, Add Image). Paint page 1 so the document is
  // visible straight away instead of waiting for a refresh.
  renderCurrent();
  startThumbs();
  setStatus(`Opened ${pdf.name} (${viewer.pageCount} pages). Load a region file or create one to start working.`);
}

// Open a project zip saved by Export project: it holds the shared map plus the
// content variant(s), all inside a folder named after the PDF. Loads the map,
// then the improve content variant, then the translate content variant.
// The PDF must already be open (the zip holds project files, not the PDF itself).
async function openProject(file) {
  if (!file) return;
  if (!viewer.doc) { setStatus('Open a PDF first, then open the project zip.'); return; }
  const buf = await file.arrayBuffer();
  const JSZip = await getJSZip();
  const zip = new JSZip();
  await zip.loadAsync(buf);

  let mapEntry = null;
  const contentEntries = [];
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    const base = name.replace(/^.*\//, ''); // strip folder prefix
    if (isMapFileName(base)) mapEntry = entry;
    else if (isContentFileName(base)) contentEntries.push({ name: base, entry });
  }

  if (!mapEntry) { setStatus('No .pmap map found in the project zip.'); return; }

  const mapText = await mapEntry.async('text');
  const kind = detectFileKind(JSON.parse(mapText));
  if (kind === 'content') { setStatus('The zip contains a content variant but no .pmap map.'); return; }
  if (kind === 'map-legacy') {
    setStatus('This is a v1.1 single-file map — split it first with tools/pmap-migrate.mjs.');
    return;
  }
  const map = parseMap(mapText);
  const errs = [];
  if (map.source?.sha256 && map.source.sha256 !== appState.sha256) errs.push(`hash differs (map for ${map.source.filename || 'another file'})`);
  if (map.source?.page_count && map.source.page_count !== viewer.pageCount) errs.push(`page count ${map.source.page_count} vs ${viewer.pageCount}`);
  if (errs.length) {
    const ok = await confirmMismatch(`This map “${mapEntry.name}” was made for a different file: ${errs.join('; ')}.`);
    if (!ok) { setStatus('Project load cancelled (mismatch).'); return; }
  }

  let content = null;
  const otherContents = [];
  for (const { name, entry } of contentEntries) {
    try {
      const text = await entry.async('text');
      const parsed = parseContent(text);
      if (parsed.mapId !== map.mapId) continue; // belongs to another map
      if (!content) content = parsed; // first content variant becomes active
      else otherContents.push({ name, content: parsed });
    } catch { /* skip unreadable content files */ }
  }

  if (content) {
    installProject(map, content);
  } else {
    // Map-only project zip: the map loads on its own; a content variant is created or
    // loaded on demand when the user first needs it.
    installMapOnly(map);
  }

  // Remember the remaining variants in-session so they appear in the switch-variant dialog.
  // They live as their own .content.json files; only the active variant is autosaved to
  // IndexedDB, so nothing is stashed into slots here.
  for (const { content: c } of otherContents) rememberVariant(c);

  afterMapLoaded(`Loaded project from ${file.name}: ${map.meta?.name || mapEntry.name}${content ? ` + ${content.meta.name}` : ' (no content variant yet)'}${otherContents.length ? ` (${otherContents.length} variant${otherContents.length === 1 ? '' : 's'} also loaded)` : ''}.`);
}

async function loadPdfFile(file) {
  const buf = await file.arrayBuffer();
  appState.pdfName = file.name;
  setStatus('Hashing PDF…');
  await new Promise(r => setTimeout(r, 0)); // let the status paint before the work
  // Hash and open concurrently. viewer.load() makes its own copy, so both can share `buf`
  // without extra full-file copies and without one detaching the other's data.
  const [sha] = await Promise.all([sha256Hex(buf), viewer.load(buf)]);
  appState.sha256 = sha;
  appState.pdfBytes = buf;
  const prefs = loadDocPrefs(sha);
  appState.pdfLanguage = prefs.pdfLanguage || null;
  appState.variants = [];
  appState.page = 1; appState.selected.clear(); history.clear(); clearItemSelection();
  appState.zoom = 1.2;
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

// Prompt to export/discard the current map's unsaved changes before replacing it.
async function confirmUnloadMap() {
  if (!appState.pmap) return true;
  let changed;
  try {
    ({ changed } = await projectTexts());
    if (!changed.map) return true; // nothing dirty
  } catch {
    // projectTexts() can throw if the resolved project can't be split. Fall back to the
    // runtime dirty flags so we never silently proceed over unsaved work.
    if (!(appState.dirtySides?.map)) return true;
  }
  const what = await appDialog({
    title: 'Export or Discard',
    text: `The region map for “${appState.pdfName || 'this PDF'}” has not been exported yet. Export it before replacing the map?`,
    buttons: [
      { value: 'export', label: 'Export', primary: true },
      { value: 'discard', label: 'Discard' },
    ],
    cancelLabel: 'Cancel',
  });
  const choice = what ? what.value : null;
  if (!choice) return false;
  if (choice === 'export') {
    await exportProjectPart('map');
    try {
      const { changed: again } = await projectTexts();
      if (again.map) return false; // export failed
    } catch { return false; }
  }
  return true;
}

// One prompt when both the map and the content variant have unsaved changes: the user
// either exports both halves together (one download) or discards both. Only the sides that
// are actually dirty are mentioned; a single dirty side keeps its own dedicated dialog.
async function confirmUnloadProject() {
  if (!appState.pmap) return true;
  let changed;
  try {
    ({ changed } = await projectTexts());
    appState.dirtySides = changed;
    if (!changed.map && (!appState.content || !changed.content)) return true; // nothing dirty
  } catch {
    // projectTexts() can throw if the resolved project can't be split. Fall back to the
    // runtime dirty flags so we never silently close over unsaved work.
    if (!(appState.dirtySides?.map || appState.dirtySides?.content)) return true;
  }
  const mapDirty = appState.pmap && changed.map;
  const contentDirty = appState.content && changed.content;
  if (!mapDirty && !contentDirty) return true;
  // Single dirty side keeps its own dialog — the combined one is only for both.
  if (contentDirty && !mapDirty) return confirmContentUnload();
  if (mapDirty && !contentDirty) return confirmUnloadMap();
  const what = await appDialog({
    title: 'Export or Discard',
    text: `Both the region map for “${appState.pdfName || 'this PDF'}” and the content variant “${appState.content.name}” have unsaved changes. Export both before closing?`,
    buttons: [
      { value: 'export', label: 'Export', primary: true },
      { value: 'discard', label: 'Discard' },
    ],
    cancelLabel: 'Cancel',
  });
  const choice = what ? what.value : null;
  if (!choice) return false;
  if (choice === 'export') {
    await exportProjectPart('both');
    try {
      const { changed: again } = await projectTexts();
      appState.dirtySides = again;
      if (again.map || again.content) return false; // export failed
    } catch { return false; }
  }
  return true;
}

// Create a brand-new empty region map for the current PDF. Prompts to export/discard
// the current map and content if either has unsaved changes.
async function newRegionFile() {
  if (!viewer.doc) { setStatus('Open a PDF first.'); return; }
  if (!(await confirmUnloadProject())) return;
  const s = await viewer.baseSize(1);
  emptyMapForPdf(s);
  afterMapLoaded('New empty region map created.');
}

// Load a .pmap region map file for the current PDF. Prompts to export/discard the
// current map and content if either has unsaved changes. Content is dropped (the map
// alone is loaded; a content variant can be created/loaded on demand).
async function openRegionFile(file) {
  if (!viewer.doc) { setStatus('Open a PDF first.'); return; }
  if (!(await confirmUnloadProject())) return;
  try {
    const text = await file.text();
    const kind = detectFileKind(JSON.parse(text));
    if (kind === 'content') { setStatus(`“${file.name}” is a content variant, not a map — open the .pmap it belongs to.`); return; }
    if (kind === 'map-legacy') {
      throw new Error('this is a v1.1 single-file map. Split it with tools/pmap-migrate.mjs first.');
    }
    const map = parseMap(text);
    const errs = [];
    if (map.source?.sha256 && map.source.sha256 !== appState.sha256) errs.push(`hash differs (map for ${map.source.filename || 'another file'})`);
    if (map.source?.page_count && map.source.page_count !== viewer.pageCount) errs.push(`page count ${map.source.page_count} vs ${viewer.pageCount}`);
    if (errs.length) {
      const ok = await confirmMismatch(`This map “${file.name}” was made for a different file: ${errs.join('; ')}.`);
      if (!ok) { setStatus('Map load cancelled (mismatch).'); return; }
    }
    // Drop any current content: the map alone is loaded with no content variant.
    installMapOnly(map);
    afterMapLoaded(`Loaded region map “${map.meta?.name || file.name}” (no content variant yet).`);
  } catch (err) { setStatus('Cannot load map: ' + err.message); }
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
    if (map.source?.sha256 && map.source.sha256 !== appState.sha256) errs.push(`hash differs (map for ${map.source.filename || 'another file'})`);
    if (map.source?.page_count && map.source.page_count !== viewer.pageCount) errs.push(`page count ${map.source.page_count} vs ${viewer.pageCount}`);
    if (errs.length) {
      const ok = await confirmMismatch(`This map “${file.name}” was made for a different file: ${errs.join('; ')}.`);
      if (!ok) { setStatus('Map load cancelled (mismatch).'); return; }
    }
    // The content variant that came with the map (if any), or none to start from. Content
    // is created or loaded on demand when the user first needs it (Translate, Make Selectable,
    // Add Text, Add Image).
    let content = null;
    let why = '';
    try {
      if (contentFiles.length === 1) content = await readContentFile(contentFiles[0], map);
      else if (contentFiles.length > 1) {
        const pick = await pickFile(contentFiles, { title: 'Multiple content variants found — pick one', cancelLabel: 'No content variant' });
        if (pick) content = await readContentFile(pick, map);
      }
    } catch (err) { why = ` — ${err.message}, so it was not loaded`; }
    if (content) {
      installProject(map, content);
      afterMapLoaded(`Loaded ${map.meta?.name || file.name} + ${appState.content.name}${why}.`);
    } else {
      installMapOnly(map);
      afterMapLoaded(`Loaded ${map.meta?.name || file.name} (no content variant yet)${why}.`);
    }
  } catch (err) { setStatus('Cannot load map: ' + err.message); }
}

// ---- region map / content variant ensure dialogs ----

// Pick a .pmap file via the hidden input and await loading. Resolves true if a map
// was loaded, false if cancelled or failed. Temporarily replaces the input's onchange
// so the file is loaded through openRegionFile() (not the fire-and-forget openFileList).
async function pickRegionFile() {
  return new Promise((resolve) => {
    let resolved = false;
    const originalOnChange = els.filePmap.onchange;
    els.filePmap.onchange = null;
    const onChange = async (e) => {
      if (resolved) return;
      resolved = true;
      els.filePmap.removeEventListener('change', onChange);
      const f = e.target.files?.[0] || null;
      els.filePmap.value = '';
      els.filePmap.onchange = originalOnChange;
      if (f) {
        try { await openRegionFile(f); } catch {}
      }
      resolve(!!appState.pmap);
    };
    els.filePmap.addEventListener('change', onChange, { once: true });
    els.filePmap.click();
    setTimeout(() => { if (!resolved) { resolved = true; els.filePmap.removeEventListener('change', onChange); els.filePmap.onchange = originalOnChange; resolve(false); } }, 30000);
  });
}

// Pick a .content.json file via the hidden input and await loading. Resolves true if
// a content variant was loaded, false if cancelled or failed.
async function pickContentFile() {
  return new Promise((resolve) => {
    let resolved = false;
    const originalOnChange = els.fileContentVariant.onchange;
    els.fileContentVariant.onchange = null;
    const onChange = async (e) => {
      if (resolved) return;
      resolved = true;
      els.fileContentVariant.removeEventListener('change', onChange);
      const f = e.target.files?.[0] || null;
      els.fileContentVariant.value = '';
      els.fileContentVariant.onchange = originalOnChange;
      if (f) {
        try { await openContentFile(f); } catch {}
      }
      resolve(!!appState.content);
    };
    els.fileContentVariant.addEventListener('change', onChange, { once: true });
    els.fileContentVariant.click();
    setTimeout(() => { if (!resolved) { resolved = true; els.fileContentVariant.removeEventListener('change', onChange); els.fileContentVariant.onchange = originalOnChange; resolve(false); } }, 30000);
  });
}

// Ensure a region map is loaded before an action that needs regions. Prompts to create
// or load one when none exists.
async function ensureRegionFile() {
  if (appState.pmap) return true;
  // No map yet — create an empty one automatically instead of asking. Users who want to
  // load an existing .pmap use File ▸ Open region file… (pickRegionFile) instead.
  await newRegionFile();
  return !!appState.pmap;
}

// Ensure a content variant is loaded before an action that needs content. Requires a
// region map first. When none exists it shows the New content variant dialog directly —
// language pickers plus Create / Open content file… / Cancel — with no extra chooser.
async function ensureContentFile() {
  if (appState.content) return true;
  if (!appState.pmap && !(await ensureRegionFile())) return false;
  if (!appState.pmap) return false;
  return await promptNewContentVariant({ showOpenFile: true });
}

function afterMapLoaded(msg) {
  syncIdCounter(appState.pmap);
  history.clear(); appState.selected.clear(); appState.itemIndex = 0;
  setStatus(msg);
  gotoPage(1);
  // The map is on screen now; fill the page rail in the background (and only for a
  // document we have not built thumbs for yet).
  startThumbs();
  saveProjectNow();
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
      // The content variant is loaded from the single session slot — its source/destination
      // language decides improve vs translate at restore time.
      content = await loadSessionContent();
    }
  } catch { return false; }
  if (!pdf?.bytes || gen !== sessionGen) return false;
  try {
    setStatus(`Restoring your last session (${pdf.name})…`);
    await viewer.load(pdf.bytes);
    if (gen !== sessionGen) return false;
    appState.pdfName = pdf.name || 'document.pdf';
    appState.pdfBytes = pdf.bytes;
    appState.sha256 = pdf.sha256 || await sha256Hex(pdf.bytes);
    const prefs = loadDocPrefs(appState.sha256);
    appState.pdfLanguage = prefs.pdfLanguage || null;
    appState.variants = [];
    appState.page = 1; appState.selected.clear(); history.clear(); appState.zoom = 1.2; clearItemSelection();
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
      if (restoredContent) {
        installProject(restoredMap, restoredContent);
        // A restored project has not been exported in this session: the map and
        // content variant carry unsaved changes until the user exports them. Do not
        // let installProject()'s canonical baselines make them look "saved".
        appState.content.savedMap = null;
        appState.content.savedContent = null;
        appState.dirtySides = { map: true, content: true };
      } else {
        // Map-only restore: no content variant was saved (or it was unreadable). The map
        // comes back on its own; a content variant is created/loaded on demand.
        installMapOnly(restoredMap);
        // Same as above: a restored map has not been exported in this session.
        appState.savedMap = null;
        appState.dirtySides = { map: true, content: false };
      }
    } else {
      // No saved map — don't fabricate an empty project. The user creates a map
      // on demand (New region file / Open region file / Detect).
      appState.pmap = null;
      appState.content = null;
      appState.variants = [];
      appState.savedMap = null; appState.mapModified = '';
      appState.dirtySides = { map: false, content: false };
      renderCurrent();
      startThumbs();
      if (gen !== sessionGen) return false;
      setStatus(`Restored ${appState.pdfName} from your last session — no map was saved.${note}`);
      return true;
    }
    if (gen !== sessionGen) return false;
    // Paints page 1 with its regions and kicks off the thumbnail build behind it.
    afterMapLoaded(`Restored ${appState.pdfName}${restoredMap ? ` + ${appState.pmap.meta?.name}${appState.content ? ` + ${appState.content.name}` : ' (no content variant yet)'}` : ''} from your last session${note}.`);
    return true;
  } catch (e) {
    // Never leave a half-restored app behind: whatever failed, drop back to the state a
    // fresh load would be in (empty map, empty overlay, nothing rendered) so the user can
    // still open the file by hand, and say what happened in the status bar.
    sessionActive = false;
    appState.pmap = null;
    appState.content = null;
    appState.savedMap = null; appState.mapModified = '';
    appState.dirtySides = { map: false, content: false };
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
  appState.page = Math.max(1, Math.min(viewer.pageCount, n));
  appState.selected.clear(); appState.itemSelected = false; clearItemSelection();
  await renderCurrent();
}
function setZoom(z) { appState.zoom = Math.max(0.2, Math.min(5, z)); renderCurrent(); }
async function fitZoom() {
  const wrap = $('stage-wrap');
  const s = await viewer.baseSize(appState.page);
  appState.zoom = Math.max(0.2, Math.min(3, (wrap.clientWidth - 60) / s.width));
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
  const size = await viewer.baseSize(appState.page);
  stage.setPageSize(size.width, size.height);
  // Skip expensive pdf.js re-render when page+zoom unchanged (selection, drag preview, typing).
  if (lastPdfRender.page !== appState.page || lastPdfRender.zoom !== appState.zoom) {
    await viewer.renderTo(els.pdfCanvas, appState.page, appState.zoom);
    try { await viewer.renderTextLayer(els.textLayer, appState.page, appState.zoom); } catch { els.textLayer.innerHTML = ''; }
    lastPdfRender = { page: appState.page, zoom: appState.zoom };
  }
  // 🚨 CRITICAL FIX FOR INP: Yield to the browser here!
  // This allows the browser to paint the mode button's visual state change
  // BEFORE we block the main thread with heavy overlay rendering and DOM updates.
  if ('scheduler' in globalThis && typeof scheduler.yield === 'function') {
    await scheduler.yield();
  } else if (typeof requestAnimationFrame === 'function') {
    await new Promise(resolve => requestAnimationFrame(resolve));
  } else {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  stage.applyToSvg(els.svg);
  els.svg.style.width = `${size.width * appState.zoom}px`;
  els.svg.style.height = `${size.height * appState.zoom}px`;
  els.textLayer.style.width = `${size.width * appState.zoom}px`;
  els.textLayer.style.height = `${size.height * appState.zoom}px`;
  applyTextLayerInteractivity();
  els.zoomLabel.textContent = Math.round(appState.zoom * 100) + '%';
  document.querySelectorAll('#thumbs canvas').forEach(c => c.classList.toggle('active', +c.dataset.page === appState.page));
  if (!appState.pmap) { refreshChrome(); return; }
  ensurePage(appState.pmap, appState.page, size.width, size.height);
  const pg = getPage(appState.pmap, appState.page);
  let regions = pg ? pg.regions : [];
  if (appState.dragPreview) regions = applyDragPreview(regions);
  const itemBoxes = inContent() && !appState.draft.length
    ? regions.filter(r => appState.selected.has(r.id)).flatMap(r => buildItemBoxes(r))
    : [];
  const digitalSource = digitalSourceState();
  const digitalFilled = new Set(regions.filter(r => hasDigitalContent(r, digitalSource)).map(r => r.id));
  overlay.render({ regions, selectedIds: appState.selected, draftPoints: appState.draft, draftCursor: inRegion() ? appState.cursor : null, splitLine: appState.splitPts, mode: appState.mode, tool: appState.tool, itemBoxes, selectedVertex: appState.selectedVertex, marquee: isEditMode() ? appState.marquee : null, clipWarn: clippedRegions(regions), showDigital: appState.showDigital, digitalFilled, awaitingOcr: appState.awaitingOcr, statusTags: { filled: workflowCopy().filledTag, missing: workflowCopy().missingTag } });
  // Preview canvas. Preview mode masks every region and draws its items. The two editing modes
  // render the very same thing (mask + items) for every region *except* the one being
  // edited, whose mask is dropped (maskExcept) so the source PDF stays visible under the
  // cursor. So a deselected region already looks exactly the way it will in Preview mode /
  // the export — in Region mode this is also how the frozen items are shown (spec §9a).
  const maskedRegions = regions.filter(regionIsMasked);
  // Skipped while a drag/marquee/draft is previewing: no region's content changes under
  // the pointer, and the canvas is rebuilt as soon as the gesture ends.
  const midGesture = !!(appState.dragPreview || appState.marquee || appState.draft.length);
  const clearViewCanvas = () => { try { els.viewCanvas.getContext('2d').clearRect(0, 0, els.viewCanvas.width, els.viewCanvas.height); } catch {} };
  if (appState.mode === 'view') {
    els.viewCanvas.hidden = false;
    els.viewCanvas.style.left = '0px'; els.viewCanvas.style.top = '0px';
    renderView({ viewCanvas: els.viewCanvas, baseCanvas: els.pdfCanvas, regions, zoom: appState.zoom, mask: true });
  } else if (isEditMode()) {
    els.viewCanvas.hidden = maskedRegions.length === 0;
    if (maskedRegions.length && !midGesture) {
      els.viewCanvas.style.left = '0px'; els.viewCanvas.style.top = '0px';
      // The region being edited stays transparent so the user sees the page under it — except
      // while the background colour picker has focus, when the mask is previewed on it so the
      // chosen colour can actually be seen (macOS fires `change` only when the panel closes).
      // In the editing modes the region being edited normally stays transparent so the page
      // shows through — but a region whose background was just set must keep showing its
      // colour (else picking a background looks like it reverted). So a selected region is
      // masked unless its background is still the default. Backgrounds are tinted (alpha 0.3)
      // here so the source page stays faintly visible; Preview mode draws them opaque (alpha 1).
      renderView({ viewCanvas: els.viewCanvas, baseCanvas: els.pdfCanvas, regions, zoom: appState.zoom, mask: true, maskExcept: appState.bgPreview ? new Set() : new Set([...appState.selected].filter(id => { const r = regionById(id); return r && isDefaultBackground(r.content?.background); })), alpha: 0.3 });
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
  const active = appState.mode === 'text';
  els.textLayer.style.pointerEvents = active ? 'auto' : 'none';
  els.textLayer.style.userSelect = active ? 'text' : 'none';
}


function refreshChrome() {
  const armed = inRegion() && appState.tool === 'polygon';
  const drafting = appState.draft.length > 0 && inRegion();
  const hint = $('draw-hint');
  hint.hidden = !(drafting || armed);
  if (drafting) hint.textContent = `Add polygon — drawing page ${appState.page}: click to add points · Enter/double-click to close (${appState.draft.length} pts) · Esc cancels`;
  else if (armed) hint.textContent = `Add polygon — page ${appState.page}: click to place the first point · Esc cancels`;
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
  const c = workflowCopy();
  if (!viewer.doc) {
    steps.push({ text: 'Open a PDF to start (Ctrl/Cmd+O, or drop it here).', btn: ['Open PDF', () => els.filePdf.click()] });
    return steps;
  }
  const pg = appState.pmap ? getPage(appState.pmap, appState.page) : null;
  const regions = pg?.regions || [];
  const textRegions = regions.filter(r => !isDetectedImage(r));
  const sel = selectedRegions().filter(r => !isDetectedImage(r));

  // 1 — map the page
  if (!regions.length) {
    steps.push({
      text: `Page ${appState.page} has no regions yet. Detect them, or draw one (P).`,
      btn: ['Detect (D)', () => detectRegionsOnPage()],
    });
  } else if (!appState.selected.size) {
    if (!isEditMode()) {
      steps.push({ text: 'Switch to an editing mode to work on this page (Tab cycles modes).', btn: ['Region mode', () => setMode('region')] });
    } else {
      const withoutSource = textRegions.filter(r => !firstTextItem(r.content)).length;
      if (withoutSource) {
        steps.push({
          text: `No region selected. Click one, or select the ${withoutSource === 1 ? 'region' : 'regions'} still missing ${contentIsImprove() ? 'selectable text' : 'source text'}.`,
          btn: [`${c.selectMissing} (Shift+A)`, () => selectTextRegionsWithoutContent()],
        });
      } else {
        steps.push({ text: 'No region selected — click one on the page to continue.' });
      }
    }
  } else {
    // 2 — the selection's next editorial move, per workflow
    if (contentIsTranslate()) {
      const withText = sel.filter(r => (r.content?.items || []).some(it => it.type === 'text')).length;
      const inSource = activeVariantIsSource();
      const target = activeTargetLanguage();
      if (inSource && withText) {
        // The source variant is on screen: the next move is a translation into the target
        // variant, never "review" (the source text is exactly what is supposed to be here).
        steps.push({
          text: `This is the ${languageName(appState.pdfLanguage || langLabel(appState.content))} source variant — translate the selection into ${languageName(target)}.`,
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
  if (flagged) steps.push({ text: `${flagged} ${flagged === 1 ? 'item is' : 'items are'} flagged ${contentIsImprove() ? 'extract' : 'machine-translated'} text — read and confirm them in the list below.` });
  const overflowing = regions.reduce((n, r) => n + (r.content?.items || []).filter(it => it.type === 'text' && overflowsBox(it)).length, 0);
  if (overflowing) {
    steps.push({
      text: `${overflowing} text box${overflowing === 1 ? '' : 'es'} on this page overflow${overflowing === 1 ? 's' : ''} its region — fit them in one step.`,
      btn: ['Fit page text (R)', () => resizeAllTextInPage()],
    });
  }
  if (appState.mode !== 'view') steps.push({ text: 'Check the result in Preview mode (Tab), then export from the File menu.', btn: ['Preview', () => setMode('view')] });

  // 4 — unsaved changes, always last (a project rows two files: map + content variant)
  if (appState.dirtySides?.map || appState.dirtySides?.content) {
    steps.push({
      text: `Unsaved ${appState.dirtySides.map && appState.dirtySides.content ? 'map + content' : appState.dirtySides.map ? 'map' : 'content'} — the project is two files.`,
      btn: ['Export project (Ctrl/Cmd+S)', () => exportProjectPart('both')],
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
  const c = workflowCopy();
  if (els.reviewSection) els.reviewSection.hidden = !appState.pmap || !appState.content;
  els.reviewHeading.textContent = c.reviewHeading;
  els.reviewList.innerHTML = '';
  if (!appState.pmap || !appState.content) return;
  // The queue follows the lens's own variant. Translate confirms target text, Improve
  // confirms source text; showing the other variant's flags under this heading would
  // mislabel exactly the state the lens exists to avoid.
  const activeIsSource = activeVariantIsSource();
  if ((contentIsTranslate() && activeIsSource) || (contentIsImprove() && !activeIsSource)) {
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
      appState.selected = new Set([row.r.id]);
      appState.selectedVertex = null;
      appState.itemIndex = Math.max(0, idx);
      appState.itemSelected = true;
      if (appState.mode !== 'content') setMode('content');
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
  if (!appState.pmap || !viewer.doc) { el.textContent = ''; return; }
  const regions = currentRegions();
  const source = digitalSourceState();
  const textRegions = regions.filter(r => !isDetectedImage(r));
  const sourceCount = textRegions.filter(r => hasDigitalContent(r, source)).length;
  const missing = textRegions.length - sourceCount;
  const figures = regions.length - textRegions.length;
  const c = workflowCopy();
  if (contentIsImprove()) {
    el.textContent = `Page ${appState.page}: ${sourceCount} ${sourceCount === 1 ? 'region' : 'regions'} selectable · ${missing} not yet selectable${figures ? ` · ${figures} figure${figures === 1 ? '' : 's'}` : ''}.`;
    return;
  }
  const activeLang = String(appState.content?.sourceLanguage || '').toLowerCase();
  const activeIsSource = !!appState.pdfLanguage && activeLang === String(appState.pdfLanguage).toLowerCase();
  const translated = activeIsSource ? 0 : textRegions.filter(r => (r.content?.items || []).some(it => it.type === 'text')).length;
  const pending = activeIsSource ? 0 : textRegions.filter(r => (r.content?.items || []).some(it => it.type === 'text' && it.needsReview)).length;
  el.textContent = `Page ${appState.page}: ${sourceCount} source read · ${translated} regions translated · ${pending} pending review.`;
}

function refreshModeIndicator() {
  for (const b of document.querySelectorAll('#mode-group button')) b.classList.toggle('active', b.dataset.mode === appState.mode);
  // The body carries the mode too, so CSS can describe the mode's vocabulary (e.g. in
  // Content mode a polygon is a read-only outline, not a draggable shape).
  for (const m of MODE_ORDER) document.body.classList.toggle(`mode-${m}`, appState.mode === m);
}

function refreshMapInfo() {
  if (!appState.pmap) { els.mapInfo.textContent = 'No Region Map loaded.'; return; }

  // Saves are now immediate (no debounce). IndexedDB is always in sync with the
  // current model. The "unsaved" indicator here now reflects export-dirty state
  // (dirtySides) — changes that haven't been exported to the file system yet.
  const indexDbDirty = appState.dirtySides?.map || appState.dirtySides?.content;

  // ---- PDF ----
  const pc = Number(appState.pmap.source?.page_count) || appState.pmap.pages.length || 0;
  const pdfSize = appState.pdfBytes ? fileSizeLabel(appState.pdfBytes.length) : '—';
  const pdfLine = `<div class="file-row"><div class="file-kind source">PDF</div><div class="file-name">${escapeHtml(appState.pdfName)}</div><div class="file-detail">${pc} page${pc === 1 ? '' : 's'} · ${pdfSize}</div></div>`;

  // ---- Region map ----
  const n = appState.pmap.pages.reduce((a, p) => a + (p.regions?.length || 0), 0);
  const mapStatus = indexDbDirty ? 'unsaved' : 'saved';
  const mapLine = `<div class="file-row"><div class="file-kind ${mapStatus}">Region map</div><div class="file-name">${escapeHtml(appState.pmap.meta?.name || '—')}</div><div class="file-detail">${n} region${n === 1 ? '' : 's'} · ${pc} page${pc === 1 ? '' : 's'}</div></div>`;

  // ---- Content variant ----
  let contentLine = '';
  if (appState.content) {
    const c = appState.content;
    const contentStatus = indexDbDirty ? 'unsaved' : 'saved';
    const variantLabel = c.label ? ` (“${escapeHtml(c.label)}”)` : '';
    const role = activeVariantIsSource() ? workflowCopy().sourceVariant : 'translation';
    contentLine = `<div class="file-row"><div class="file-kind ${contentStatus}">Content variant</div><div class="file-name">${escapeHtml(c.name)}${variantLabel}</div><div class="file-detail">${escapeHtml(c.sourceLanguage)} → ${escapeHtml(c.destinationLanguage)} · ${role}</div></div>`;
  }

  els.mapInfo.innerHTML = `<div class="file-list">${pdfLine}${mapLine}${contentLine}</div>`;
}

function applyMode() {
  // A tool, a half-drawn draft or a picked vertex belongs to Region mode; leaving it (or
  // moving between the two editing modes) must not leave one behind. The *region* selection
  // survives a mode change in every mode (a region is selectable in Region and Content and
  // stays highlighted in the read-only ones); the *item* selection is an editorial state, so
  // it is dropped as soon as the mode is no longer Content (spec §9a).
  appState.draft = []; appState.splitPts = []; appState.cursor = null; appState.marquee = null; appState.marqueeBase = null; appState.marqueeItems = false;
  if (!inRegion()) { appState.tool = 'select'; appState.selectedVertex = null; }
  // Coloring mode (eyedropper) is Region-only; switching out of it turns it off.
  if (!inRegion() && appState.coloringMode) { appState.coloringMode = false; cancelEyedropper(); document.body.classList.remove('coloring-mode'); }
  if (!inContent()) { appState.itemSelected = false; clearItemSelection(); }
  applyTextLayerInteractivity();
  rerender();
}

// ---- toolbar / menu action helpers ----
// Tab steps forward through the modes, Shift+Tab steps back (spec §9a).
function cycleMode(back = false) {
  const n = MODE_ORDER.length;
  const i = MODE_ORDER.indexOf(appState.mode);
  setMode(MODE_ORDER[((i + (back ? -1 : 1)) % n + n) % n]);
}
function setTool(t) {
  appState.tool = t;
  appState.draft = []; appState.splitPts = []; appState.cursor = null;
  applyTextLayerInteractivity();
  rerender();
}
// Arm/disarm the polygon drawing tool (Tools ▸ Add polygon, or the P shortcut). Drawing is
// geometry, so the tool lives in Region mode only (spec §9a/§11.1).
async function armPolygon() {
  if (!inRegion()) { setStatus('Switch to Region mode to draw regions.'); return; }
  if (!appState.pmap && !(await ensureRegionFile())) return;
  if (appState.tool === 'polygon') { setTool('select'); setStatus('Add polygon: off.'); return; }
  setTool('polygon');
  setStatus('Add polygon: click to add points · Enter/double-click to close · Esc cancels.');
}
function setMode(m) {
  if (appState.mode === m) return;
  appState.mode = m;
  applyMode();
  refreshModeIndicator();
}
function toggleOverlay() {
  appState.overlayVisible = !appState.overlayVisible;
  overlay.visible = appState.overlayVisible;
  rerender();
}
// The source/selectability on-page tags. They are an editing aid, not a content layer:
// turning them off leaves the polygons and ids exactly as they were.
function toggleDigitalVersion() {
  appState.showDigital = !appState.showDigital;
  rerender();
  const where = isEditMode() ? '.' : ' — visible in Region and Content mode.';
  const label = contentIsImprove() ? 'Selectability status tags' : 'Source-text status tags';
  setStatus(`${label} ${appState.showDigital ? 'shown' : 'hidden'}${where}`);
}
async function gotoPagePrompt() {
  const answer = await promptValue({
    title: 'Go to page',
    text: `Page number (1–${viewer.pageCount}):`,
    value: String(appState.page),
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
  if (stats.awaiting) parts.push(`${stats.awaiting} ${workflowCopy().missing}`);
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
  // switch variants and rebuild appState.pmap. Geometry proposals are variant-independent.
  if (extract && !(await ensureExtractionVariant('Detect and extract'))) return { cancelled: true, stats };
  const threshold = detectOverlap();
  const run = makeRunChoice();
  const plans = pages.map(({ page, res }) => {
    const pg = getPage(appState.pmap, page);
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
  const beforeAwaiting = new Set(appState.awaitingOcr);
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
    appState.awaitingOcr = new Set(beforeAwaiting);
    for (const p of plans) for (const id of p.removedIds) appState.awaitingOcr.delete(id);
    for (const id of notAwaitingIds) appState.awaitingOcr.delete(id);
    for (const id of awaitingIds) appState.awaitingOcr.add(id);
    rerender();
    return { cancelled: false, stats };
  }

  history.exec({
    label: extract ? 'detect and extract' : 'detect regions',
    do() {
      for (const p of plans) {
        const pg = ensurePage(appState.pmap, p.page, p.width, p.height);
        pg.regions = structuredClone(p.after);
      }
      appState.awaitingOcr = new Set(beforeAwaiting);
      for (const p of plans) for (const id of p.removedIds) appState.awaitingOcr.delete(id);
      for (const id of notAwaitingIds) appState.awaitingOcr.delete(id);
      for (const id of awaitingIds) appState.awaitingOcr.add(id);
      for (const id of extractedIds) appState.awaitingOcr.delete(id);
      const selected = plans.flatMap(p => [...p.addedIds, ...p.replacedIds, ...p.retypedIds]);
      // Select what the run produced (adds and replacements) so the canvas shows the result.
      appState.selected = new Set(selected);
      appState.itemSelected = false; clearItemSelection();
      touch(appState.pmap); rerender();
    },
    undo() {
      for (const p of plans) {
        if (p.existed) { const pg = getPage(appState.pmap, p.page); if (pg) pg.regions = structuredClone(p.before); }
        else appState.pmap.pages = appState.pmap.pages.filter(x => x.page !== p.page);
      }
      appState.awaitingOcr = new Set(beforeAwaiting);
      appState.selected.clear(); rerender();
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
  if (!appState.pmap && !(await ensureRegionFile())) return;
  try {
    const engine = cvEngine();
    const guard = engine === 'opencv' ? 120000 : 60000;
    const res = normalizeDetection(await whileTicking(
      `Detecting regions on page ${appState.page}…`, () => viewer.detectRegions(appState.page, { tier: detectTier(), engine, onProgress: detectionProgress }),
      guard, `timed out after ${guard / 1000} s`).finally(() => clearProgress()));
    setStatus(`Reviewing ${res.regions.length} proposal${res.regions.length === 1 ? '' : 's'} on page ${appState.page}…`);
    const out = await detectCommand([{ page: appState.page, res }], { extract: detectExtract() });
    if (out.cancelled) { setStatus(`Detection cancelled — nothing on page ${appState.page} changed.`); return; }
    const note = (res.notes && res.notes.length) ? ` — ${res.notes.join('; ')}` : '';
    setStatus(detectionSummary(out.stats, ` on page ${appState.page}${tierNote([res])}`) + note);
  } catch (e) {
    setStatus('Detection failed: ' + ((e && e.message) || e));
  }
}

async function detectRegionsAllPages() {
  if (!viewer.doc) { setStatus('Open a PDF first.'); return; }
  if (!appState.pmap && !(await ensureRegionFile())) return;
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
function clearItemSelection() { appState.itemSelection.clear(); }
function isItemSelected(regionId, index) {
  // Preserve the pre-existing single-item behavior: the active item index is drawn as a box
  // handle even when the toolbar selection was handed back to the region (Alt press, mode
  // switch). The explicit page-wide set takes over only when Ctrl/Cmd+A filled it.
  if (appState.itemSelection.size) return appState.itemSelection.has(itemKey(regionId, index));
  return currentRegion()?.id === regionId && appState.itemIndex === index;
}
function selectSingle(id) { appState.selected.clear(); appState.selected.add(id); appState.selectedVertex = null; appState.itemIndex = 0; appState.itemSelected = false; clearItemSelection(); rerender(); }
function toggleSelect(id) { appState.selectedVertex = null; appState.itemSelected = false; clearItemSelection(); appState.selected.has(id) ? appState.selected.delete(id) : appState.selected.add(id); rerender(); }
// Where the PDF-language ("digital") content lives right now. The active variant is the
// source when its language is the PDF's; otherwise a variant switched away from is read from
// the session cache. If that source was never loaded, no region has a digital version yet.
function digitalSourceState() {
  const pdfLang = String(appState.pdfLanguage || '').toLowerCase();
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
  if (!appState.pmap || !isEditMode()) return;
  const source = digitalSourceState();
  const c = workflowCopy();
  const regions = currentRegions().filter(r => isTextConvertible(r, source));
  if (!regions.length) { setStatus(c.noMissing); return; }
  clearItemSelection();
  appState.selected = new Set(regions.map(r => r.id));
  appState.selectedVertex = null; appState.itemIndex = 0; appState.itemSelected = false;
  setStatus(c.selectedMissing(regions.length));
  rerender();
}
// Ctrl/Cmd+A: geometry in Region mode, every text/image item on the page in Content mode.
function selectAll() {
  if (!appState.pmap || !isEditMode()) return;
  const regions = currentRegions();
  if (inRegion()) {
    if (!regions.length) { setStatus('No regions on this page.'); return; }
    clearItemSelection();
    appState.selected = new Set(regions.map(r => r.id));
    appState.selectedVertex = null; appState.itemIndex = 0; appState.itemSelected = false;
    setStatus(`${regions.length} region${regions.length === 1 ? '' : 's'} selected.`);
    rerender();
    return;
  }
  const withItems = regions.filter(r => (r.content?.items || []).length);
  const count = withItems.reduce((n, r) => n + r.content.items.length, 0);
  if (!count) { setStatus('No content items on this page.'); return; }
  clearItemSelection();
  for (const r of withItems) r.content.items.forEach((_, i) => appState.itemSelection.add(itemKey(r.id, i)));
  appState.selected = new Set(withItems.map(r => r.id));
  appState.selectedVertex = null; appState.itemIndex = 0; appState.itemSelected = true;
  setStatus(`${count} content item${count === 1 ? '' : 's'} selected on this page.`);
  rerender();
}
// Do two axis-aligned [x0,y0,x1,y1] boxes overlap? (used by the selection marquee)
function rectsIntersect(a, b) { return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1]; }
function currentRegions() { return appState.pmap ? (getPage(appState.pmap, appState.page)?.regions || []) : []; }
function selectedRegions() { return currentRegions().filter(r => appState.selected.has(r.id)); }

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
    if (!appState.selected.has(id)) selectSingle(id);
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
    els.fOcr.hidden = !(isEditMode() && appState.awaitingOcr.has(r.id));
    els.fOcr.textContent = workflowCopy().missing;
    els.fOcr.title = contentIsImprove()
      ? 'No usable selectable text under this region — the source is a scan, an image, or a broken text layer. Right-click the region and choose Read with OCR.'
      : 'No usable source text under this region — the source is a scan, an image, or a broken text layer. Right-click the region and choose Read with OCR.';
  }
  const items = r.content?.items || [];
  if (appState.itemIndex >= items.length) appState.itemIndex = items.length - 1;
  if (appState.itemIndex < 0) appState.itemIndex = 0;
  renderItemsPanel(items);
  syncItemEditor(items[appState.itemIndex] || null);
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
      appState.itemIndex = idx; appState.itemSelected = true; clearItemSelection(); syncPropsForm(); refreshContextTools();
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
    do() { fn(r.content); clearDetection(r); appState.awaitingOcr.delete(r.id); touch(appState.pmap); rerender(); },
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
  const idx = appState.itemIndex;
  mutateContent(label, (c) => { const it = c.items[idx]; if (it) fn(it); });
}

// Absolute PDF boxes for the selected region's items, for overlay rendering.
function buildItemBoxes(region) {
  if (!region || !appState.overlayVisible) return [];
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
    do() { commitTextPlacement(r, item, fit); touch(appState.pmap); rerender(); },
    undo() { r.content = structuredClone(beforeContent); rerender(); },
  });
}
function commitTextPlacement(r, item, fit) {
  r.content.items.push(item);
  clearDetection(r); // content add is user involvement (§21 rule 4)
  appState.awaitingOcr.delete(r.id); // a region with content is not awaiting OCR any more (§20)
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
  appState.itemIndex = r.content.items.indexOf(item);
  appState.itemSelected = true; clearItemSelection();
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
  appState.itemIndex = content.items.indexOf(item);
  appState.itemSelected = true; clearItemSelection();
}

async function addTextItem() {
  let r = currentRegion();
  if (!r) { setStatus('Select a region first, then add text.'); return; }
  const rid = r.id;
  if (!appState.content && !(await ensureContentFile())) return;
  // A newly created variant rebuilds the region objects and clears the selection.
  r = regionById(rid);
  if (!r) { setStatus('The selected region is no longer available.'); return; }
  if (!appState.selected.size) appState.selected = new Set([rid]);
  // Improve edits source text. If the active variant is a translation (or its language is
  // still unknown), establish the PDF-language/Selectable-text variant before opening the
  // editor; otherwise the words typed here would land in the target variant. The guard is
  // the normal extraction-language flow, so it asks at most once and never silently changes
  // a variant the user is editing.
  if (contentIsImprove() && !activeVariantIsSource()) {
    const ids = selectedRegions().map(x => x.id);
    if (!(await ensureExtractionVariant('Add source text'))) return;
    const sel = ids.map(regionById).filter(Boolean);
    if (!sel.length) { setStatus('The selected region is no longer available.'); return; }
    appState.selected = new Set(sel.map(x => x.id));
    appState.selectedVertex = null;
    r = sel[0];
  }
  // Placing an item is editorial work, so the region menu's Add text / Add image drop the
  // user into Content mode with the new item selected and its dialog open (spec §9a).
  if (!inContent()) setMode('content');
  openInlineEditor(r, null, { box: textRect(r), style: {} });
}

// Add image: file picker is the explicit path; Ctrl+V is handled globally.
async function addImageItem() {
  const r = currentRegion();
  if (!r) { setStatus('Select a region first, then add an image.'); return; }
  const rid = r.id;
  if (!appState.content && !(await ensureContentFile())) return;
  if (!appState.selected.size) appState.selected = new Set([rid]);
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
  const idx = appState.itemIndex;
  mutateContent('delete item', (c) => { c.items.splice(idx, 1); appState.itemIndex = Math.max(0, Math.min(idx, c.items.length - 1)); appState.itemSelected = c.items.length > 0; });
}

// Delete every item picked by Ctrl/Cmd+A in Content mode, across regions, as one undo step.
// The page-wide selection is an editorial convenience; it deliberately does not bulk-run any
// other item command (fit, z-order), whose result is only meaningful for one active item.
function selectedItemRefs() {
  const refs = [];
  for (const r of currentRegions()) {
    (r.content?.items || []).forEach((it, i) => {
      if (appState.itemSelection.has(itemKey(r.id, i))) refs.push({ r, i });
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
        appState.awaitingOcr.delete(r.id);
      }
      appState.selected.clear(); appState.selectedVertex = null; appState.itemIndex = 0;
      appState.itemSelected = false; clearItemSelection();
      touch(appState.pmap);
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
  const idx = appState.itemIndex;
  const j = where === 'front' ? items.length - 1 : 0;
  if (idx < 0 || idx >= items.length || idx === j) return;
  mutateContent(where === 'front' ? 'bring item to front' : 'send item to back', (c) => {
    const [it] = c.items.splice(idx, 1);
    c.items.splice(j, 0, it);
    appState.itemIndex = j;
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
  appState.selected.clear(); appState.selected.add(id);
  appState.itemIndex = idx; appState.itemSelected = true; clearItemSelection();
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
  const pg = getPage(appState.pmap, appState.page);
  return (pg?.regions || []).reduce((n, r) => n + (r.content?.items || []).filter(it => it.type === 'text').length, 0);
}
function resizeAllTextInPage() {
  const pg = getPage(appState.pmap, appState.page);
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
  if (!boxes) { setStatus(`No text boxes on page ${appState.page}.`); return; }
  if (!plans.length) {
    setStatus(clipped
      ? `All ${boxes} text box(es) on page ${appState.page} already match their text, but ${clipped} still need a bigger region (the polygon clips the overhang and is painted orange).`
      : `All ${boxes} text box(es) on page ${appState.page} already match their text.`);
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
    do() { apply('after'); touch(appState.pmap); rerender(); },
    undo() { apply('before'); rerender(); },
  });
  setStatus(`Resized ${plans.length} of ${boxes} text box(es) on page ${appState.page}${tightened ? `, tightening the line spacing of ${tightened}` : ''}${shrunk ? `, reducing the font of ${shrunk}` : ''}${clipped ? ` — ${clipped} still need a bigger region (the polygon clips the overhang and is painted orange)` : ''}.`);
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
// Prefer a non-collapsed selection: clicking a toolbar button can collapse the live caret,
// but the user's intended selection is still the one captured on pointerdown. Without this,
// every format button would only set a pending style instead of formatting the selection.
function liveRange() {
  const sel = window.getSelection();
  const live = (sel && sel.rangeCount && els.inlineEdit.contains(sel.getRangeAt(0).commonAncestorContainer))
    ? sel.getRangeAt(0) : null;
  const captured = (capturedSel && els.inlineEdit.contains(capturedSel.commonAncestorContainer))
    ? capturedSel : null;
  if (live && !live.collapsed) return live;
  if (captured && !captured.collapsed) return captured;
  return live || captured;
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
function renderEditor() { clearEditorDomCaches(); els.inlineEdit.innerHTML = blocksToHtml(inlineState.blocks, inlineState.style); }
function readEditor() {
  if (!inlineState) return;
  clearEditorDomCaches();
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
  // Structural conversions change a flow's path (paragraph "3" ↔ list "3.0", or a table
  // cell "3.0.1"), so fall back to the first flow of the same block instead of dropping
  // the selection entirely (e.g. after pressing the bullet/numbering buttons).
  const findFlow = (path) => {
    const exact = els.inlineEdit.querySelector(`[data-flow="${path}"]`);
    if (exact) return exact;
    const bi = String(path).split('.')[0];
    return flowsInEditor().find(f => String(pathOf(f)).split('.')[0] === bi) || null;
  };
  const sEl = findFlow(save.sPath);
  const eEl = findFlow(save.ePath) || sEl;
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

// Resize the reference page-crop image inside the text editor dialog. Drag the small
// handle at its bottom-right corner; the image keeps its aspect-free size (width and
// height are set explicitly so it can grow past the default caps).
let sourceResize = null;
function sourceResizeStart(e, img) {
  e.preventDefault();
  if (sourceResize) return;
  const rect = img.getBoundingClientRect();
  // Drop the default caps so the image can be grown; then size explicitly.
  img.style.maxWidth = 'none';
  img.style.maxHeight = 'none';
  img.style.width = Math.round(rect.width) + 'px';
  img.style.height = Math.round(rect.height) + 'px';
  sourceResize = { img, startX: e.clientX, startY: e.clientY, startW: rect.width, startH: rect.height };
  img.style.cursor = 'se-resize';
  document.addEventListener('pointermove', sourceResizeMove);
  document.addEventListener('pointerup', sourceResizeEnd);
}
function sourceResizeMove(e) {
  if (!sourceResize) return;
  const w = Math.max(60, sourceResize.startW + (e.clientX - sourceResize.startX));
  const h = Math.max(40, sourceResize.startH + (e.clientY - sourceResize.startY));
  sourceResize.img.style.width = w + 'px';
  sourceResize.img.style.height = h + 'px';
}
function sourceResizeEnd() {
  if (!sourceResize) return;
  sourceResize.img.style.cursor = '';
  sourceResize = null;
  document.removeEventListener('pointermove', sourceResizeMove);
  document.removeEventListener('pointerup', sourceResizeEnd);
}

// Split pane resize handler (for source image / editor pane divider)
let splitResize = null;
function splitResizeStart(e) {
  e.preventDefault();
  if (splitResize) return;
  const splitPane = e.target.closest('.tm-split-pane');
  const sourcePane = splitPane?.querySelector('.tm-source-pane');
  const editorPane = splitPane?.querySelector('.tm-editor-pane');
  if (!sourcePane || !editorPane) return;
  
  const rect = splitPane.getBoundingClientRect();
  const sourceRect = sourcePane.getBoundingClientRect();
  
  splitResize = { 
    splitPane, sourcePane, editorPane,
    startX: e.clientX, 
    startSourceWidth: sourceRect.width,
    splitWidth: rect.width
  };
  
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
  e.target.classList.add('dragging');
  
  document.addEventListener('pointermove', splitResizeMove);
  document.addEventListener('pointerup', splitResizeEnd);
}

function splitResizeMove(e) {
  if (!splitResize) return;
  const { splitPane, sourcePane, editorPane, startX, startSourceWidth, splitWidth } = splitResize;
  const dx = e.clientX - startX;
  const newSourceWidth = startSourceWidth + dx;
  const minSourceWidth = 150;
  const maxSourceWidth = splitWidth - 200; // leave at least 200px for editor
  
  const clampedWidth = Math.max(minSourceWidth, Math.min(maxSourceWidth, newSourceWidth));
  const sourcePercent = (clampedWidth / splitWidth) * 100;
  
  splitResize.sourcePane.style.flex = `0 0 ${sourcePercent}%`;
  splitResize.editorPane.style.flex = `1 1 auto`;
}

function splitResizeEnd() {
  if (!splitResize) return;
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
  if (splitResize && splitResize.sourcePane) {
    splitResize.sourcePane.style.cursor = '';
    splitResize.sourcePane.classList.remove('dragging');
  }
  splitResize = null;
  document.removeEventListener('pointermove', splitResizeMove);
  document.removeEventListener('pointerup', splitResizeEnd);
}

// Fullscreen toggle for text editor dialog
let textEditorFullscreen = false;
let textEditorPrevSize = null; // { width, height, left, top }

function toggleTextEditorFullscreen() {
  const modal = els.textModal?.querySelector('.text-box-modal');
  if (!modal) return;
  
  textEditorFullscreen = !textEditorFullscreen;
  els.tmFullscreen?.classList.toggle('active', textEditorFullscreen);
  
  if (textEditorFullscreen) {
    // Save current size and position
    textEditorPrevSize = {
      width: modal.style.width || '',
      height: modal.style.height || '',
      left: modal.style.left || '',
      top: modal.style.top || ''
    };
    // Set to full viewport
    modal.style.width = '100vw';
    modal.style.height = '100vh';
    modal.style.left = '0';
    modal.style.top = '0';
    modal.style.maxWidth = 'none';
    modal.style.maxHeight = 'none';
    modal.style.borderRadius = '0';
    document.body.style.overflow = 'hidden'; // Prevent background scrolling
  } else {
    // Restore previous size and position
    if (textEditorPrevSize) {
      modal.style.width = textEditorPrevSize.width;
      modal.style.height = textEditorPrevSize.height;
      modal.style.left = textEditorPrevSize.left;
      modal.style.top = textEditorPrevSize.top;
      modal.style.maxWidth = '';
      modal.style.maxHeight = '';
      modal.style.borderRadius = '';
    }
    document.body.style.overflow = '';
  }
  
  // Re-render to adjust editor layout
  if (inlineState) {
    renderEditor();
    styleInlineEditor();
  }
}

function openInlineEditor(region, index, { box, style, blocks } = {}) {
  appState.selected.clear(); appState.selected.add(region.id);
  appState.itemSelected = true; clearItemSelection();
  if (index != null) appState.itemIndex = index;
  const st = normalizeStyle(style);
  // Preference defaults fill in anything the item did not set explicitly, so new
  // items and new typing start from the user's chosen defaults rather than the
  // built-in ones.
  if (!style || style.font === undefined) st.font = defaultFont();
  if (!style || style.size === undefined) st.size = defaultSize();
  if (!style || style.lineHeight === undefined) st.lineHeight = defaultLineHeight();
  // Default state is always regular: new typing never inherits bold/italic/underline
  // from the item's stored style or from a previously edited item.
  st.bold = false; st.italic = false; st.underline = false;
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
  // Wire the split pane resize handle.
  if (els.textModal) {
    const splitHandle = els.textModal.querySelector('#tm-split-handle');
    if (splitHandle && !splitHandle.dataset.splitResize) {
      splitHandle.dataset.splitResize = '1';
      splitHandle.addEventListener('pointerdown', splitResizeStart);
    }
  }
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
  openInlineEditor(r, appState.itemIndex, { box: item.box, style: item.style, blocks: itemBlocks(item) });
  return true;
}

// Mirror the item's *look* in the dialog's text area: the font size is the item's real size in
// PDF points (1 pt = 1 px, never magnified), with its family, colour, direction and line
// spacing, so what is typed looks like what the page will hold. The area's size is the
// dialog's, not the box's (the box is sized on the page — see the note above); the header
// still reports the box's real size so it is never a mystery.
function styleInlineEditor() {
  if (!inlineState || els.inlineEdit.hidden) return;
  const r = getPage(appState.pmap, appState.page)?.regions.find(x => x.id === inlineState.regionId);
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
  // Fast path: use TreeWalker for efficient tree traversal
  if (node === root && node.nodeType === 1) {
    let count = 0;
    for (let m = 0; m < offset && m < node.childNodes.length; m++) count += subtreeUnits(node.childNodes[m]);
    return count;
  }
  // Create a range from root start to the target point
  const range = document.createRange();
  range.setStart(root, 0);
  range.setEnd(node, offset);
  // Get text content, excluding zero-width spaces
  const text = range.toString();
  let count = 0;
  for (const ch of text) if (ch !== '\u200b') count++;
  return count;
}

// Cache for collectUnits results per flow element (invalidated on readEditor/renderEditor)
const unitsCacheRef = { current: new WeakMap() };
function getUnits(root) {
  const unitsCache = unitsCacheRef.current;
  let cached = unitsCache.get(root);
  if (cached) return cached;
  const units = [];
  const walk = (n) => {
    for (const c of n.childNodes) {
      if (c.nodeType === 3) { for (let i = 0; i < c.nodeValue.length; i++) { if (ignoreChar(c.nodeValue[i])) continue; units.push({ node: c, i }); } }
      else if (c.nodeType === 1) { if (c.tagName === 'BR') units.push({ node: c, br: true }); else walk(c); }
    }
  };
  walk(root);
  unitsCache.set(root, units);
  return units;
}

function collectUnits(root) { return getUnits(root); }
function indexInParent(node) { return Array.prototype.indexOf.call(node.parentNode.childNodes, node); }
function locateOffset(root, units, off) {
  if (!units.length) return [root, 0];
  if (off <= 0) { const u = units[0]; return u.br ? [u.node.parentNode, indexInParent(u.node)] : [u.node, 0]; }
  if (off >= units.length) { const u = units[units.length - 1]; return u.br ? [u.node.parentNode, indexInParent(u.node) + 1] : [u.node, u.node.nodeValue.length]; }
  const u = units[off];
  return u.br ? [u.node.parentNode, indexInParent(u.node) + 1] : [u.node, u.i];
}
function offsetToDom(root, off) { return locateOffset(root, getUnits(root), off); }

function clearEditorDomCaches() {
  unitsCacheRef.current = new WeakMap();
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
  const range = liveRange();
  // A pending style describes what the caret will type next. It must not mask the real
  // style of an actual selection, or a leftover pending style would keep Bold (or any
  // other toggle) shown as active while the user selects ordinary text.
  const hasSelection = !!(range && !range.collapsed);
  if (inlineState.pending && !hasSelection) return normalizeStyle(inlineState.pending);
  const el = range ? closestFlow(range.startContainer) : null;
  const hit = el ? flowAt(inlineState.blocks, pathOf(el)) : null;
  if (!hit) return baseOfBlocks();
  const base = baseForFlow(hit.block, hit.flow);
  const value = String(hit.flow.value || '');
  if (!value.length) return normalizeStyle(base);
  const cs = charStyles(hit.flow, base);
  const off = range ? domPointToOffset(el, range.startContainer, range.startOffset) : 0;
  return cs[Math.max(0, Math.min(value.length - 1, off))] || normalizeStyle(base);
}

function applyTextFormat(kind, value) {
  if (!ensureEditorOpen()) return;
  // The pending style (if the caret is mid-formatting) is the base for the collapsed-caret
  // path: starting from it keeps other attributes when toggling one (bold then italic).
  const previousPending = inlineState.pending;
  inlineState.pending = null;
  readEditor();
  const range = liveRange();
  const sFlow = range ? closestFlow(range.startContainer) : null;
  const eFlow = range ? closestFlow(range.endContainer) : null;
  if (!range || !sFlow || !eFlow) { caretToEnd(); const r2 = liveRange(); if (r2) insertPending(kind, value, previousPending); refreshContextTools(); return; }

  if (range.collapsed && sFlow === eFlow) { insertPending(kind, value, previousPending); refreshContextTools(); return; }

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
function insertPending(kind, value, previousPending) {
  const range = liveRange();
  const el = range ? closestFlow(range.startContainer) : null;
  const hit = el ? flowAt(inlineState.blocks, pathOf(el)) : null;
  if (!hit) return;
  const { block, flow } = hit;
  const base = baseForFlow(block, flow);
  const n = String(flow.value || '').length;
  const off = range ? domPointToOffset(el, range.startContainer, range.startOffset) : n;
  const cs = n ? charStyles(flow, base) : null;
  // If the caret already sits in a pending marker (the user pressed another format
  // control before typing), that marker is the style base and is restyled in place —
  // markers would otherwise accumulate and the other attributes would be lost.
  const pendingEl = (() => {
    const node = range ? range.startContainer : null;
    const nodeEl = node && node.nodeType === 1 ? node : (node ? node.parentElement : null);
    return nodeEl && nodeEl.closest ? nodeEl.closest('[data-pending]') : null;
  })();
  const at = (pendingEl && previousPending)
    ? normalizeStyle(previousPending)
    : (n ? (cs[Math.max(0, Math.min(n - 1, off))] || normalizeStyle(base)) : normalizeStyle(base));
  // Start from the effective style at the caret (not the bare block base): toggling one
  // attribute (e.g. italic) must keep the others (e.g. bold) that the caret already has.
  const pend = { ...normalizeStyle(at) };
  if (kind === 'bold') pend.bold = value === undefined ? !at.bold : !!value;
  else if (kind === 'italic') pend.italic = value === undefined ? !at.italic : !!value;
  else if (kind === 'underline') pend.underline = value === undefined ? !at.underline : !!value;
  else if (kind === 'color') pend.color = value;
  else if (kind === 'font') pend.font = value;
  else if (kind === 'size') pend.size = Math.max(4, Math.min(200, Number(value) || 12));
  else if (kind === 'dir') pend.direction = value === 'rtl' ? 'rtl' : 'ltr';
  else if (kind === 'fontWeight') pend.bold = value === 'bold';
  else if (kind === 'background') {
    // background color is applied to the whole block/item, not as a run
    // we'll handle this differently - for now just set pending
    pend.background = value;
  }
  inlineState.pending = pend;
  if (range && !range.collapsed) return;
  if (!range) return;
  if (pendingEl) { pendingEl.setAttribute('style', spanCss(pend)); return; }
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
  // A non-collapsed selection is the user's working range: keep it across the structural
  // change instead of replacing it with a caret inside a newly inserted table.
  const hadSelection = !!(save && (save.sPath !== save.ePath || save.sOff !== save.eOff));
  if (kind === 'table') {
    inlineState.blocks.splice(bi + 1, 0, newTableBlock(2, 2));
    ensureTrailingParagraph(inlineState.blocks, inlineState.style);
  } else if (kind === 'ul' || kind === 'ol') {
    const ordered = kind === 'ol';
    // Toggle: if current block is already a list with same ordered state, convert to paragraph
    if (b && b.type === 'list' && b.ordered === ordered) {
      const items = b.items.map(it => ({ value: it.value, runs: it.runs || [], level: it.level || 0 }));
      inlineState.blocks[bi] = { type: 'paragraph', value: (items[0]?.value || '').replace(/\n+$/, ''), runs: items[0]?.runs || [], align: b.align, direction: b.direction };
    } else if (b && b.type === 'list') {
      // Switch list type
      b.ordered = ordered;
    } else if (b) {
      const items = b.type === 'paragraph' || b.type === 'heading'
        ? [{ value: (b.value || '').replace(/\n+$/, ''), runs: b.runs || [], level: 0 }]
        : [{ value: '', runs: [], level: 0 }];
      inlineState.blocks[bi] = { type: 'list', ordered, direction: b.direction || 'ltr', items };
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
  if (kind === 'table' && !hadSelection) {
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
    if (b.rows.length <= 1) {
      // Convert table to paragraph if it would become empty
      const cellsText = b.rows.flatMap(r => r.cells.map(c => c.value)).join(' ');
      inlineState.blocks[bi] = { type: 'paragraph', value: cellsText, runs: [], align: 'left', direction: b.dir };
    } else {
      b.rows.splice(row, 1);
    }
  } else if (kind === 'addCol') {
    b.columns.splice(col + 1, 0, { width: b.columns[col]?.width || DEFAULT_COL_WIDTH });
    for (const r of b.rows) r.cells.splice(col + 1, 0, mkCell());
  } else if (kind === 'delCol') {
    if (b.columns.length <= 1) {
      // Convert table to paragraph if it would become empty
      const cellsText = b.rows.flatMap(r => r.cells.map(c => c.value)).join(' ');
      inlineState.blocks[bi] = { type: 'paragraph', value: cellsText, runs: [], align: 'left', direction: b.dir };
    } else {
      b.columns.splice(col, 1);
      for (const r of b.rows) r.cells.splice(col, 1);
    }
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
  if (!appState.pmap || !appState.itemSelected || !inContent()) return null;
  return currentRegion()?.content?.items?.[appState.itemIndex] || null;
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
  const editing = isEditMode() && !!appState.pmap;
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
  // Coloring mode (eyedropper) toggle: shown in Region mode only; pressed while color mode
  // is on — the same state pressing C toggles (see toggleColoringMode / spec §11).
  if (els.btnColoringMode) {
    const coloring = editing && inRegion();
    els.btnColoringMode.hidden = !coloring;
    els.btnColoringMode.setAttribute('aria-pressed', String(appState.coloringMode));
  }
  if (els.itemTools) els.itemTools.hidden = !itemSel;
  // Add text / Add image place items, so they are the two Content-mode-only buttons of the
  // region group (spec §9a).
  if (els.regionAddTools) els.regionAddTools.hidden = !(regionSel && inContent());
  const textSelection = regionSel && selectedRegions().some(x => !isDetectedImage(x));
  const tbl = inlineText ? tableTarget() : null;
  // Border tools are always visible in toolbar row 1 (not hidden)
  if (textSel) {
    const st = editorCurrentStyle();
    els.ttBold.classList.toggle('active', !!st.bold);
    els.ttItalic.classList.toggle('active', !!st.italic);
    els.ttUnderline.classList.toggle('active', !!st.underline);
    // Update text color button
    if (els.ttColorInput) els.ttColorInput.value = st.color || '#111111';
    const letter = els.ttColor?.querySelector('.letter');
    if (letter) letter.style.color = st.color || '#111111';
    els.ttFont.value = st.font || 'sans';
    
    // Update list buttons (toggle state)
    const range = liveRange();
    const el = range ? closestFlow(range.startContainer) : null;
    const hit = el ? flowAt(inlineState.blocks, pathOf(el)) : null;
    const block = hit?.block;
    if (els.ttUl) els.ttUl.classList.toggle('active', block?.type === 'list' && block.ordered === false);
    if (els.ttOl) els.ttOl.classList.toggle('active', block?.type === 'list' && block.ordered === true);
    // Update size display
    if (els.ttSize) {
      const sizeVal = Math.round((st.size ?? 12) * 2) / 2;
      els.ttSize.value = sizeVal;
    }
    // Update line spacing display
    if (els.ttLine) {
      const lineVal = String(lineHeightOf(inlineState.style));
      els.ttLine.value = lineVal;
    }
    // Update alignment buttons
    const align = tbl ? (tbl.block.rows[tbl.row]?.cells?.[tbl.col]?.align) : st.align;
    [els.ttAlignLeft, els.ttAlignCenter, els.ttAlignRight, els.ttAlignJustify].forEach(btn => {
      if (btn) btn.classList.remove('active');
    });
    const alignMap = { left: els.ttAlignLeft, center: els.ttAlignCenter, right: els.ttAlignRight, justify: els.ttAlignJustify };
    if (alignMap[align]) alignMap[align].classList.add('active');
    // Update direction buttons
    const dir = st.direction || 'ltr';
    if (els.ttDirLtr) els.ttDirLtr.classList.toggle('active', dir === 'ltr');
    if (els.ttDirRtl) els.ttDirRtl.classList.toggle('active', dir === 'rtl');
  } else if (imgSel) {
    els.fItemFit.value = item.fit || 'contain';
  } else if (regionSel) {
    els.fBg.value = r.content?.background || DEFAULT_BACKGROUND;
    const lk = $('btn-lock-region');
    if (lk) { lk.textContent = isRegionLocked(r) ? 'Unlock region' : 'Lock region'; lk.classList.toggle('active', isRegionLocked(r)); }
  }
  if (itemSel && els.itemTools) {
    const n = r?.content?.items?.length || 0;
    if (els.btnItemFitText) els.btnItemFitText.disabled = item.type !== 'text';
    if (els.btnItemFront) els.btnItemFront.disabled = !(n > 1 && appState.itemIndex < n - 1);
    if (els.btnItemBack) els.btnItemBack.disabled = !(n > 1 && appState.itemIndex > 0);
  }
  if (tbl && els.tableTools) {
    const borderColor = tbl.block.border?.color || DEFAULT_TABLE_BORDER.color;
    const borderWidth = tbl.block.border?.width ?? DEFAULT_TABLE_BORDER.width;
    // Update table tools group (for col width, row height, table width)
    els.tblBorderColor.value = borderColor;
    els.tblBorderWidth.value = borderWidth;
    els.tblColW.value = Math.round(tbl.block.columns[tbl.col]?.width || DEFAULT_COL_WIDTH);
    els.tblRowH.value = Math.round(tbl.block.rows[tbl.row]?.height || DEFAULT_ROW_HEIGHT);
    if (els.tblWidth) els.tblWidth.value = Math.round(tbl.block.columns.reduce((a, c) => a + Math.max(8, Number(c.width) || DEFAULT_COL_WIDTH), 0));
    // Update table border tools in toolbar row 1
    if (els.tblBorderColor) els.tblBorderColor.value = borderColor;
    if (els.tblBorderWidth) els.tblBorderWidth.value = borderWidth;
    if (els.tblBorderSwatch) els.tblBorderSwatch.style.backgroundColor = borderColor;
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
  const r = getPage(appState.pmap, appState.page)?.regions.find(x => x.id === regionId);
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
    } else if (cur && cur.needsReview) {
      // Pressing Done on a review-flagged item without edits still clears the flag —
      // "Done" means "I've reviewed this" (spec §7).
      mutateContentFor(r, 'confirm review', (c) => { c.items[index].needsReview = false; });
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
    const blob = await viewer.cropPolygonBlob(appState.page, regionRings(region.geometry), 2);
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
  // Leave full-page mode before hiding: otherwise the saved size is never restored and the
  // page would stay scroll-locked after the dialog closes.
  if (textEditorFullscreen) toggleTextEditorFullscreen();
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

// Debounced selectionchange handler using rAF to avoid running on every keystroke
let selectionChangeFrame = 0;
document.addEventListener('selectionchange', () => {
  if (!inlineState || els.inlineEdit.hidden) return;
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !els.inlineEdit.contains(sel.getRangeAt(0).commonAncestorContainer)) return;
  if (selectionChangeFrame) cancelAnimationFrame(selectionChangeFrame);
  selectionChangeFrame = requestAnimationFrame(() => {
    captureEditorSel();
    // A pending style only applies to the caret's next typed characters. It is stale once
    // the user selects text or moves the caret out of the marker it was set on — clear it so
    // the toolbar reflects the actual text instead of a leftover pending format (e.g. Bold
    // stuck active after the caret moved elsewhere).
    if (inlineState && inlineState.pending) {
      const range = sel.getRangeAt(0);
      const node = range.startContainer;
      const el = node && node.nodeType === 1 ? node : (node ? node.parentElement : null);
      const marker = el && el.closest ? el.closest('[data-pending]') : null;
      if (!range.collapsed || !marker) inlineState.pending = null;
    }
    updateActiveFlow();
    refreshContextTools();
  });
});

// ---- table column / row resize by dragging the grips ----
els.inlineEdit.addEventListener('pointerdown', (e) => {
  if (!inlineState) return;
  const t = e.target;
  const colGrip = t.closest && t.closest('.rt-colgrip');
  const rowGrip = !colGrip && t.closest && t.closest('.rt-rowgrip');
  const tableMove = t.closest && t.closest('.rt-table-move-handle');
  if (tableMove) {
    e.preventDefault();
    e.stopPropagation();
    const tableWrap = tableMove.closest('.rt-blk.rt-table');
    const bi = tableWrap ? +tableWrap.dataset.blk : -1;
    const b = inlineState.blocks[bi];
    if (!b || b.type !== 'table') return;
    const startX = e.clientX;
    const startOffsetX = b.offsetX || 0;
    const move = (ev) => {
      const delta = ev.clientX - startX;
      const newOffsetX = Math.max(0, Math.round(startOffsetX + delta));
      tableWrap.style.marginLeft = `${newOffsetX}px`;
      tableMove.classList.add('dragging');
    };
    const up = () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      tableMove.classList.remove('dragging');
      // margin-left was applied live; readEditor picks it up from the DOM
      readEditor();
      renderEditor();
      refreshContextTools();
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    return;
  }
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
  const pg = getPage(appState.pmap, appState.page);
  const before = pg.regions.filter(r => ids.has(r.id)).map(r => structuredClone(r));
  const apply = () => { pg.regions.filter(r => ids.has(r.id)).forEach(fn); };
  const restore = () => { before.forEach(b => { const i = pg.regions.findIndex(r => r.id === b.id); if (i >= 0) pg.regions[i] = structuredClone(b); }); };
  history.exec({ label, do() { apply(); touch(appState.pmap); rerender(); }, undo() { restore(); rerender(); } });
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
  const pg = getPage(appState.pmap, appState.page);
  const before = pg.regions.filter(r => ids.has(r.id)).map(r => ({ id: r.id, locked: isRegionLocked(r), provenance: detectionSnapshot(r) }));
  const setAll = (v) => {
    for (const b of before) {
      const r = pg.regions.find(x => x.id === b.id);
      if (!r) continue;
      if (v) { r.locked = true; clearDetection(r); } else delete r.locked;
    }
  };
  appState.selectedVertex = null; // a picked vertex makes no sense on a frozen polygon
  history.exec({
    label: lock ? 'lock region(s)' : 'unlock region(s)',
    do() { setAll(lock); touch(appState.pmap); rerender(); },
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
  for (const p of appState.draft) {
    const last = dedup[dedup.length - 1];
    if (!last || Math.hypot(last[0] - p[0], last[1] - p[1]) > 0.5) dedup.push(p);
  }
  if (dedup.length > 1) {
    const f = dedup[0], l = dedup[dedup.length - 1];
    if (Math.hypot(f[0] - l[0], f[1] - l[1]) < 0.5) dedup.pop();
  }
  if (!draftValid(dedup)) { setStatus('Polygon needs ≥3 points.'); return; }
  const pts = dedup.map(p => [...p]);
  appState.draft = [];
  appState.itemSelected = false; clearItemSelection();
  appState.tool = 'select'; // one-shot: polygon tool disarms after a successful draw
  const pg = getPage(appState.pmap, appState.page);
  const r = createRegion(appState.page, pts);
  history.exec({
    label: 'create region',
    do() { pg.regions.push(r); appState.selected.clear(); appState.selected.add(r.id); touch(appState.pmap); rerender(); },
    undo() { pg.regions = pg.regions.filter(x => x.id !== r.id); appState.selected.clear(); rerender(); },
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
  const pg = getPage(appState.pmap, appState.page);
  const ids = new Set(sel.map(r => r.id));
  const removed = sel.map(r => ({ r: structuredClone(r), idx: pg.regions.findIndex(x => x.id === r.id) }));
  history.exec({
    label: 'delete region(s)',
    do() { pg.regions = pg.regions.filter(r => !ids.has(r.id)); for (const id of ids) appState.awaitingOcr.delete(id); appState.selected.clear(); appState.selectedVertex = null; appState.itemSelected = false; clearItemSelection(); touch(appState.pmap); rerender(); },
    undo() { for (const { r, idx } of removed) pg.regions.splice(Math.min(idx, pg.regions.length), 0, structuredClone(r)); rerender(); },
  });
}

// Delete key (spec §11.4): Content mode removes the selected item and is inert on a
// region-only selection — deleting a polygon is geometry work and needs Region mode. Region
// mode deletes the picked vertex, else the whole selected region(s).
function deleteKey() {
  if (inContent()) {
    if (appState.itemSelection.size) deleteSelectedItems();
    else if (appState.itemSelected && selectedItem()) deleteItem();
    return;
  }
  if (!inRegion()) return;
  const v = appState.selectedVertex;
  if (v) {
    const r = currentRegions().find(x => x.id === v.id);
    const ring = r && regionRings(r.geometry)[v.ring ?? 0];
    if (ring && ring.length > 3) { appState.selectedVertex = null; deleteVertex(v.id, v.ring ?? 0, v.idx); return; }
  }
  deleteSelection();
}

function applyDragPreview(regions) {
  const d = appState.dragPreview;
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
  const preview = appState.dragPreview;
  appState.dragPreview = null;
  const dx = endPt[0] - d.start[0], dy = endPt[1] - d.start[1];
  // Geometry drags on a locked region are refused (it may have been locked mid-drag).
  if (d.kind !== 'item' && d.kind !== 'item-resize') {
    const lockedTarget = getPage(appState.pmap, appState.page)?.regions.find(r => r.id === d.id && isRegionLocked(r));
    if (lockedTarget) { setStatus(`${lockedTarget.id} is locked — press L to unlock before reshaping.`); rerender(); return; }
  }
  if (Math.hypot(dx, dy) * appState.zoom < 3) {
    // A click (not a drag) on an item only selects it: the selection's own handles are
    // what you grab to move/resize it, and editing a text box happens in its dialog on
    // double-click (spec §9b). A click must never open the editor.
    rerender(); return;
  } // click, not drag
  const pg = getPage(appState.pmap, appState.page);
  if (d.kind === 'region') {
    const target = pg.regions.find(r => r.id === d.id);
    if (!target) return;
    const before = structuredClone(regionRings(target.geometry));
    const after = before.map(ring => ring.map(p => [p[0] + dx, p[1] + dy]));
    history.exec({ label: 'move region', do() { applyRings(target, after); touch(appState.pmap); rerender(); }, undo() { applyRings(target, before); rerender(); } });
  } else if (d.kind === 'vertex') {
    const target = pg.regions.find(r => r.id === d.id);
    if (!target) return;
    const ri = d.ring ?? 0;
    const before = structuredClone(regionRings(target.geometry));
    const after = before.map((ring, k) => (k === ri ? ring.map((p, i) => (i === d.idx ? [endPt[0], endPt[1]] : p)) : ring));
    if (!polygonIsValid(after[ri])) { setStatus('Invalid polygon — vertex move rejected.'); rerender(); return; }
    history.exec({ label: 'move vertex', do() { applyRings(target, after); touch(appState.pmap); rerender(); }, undo() { applyRings(target, before); rerender(); } });
  } else if (d.kind === 'edge') {
    const target = pg.regions.find(r => r.id === d.id);
    if (!target) return;
    const ri = d.ring ?? 0;
    const before = structuredClone(regionRings(target.geometry));
    const n = before[ri].length, i = d.idx, j = (d.idx + 1) % n;
    const after = before.map((ring, k) => (k === ri ? ring.map((p, ki) => (ki === i || ki === j ? [p[0] + dx, p[1] + dy] : [p[0], p[1]])) : ring));
    if (!polygonIsValid(after[ri])) { setStatus('Invalid polygon — edge move rejected.'); rerender(); return; }
    history.exec({ label: 'move edge', do() { applyRings(target, after); touch(appState.pmap); rerender(); }, undo() { applyRings(target, before); rerender(); } });
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
        touch(appState.pmap); rerender();
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
  if (dist * appState.zoom >= 12) return;
  const a = pts[edge], b = pts[(edge + 1) % pts.length];
  const np = [a[0] + (b[0]-a[0]) * t, a[1] + (b[1]-a[1]) * t];
  const before = structuredClone(rings);
  const after = rings.map((rg, k) => (k === ring ? [...rg.slice(0, edge + 1), np, ...rg.slice(edge + 1)] : rg.map(p => [...p])));
  history.exec({ label: 'add vertex', do() { applyRings(r, after); touch(appState.pmap); rerender(); }, undo() { applyRings(r, before); rerender(); } });
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
  history.exec({ label: 'right angle', do() { applyRings(r, after); touch(appState.pmap); rerender(); }, undo() { applyRings(r, before); rerender(); } });
}

function deleteVertex(id, ring, idx) {
  const pg = getPage(appState.pmap, appState.page);
  const r = pg.regions.find(x => x.id === id);
  if (!r) return;
  if (isRegionLocked(r)) { setStatus(`${r.id} is locked — press L to unlock before deleting vertices.`); return; }
  const rings = regionRings(r.geometry);
  const pts = rings[ring];
  if (!pts) return;
  if (pts.length <= 3) { setStatus('A polygon needs ≥3 vertices.'); return; }
  const before = structuredClone(rings);
  const after = rings.map((rg, k) => (k === ring ? rg.filter((_, i) => i !== idx) : rg));
  history.exec({ label: 'delete vertex', do() { applyRings(r, after); touch(appState.pmap); rerender(); }, undo() { applyRings(r, before); rerender(); } });
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
  const pg = getPage(appState.pmap, appState.page);
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
  const nr = createRegion(appState.page, rings.length === 1 ? rings[0] : rings, rings.length === 1 ? 'polygon' : 'multipolygon');
  nr.content = { background: sel[0].content?.background || DEFAULT_BACKGROUND, items };
  history.exec({
    label: 'merge regions',
    do() { pg.regions = pg.regions.filter(r => !ids.has(r.id)); for (const id of ids) appState.awaitingOcr.delete(id); pg.regions.push(nr); appState.selected.clear(); appState.selected.add(nr.id); touch(appState.pmap); rerender(); },
    undo() { pg.regions = pg.regions.filter(r => r.id !== nr.id); for (const { r, idx } of removed) pg.regions.splice(Math.min(idx, pg.regions.length), 0, structuredClone(r)); appState.selected.clear(); sel.forEach(r => appState.selected.add(r.id)); rerender(); },
  });
  setStatus(`Merged ${sel.length} regions into ${nr.id}${rings.length > 1 ? ` (${rings.length} parts)` : ''}.`);
}

function finishSplit() {
  if (appState.splitPts.length < 2) { setStatus('Split: click 2+ points for the dividing line, then Enter.'); return; }
  const sel = selectedRegions();
  if (sel.length !== 1) { setStatus('Split: select exactly one region first.'); appState.splitPts = []; appState.tool = 'select'; rerender(); return; }
  const r = sel[0];
  if (isRegionLocked(r)) { setStatus(`${r.id} is locked — press L to unlock before splitting.`); appState.splitPts = []; appState.tool = 'select'; rerender(); return; }
  if (regionRings(r.geometry).length > 1) { setStatus('Split needs a single-part region (this one was merged from separate areas).'); appState.splitPts = []; appState.tool = 'select'; rerender(); return; }
  const A = appState.splitPts[0], B = appState.splitPts[appState.splitPts.length - 1];
  appState.splitPts = [];
  let parts;
  try { parts = splitPolygonByLine(regionRings(r.geometry)[0], A, B); } catch (e) { parts = null; }
  if (!parts) { setStatus('Split failed — line must cross the polygon.'); appState.tool = 'select'; rerender(); return; }
  const pg = getPage(appState.pmap, appState.page);
  const orig = structuredClone(r);
  const idx = pg.regions.findIndex(x => x.id === r.id);
  const a = createRegion(appState.page, parts[0]); a.content = structuredClone(r.content);
  const b = createRegion(appState.page, parts[1]); b.content = structuredClone(r.content);
  history.exec({
    label: 'split region',
    do() { pg.regions.splice(idx, 1, a, b); appState.awaitingOcr.delete(r.id); appState.selected.clear(); appState.selected.add(a.id); appState.selected.add(b.id); touch(appState.pmap); rerender(); },
    undo() { pg.regions = pg.regions.filter(x => x.id !== a.id && x.id !== b.id); pg.regions.splice(Math.min(idx, pg.regions.length), 0, orig); appState.selected.clear(); appState.selected.add(orig.id); rerender(); },
  });
  appState.tool = 'select';
}

// ---- image content ----
async function cropImageForSelected() {
  const r = currentRegion();
  if (!r) { setStatus('Select exactly one region.'); return; }
  const [x0, y0, x1, y1] = regionBBox(r.geometry);
  const cur = r.content?.items?.[appState.itemIndex];
  let bbox = [x0, y0, x1, y1];
  if (cur && cur.type === 'image') {
    const b = cur.box || [0, 0, x1 - x0, y1 - y0];
    bbox = [x0 + b[0], y0 + b[1], x0 + b[0] + b[2], y0 + b[1] + b[3]];
  }
  try {
    const url = await viewer.cropDataUrl(appState.page, bbox);
    if (cur && cur.type === 'image') {
      editItem(i => { i.source = url; }, 'set image crop');
    } else {
      const [w, h] = regionSize(r);
      mutateContent('add image crop', (c) => { c.items.push(createImageItem({ source: url, box: [0, 0, w, h] })); appState.itemIndex = c.items.length - 1; appState.itemSelected = true; clearItemSelection(); });
    }
    setStatus('Cropped page area into an image item.');
  } catch (e) { setStatus('Crop failed: ' + e.message); }
}

// ---- save / export ----
// A project is saved as a ZIP file containing a folder named after the PDF
// (without the .pdf extension), with the map and content variant(s) inside.
function pdfFolderName() {
  const name = appState.pdfName || 'document';
  return name.replace(/\.pdf$/i, '') || 'document';
}

// Export the project (Ctrl/Cmd+S) — the shared map plus the active content variant —
// into a folder-named ZIP on the user's file system.
async function exportProjectPart(what = 'both') {
  if (!appState.pmap) return;
  try {
    const { map, content, changed, mapText, contentText } = await projectTexts();
    const folder = pdfFolderName();
    const JSZip = await getJSZip();
    const zip = new JSZip();
    const dir = zip.folder(folder);
    const names = [];
    if (what !== 'content') {
      dir.file(map.meta.name, mapText);
      if (appState.content) {
        appState.content.mapModified = map.meta.modified;
        appState.content.savedMap = canonical(map);
      } else {
        appState.savedMap = canonical(map);
        appState.mapModified = map.meta.modified;
      }
      names.push(`${folder}/${map.meta.name}`);
    }
    if (appState.content && what !== 'map') {
      dir.file(content.meta.name, contentText);
      appState.content = { ...appState.content, modified: content.meta.modified };
      appState.content.savedContent = canonical(content);
      names.push(`${folder}/${content.meta.name}`);
      // Save holds every loaded variant, not just the active one: write each
      // variant known this session plus both IndexedDB slots into the ZIP so
      // nothing is lost. Deduped by variant identity so the active variant (just
      // written above) isn't duplicated, and the same variant from a slot isn't
      // written twice either.
      if (what === 'both') {
        const activeKey = variantKey(content);
        const byKey = new Map();
        const addVariant = (c, defaultName) => {
          if (!c || c.mapId !== appState.content.mapId) return;
          const k = variantKey(c);
          if (k === activeKey) return; // already written as the active variant
          byKey.set(k, { content: c, name: defaultName || c.meta.name });
        };
        for (const v of appState.variants) addVariant(v.content);
        // One IndexedDB content slot ('content') holds the active variant — already
        // written above. There are no separate 'translate'/'improve' slots.
        for (const { content: c, name } of byKey.values()) {
          const text = serializeContent(c);
          dir.file(name, text);
          names.push(`${folder}/${name}`);
        }
      }
    }
    if (what !== 'content') appState.dirtySides.map = false;
    if (appState.content && what !== 'map') appState.dirtySides.content = false;
    // Persist the exported state to IndexedDB so the session (and a refresh) sees the
    // same backgrounds and content that just went into the ZIP.
    if (appState.content) {
      await saveSessionProject({ mapJson: mapText, mapName: appState.pmap.meta?.name, contentJson: contentText, contentName: appState.content.name });
    } else {
      await saveSessionProject({ mapJson: mapText, mapName: appState.pmap.meta?.name, contentJson: null, contentName: null });
    }
    const blob = await zip.generateAsync({ type: 'blob' });
    downloadBlob(blob, `${folder}.zip`);
    const only = what === 'both' && changed.map !== changed.content ? ` (only the ${changed.map ? 'shared map' : 'content variant'} had changed)` : '';
    setStatus(`Exported ${names.join(' + ')} into ${folder}.zip.${only}`);
    refreshMapInfo();
  } catch (e) { setStatus('Export failed: ' + e.message); }
}

// ---- image export ----
async function doExport() {
  if (!appState.pmap) return;
  setStatus('Exporting…');
  try {
    const bytes = await exportReconstruction({ pmap: appState.pmap, viewer, onProgress: (n, t) => setStatus(`Exporting ${n}/${t}…`) });
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (appState.pdfName || 'document.pdf').replace(/\.pdf$/i, '') + '.recon.pdf';
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
  for (const pg of appState.pmap?.pages || []) {
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
  if (!appState.pdfBytes || !appState.pmap || !appState.content) { setStatus('Open a PDF first.'); return; }
  let source = appState.pdfLanguage ? sourceVariantFor(appState.pdfLanguage) : null;
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
    if (!appState.pdfLanguage) { setStatus('Export cancelled — no extraction ran.'); return; }
    source = sourceVariantFor(appState.pdfLanguage);
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
  const name = digitalizedPdfName(appState.pdfName);
  setStatus('Exporting digitalized PDF…');
  try {
    const result = await exportDigitalizedPdf({
      pdfBytes: appState.pdfBytes, pmap: appState.pmap, content, awaitingOcr: appState.awaitingOcr,
      onProgress: (n, t) => setStatus(`Exporting digitalized PDF ${n}/${t}…`),
    });
    downloadBlob(new Blob([result.bytes], { type: 'application/pdf' }), name);
    const notes = [];
    if (result.unsupported) notes.push(`${result.unsupported} text run(s) could not be embedded`);
    if (result.fontWarning) notes.push(result.fontWarning);
    const summary = digitalizationSummary(result.stats).replace('awaiting OCR', workflowCopy().missing);
    setStatus(`Exported ${name} — ${summary}${notes.length ? `; ${notes.join('; ')}` : ''}; source untouched.`);
  } catch (e) {
    setStatus('Export failed: ' + e.message);
  }
}


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
  let s = { provider: DEFAULT_PROVIDER, endpoint: '', endpoints: {}, apiKey: '', targetLang: 'de', selectableLang: '', sourceLang: 'auto', textPadding: DEFAULT_TEXT_PADDING, detectOverlap: DEFAULT_DETECT_OVERLAP, extractAfterDetect: false, detectTier: 'auto', cvEngine: 'classical', ocrEngine: 'tesseract', defaultFont: 'sans', defaultSize: DEFAULT_STYLE.size, defaultLineHeight: DEFAULT_LINE_HEIGHT };
  try { Object.assign(s, JSON.parse(localStorage.getItem('pmap.settings') || '{}')); } catch {}
  if (!s.endpoints || typeof s.endpoints !== 'object') s.endpoints = {};
  // A missing (older build) or nonsense padding falls back to the default; the value
  // is kept in the same 0…72 pt range the dialog's number input allows.
  s.textPadding = clampPadding(s.textPadding);
  s.detectOverlap = clampDetectOverlap(s.detectOverlap);
  s.detectTier = clampDetectTier(s.detectTier);
  s.cvEngine = clampCvEngine(s.cvEngine);
  s.ocrEngine = clampOcrEngine(s.ocrEngine);
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
    const blob = await viewer.cropPolygonBlob(appState.page, regionRings(r.geometry), 2);
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
  if (!appState.selected.has(id)) selectSingle(id);
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
  const targetAwaiting = !!ocrTarget && appState.awaitingOcr.has(id) && !isDetectedImage(ocrTarget);
  const anyUnlocked = selectedRegions().some(x => !isRegionLocked(x));
  const targetLang = activeTargetLanguage();
  buildCtxMenu(e, [
    { label: 'Add text', fn: addTextItem },
    { label: 'Add image', fn: addImageItem },
    { sep: true },
    { label: 'Copy underlying content as image', fn: copySelectedAsImage },
    { label: 'Copy underlying content as text', fn: copySelectedText, enabled: hasText },
    ...(contentIsTranslate() ? [
      { label: `Translate to “${targetLang}”`, fn: () => translateSelected(), enabled: hasText },
      { label: 'Translate from page text…', fn: () => translateFromPageText() },
    ] : []),
    ...(targetAwaiting ? [{ label: workflowCopy().ocrAction, fn: () => ocrRegions([ocrTarget]) }] : []),
    { sep: true },
    { label: anyUnlocked ? 'Lock region (L)' : 'Unlock region (L)', fn: toggleLockSelected },
    { label: 'Merge selected regions', fn: mergeSelected, enabled: appState.selected.size >= 2 },
    { label: 'Split region…', fn: startSplit, enabled: appState.selected.size === 1 },
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
  appState.selectedVertex = { id, ring, idx };
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
  if (!appState.selected.has(id)) selectSingle(id);
  appState.itemSelected = true; appState.itemIndex = idx; clearItemSelection();
  rerender();
  const items = regionById(id)?.content?.items || [];
  const n = items.length;
  const isText = items[idx]?.type === 'text';
  const menu = [];
  if (isText) menu.push({ label: 'Resize to text', fn: () => resizeItemToText(id, idx) }, { sep: true });
  menu.push(
    { label: 'Bring to front', fn: () => { appState.itemIndex = idx; moveItemTo('front'); }, enabled: n > 1 && idx < n - 1 },
    { label: 'Send to back', fn: () => { appState.itemIndex = idx; moveItemTo('back'); }, enabled: n > 1 && idx > 0 },
    { sep: true },
    { label: 'Delete item', fn: () => { appState.itemIndex = idx; deleteItem(); } },
  );
  buildCtxMenu(e, menu);
}

function startSplit() {
  if (!inRegion() || appState.selected.size !== 1) return;
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
  const targetLang = activeTargetLanguage();
  const sourceLang = activeSourceLanguage();
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
  const pg = getPage(appState.pmap, appState.page);
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
    touch(appState.pmap);
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
  const suggested = String(els.fTargetLang?.value || settings.targetLang || 'de').toLowerCase();
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
      do() { for (const w of active) applyExtraction(w); touch(appState.pmap); rerender(); },
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
async function switchToTargetVariant(pdfLang, targetLang) {
  // Look for a remembered target variant: source === PDF's language, destination === target.
  const remembered = appState.variants.find(v =>
    v.content.mapId === appState.content?.mapId &&
    String(v.content.meta?.sourceLanguage || '').toLowerCase() === String(pdfLang || '').toLowerCase() &&
    String(v.content.meta?.destinationLanguage || '').toLowerCase() === String(targetLang || '').toLowerCase()
  )?.content;
  if (remembered) return switchContentVariant(remembered, { guard: false });
  const { map } = await projectTexts();
  const next = emptyContentVariant({
    mapId: map.mapId,
    sourceLanguage: pdfLang,
    destinationLanguage: targetLang,
    label: languageName(targetLang),
    name: defaultContentName(map.meta.name, pdfLang, targetLang),
  });
  return switchContentVariant(next, { guard: false });
}

// Read the PDF-language variant's text for one region, extracting into it when the entry
// is still empty (spec 1.5 §22). Returns { text, hints } or { error }.
async function translateFromVariant(sel, { pdfLang, source, targetLang, chosenSource }) {
  const activeIsSource = source.active;
  const sourceName = activeIsSource ? appState.content.name : (source.content.meta?.name || `${pdfLang} variant`);
  const target = activeIsSource && targetLang === pdfLang ? askTargetLanguage(pdfLang) : targetLang;
  if (!target) return { cancelled: true };

  setStatus(`Reading ${sourceName} under ${sel.length} region(s)…`);
  let page = null, viewport = null;
  const openPage = async () => {
    if (!page) {
      page = await viewer.doc.getPage(appState.page);
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
    if (!(await switchToTargetVariant(pdfLang, target))) {
      setStatus('Translation cancelled — the target variant was not opened.');
      return { cancelled: true };
    }
  }

  // Re-resolve the target regions after a possible switch: installProject() replaced
  // appState.pmap's objects, so the selection's region objects no longer belong to the model.
  const targetPage = getPage(appState.pmap, appState.page);
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
    appState.selected = new Set(plan.map(d => d.r.id));
    appState.itemIndex = 0; appState.itemSelected = false; clearItemSelection();
  }

  // One undo step covers the whole batch, region growth included.
  const before = plan.map(d => ({ r: d.r, content: structuredClone(d.r.content), rings: structuredClone(regionRings(d.r.geometry)) }));
  history.exec({
    label: 'translate from page text',
    do() { for (const d of plan) d.item = applyTranslation(d); touch(appState.pmap); rerender(); },
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
  try { page = await viewer.doc.getPage(appState.page); }
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
    do() { for (const d of done) d.item = applyTranslation(d); touch(appState.pmap); rerender(); },
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
  if (!appState.pmap) { setStatus('Load a region map first.'); return { cancelled: true }; }
  if (!appState.content && !(await ensureContentFile())) return { cancelled: true };
  // Creating (or switching) a variant rebuilds the page's region objects, so the caller's
  // references can be stale. Re-resolve them by id from the now-active map.
  const ids = sel.map(r => r.id);
  const fresh = () => ids.map(regionById).filter(Boolean);
  sel = fresh();
  if (!sel.length) { setStatus('The selected region(s) are no longer available.'); return { cancelled: true }; }
  if (settings.provider === 'none') {
    setStatus('No translation provider configured. Set one in Preferences…, or use “Copy underlying content as text”, translate it, then paste it back.');
    return { cancelled: true };
  }
  // Read the pair before any variant switch below: the active variant names the languages.
  const targetLang = activeTargetLanguage();
  const chosenSource = activeSourceLanguage();
  let pdfLang = appState.pdfLanguage;
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
    pdfLang = appState.pdfLanguage;
    source = pdfLang ? sourceVariantFor(pdfLang) : null;
  }
  // The source-variant guard may have switched the active variant above; resolve again.
  sel = fresh();
  if (!sel.length) { setStatus('The selected region(s) are no longer available.'); return { cancelled: true }; }
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
  if (!appState.content && !(await ensureContentFile())) return;
  if (settings.provider === 'none') {
    setStatus('No translation provider configured. Set one in Preferences…, or use “Copy underlying content as text”, translate it, then paste it back.');
    return;
  }
  let regions = currentRegions().filter(r => r && !isDetectedImage(r));
  if (!currentRegions().length) {
    if (!(await detectMissingPages([appState.page]))) return;
    regions = currentRegions().filter(r => r && !isDetectedImage(r));
  }
  if (!regions.length) { setStatus(`No text regions to translate on page ${appState.page}.`); return; }
  appState.selected = new Set(regions.map(r => r.id));
  appState.itemIndex = 0; appState.itemSelected = false; clearItemSelection();
  return translateRegions(regions, { scope: 'page' });
}
async function translateDocumentText() {
  if (!viewer.doc) { setStatus('Load a PDF first.'); return; }
  if (!appState.content && !(await ensureContentFile())) return;
  if (settings.provider === 'none') {
    setStatus('No translation provider configured. Set one in Preferences…, or use “Copy underlying content as text”, translate it, then paste it back.');
    return;
  }
  const startPage = appState.page;
  const startSelection = [...appState.selected];
  const empty = [];
  for (let p = 1; p <= viewer.pageCount; p++) {
    if (!(getPage(appState.pmap, p)?.regions || []).length) empty.push(p);
  }
  if (empty.length && !(await detectMissingPages(empty))) {
    appState.page = startPage; appState.selected = new Set(startSelection); rerender(); refreshChrome();
    return;
  }
  let pagesTouched = 0, translated = 0, failed = 0;
  let cancelled = false;
  for (let p = 1; p <= viewer.pageCount; p++) {
    const regions = (getPage(appState.pmap, p)?.regions || []).filter(r => r && !isDetectedImage(r));
    if (!regions.length) continue;
    appState.page = p;
    appState.selected = new Set(regions.map(r => r.id));
    const res = await translateRegions(regions, { scope: 'document' });
    if (res?.cancelled) { cancelled = true; break; }
    if (res?.translated) pagesTouched += 1;
    translated += res?.translated || 0;
    failed += res?.failed || 0;
  }
  appState.page = Math.min(Math.max(1, startPage), viewer.pageCount);
  appState.selected = new Set(startSelection.filter(id => !!regionById(id)));
  appState.itemIndex = 0; appState.itemSelected = false; clearItemSelection();
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

// Escape HTML so user-visible filenames/labels can't inject markup into the sidebar.
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text || '';
  return div.innerHTML;
}

// Human-readable file size for the sidebar Files panel.
function fileSizeLabel(bytes) {
  if (!bytes && bytes !== 0) return '—';
  const b = Number(bytes);
  if (b < 1024) return `${b} B`;
  const kb = b / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${Math.round(mb * 10) / 10} MB`;
  return `${Math.round(mb / 1024 * 10) / 10} GB`;
}

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
  return appState.content?.sourceLanguage || 'en';
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
  const code = String(explicit || appState.pdfLanguage || pdfLanguageGuess() || 'en').toLowerCase();
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
async function ensurePdfLanguage(what = 'Extraction', { preferToolbar = false } = {}) {
  if (appState.pdfLanguage) return appState.pdfLanguage;

  // Accept what the user already has in the Source dropdown, unless it is Auto-detect.
  const sel = els.fSourceLang;
  if (sel && sel.offsetParent !== null) {
    const code = String(sel.value || '').trim().toLowerCase();
    if (code && code !== 'auto' && languageCodeValid(code)) {
      appState.pdfLanguage = code;
      settings.sourceLang = code;
      saveSettings(); saveDocPrefs();
      return code;
    }
    // Auto-detect: run detection, then ask the user to confirm before using it.
    if (code === 'auto') {
      const detected = await initialPdfLanguageGuess();
      if (detected && languageCodeValid(detected)) {
        const confirmed = await confirmDialog({
          title: 'Detected language',
          text: `${what} detected ${languageName(detected)} (${detected}) for this PDF. Use it as the source language?`,
          confirmLabel: `Use ${languageName(detected)}`,
          cancelLabel: 'Choose another…',
        });
        if (confirmed) {
          appState.pdfLanguage = detected;
          settings.sourceLang = detected;
          saveSettings(); saveDocPrefs();
          return detected;
        }
        // User declined the detection: fall through to the manual picker below.
      }
    }
  }

  // The preferToolbar shortcut (Improve lens): its toolbar language dropdown
  // doubles as the source language.
  if (preferToolbar) {
    const code = String(els.fTargetLang?.value || settings.selectableLang || '').trim().toLowerCase();
    if (code && code !== 'auto' && languageCodeValid(code)) {
      appState.pdfLanguage = code;
      settings.selectableLang = code;
      saveSettings(); saveDocPrefs();
      return code;
    }
  }

  // Fallback: full dialog picker when the dropdown is not on screen or the user
  // declined the detected language.
  const guess = await initialPdfLanguageGuess();
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
  appState.pdfLanguage = code;
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
  if (!appState.content && !(await ensureContentFile())) return null;
  const pdfLang = await ensurePdfLanguage(what, { preferToolbar: contentIsImprove() });
  if (!pdfLang) return null;
  if (!isSourceTextVariant(appState.content, pdfLang)) {
    // Re-running extraction updates the same PDF-language variant, even after the user
    // switched to a target: never create a second empty one (§22).
    const remembered = findRememberedSourceVariant(pdfLang);
    const decline = () => {
      setStatus(`${what} cancelled — the active variant is ${appState.content.sourceLanguage} → ${appState.content.destinationLanguage}, not the PDF's ${pdfLang}.`);
      return null;
    };
    if (remembered) {
      // Translate's happy path passes confirmSwitch:false: establish the source variant
      // invisibly, leaving only the ordinary unsaved-changes guard inside the switch.
      if (confirmSwitch && !(await confirmDialog({
        title: `Extract into “${remembered.meta.name}”?`,
        text: `This PDF is written in ${languageName(pdfLang)} (${pdfLang}), and its variant “${remembered.meta.name}” is still loaded from this session — but the active variant is “${appState.content.name}” (${appState.content.sourceLanguage}). Switch back to the ${pdfLang} variant and extract there? Your current edits stay in memory and are untouched by the switch.`,
        confirmLabel: `Switch to “${remembered.meta.name}”`,
        cancelLabel: 'Cancel',
      }))) return decline();
      if (!(await switchContentVariant(remembered))) return null;
    } else {
      if (confirmSwitch && !(await confirmDialog({
        title: `Create the ${pdfLang} variant?`,
        text: `This PDF is written in ${languageName(pdfLang)} (${pdfLang}), but the active content variant is “${appState.content.name}” (${appState.content.sourceLanguage}). The extracted source text must live in a ${pdfLang} variant — a new, empty one will be created and opened. Your current variant stays in memory and is untouched.`,
        confirmLabel: `Create ${pdfLang} variant`,
        cancelLabel: 'Cancel',
      }))) return decline();
      await createContentVariant(pdfLang, pdfLang, languageName(pdfLang));
      if (!isSourceTextVariant(appState.content, pdfLang)) return null;
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
  const beforeAwaiting = new Set(appState.awaitingOcr);
  if (done.length || awaiting.length) {
    const before = done.map(d => ({ r: d.r, content: structuredClone(d.r.content), rings: structuredClone(regionRings(d.r.geometry)) }));
    history.exec({
      label,
      do() {
        for (const d of done) applyExtraction(d);
        appState.awaitingOcr = new Set(beforeAwaiting);
        for (const id of awaiting) appState.awaitingOcr.add(id);
        for (const d of done) appState.awaitingOcr.delete(d.r.id);
        touch(appState.pmap); rerender();
      },
      undo() {
        for (const b of before) { b.r.content = structuredClone(b.content); applyRings(b.r, b.rings); }
        appState.awaitingOcr = new Set(beforeAwaiting);
        rerender();
      },
    });
  }
  const c = workflowCopy();
  let msg = done.length
    ? `${action} ${done.length} region(s) into ${appState.content.name} (${langLabel(appState.content)})`
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
  if (!(await ensureExtractionVariant(workflowCopy().actionLabel))) return;
  // The variant guard can switch to the PDF-language variant; that rebuilds the page's
  // region objects, so re-resolve the ids instead of writing into the old variant's copies.
  const sel = ids.map(regionById).filter(Boolean);
  if (!sel.length) { setStatus('The selected regions are no longer available.'); return; }
  appState.selected = new Set(sel.map(r => r.id));
  let page;
  try { page = await viewer.doc.getPage(appState.page); }
  catch (e) { setStatus(`Could not read the page: ${e.message}`); return { cancelled: true }; }
  const viewport = page.getViewport({ scale: 1 });
  setStatus(`Reading ${sel.length} region(s) into ${appState.content.name}…`);
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
  finishExtraction({ done, skipped, failed, awaiting: awaiting.map(a => a.id), label: 'extract content', action: workflowCopy().actionPast });
}

// OCR only the supplied regions that are marked awaiting OCR. This is deliberately
// narrower than a page harvest: it never touches another region, never falls back to the
// digital layer, and writes into the PDF-language ("digital") variant through the same
// extraction variant guard and undo step as every other harvest.
async function ocrRegions(regions) {
  const ids = (regions || []).filter(r => r && appState.awaitingOcr.has(r.id) && !isDetectedImage(r)).map(r => r.id);
  if (!ids.length) { setStatus(`Select region(s) marked ${workflowCopy().missing} first.`); return; }
  if (!ocrEnabled()) { setStatus('OCR is off — enable it in Preferences… ▸ OCR Service.'); return; }
  if (!(await ensureExtractionVariant(workflowCopy().actionLabel))) return;
  // The guard may have switched to the PDF-language variant, which rebuilds the region
  // objects; resolve the ids again so OCR writes into the active source variant, not a
  // stale copy from the variant the user right-clicked in.
  const sel = ids.map(regionById).filter(r => r && appState.awaitingOcr.has(r.id) && !isDetectedImage(r));
  if (!sel.length) { setStatus(`Those regions are no longer ${workflowCopy().missing}.`); return; }
  appState.selected = new Set(sel.map(r => r.id));
  let page;
  try { page = await viewer.doc.getPage(appState.page); }
  catch (e) { setStatus(`Could not read the page: ${e.message}`); return { cancelled: true }; }
  const viewport = page.getViewport({ scale: 1 });
  setStatus(`Reading ${sel.length} region${sel.length === 1 ? '' : 's'} with OCR into ${appState.content.name}…`);
  const done = [], failed = [], awaiting = [];
  const run = makeRunChoice();
  try {
    for (const r of sel) {
      const h = await harvestRegion(page, viewport, r, true, run, { forceOcr: true });
      if (h.cancelled) { setStatus(`${workflowCopy().actionLabel} cancelled — nothing was written.`); return; }
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
  if (!(await ensureExtractionVariant(workflowCopy().actionLabel))) return;
  // Re-read after the guard: it may have switched variants and rebuilt these objects.
  const regions = currentRegions();
  let page;
  try { page = await viewer.doc.getPage(appState.page); }
  catch (e) { setStatus(`Could not read the page: ${e.message}`); return { cancelled: true }; }
  const viewport = page.getViewport({ scale: 1 });
  setStatus(`Reading page ${appState.page} into ${appState.content.name}…`);
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
  finishExtraction({ done, skipped, failed, awaiting: awaiting.map(a => a.id), label: 'extract content on page', action: workflowCopy().actionPast });
}

// The document-wide run: a loop over pages with progress in the status bar, empty
// regions only, and one undo step for the whole run (spec §20/§21).
async function extractAllPagesContent() {
  if (!(await ensureExtractionVariant(workflowCopy().actionLabel))) return;
  setStatus(`Reading all pages into ${appState.content.name}…`);
  const done = [], skipped = [], failed = [], awaiting = [];
  for (let p = 1; p <= viewer.pageCount; p++) {
    const regions = appState.pmap.pages.find(pg => pg.page === p)?.regions || [];
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
  finishExtraction({ done, skipped, failed, awaiting: awaiting.map(a => a.id), label: 'extract content on all pages', action: workflowCopy().actionPast });
}

// Improve's page/document entry points. A page that has never been detected gets geometry
// first (the same detector, the same proposals/review rules); then the normal extraction
// guard writes the PDF's text into the PDF-language/selectable-text variant.
async function makeSelectablePage() {
  if (!viewer.doc) { setStatus('Load a PDF first.'); return; }
  if (!appState.content && !(await ensureContentFile())) return;
  if (!(await ensureExtractionVariant('Make this selectable'))) return;
  let regions = currentRegions();
  if (!regions.length) {
    if (!(await detectMissingPages([appState.page]))) return;
    regions = currentRegions();
    if (!regions.length) { setStatus(`Detection found no regions to make selectable on page ${appState.page}.`); return; }
  }
  return extractPageContent();
}
async function makeSelectableAllPages() {
  if (!viewer.doc) { setStatus('Load a PDF first.'); return; }
  if (!appState.content && !(await ensureContentFile())) return;
  if (!(await ensureExtractionVariant('Make this selectable'))) return;
  const empty = [];
  for (let p = 1; p <= viewer.pageCount; p++) {
    if (!(getPage(appState.pmap, p)?.regions || []).length) empty.push(p);
  }
  if (empty.length && !(await detectMissingPages(empty))) return;
  return extractAllPagesContent();
}

// Preferences tabs. Kept in the session only. The active variant's workflow decides the
// default section — Translate opens Translation Service, Improve opens OCR Service — and
// remembering the last tab per workflow keeps a detour into Region Detection from changing
// the other workflow.
function showPrefTab(name) {
  const tabs = [...document.querySelectorAll('[data-pref-tab]')];
  if (!tabs.some(t => t.dataset.prefTab === name)) name = workflowCopy().prefsTab;
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
  showPrefTab(workflowCopy().prefsTab);
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
  saveSettings();
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
  return (appState.pmap?.pages || []).flatMap(pg => (pg.regions || []).map(r => ({
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
  if (!appState.pmap || !appState.content) return null;
  if (contentIsImprove()) {
    const source = digitalSourceState();
    if (source.active) {
      return { entries: activeFindEntries(), label: `Selectable text · ${appState.content.name} (${langLabel(appState.content)}) · all pages` };
    }
    if (source.content) {
      return { entries: variantFindEntries(source.content), label: `Selectable text · ${source.content.meta?.name || 'source variant'} (${langLabel(source.content)}) · all pages` };
    }
    // No PDF-language variant has been identified yet. Improve is working in the only
    // loaded variant; searching it is more useful than refusing, and the label says so.
    if (!appState.pdfLanguage) {
      return { entries: activeFindEntries(), label: `Current content · ${appState.content.name} (${langLabel(appState.content)}) · all pages` };
    }
    return null;
  }
  return { entries: activeFindEntries(), label: `Translate content · ${appState.content.name} (${langLabel(appState.content)}) · all pages` };
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
    do() { commit('after'); touch(appState.pmap); refreshChrome(); },
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
const menubar = createMenubar(els.menubar, mainMenuItems);


async function closePdf() {
  if (!viewer.doc) return;
  // One combined prompt when both map and content are dirty: export both or discard both.
  if (!(await confirmUnloadProject())) { setStatus('Close cancelled — unsaved changes.'); return; }

  // Null out the document state before clearing the session, so a concurrent
  // saveProjectNow() that resumes after closePdf() started cannot rewrite the
  // IndexedDB session that clearSavedSession() is about to delete.
  appState.pmap = null; appState.content = null; appState.variants = [];
  appState.savedMap = null; appState.mapModified = '';
  appState.dirtySides = { map: false, content: false };

  const name = appState.pdfName || 'PDF';
  const sha = appState.sha256;
  docGen++;
  sessionGen++;
  await clearSavedSession();
  clearDocPrefsFor(sha);
  cancelChromeAiDownload();
  if (inlineState) closeInlineEditor();
  try { await viewer.close(); } catch {}

  // Drop every piece of state that belongs to the closed document. The empty app keeps
  // only global preferences. (pmap, content, variants, dirtySides already nulled above.)
  appState.pdfBytes = null; appState.pdfName = ''; appState.sha256 = ''; appState.pdfLanguage = null;
  appState.page = 1; appState.zoom = 1.2;
  appState.selected.clear(); clearItemSelection(); appState.awaitingOcr.clear();
  appState.itemIndex = 0; appState.itemSelected = false; appState.selectedVertex = null;
  appState.draft = []; appState.splitPts = []; appState.cursor = null;
  appState.marquee = null; appState.marqueeBase = null; appState.marqueeItems = false;
  appState.dragPreview = null; appState.bgPreview = false;
  appState.eyedropperKey = false; cancelEyedropper();
  appState.tool = 'select'; appState.mode = 'region';
  appState.overlayVisible = true; overlay.visible = true;
  appState.showDigital = true;
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
  refreshMapInfo();
  setStatus(`Closed ${name}.`);
}

// Closing the PDF is the only session reset the app offers now: it clears the IndexedDB
// session and this PDF's per-document prefs (see clearSavedSession above), so the saved
// "session" never outlives the document it belongs to and no separate menu command is
// needed. Opening another PDF overwrites the session with the new document instead.

// Bring back the last session (the PDF and its map) from IndexedDB, if there is one.
restoreSession().catch(() => {});
