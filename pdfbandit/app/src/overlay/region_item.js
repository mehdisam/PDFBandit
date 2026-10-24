// SVG overlay rendering: polygons, labels, vertex handles. Emits callbacks via delegate.
import { REGION_COLOR, isRegionLocked, regionIsMasked } from '../model/region.js';
import { regionRings } from '../model/geometry.js';

const NS = 'http://www.w3.org/2000/svg';
// Half the side of an item's square corner handle (8 x 8 px, the same grab area the round
// handles had).
const ITEM_HANDLE_HALF = 4;
function el(tag, attrs = {}) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

export class Overlay {
  constructor(svg, delegate) {
    this.svg = svg;
    this.d = delegate; // { onSelect(id, additive), onVertexDrag(...), onEdgeClick(...), ... }
    this.visible = true;
  }
  clear() { this.svg.innerHTML = ''; }
  render({ regions, selectedIds, draftPoints, draftCursor, splitLine, mode, tool = 'select', itemBoxes = [], selectedVertex = null, marquee = null, clipWarn = null, showDigital = false, digitalFilled = null, awaitingOcr = null, statusTags = null }) {
    this.clear();
    if (!this.visible || mode === 'view' || mode === 'text') return;
    const drafting = !!(draftPoints && draftPoints.length);
    const clickThroughPolys = tool === 'split';
    const clickThroughHandles = tool === 'split' || drafting;
    // The selected region(s) are drawn last, so that where regions overlap — or merely sit
    // close enough that their edge bands cross — the press, its cursor and the vertex handles
    // belong to the region being edited, never to a neighbour that happens to be later in the
    // array (spec §9). While selected, the region is simply on top.
    const ordered = regions.filter(r => !selectedIds.has(r.id)).concat(regions.filter(r => selectedIds.has(r.id)));
    // A ring's points as an SVG `points` attribute; shared by every polygon and band below.
    const ptsAttr = (ring) => ring.map(p => p.join(',')).join(' ');
    const filled = digitalFilled || new Set();
    const awaiting = awaitingOcr || new Set();
    // The digital-status tag under the id. A region with no detected class is still a text
    // candidate (the same way detection/harvest treats it), so it reads as "text" until it
    // gets content; a detected figure stays untagged instead of pretending to be convertible.
    const filledTag = statusTags?.filled || 'digital';
    const missingTag = statusTags?.missing || 'awaiting OCR';
    const tagsFor = (r) => {
      const tags = [];
      if (r.detectedType === 'heading') tags.push({ text: 'heading', cls: 'rtag-heading' });
      else if (r.detectedType === 'text') tags.push({ text: 'text', cls: 'rtag-text' });
      if (awaiting.has(r.id)) tags.push({ text: missingTag, cls: 'rtag-awaiting-ocr' });
      if (filled.has(r.id)) tags.push({ text: filledTag, cls: 'rtag-digital' });
      // A manual region has no detected class, but it is a text candidate by definition;
      // a detected figure is not, so it stays untagged and keeps only its dashed outline.
      if (!tags.length && r.detectedType !== 'image') tags.push({ text: 'text', cls: 'rtag-text' });
      return tags;
    };
    for (const r of ordered) {
      const color = REGION_COLOR;
      const sel = selectedIds.has(r.id);
      const locked = isRegionLocked(r);
      // A region is one ring (polygon) or several rings (multipolygon, after merging
      // non-touching regions) — draw one <polygon> per ring with the same id.
      const rings = regionRings(r.geometry);
      if (!rings.length) continue;
      // Mask preview: a region that holds content is masked *under* the overlay by the
      // view canvas, exactly as Preview mode and the export render it, while it is *not*
      // selected. The polygon itself stays transparent (the selected region must show the
      // original through it; empty regions are never masked) — the class only flips the
      // id label to dark text so it stays readable over the mask.
      const masked = !sel && regionIsMasked(r);
      // A soft halo behind the selected region makes the selection obvious without
      // filling it (Edit mode stays transparent so the source PDF shows through).
      if (sel) {
        for (const ring of rings) {
          const halo = el('polygon', { points: ptsAttr(ring), class: 'region-halo', fill: 'none' });
          halo.style.pointerEvents = 'none';
          this.svg.appendChild(halo);
        }
      }
      for (let ri = 0; ri < rings.length; ri++) {
        // A still-untouched figure proposal keeps a dashed outline (P4): it tells the user
        // the region came from image detection, and the first edit clears the provenance.
        const fig = r.detected && r.detectedType === 'image' ? ' detected-image' : '';
        const poly = el('polygon', {
          points: ptsAttr(rings[ri]),
          class: `region${sel ? ' selected' : ''}${locked ? ' locked' : ''}${masked ? ' masked' : ''}${clipWarn && clipWarn.has(r.id) ? ' clip-warn' : ''}${fig}`,
          fill: color,
          stroke: color,
        });
        poly.dataset.id = r.id; poly.dataset.ring = ri;
        if (locked) poly.dataset.locked = '1';
        // In split mode clicks must reach background to place the dividing line.
        if (clickThroughPolys && !sel) poly.style.pointerEvents = 'none';
        poly.addEventListener('pointerdown', (e) => this.d.onRegionPointerDown(e, r.id));
        this.svg.appendChild(poly);
      }
      const [lx, ly] = rings[0][0];
      const label = el('text', { x: lx + (locked ? 16 : 3), y: ly + 13, class: 'rlabel' });
      label.textContent = r.id;
      if (showDigital) {
        for (const tag of tagsFor(r)) {
          const part = el('tspan', { class: `rtag ${tag.cls}` });
          part.textContent = ` · ${tag.text}`;
          label.appendChild(part);
        }
      }
      this.svg.appendChild(label);
      if (locked) this.svg.appendChild(this.renderLockBadge(lx + 3, ly + 2));
    }
    // The edge band of a selected region: an invisible ~10 px grab strip along its outline,
    // painted over every polygon so its line stays reachable even where a neighbouring region
    // overlaps it. Locked regions get none — their geometry is refused anyway, and a band
    // would only steal presses from the regions around them.
    if (mode === 'region' && !drafting) {
      if (tool === 'select') {
        for (const r of ordered) {
          if (!selectedIds.has(r.id) || isRegionLocked(r)) continue;
          for (const ring of regionRings(r.geometry)) {
            const band = el('polygon', { points: ptsAttr(ring), class: 'region-band' });
            band.dataset.id = r.id;
            band.addEventListener('pointerdown', (e) => this.d.onRegionPointerDown(e, r.id));
            this.svg.appendChild(band);
          }
        }
      }
      // Vertex handles come last of all: a vertex always outranks the line band, so the
      // handle keeps its precedence over the line no matter what overlaps it. In Content mode
      // there are none — the outline is read-only there (spec §9a).
      for (const r of ordered) {
        if (!selectedIds.has(r.id) || isRegionLocked(r)) continue;
        this.renderHandles(r, clickThroughHandles, selectedVertex);
      }
    }
    // Item boxes for the selected region: the "tiny canvas" for placing content.
    for (const it of itemBoxes) {
      const rect = el('rect', { x: it.x, y: it.y, width: it.w, height: it.h, class: `item-box${it.selected ? ' item-selected' : ''}` });
      rect.dataset.region = it.id; rect.dataset.index = it.index;
      rect.style.pointerEvents = 'auto';
      rect.addEventListener('pointerdown', (e) => this.d.onItemPointerDown(e, it.id, it.index));
      this.svg.appendChild(rect);
      const tag = el('text', { x: it.x + 2, y: it.y + 9, class: 'item-tag' });
      tag.textContent = it.type === 'image' ? 'IMG' : 'TXT';
      this.svg.appendChild(tag);
      if (it.selected) this.renderItemHandles(it);
    }
    if (draftPoints && draftPoints.length) this.renderDraft(draftPoints, draftCursor);
    if (splitLine && splitLine.length) {
      const pl = el('polyline', { points: splitLine.map(p=>p.join(',')).join(' '), fill: 'none', stroke: '#ff0', 'stroke-width': 2 });
      pl.style.pointerEvents = 'none';
      this.svg.appendChild(pl);
    }
    if (marquee) {
      const [mx0, my0, mx1, my1] = marquee;
      const rect = el('rect', {
        x: Math.min(mx0, mx1), y: Math.min(my0, my1),
        width: Math.abs(mx1 - mx0), height: Math.abs(my1 - my0),
        class: 'marquee',
      });
      rect.style.pointerEvents = 'none';
      this.svg.appendChild(rect);
    }
  }
  // Small padlock next to a locked region's id: a visual reminder that the polygon
  // is frozen while its content stays editable.
  renderLockBadge(x, y) {
    const g = el('g', { class: 'lock-badge' });
    g.style.pointerEvents = 'none';
    const shackle = el('path', { d: `M${x + 3.1} ${y + 8} v-1.6 a1.9 1.9 0 0 1 3.8 0 v1.6`, class: 'lock-shackle' });
    const body = el('rect', { x: x + 1.6, y: y + 8, width: 6.8, height: 5.4, rx: 1, class: 'lock-body' });
    g.appendChild(shackle);
    g.appendChild(body);
    return g;
  }
  // Item corner handles are **squares in dark grey** — deliberately not the round blue
  // circles a region's own vertices use, so a text box's corners can never be mistaken for
  // the region's (spec §9b).
  renderItemHandles(it) {
    const cs = [[it.x, it.y, 'nw'], [it.x + it.w, it.y, 'ne'], [it.x, it.y + it.h, 'sw'], [it.x + it.w, it.y + it.h, 'se']];
    for (const [cx, cy, corner] of cs) {
      const h = el('rect', {
        x: cx - ITEM_HANDLE_HALF, y: cy - ITEM_HANDLE_HALF,
        width: ITEM_HANDLE_HALF * 2, height: ITEM_HANDLE_HALF * 2, class: 'item-handle',
      });
      h.dataset.region = it.id; h.dataset.index = it.index; h.dataset.corner = corner;
      h.style.pointerEvents = 'auto';
      h.addEventListener('pointerdown', (e) => this.d.onItemHandlePointerDown(e, it.id, it.index, corner));
      this.svg.appendChild(h);
    }
  }
  // Live preview of an in-progress polygon: lines + vertex dots + rubber-band to cursor.
  renderDraft(draftPoints, cursor) {
    const col = '#0a66c2';
    const pl = el('polyline', { points: draftPoints.map(p => p.join(',')).join(' '), fill: 'none', stroke: col, 'stroke-width': 1.5, 'stroke-dasharray': '6 3' });
    pl.style.pointerEvents = 'none';
    this.svg.appendChild(pl);
    if (cursor) {
      const last = draftPoints[draftPoints.length - 1];
      const rb = el('line', { x1: last[0], y1: last[1], x2: cursor[0], y2: cursor[1], stroke: col, 'stroke-width': 1.5, 'stroke-dasharray': '6 3' });
      rb.style.pointerEvents = 'none';
      this.svg.appendChild(rb);
    }
    for (const p of draftPoints) {
      const c = el('circle', { cx: p[0], cy: p[1], r: 4, fill: col, stroke: '#fff', 'stroke-width': 1.5 });
      c.style.pointerEvents = 'none';
      this.svg.appendChild(c);
    }
  }
  renderHandles(region, clickThrough = false, selectedVertex = null) {
    const rings = regionRings(region.geometry);
    const vSel = selectedVertex && selectedVertex.id === region.id ? selectedVertex : null;
    rings.forEach((pts, ri) => {
      pts.forEach((p, i) => {
        const isSel = !!(vSel && (vSel.ring ?? 0) === ri && vSel.idx === i);
        const c = el('circle', { cx: p[0], cy: p[1], r: 5, class: `handle${isSel ? ' vertex-selected' : ''}` });
        c.dataset.region = region.id; c.dataset.ring = ri; c.dataset.vertex = i;
        if (clickThrough) c.style.pointerEvents = 'none';
        c.addEventListener('pointerdown', (e) => this.d.onVertexPointerDown(e, region.id, ri, i));
        this.svg.appendChild(c);
      });
    });
  }
  // Screen->PDF coords for a pointer event on the SVG.
  eventPdfPoint(e, zoom) {
    const rect = this.svg.getBoundingClientRect();
    return [(e.clientX - rect.left) / zoom, (e.clientY - rect.top) / zoom];
  }
  // Hit-test which edge (of which ring) is near a pdf point (for add-vertex / edge-drag).
  static nearestEdge(region, pdfPt, zoom) {
    const rings = regionRings(region.geometry);
    let best = null, bestD = Infinity;
    rings.forEach((pts, ri) => {
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        const dx = b[0]-a[0], dy = b[1]-a[1];
        const L2 = dx*dx+dy*dy || 1;
        let t = ((pdfPt[0]-a[0])*dx + (pdfPt[1]-a[1])*dy) / L2;
        t = Math.max(0, Math.min(1, t));
        const d = Math.hypot(pdfPt[0]-(a[0]+t*dx), pdfPt[1]-(a[1]+t*dy));
        if (d < bestD) { bestD = d; best = { ring: ri, edge: i, dist: d }; }
      }
    });
    // threshold ~10 screen px
    return best && bestD * zoom < 10 ? best : null;
  }
  // The cursor for the *line* a pointer is near (spec §9). A resize cursor's axis is
  // perpendicular to the line it belongs to — a horizontal line reads as up/down
  // (`ns-resize`), a vertical one as left/right (`ew-resize`), the diagonals as their own —
  // which is exactly how a box's edge handles read, so "this line will move" is obvious and
  // can never be confused with the region's *move* cursor or a vertex's *grab*.
  static edgeCursor(region, edge) {
    const pts = regionRings(region.geometry)[edge.ring];
    if (!pts || pts.length < 2) return 'move';
    const a = pts[edge.edge], b = pts[(edge.edge + 1) % pts.length];
    const nx = -(b[1] - a[1]), ny = b[0] - a[0]; // a normal to the line (y down)
    const ax = Math.abs(nx), ay = Math.abs(ny);
    if (ax > 2.414 * ay) return 'ew-resize';     // within 22.5° of horizontal
    if (ay > 2.414 * ax) return 'ns-resize';     // within 22.5° of vertical
    return nx * ny > 0 ? 'nwse-resize' : 'nesw-resize';
  }
  // What a press at a pdf point over a region would grab, as a cursor: the line's cursor
  // when the point is inside the edge band the press uses, the region's move cursor
  // otherwise, and the plain pointer for a locked region (it can only be selected).
  static regionCursor(region, pdfPt, zoom) {
    if (!region) return null;
    if (isRegionLocked(region)) return 'pointer';
    const edge = Overlay.nearestEdge(region, pdfPt, zoom);
    return edge ? Overlay.edgeCursor(region, edge) : 'move';
  }
}
