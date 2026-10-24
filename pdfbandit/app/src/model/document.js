// Pure PageMap model: no DOM, no pdf.js.
import { resetIdCounter } from './region.js';

// A v2 project's shared-map identity. Assigned once, when the map is created: the id is
// an identity, not a checksum (spec §4) — the geometry may change afterwards and the
// map must keep the id its content files reference. The migration tool derives the same
// shape of id from the structure it splits, so both sides look alike.
export function newMapId() {
  const b = new Uint8Array(8);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(b);
  else for (let i = 0; i < b.length; i++) b[i] = Math.floor(Math.random() * 256);
  return 'map_' + [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}

export function ensurePage(pmap, pageNum, width, height) {
  let p = pmap.pages.find(p => p.page === pageNum);
  if (!p) { p = { page: pageNum, width, height, regions: [] }; pmap.pages.push(p); pmap.pages.sort((a,b)=>a.page-b.page); }
  else { p.width = width; p.height = height; }
  return p;
}
export function getPage(pmap, pageNum) {
  return pmap.pages.find(p => p.page === pageNum) || null;
}
export function touch(pmap) { pmap.meta.modified = new Date().toISOString(); }

export function maxRegionIndex(pmap) {
  let m = 0;
  for (const p of pmap.pages) for (const r of (p.regions || [])) {
    const n = parseInt(String(r.id).replace(/\D/g,''), 10);
    if (!isNaN(n)) m = Math.max(m, n);
  }
  return m;
}
export function syncIdCounter(pmap) { resetIdCounter(maxRegionIndex(pmap)); }
