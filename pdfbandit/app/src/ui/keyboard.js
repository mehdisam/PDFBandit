// Global keyboard shortcuts — extracted from main.js
import { appState, els, viewer } from '../app.js';
import {
  inRegion, inContent, isEditMode, contentIsImprove,
  openFindReplace, exportProjectPart, selectAll, armPolygon,
  cycleMode, toggleOverlay, addTextItem, toggleLockSelected,
  toggleDigitalVersion, selectTextRegionsWithoutContent,
  detectRegionsOnPage, resizeAllTextInPage,
  ensureContentFile, translateFromPageText, extractSelectedContent,
  commitInlineEditor, closeFindReplace, currentRegion, regionById
} from '../main.js';
import { backgroundButtonVisible, openBackgroundPicker, toggleColoringMode } from '../editor/background.js';

export function initKeyboardShortcuts() {
  // Alt key tracking for overlay cursor (spec §9b: Alt means "the region, not the item")
  window.addEventListener('keydown', (e) => { if (e.key === 'Alt') refreshOverlayCursor(true); }, true);
  window.addEventListener('keyup', (e) => { if (e.key === 'Alt') refreshOverlayCursor(false); }, true);

  // Global keyboard shortcuts (ignore while typing in a field)
  window.addEventListener('keydown', async (e) => {
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
    if (mod && e.key.toLowerCase() === 'f' && appState.pmap && appState.content) { e.preventDefault(); openFindReplace(); }
    else if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); els.filePdf.click(); }
    else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); if (appState.pmap) exportProjectPart('both'); }
    else if (mod && e.key.toLowerCase() === 'a' && appState.pmap && (inRegion() || inContent())) { e.preventDefault(); selectAll(); }
    else if (e.key === 'Tab') { e.preventDefault(); cycleMode(e.shiftKey); }
    else if (e.key === '0') toggleOverlay();
    else if ((e.key === 'p' || e.key === 'P') && inRegion() && !mod && !e.altKey) { e.preventDefault(); armPolygon(); }
    else if (e.shiftKey && !mod && !e.altKey && e.key.toLowerCase() === 't' && appState.pmap && appState.selected.size > 0) {
      e.preventDefault();
      const ids = [...appState.selected];
      if (!(await ensureContentFile())) return;
      // Creating the variant rebuilds the regions and clears the selection; put it back.
      if (!appState.selected.size) appState.selected = new Set(ids.filter(id => !!regionById(id)));
      if (!appState.selected.size) return;
      if (contentIsImprove()) extractSelectedContent(); else translateFromPageText();
    }
    else if ((e.key === 'i' || e.key === 'I') && !mod && !e.altKey && backgroundButtonVisible()) { e.preventDefault(); openBackgroundPicker(); }
    else if ((e.key === 't' || e.key === 'T') && !e.shiftKey && inContent() && currentRegion()) { e.preventDefault(); addTextItem(); }
    else if ((e.key === 'l' || e.key === 'L') && isEditMode() && !mod && !e.altKey) { e.preventDefault(); toggleLockSelected(); }
    else if (e.shiftKey && !mod && !e.altKey && e.key.toLowerCase() === 'd' && viewer.doc) { e.preventDefault(); toggleDigitalVersion(); }
    else if (e.shiftKey && !mod && !e.altKey && e.key.toLowerCase() === 'a' && appState.pmap && isEditMode()) { e.preventDefault(); selectTextRegionsWithoutContent(); }
    else if ((e.key === 'c' || e.key === 'C') && !mod && !e.altKey && !e.shiftKey && inRegion()) { e.preventDefault(); toggleColoringMode(); }
    else if ((e.key === 'd' || e.key === 'D') && viewer.doc && !mod && !e.altKey && !e.shiftKey) { e.preventDefault(); detectRegionsOnPage(); }
    else if ((e.key === 'r' || e.key === 'R') && isEditMode() && !mod && !e.altKey) { e.preventDefault(); resizeAllTextInPage(); }
  });
}

// Coloring mode empty-space click handler (capture phase)
// In coloring mode, clicking empty space should NOT start the eyedropper.
// The eyedropper should only be started by clicking INSIDE a region.
export function initColoringClickHandler() {
  // No-op: empty space clicks in coloring mode do nothing
  // The eyedropper is only started by clicking inside a region (handled by regionPointerDown)
}

// Import the internal function needed for coloring click handler
// (no longer needed - kept for potential future use)