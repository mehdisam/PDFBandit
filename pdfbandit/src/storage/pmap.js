// Shared-map (.pmap) parse/serialize + map sidecar discovery. No DOM except the
// download helper.
//
// v2 only: a `.pmap` holds the shared *structure* — page sizes, region ids, geometry,
// lock state — and never any content. The content lives in the project's content
// variant(s) (see storage/content-file.js), keyed by the same region ids. A v1.1
// single-file map (geometry and content in one object) is refused with a pointer to the
// migration tool, which is how such a file becomes a v2 project.
//
// The format constants live next to the split/join that implements the format
// (storage/project-migrate.js), so there is exactly one definition of it.
import { MAP_FORMAT, MAP_VERSION, LEGACY_VERSION } from './project-migrate.js';

// Pure: the caller owns `meta.modified`. The project save bumps it only for the side
// that actually changed (a content-only edit must not pretend the map changed).
export function serializeMap(map) { return JSON.stringify(map, null, 2); }

export function parseMap(textOrObj) {
  const obj = typeof textOrObj === 'string' ? JSON.parse(textOrObj) : textOrObj;
  if (!obj || typeof obj !== 'object') throw new Error('Not a .pmap file');
  if (obj.format !== MAP_FORMAT) throw new Error('Not a .pmap file (format field missing)');
  if (obj.version === LEGACY_VERSION) {
    throw new Error('This is a v1.1 single-file map (geometry and content in one file). '
      + 'This build reads v2 projects — split it first with tools/pmap-migrate.mjs, then open '
      + 'the .pmap together with its .content.json file.');
  }
  if (obj.version !== MAP_VERSION) throw new Error(`Unsupported .pmap version ${JSON.stringify(obj.version)} (expected ${MAP_VERSION})`);
  if (!obj.mapId) throw new Error('Invalid .pmap: mapId missing (a v2 map declares the id its content files reference)');
  if (!Array.isArray(obj.pages)) throw new Error('Invalid .pmap: pages missing');
  for (const p of obj.pages) {
    if (!Array.isArray(p.regions)) p.regions = [];
    for (const r of p.regions) {
      if (!r.geometry || !Array.isArray(r.geometry.points)) throw new Error(`Region ${r.id} has no polygon`);
      if (r.geometry.type === 'multipolygon') {
        if (!r.geometry.points.every(ring => Array.isArray(ring) && ring.length >= 3 && Array.isArray(ring[0]))) {
          throw new Error(`Region ${r.id} has an invalid multipolygon`);
        }
      } else {
        r.geometry.type = 'polygon';
      }
    }
  }
  return obj;
}

export function downloadText(filename, text, mime='application/json') {
  const blob = new Blob([text], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

const stripExt = (n) => n.replace(/\.[^.]+$/, '');
// Candidate map sidecars for a pdf name: same stem, ending .pmap (incl. lang/stage variants).
export function matchSidecars(pdfName, files) {
  const stem = stripExt(pdfName);
  return files.filter(f =>
    f.name !== pdfName &&
    f.name.endsWith('.pmap') &&
    (f.name === stem + '.pmap' || f.name.startsWith(stem + '.'))
  );
}
