// Legacy .pmap (v1.1) <-> v2 project migration (spec §4 "Legacy v1.1 single-file map
// (input only)" and "Migration from v1.1 single-file maps").
//
// v1.1 stores geometry AND content in one file; v2 stores a structure-only map
// plus one or more content variants keyed by stable region ID. This module is the
// split (legacy -> map + content) and its inverse (map + content -> legacy), so
// it can also *prove* the split is lossless before anything is written.
//
// It is deliberately pure: no DOM, no pdf.js, no third-party imports — the same
// code runs in the browser (a future in-app legacy import) and under Node
// (pdfbandit/tools/pmap-migrate.mjs, the CLI the spec's migration step asks for).
import { normalizeRegion, DEFAULT_BACKGROUND } from '../model/region.js';
import { normalizeDetectedType } from '../model/detection.js';

export const MAP_FORMAT = 'pmap';
export const MAP_VERSION = '2.0';          // the structure-only map
export const LEGACY_VERSION = '1.1';       // the single-file map this migrates
export const CONTENT_FORMAT = 'pmap-content';
export const CONTENT_VERSION = '1.0';
export const CONTENT_SUFFIX = '.content.json';
export const DEFAULT_ASSETS_DIR = 'assets';
export const FALLBACK_LANGUAGE = 'und';    // BCP-47 "undetermined", for maps with no language

// ---------------------------------------------------------------- small helpers
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => (typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)));

export function isDataUri(s) { return typeof s === 'string' && /^data:/i.test(s); }
export function detectFileKind(obj) {
  if (!isObj(obj)) return null;
  if (obj.format === CONTENT_FORMAT) return 'content';
  if (obj.format === MAP_FORMAT) return obj.version === MAP_VERSION ? 'map-v2' : 'map-legacy';
  return null;
}
function assertLegacyMap(obj) {
  if (!isObj(obj)) throw new Error('Not a .pmap object');
  if (obj.format !== MAP_FORMAT) throw new Error('Not a .pmap file (format field missing)');
  if (!Array.isArray(obj.pages)) throw new Error('Invalid .pmap: pages missing');
}

// Normalize a legacy map exactly the way the editor does when it resolves a project
// (`resolveProject` → `normalizeRegion`), so pre-`items` content shapes (`content.type/value`,
// flat text items) migrate as the item list the app would have written.
export function normalizeLegacyPmap(obj) {
  assertLegacyMap(obj);
  const out = clone(obj);
  for (const page of out.pages) {
    if (!Array.isArray(page.regions)) page.regions = [];
    for (const r of page.regions) {
      if (!isObj(r.geometry) || !Array.isArray(r.geometry.points)) throw new Error(`Region ${r.id} has no polygon`);
      if (r.geometry.type === 'multipolygon') {
        if (!r.geometry.points.every(ring => Array.isArray(ring) && ring.length >= 3 && Array.isArray(ring[0]))) {
          throw new Error(`Region ${r.id} has an invalid multipolygon`);
        }
      }
      normalizeRegion(r);
    }
  }
  return out;
}

// ---------------------------------------------------------------- content hashing
export async function sha256Hex(bytes) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('SHA-256 is unavailable: crypto.subtle needs a secure context (https:// or localhost)');
  const digest = await subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function base64ToBytes(b64) {
  // Accept base64url as well as standard base64 (data URIs are standard, but be liberal).
  const clean = String(b64 ?? '').replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = clean + '='.repeat((4 - (clean.length % 4)) % 4);
  if (typeof atob === 'function') {
    const bin = atob(padded);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(padded, 'base64'));
  throw new Error('No base64 decoder available in this environment');
}

const MIME_EXT = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp',
  'image/gif': 'gif', 'image/svg+xml': 'svg', 'image/bmp': 'bmp', 'image/tiff': 'tiff',
  'application/pdf': 'pdf', 'text/plain': 'txt',
};
export function extForMime(mime) { return MIME_EXT[String(mime || '').toLowerCase()] || 'bin'; }

const DATA_URI_RE = /^data:([^;,]*)(;base64)?,([\s\S]*)$/i;

// Data URIs are the one thing the spec asks to externalize ("avoid duplicating
// large Base64 data URIs across language files"): decode, hash the bytes and
// point the item at assets/<content-hash>.<ext>, deduplicated by content.
async function externalizeSource(source, assetsDir, table) {
  const m = DATA_URI_RE.exec(String(source));
  if (!m) return { source, externalized: false };
  if (!m[2]) return { source, externalized: false, unsupported: 'not base64' };
  const mime = (m[1] || 'application/octet-stream').toLowerCase();
  const bytes = base64ToBytes(m[3]);
  const hash = await sha256Hex(bytes);
  const hit = table.get(hash);
  if (hit) return { source: hit.path, externalized: true, deduped: true, asset: hit };
  const name = `${hash.slice(0, 32)}.${extForMime(mime)}`;
  const asset = { id: `sha256:${hash}`, name, path: `${assetsDir}/${name}`, mime, bytes };
  table.set(hash, asset);
  return { source: asset.path, externalized: true, asset };
}

// ---------------------------------------------------------------- legacy -> v2
// Deterministic map identity: derived from the *structure* (source identity +
// pages + region ids/geometry/lock) so re-running the migration yields the same
// id. The id is an identity, not a checksum: once the app owns the map it must
// keep it when geometry changes (spec §4).
async function deriveMapId(norm) {
  const structure = {
    source: { filename: norm.source?.filename ?? null, sha256: norm.source?.sha256 ?? null },
    pages: norm.pages.map(p => ({
      page: p.page, width: p.width, height: p.height,
      regions: (p.regions || []).map(r => ({ id: r.id, geometry: r.geometry, locked: !!r.locked })),
    })),
  };
  const hex = await sha256Hex(new TextEncoder().encode(JSON.stringify(structure)));
  return `map_${hex.slice(0, 16)}`;
}

/**
 * Split a legacy v1.1 `.pmap` into a structure-only v2 map + one content variant.
 * Pure and side-effect free: returns the file contents and the asset bytes, the
 * CLI does the writing.
 *
 * opts: { variant, label, mapName, contentName, assetsDir, externalizeDataUris, mapId }
 * returns { map, content, assets, report, warnings }
 */
export async function splitLegacyPmap(legacy, opts = {}) {
  const {
    variant = legacy?.meta?.language || FALLBACK_LANGUAGE,
    label = legacy?.meta?.label || '',
    mapName = legacy?.meta?.name || `${MAP_FORMAT}.pmap`,
    contentName = '',
    assetsDir = DEFAULT_ASSETS_DIR,
    externalizeDataUris = true,
    mapId = '',
  } = opts;

  const norm = normalizeLegacyPmap(legacy);
  const resolvedMapId = mapId || await deriveMapId(norm);
  const assets = [];
  const assetTable = new Map();       // sha256 -> asset (deduplicates across the file)
  const warnings = [];
  const report = {
    pages: norm.pages.length,
    regions: 0, locked: 0, withContent: 0, omitted: 0,
    items: 0, textItems: 0, imageItems: 0, needsReview: 0,
    tables: 0, assets: [], assetRefs: [], externalized: 0, deduped: 0,
    // "normalized" means the legacy payload was not already in the shape the app
    // writes (pre-`items` content, a flat text item, missing style defaults…).
    // Key order alone is not a difference — sortKeys makes the comparison canonical.
    normalized: JSON.stringify(sortKeys(legacy)) !== JSON.stringify(sortKeys(norm)),
  };

  const seenIds = new Set();
  const regionEntries = {};
  const mapPages = [];

  for (const page of norm.pages) {
    const mapRegions = [];
    for (const r of page.regions) {
      if (!r.id) throw new Error('Invalid .pmap: a region has no id');
      if (seenIds.has(r.id)) {
        throw new Error(`Duplicate region id "${r.id}": content is keyed by region id, so ids must be unique`);
      }
      seenIds.add(r.id);
      report.regions += 1;
      if (r.locked) report.locked += 1;

      const background = r.content?.background ?? DEFAULT_BACKGROUND;
      const items = [];
      for (const item of (r.content?.items || [])) {
        const it = clone(item);
        if (it.type === 'image') {
          if (it.source && isDataUri(it.source)) {
            if (externalizeDataUris) {
              const res = await externalizeSource(it.source, assetsDir, assetTable);
              if (res.externalized) {
                it.source = res.source;
                report.externalized += 1;
                if (res.deduped) report.deduped += 1;
                else { assets.push(res.asset); report.assets.push(res.asset.path); }
              } else {
                warnings.push(`image item in ${r.id}: data URI with ${res.unsupported} kept verbatim`);
              }
            }
          } else if (it.source) {
            // A path (or URL) reference is kept verbatim — the CLI reports whether the
            // file it names is actually there.
            report.assetRefs.push(it.source);
          }
        }
        if (it.type === 'text' && it.needsReview) report.needsReview += 1;
        if (it.type === 'text' && (it.blocks || []).some(b => b?.type === 'table')) report.tables += 1;
        if (it.type === 'text') report.textItems += 1;
        else if (it.type === 'image') report.imageItems += 1;
        report.items += 1;
        items.push(it);
      }

      // A region whose content is exactly the default needs no entry: a missing
      // entry resolves back to it (spec §4), so this stays lossless.
      const isDefault = items.length === 0 && background === DEFAULT_BACKGROUND;
      if (isDefault) report.omitted += 1;
      else { regionEntries[r.id] = { background, items }; report.withContent += 1; }

      const mapRegion = { id: r.id, geometry: clone(r.geometry) };
      if (r.locked) mapRegion.locked = true;
      // Additive detection provenance (spec 1.5 §21): written only when present, exactly like
      // `locked`, so v1.1 maps and ordinary v2 files stay unchanged. `detectedType` rides
      // along with the provenance and is dropped with it.
      if (r.detected) {
        mapRegion.detected = true;
        if (r.fingerprint != null) mapRegion.fingerprint = r.fingerprint;
        const kind = normalizeDetectedType(r.detectedType);
        if (kind) mapRegion.detectedType = kind;
      }
      mapRegions.push(mapRegion);
    }
    mapPages.push({ page: page.page, width: page.width, height: page.height, regions: mapRegions });
  }

  const map = {
    format: MAP_FORMAT,
    version: MAP_VERSION,
    mapId: resolvedMapId,
    meta: {
      name: mapName,
      label: 'Shared map',
      created: norm.meta?.created || '',
      modified: norm.meta?.modified || '',
    },
    source: clone(norm.source || {}),
    pages: mapPages,
  };

  const content = {
    format: CONTENT_FORMAT,
    version: CONTENT_VERSION,
    mapId: resolvedMapId,
    meta: {
      name: contentName || `${mapName.replace(/\.pmap$/i, '')}.${variant}${CONTENT_SUFFIX}`,
      language: variant,
      ...(label ? { label } : {}),
      created: norm.meta?.created || '',
      modified: norm.meta?.modified || '',
    },
    regions: regionEntries,
    assets: assets.map(a => ({ id: a.id, path: a.path, mime: a.mime })),
  };

  return { map, content, assets, report, warnings };
}

/**
 * Split the editor's *resolved* project (regions carrying their own content) back into
 * the two v2 files. It is the same operation as the legacy split — the editor's resolved
 * shape is the legacy shape — with what a browser save needs: data URIs stay inline by
 * default (a save is a download; externalizing them into assets/ is the CLI's job), and
 * the caller passes the map id and file names it already owns.
 *
 * Returns what `splitLegacyPmap` returns ({ map, content, assets, report, warnings }).
 */
export function splitProject(resolved, opts = {}) {
  return splitLegacyPmap(resolved, { externalizeDataUris: false, ...opts });
}

// ---------------------------------------------------------------- v2 -> legacy
// The inverse of the split: join a shared map with one content variant into the shape
// that carries both. The editor *resolves* a project this way (it works on regions that
// carry their content — spec §7); the CLI uses the same function for `--to v1.1`.
// Refuses a variant that belongs to another map. Entries for regions the map no longer
// has are inert data, not an error (spec 1.5 §22): a region can be deleted while another
// variant is active, and the variant file keeps its entry until it is next saved. They
// are ignored here and dropped by splitProject() when the variant is written back.
export function joinProject(map, content) {
  if (detectFileKind(map) !== 'map-v2') throw new Error('Not a v2 shared map (format "pmap", version "2.0")');
  if (detectFileKind(content) !== 'content') throw new Error('Not a content variant (format "pmap-content")');
  if (content.mapId !== map.mapId) {
    throw new Error(`Content belongs to map ${content.mapId || '(none)'}, not ${map.mapId}`);
  }
  const entries = content.regions || {};
  const pages = (map.pages || []).map(p => ({
    page: p.page, width: p.width, height: p.height,
    regions: (p.regions || []).map(r => {
      const entry = entries[r.id];
      const region = { id: r.id, geometry: clone(r.geometry) };
      if (r.locked) region.locked = true;
      if (r.detected) {
        region.detected = true;
        if (r.fingerprint != null) region.fingerprint = r.fingerprint;
        const kind = normalizeDetectedType(r.detectedType);
        if (kind) region.detectedType = kind;
      }
      region.content = {
        background: entry?.background ?? DEFAULT_BACKGROUND,
        items: clone(entry?.items || []),
      };
      return region;
    }),
  }));
  return {
    format: MAP_FORMAT,
    version: LEGACY_VERSION,
    meta: {
      name: map.meta?.name || `${MAP_FORMAT}.pmap`,
      language: content.meta?.language,
      ...(content.meta?.label ? { label: content.meta.label } : {}),
      created: content.meta?.created || map.meta?.created || '',
      modified: content.meta?.modified || map.meta?.modified || '',
    },
    source: clone(map.source || {}),
    pages,
  };
}

// ---------------------------------------------------------------- round-trip check
// The exact set of fields Section 4 requires the migration to preserve. Comparing
// these (and not the raw JSON) keeps the check meaningful: a file name in `meta`
// legitimately changes, and unknown legacy fields are reported rather than failing.
async function projectPmap(obj, { assetsDir = DEFAULT_ASSETS_DIR, table = new Map(), externalizeDataUris = true } = {}) {
  const out = {
    source: clone(obj.source || {}),
    // `name`, `language` and `label` are labels, not content: a file name changes on
    // migration and the content variant may be deliberately re-labelled (`--variant`).
    // The variant metadata is checked separately in validateRoundTrip.
    meta: { created: obj.meta?.created || '', modified: obj.meta?.modified || '' },
    pages: [],
  };
  for (const page of (obj.pages || [])) {
    const regions = [];
    for (const r of (page.regions || [])) {
      const items = [];
      for (const item of (r.content?.items || [])) {
        const it = clone(item);
        if (externalizeDataUris && it.type === 'image' && isDataUri(it.source)) {
          it.source = (await externalizeSource(it.source, assetsDir, table)).source;
        }
        items.push(it);
      }
      regions.push({
        id: r.id,
        geometry: clone(r.geometry),
        locked: !!r.locked,
        ...(r.detected ? {
          detected: true,
          ...(r.fingerprint != null ? { fingerprint: r.fingerprint } : {}),
          ...(normalizeDetectedType(r.detectedType) ? { detectedType: normalizeDetectedType(r.detectedType) } : {}),
        } : {}),
        background: r.content?.background ?? DEFAULT_BACKGROUND,
        items,
      });
    }
    regions.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    out.pages.push({ page: page.page, width: page.width, height: page.height, regions });
  }
  return sortKeys(out);
}

// Key-order-insensitive canonical form, so "same data" means the same string.
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (!isObj(v)) return v;
  const out = {};
  for (const k of Object.keys(v).sort()) if (v[k] !== undefined) out[k] = sortKeys(v[k]);
  return out;
}

export function deepDiff(a, b, path = '') {
  if (a === b) return null;
  const ta = Array.isArray(a) ? 'array' : typeof a, tb = Array.isArray(b) ? 'array' : typeof b;
  if (ta !== tb) return `${path || '(root)'}: ${ta} vs ${tb}`;
  if (ta === 'array') {
    if (a.length !== b.length) return `${path}: length ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i++) { const d = deepDiff(a[i], b[i], `${path}[${i}]`); if (d) return d; }
    return null;
  }
  if (ta === 'object') {
    const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
    if (ka.join('\u0000') !== kb.join('\u0000')) {
      const missing = ka.filter(k => !kb.includes(k)), added = kb.filter(k => !ka.includes(k));
      return `${path || '(root)'}: ${missing.length ? `missing ${missing.join(',')}` : ''}${missing.length && added.length ? ', ' : ''}${added.length ? `unexpected ${added.join(',')}` : ''}`;
    }
    for (const k of ka) { const d = deepDiff(a[k], b[k], path ? `${path}.${k}` : k); if (d) return d; }
    return null;
  }
  return `${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
}

/**
 * Verify that split() -> join() preserved everything. `before` is the normalized
 * legacy map, `after` the joined output. `opts.expect` names the variant metadata
 * the caller deliberately wrote (it defaults to the legacy file's own).
 * Returns { ok, checks, errors }.
 */
export async function validateRoundTrip(before, after, opts = {}) {
  const table = new Map();                              // shared: hashes each data URI once
  const proj = (o) => projectPmap(o, { ...opts, table });
  const a = await proj(before), b = await proj(after);

  const fields = (p, pick) => {
    const out = {};
    for (const page of p.pages) for (const r of page.regions) out[r.id] = pick(r);
    return out;
  };
  const ids = (p) => p.pages.map(pg => ({ page: pg.page, ids: pg.regions.map(r => r.id) }));
  const checks = [];
  const add = (name, ok, detail) => { checks.push({ name, ok, detail }); return ok; };

  const expectLang = opts.expect?.language ?? before?.meta?.language;
  const expectLabel = opts.expect?.label ?? before?.meta?.label;
  add('content variant metadata (language/label)',
    (after.meta?.language ?? null) === (expectLang ?? null) && (after.meta?.label || '') === (expectLabel || ''),
    `language ${after.meta?.language ?? '(none)'}${after.meta?.label ? ` · "${after.meta.label}"` : ''}`);

  add('pages and region ids', JSON.stringify(ids(a)) === JSON.stringify(ids(b)),
    `${a.pages.length} pages, ${Object.keys(fields(a, r => r.id)).length} region ids`);
  add('geometry', !deepDiff(fields(a, r => r.geometry), fields(b, r => r.geometry)),
    deepDiff(fields(a, r => r.geometry), fields(b, r => r.geometry)) || 'unchanged');
  add('lock state', !deepDiff(fields(a, r => r.locked), fields(b, r => r.locked)), 'unchanged');
  add('content backgrounds', !deepDiff(fields(a, r => r.background), fields(b, r => r.background)), 'unchanged');
  add('content items (order, boxes, blocks, runs, styles, review flags)',
    !deepDiff(fields(a, r => r.items), fields(b, r => r.items)),
    deepDiff(fields(a, r => r.items), fields(b, r => r.items)) || 'unchanged');
  add('asset references', !deepDiff(assetRefs(a), assetRefs(b)), `${assetRefs(a).length} references`);
  add('source fingerprint', !deepDiff(a.source, b.source),
    `${a.source?.filename || '(none)'} ${String(a.source?.sha256 || '').slice(0, 12)}… ${a.source?.page_count ?? '?'} pages`);
  const whole = deepDiff(a, b);
  add('whole file', !whole, whole || 'identical');

  const errors = checks.filter(c => !c.ok).map(c => `${c.name}: ${c.detail}`);
  return { ok: errors.length === 0, checks, errors };
}

function assetRefs(p) {
  const refs = [];
  for (const page of p.pages) for (const r of page.regions) {
    for (const it of r.items) if (it.type === 'image' && it.source) refs.push(String(it.source));
  }
  return refs.sort();
}
