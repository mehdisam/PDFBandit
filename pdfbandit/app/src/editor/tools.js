// Pointer tools: draw / select-move / vertex-edit / split / marquee-select. Delegates model mutations to app via ctx.
import { polygonIsValid } from '../model/geometry.js';
import { Overlay } from '../overlay/region_item.js';

export class ToolController {
  constructor(bgEl, overlay, ctx) {
    this.bgEl = bgEl; this.overlay = overlay; this.ctx = ctx; // ctx: app interface
    this.drag = null;
    this.marquee = null; // empty-space rubber-band selection: { start, cur, additive, moved }
    // Polygons/handles stopPropagation, so anything reaching bgEl is "background".
    bgEl.addEventListener('pointerdown', (e) => this.onBackground(e));
    window.addEventListener('pointermove', (e) => this.onMove(e));
    window.addEventListener('pointerup', (e) => this.onUp(e));
    window.addEventListener('keydown', (e) => this.onKey(e));
    bgEl.addEventListener('dblclick', (e) => {
      if (!this.ctx.regionMode) return;
      if (this.ctx.tool === 'split') { e.preventDefault(); this.ctx.finishSplit(); }
      else if (this.ctx.tool === 'polygon' && this.ctx.drafting?.()) { e.preventDefault(); this.ctx.finishDraw(); }
    });
  }
  pdfPt(e) { return this.overlay.eventPdfPoint(e, this.ctx.zoom); }

  onBackground(e) {
    if (!this.ctx.editing) return;
    const { tool } = this.ctx;
    if (e.button === 1 || e.button === 2) return; // middle = pan, right = context menu
    if (e.target.closest?.('.region, .handle, .item-box, .item-handle, .inline-edit')) return; // safety; these normally stopPropagation
    if (this.ctx.regionMode && tool === 'split') {
      this.ctx.addSplitPoint(this.pdfPt(e));
    } else if (this.ctx.regionMode && tool === 'polygon') {
      // The polygon tool is armed from Tools ▸ Add polygon (P); clicks add points.
      this.ctx.addDraftPoint(this.pdfPt(e));
    } else {
      // Normal edit behaviour: pressing empty space clears the selection, then
      // dragging a rubber band selects live as it is dragged (Shift adds to
      // the existing selection instead of replacing it). beginMarquee() does the
      // clearing, so a plain click ends up with nothing selected. Which *kind* of
      // thing the band selects depends on the mode (regions, or — in Content mode,
      // with a region selected — that region's items); beginMarquee decides.
      this.ctx.beginMarquee?.(!!e.shiftKey);
      const p = this.pdfPt(e);
      this.marquee = { start: p, cur: p, additive: !!e.shiftKey, moved: false };
    }
  }
  onMove(e) {
    if (this.drag) {
      const p = this.pdfPt(e);
      this.drag.last = p;
      this.ctx.previewDrag(this.drag, p);
      return;
    }
    if (this.marquee) {
      if (!this.ctx.editing || this.ctx.tool !== 'select') { this.marquee = null; this.ctx.endMarquee?.(); }
      else {
        const p = this.pdfPt(e);
        this.marquee.cur = p;
        if (!this.marquee.moved && Math.hypot(p[0] - this.marquee.start[0], p[1] - this.marquee.start[1]) * this.ctx.zoom >= 3) this.marquee.moved = true;
        if (this.marquee.moved) this.ctx.setMarquee?.([this.marquee.start[0], this.marquee.start[1], p[0], p[1]]);
        return;
      }
    }
    if (this.ctx.regionMode && this.ctx.tool === 'polygon' && this.ctx.drawing?.()) this.ctx.setCursor(this.pdfPt(e));
  }
  onUp(e) {
    if (this.drag) {
      const d = this.drag; this.drag = null;
      this.ctx.commitDrag(d, this.pdfPt(e));
      return;
    }
    if (this.marquee) {
      const m = this.marquee; this.marquee = null;
      if (m.moved && this.ctx.editing && this.ctx.tool === 'select') {
        const p = this.pdfPt(e);
        this.ctx.setMarquee?.([m.start[0], m.start[1], p[0], p[1]]);
      } else if (!m.moved) {
        // A press on empty space released without moving is a *click*, not a band: it clears the
        // whole selection (regions and content items) in every editing mode (spec §9a). A
        // Shift-click keeps the selection — that gesture means "add to it".
        this.ctx.onEmptyClick?.(m.additive);
      }
      this.ctx.endMarquee?.();
    }
  }
  onKey(e) {
    if (e.key === 'Enter') {
      if (this.ctx.tool === 'split') this.ctx.finishSplit();
      else if (this.ctx.tool === 'polygon' && this.ctx.drafting?.()) this.ctx.finishDraw();
    } else if (e.key === 'Escape') {
      if (this.marquee) { this.marquee = null; this.ctx.endMarquee?.(); }
      this.ctx.cancelDraft();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      const ae = document.activeElement;
      if (ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT' || ae.tagName === 'SELECT' || ae.isContentEditable)) return;
      (this.ctx.deleteKey || this.ctx.deleteSelection)();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      e.shiftKey ? this.ctx.redo() : this.ctx.undo();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
      e.preventDefault(); this.ctx.redo();
    }
  }
  startRegionDrag(e, id) {
    const p = this.pdfPt(e);
    this.drag = { kind: 'region', id, start: p, last: p, moved: false, additive: e.shiftKey };
  }
  startVertexDrag(e, id, ring, idx) {
    const p = this.pdfPt(e);
    this.drag = { kind: 'vertex', id, ring, idx, start: p, last: p, moved: false };
    e.stopPropagation();
  }
  // Grab an edge: both endpoints follow the pointer; neighbouring vertices stay
  // put, so the two adjoining edges stretch (thread-through-a-stick behaviour).
  startEdgeDrag(e, id, ring, idx) {
    const p = this.pdfPt(e);
    this.drag = { kind: 'edge', id, ring, idx, start: p, last: p, moved: false };
    e.stopPropagation();
  }
  // Move an item inside its region (box translation).
  startItemDrag(e, id, idx) {
    const p = this.pdfPt(e);
    this.drag = { kind: 'item', id, idx, start: p, last: p, moved: false };
    e.stopPropagation();
  }
  // Resize an item by dragging a corner of its box ('nw'|'ne'|'sw'|'se').
  startItemResize(e, id, idx, corner) {
    const p = this.pdfPt(e);
    this.drag = { kind: 'item-resize', id, idx, corner, start: p, last: p, moved: false };
    e.stopPropagation();
  }
}

export function draftValid(points) { return polygonIsValid(points); }
