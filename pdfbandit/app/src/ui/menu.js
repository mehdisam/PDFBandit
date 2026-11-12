// Menubar definitions — extracted from main.js
import { appState, viewer, history, els } from '../app.js';
import {
  gotoPage, gotoPagePrompt, closePdf, newRegionFile, exportProjectPart,
  promptNewContentVariant, promptSwitchContentVariant, openSettings, selectAll, armPolygon,
  toggleLockSelected, mergeSelected, resizeAllTextInPage,
  deleteSelection, startSplit, detectRegionsOnPage, detectRegionsAllPages,
  toggleDetectExtract, extractSelectedContent, translateFromPageText,
  toggleDigitalVersion, selectTextRegionsWithoutContent,
  setWorkspace, enterView, exitView, toggleOverlay, toggleRegionInfo, setZoom, fitZoom,
  openHelp, openAbout, contentIsImprove, pageTextItemCount,
  detectExtract, inRegion, inContent, isEditMode, openFindReplace,
  doExport, doExportDigital, switchContentVariant, openFilePicker
} from '../main.js';

export function pageNavItems() {
  if (!viewer.doc) return [{ type: 'header', label: 'Pages' }, { label: 'No PDF loaded', enabled: () => false, run: () => {} }, { type: 'sep' }];
  return [
    { type: 'header', label: `Page ${appState.page} / ${viewer.pageCount}` },
    { label: 'Previous page', enabled: () => appState.page > 1, run: () => gotoPage(appState.page - 1) },
    { label: 'Next page', enabled: () => appState.page < viewer.pageCount, run: () => gotoPage(appState.page + 1) },
    { label: 'Go to page…', run: gotoPagePrompt },
    { label: 'First page', enabled: () => appState.page > 1, run: () => gotoPage(1) },
    { label: 'Last page', enabled: () => appState.page < viewer.pageCount, run: () => gotoPage(viewer.pageCount) },
    { type: 'sep' },
  ];
}

export function fileMenuItems() {
  return [
    { label: 'Open PDF…', shortcut: 'Ctrl/Cmd+O', run: () => openFilePicker(els.filePdf) },
    { label: 'Close PDF', enabled: () => !!viewer.doc, run: closePdf },
    { type: 'sep' },
    { label: 'New region map…', enabled: () => !!viewer.doc, run: newRegionFile },
    { label: 'Open region map…', enabled: () => !!viewer.doc, run: () => openFilePicker(els.filePmap) },
    { label: 'Export region map…', enabled: () => !!appState.pmap, run: () => exportProjectPart('map') },
    { type: 'sep' },
    { label: 'New content variant…', enabled: () => !!appState.pmap, run: promptNewContentVariant },
    { label: 'Switch content variant…', enabled: () => !!appState.content && appState.variants.some(v => v.content.mapId === appState.content.mapId), run: promptSwitchContentVariant },
    { label: 'Open content variant…', enabled: () => !!viewer.doc && !!appState.pmap, run: () => openFilePicker(els.fileContentVariant) },
    { label: 'Export content variant…', enabled: () => !!appState.content, run: () => exportProjectPart('content') },
    { type: 'sep' },
    { label: 'Export project…', shortcut: 'Ctrl/Cmd+S', enabled: () => !!viewer.doc, run: () => exportProjectPart('both') },
    { label: 'Export reconstructed PDF…', enabled: () => !!appState.pmap, run: doExport },
    { label: 'Export digitalized PDF…', enabled: () => !!appState.pdfBytes && !!appState.pmap, run: doExportDigital },
    { type: 'sep' },
    { label: 'Preferences…', run: openSettings },
  ];
}

export function toolsMenuItems() {
  return [
    { label: 'Undo', shortcut: 'Ctrl/Cmd+Z', enabled: () => history.canUndo, run: () => history.undo() },
    { label: 'Redo', shortcut: 'Ctrl/Cmd+Shift+Z', enabled: () => history.canRedo, run: () => history.redo() },
    { type: 'sep' },
    { label: 'Find & replace…', shortcut: 'Ctrl/Cmd+F', enabled: () => !!appState.pmap && !!appState.content, run: openFindReplace },
    { label: 'Select all', shortcut: 'Ctrl/Cmd+A', enabled: () => isEditMode() && !!appState.pmap, run: selectAll },
    { label: 'Add polygon', shortcut: 'P', checked: () => appState.tool === 'polygon', enabled: () => inRegion(), run: armPolygon },
    { label: 'Lock / unlock region', shortcut: 'L', enabled: () => isEditMode() && appState.selected.size > 0, run: toggleLockSelected },
    { label: 'Merge selected', enabled: () => inRegion() && appState.selected.size >= 2, run: mergeSelected },
    { type: 'sep' },
    { label: 'Resize to text in page', shortcut: 'R', enabled: () => inContent() && pageTextItemCount() > 0, run: resizeAllTextInPage },
    { label: 'Delete region(s)', shortcut: 'Del', enabled: () => inRegion() && appState.selected.size > 0, run: deleteSelection },
    { label: 'Split selected region…', enabled: () => inRegion() && appState.selected.size === 1, run: startSplit },
    { type: 'sep' },
    { label: 'Detect regions on this page', shortcut: 'D', enabled: () => !!viewer.doc, run: detectRegionsOnPage },
    { label: 'Detect regions on all pages', enabled: () => !!viewer.doc, run: detectRegionsAllPages },
    { label: 'Extract content after detecting', checked: () => detectExtract(), run: toggleDetectExtract },
  ];
}

export function contentMenuItems() {
  if (contentIsImprove()) {
    return [
      { label: 'Make Selectable (Shift+T)', enabled: () => !!viewer.doc && !!appState.pmap && appState.selected.size > 0, run: extractSelectedContent },
      { type: 'sep' },
      { label: 'Toggle status', shortcut: 'Shift+D', checked: () => appState.showDigital, enabled: () => !!viewer.doc, run: toggleDigitalVersion },
      { label: 'Select not selectables', shortcut: 'Shift+A', enabled: () => !!viewer.doc && !!appState.pmap && isEditMode(), run: selectTextRegionsWithoutContent },
    ];
  }
  return [
    { label: 'Translate (Shift+T)', enabled: () => !!viewer.doc && !!appState.pmap && appState.selected.size > 0, run: translateFromPageText },
    { type: 'sep' },
    { label: 'Toggle status', shortcut: 'Shift+D', checked: () => appState.showDigital, enabled: () => !!viewer.doc, run: toggleDigitalVersion },
    { label: 'Select not selectables', shortcut: 'Shift+A', enabled: () => !!viewer.doc && !!appState.pmap && isEditMode(), run: selectTextRegionsWithoutContent },
  ];
}

// View is a set of transient actions, not a workspace: Preview and Original layer a
// read-only rendering over the editing workspace, and "Return to editing" restores the
// workspace, page, zoom, scroll and selection exactly as they were.
export function viewMenuItems() {
  return [
    { type: 'header', label: 'View' },
    { label: 'Preview reconstruction', shortcut: 'Shift+P', checked: () => appState.viewing === 'preview', enabled: () => !!viewer.doc, run: () => enterView('preview') },
    { label: 'Original PDF text', shortcut: 'Shift+O', checked: () => appState.viewing === 'original', enabled: () => !!viewer.doc, run: () => enterView('original') },
    { label: 'Return to editing', shortcut: 'Esc', enabled: () => !!appState.viewing, run: exitView },
    { type: 'sep' },
    { type: 'header', label: 'Editing workspace' },
    { label: 'Content workspace', checked: () => appState.workspace === 'content', run: () => setWorkspace('content') },
    { label: 'Edit regions workspace', checked: () => appState.workspace === 'region', run: () => setWorkspace('region') },
    { type: 'sep' },
    { label: 'Show overlay', shortcut: '0', checked: () => appState.overlayVisible, run: toggleOverlay },
    { label: 'Region labels & status tags', shortcut: 'Shift+I', checked: () => appState.showRegionInfo, run: toggleRegionInfo },
    { type: 'sep' },
    ...pageNavItems(),
    { label: 'Zoom in', run: () => setZoom(appState.zoom * 1.2) },
    { label: 'Zoom out', run: () => setZoom(appState.zoom / 1.2) },
    { label: 'Fit width', run: fitZoom },
  ];
}

// The active-variant menu: one place to see and switch the variants loaded this session,
// create another one, or load a .content.json from disk.
export function variantMenuItems() {
  const items = [];
  if (!appState.pmap) {
    items.push({ type: 'header', label: 'No region map loaded' });
    items.push({ label: 'Create a region map first…', run: newRegionFile });
    return items;
  }
  if (!appState.content) {
    items.push({ type: 'header', label: 'No content variant loaded' });
  } else {
    items.push({ type: 'header', label: `${appState.content.name} (${appState.content.sourceLanguage} → ${appState.content.destinationLanguage})` });
    const mine = appState.variants.filter(v => v.content.mapId === appState.content.mapId);
    if (mine.length) {
      for (const v of mine) {
        const name = v.content.meta?.name || v.content.name || 'variant';
        const lang = `${v.content.meta?.sourceLanguage || v.content.sourceLanguage} → ${v.content.meta?.destinationLanguage || v.content.destinationLanguage}`;
        items.push({
          label: `${name} — ${lang}`,
          checked: () => v.content === appState.content,
          run: () => { if (v.content !== appState.content) promptSwitchToVariant(v.content); },
        });
      }
    } else {
      items.push({ label: 'No other variants loaded this session', enabled: () => false, run: () => {} });
    }
    items.push({ type: 'sep' });
  }
  items.push({ label: 'New content variant…', enabled: () => !!appState.pmap, run: promptNewContentVariant });
  items.push({ label: 'Open content variant…', enabled: () => !!appState.pmap, run: () => openFilePicker(els.fileContentVariant) });
  if (appState.content) {
    items.push({ label: 'Export active variant…', run: () => exportProjectPart('content') });
  }
  return items;
}

// Used by the variant menu; keeps the same guard/undo/reset path as the explicit
// "Switch content variant" command.
function promptSwitchToVariant(content) {
  return switchContentVariant(content);
}

export function exportMenuItems() {
  return [
    { label: 'Export project (map + content)', shortcut: 'Ctrl/Cmd+S', enabled: () => !!appState.pmap, run: () => exportProjectPart('both') },
    { label: 'Export region map only…', enabled: () => !!appState.pmap, run: () => exportProjectPart('map') },
    { label: 'Export active content variant…', enabled: () => !!appState.content, run: () => exportProjectPart('content') },
    { type: 'sep' },
    { label: 'Export reconstructed PDF…', enabled: () => !!appState.pmap, run: doExport },
    { label: 'Export digitalized PDF…', enabled: () => !!appState.pdfBytes && !!appState.pmap, run: doExportDigital },
  ];
}

export function regionMoreMenuItems() {
  return [
    { label: 'Add polygon', shortcut: 'P', checked: () => appState.tool === 'polygon', run: armPolygon },
    { label: 'Merge selected regions', enabled: () => appState.selected.size >= 2, run: mergeSelected },
    { label: 'Split selected region…', enabled: () => appState.selected.size === 1, run: startSplit },
    { type: 'sep' },
    { label: 'Resize text to fit (this page)', shortcut: 'R', enabled: () => pageTextItemCount() > 0, run: resizeAllTextInPage },
    { label: 'Select regions without content', shortcut: 'Shift+A', run: selectTextRegionsWithoutContent },
    { label: 'Detect regions on all pages', run: detectRegionsAllPages },
    { type: 'sep' },
    { label: 'Delete selected region(s)', shortcut: 'Del', enabled: () => appState.selected.size > 0, run: deleteSelection },
  ];
}

export function helpMenuItems() {
  return [
    { label: 'Shortcuts & workflow', run: () => openHelp() },
    { label: 'About PDFBandit', run: () => openAbout() },
  ];
}

export function mainMenuItems() {
  return [
    { label: 'File', items: fileMenuItems },
    { label: 'Tools', items: toolsMenuItems },
    { label: 'Content', items: contentMenuItems },
    { label: 'View', items: viewMenuItems },
    { label: 'Help', items: helpMenuItems },
  ];
}
