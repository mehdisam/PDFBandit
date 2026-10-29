// Menubar definitions — extracted from main.js
import { appState, viewer, history, els } from '../app.js';
import {
  gotoPage, gotoPagePrompt, closePdf, newRegionFile, exportProjectPart,
  promptNewContentVariant, openSettings, selectAll, armPolygon,
  toggleLockSelected, mergeSelected, resizeAllTextInPage,
  deleteSelection, startSplit, detectRegionsOnPage, detectRegionsAllPages,
  toggleDetectExtract, extractSelectedContent, translateFromPageText,
  toggleDigitalVersion, selectTextRegionsWithoutContent,
  setMode, toggleOverlay, setZoom, fitZoom,
  openHelp, openAbout, contentIsImprove, pageTextItemCount,
  detectExtract, inRegion, inContent, isEditMode, openFindReplace,
  doExport
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
    { label: 'Open PDF…', shortcut: 'Ctrl/Cmd+O', run: () => els.filePdf.click() },
    { label: 'Close PDF', enabled: () => !!viewer.doc, run: closePdf },
    { type: 'sep' },
    { label: 'New region map…', enabled: () => !!viewer.doc, run: newRegionFile },
    { label: 'Open region map…', enabled: () => !!viewer.doc, run: () => els.filePmap.click() },
    { label: 'Export region map…', enabled: () => !!appState.pmap, run: () => exportProjectPart('map') },
    { type: 'sep' },
    { label: 'New content variant…', enabled: () => !!appState.pmap, run: promptNewContentVariant },
    { label: 'Open content variant…', enabled: () => !!viewer.doc && !!appState.pmap, run: () => els.fileContentVariant.click() },
    { label: 'Export content variant…', enabled: () => !!appState.content, run: () => exportProjectPart('content') },
    { type: 'sep' },
    { label: 'Export All…', shortcut: 'Ctrl/Cmd+S', enabled: () => !!viewer.doc, run: () => exportProjectPart('both') },
    { label: 'Export PDF…', enabled: () => !!appState.pmap, run: doExport },
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

export function viewMenuItems() {
  return [
    { label: 'Region mode', shortcut: 'Tab', checked: () => appState.mode === 'region', run: () => setMode('region') },
    { label: 'Content mode', checked: () => appState.mode === 'content', run: () => setMode('content') },
    { label: 'Preview mode', checked: () => appState.mode === 'view', run: () => setMode('view') },
    { label: 'Original mode', checked: () => appState.mode === 'text', run: () => setMode('text') },
    { type: 'sep' },
    { label: 'Show overlay', shortcut: '0', checked: () => appState.overlayVisible, run: toggleOverlay },
    { type: 'sep' },
    ...pageNavItems(),
    { label: 'Zoom in', run: () => setZoom(appState.zoom * 1.2) },
    { label: 'Zoom out', run: () => setZoom(appState.zoom / 1.2) },
    { label: 'Fit width', run: fitZoom },
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