// Zoom/pan + PDF-points <-> screen conversion. Origin top-left, units points.
export class StageTransform {
  constructor() {
    this.zoom = 1;
    this.panX = 0; this.panY = 0; // reserved (scroll container handles pan; kept for API)
    this.pageW = 0; this.pageH = 0;
  }
  setPageSize(w, h) { this.pageW = w; this.pageH = h; }
  toScreen([x, y]) { return [x * this.zoom, y * this.zoom]; }
  toPdf([x, y]) { return [x / this.zoom, y / this.zoom]; }
  applyToSvg(svg) {
    const w = this.pageW * this.zoom, h = this.pageH * this.zoom;
    svg.setAttribute('width', w);
    svg.setAttribute('height', h);
    svg.setAttribute('viewBox', `0 0 ${this.pageW} ${this.pageH}`);
  }
}
