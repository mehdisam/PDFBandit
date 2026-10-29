// Content variants: the language half of a v2 project.
//
// A project on disk is a structure-only `.pmap` (shared geometry, stable region ids —
// see storage/pmap.js) plus one `<stem>.<variant>.content.json` per variant, keyed by
// those same region ids. This module owns that half: its own shape, its name convention,
// and the resolution of the two halves into the one object the editor works on
// (`resolveProject`).
//
// A content variant names both its *source* and *destination* language. When they are
// equal the variant is an "improve" variant (the PDF's own language, made selectable);
// when they differ it is a "translate" variant (source → destination). The editor derives
// the workflow from this equality — there is no separate lens concept.
//
// The editor deliberately consumes the *resolved* project — every region carries its
// content — so nothing downstream (rendering, editing, export) has to know where the
// JSON was stored (spec §7). Saving splits it back into the two files
// (`splitProject`), which is the exact inverse of the resolution here.
//
// Pure: no DOM, no pdf.js — usable from Node (tests) as well as the browser.
import { normalizeRegion } from '../model/region.js';
import { newMapId } from '../model/document.js';
import { CONTENT_FORMAT, CONTENT_VERSION, CONTENT_SUFFIX, MAP_FORMAT, MAP_VERSION, FALLBACK_LANGUAGE, joinProject } from './project-migrate.js';
import { parseMap } from './pmap.js';

// ---------------------------------------------------------------- names
export function isMapFileName(name) { return /\.pmap$/i.test(String(name || '')); }
export function isContentFileName(name) { return /\.content\.json$/i.test(String(name || '')); }
export function contentStem(name) { return String(name || '').replace(/\.content\.json$/i, ''); }
export function mapStem(name) { return String(name || '').replace(/\.pmap$/i, '').replace(/\.pdf$/i, ''); }

export function defaultMapName(filename) { return `${mapStem(filename || 'document')}.pmap`; }
export function defaultContentName(stem, sourceLanguage, destinationLanguage) {
  const src = sourceLanguage || FALLBACK_LANGUAGE;
  const dst = destinationLanguage || src;
  return src === dst
    ? `${mapStem(stem || 'document')}.${src}${CONTENT_SUFFIX}`
    : `${mapStem(stem || 'document')}.${src}-${dst}${CONTENT_SUFFIX}`;
}

// ---------------------------------------------------------------- content variants
// A variant with no entries at all: every region falls back to the default content
// (transparent background, no items) — the source page shows through, which is a valid
// state and the natural starting point for a new language. When source and destination
// are equal this is an "improve" variant (the PDF's own language made selectable);
// otherwise it is a "translate" variant (source → destination).
export function emptyContentVariant({ mapId, sourceLanguage = FALLBACK_LANGUAGE, destinationLanguage = sourceLanguage, label = '', name = '', created = '' } = {}) {
  if (!mapId) throw new Error('A content variant needs the id of the map it belongs to');
  const now = new Date().toISOString();
  const src = String(sourceLanguage || FALLBACK_LANGUAGE);
  const dst = String(destinationLanguage || src);
  return {
    format: CONTENT_FORMAT,
    version: CONTENT_VERSION,
    mapId,
    meta: {
      name: name || defaultContentName('document', src, dst),
      sourceLanguage: src,
      destinationLanguage: dst,
      ...(label ? { label } : {}),
      created: created || now,
      modified: created || now,
    },
    regions: {},
    assets: [],
  };
}

export function parseContent(textOrObj) {
  const obj = typeof textOrObj === 'string' ? JSON.parse(textOrObj) : textOrObj;
  if (!obj || typeof obj !== 'object') throw new Error('Not a content variant');
  if (obj.format !== CONTENT_FORMAT) throw new Error('Not a content variant (format "pmap-content" missing)');
  if (!obj.mapId) throw new Error('Invalid content variant: mapId missing (it must name the map it belongs to)');
  if (!obj.regions || typeof obj.regions !== 'object' || Array.isArray(obj.regions)) {
    throw new Error('Invalid content variant: regions missing');
  }
  const meta = obj.meta || {};
  if (!meta.sourceLanguage) throw new Error('Invalid content variant: sourceLanguage missing');
  if (!meta.destinationLanguage) throw new Error('Invalid content variant: destinationLanguage missing');
  if (!Array.isArray(obj.assets)) obj.assets = [];
  for (const [id, entry] of Object.entries(obj.regions)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`Content entry for region ${id} is not an object`);
    if (!Array.isArray(entry.items)) entry.items = [];
  }
  return obj;
}

// True when source and destination are the same language: an "improve" variant (the PDF's
// own language made selectable) rather than a "translate" variant (source → destination).
export function isImproveVariant(content) {
  const m = content && content.meta;
  return !!m && String(m.sourceLanguage || '').toLowerCase() === String(m.destinationLanguage || '').toLowerCase();
}

// Pure, like serializeMap: the caller owns `meta.modified`.
export function serializeContent(content) { return JSON.stringify(content, null, 2); }

// Content files offered for a PDF: the ones whose stem matches come first (a
// convenience), any other `*.content.json` in the same selection as a fallback. What
// decides is the file's `mapId`, never its name (spec §3).
export function matchContentFiles(pdfName, files) {
  const stem = mapStem(pdfName);
  const all = files.filter(f => isContentFileName(f.name));
  const sameStem = all.filter(f => contentStem(f.name) === stem || contentStem(f.name).startsWith(stem + '.'));
  return sameStem.length ? sameStem : all;
}

// ---------------------------------------------------------------- map + project
// The structure-only half of a project (storage/pmap.js parses/serializes it).
export function createMap({ filename, sha256, pageCount, mapId = newMapId(), name = '' } = {}) {
  const now = new Date().toISOString();
  return {
    format: MAP_FORMAT,
    version: MAP_VERSION,
    mapId,
    meta: { name: name || defaultMapName(filename), label: 'Shared map', created: now, modified: now },
    source: { filename: filename || '', sha256: sha256 || '', page_count: pageCount || 0 },
    pages: [],
  };
}

// A brand new project: an empty shared map plus one empty content variant.
export function createEmptyProject({ filename, sha256, pageCount, sourceLanguage = 'en', destinationLanguage = sourceLanguage, label = 'Base map', mapId } = {}) {
  const map = createMap({ filename, sha256, pageCount, mapId });
  const content = emptyContentVariant({
    mapId: map.mapId, sourceLanguage, destinationLanguage, label,
    name: defaultContentName(filename, sourceLanguage, destinationLanguage),
    created: map.meta.created,
  });
  return resolveProject(map, content);
}

/**
 * Resolve a project for the editor: shared map + one content variant → the object the
 * editor works on, with every region carrying its content.
 *
 * `contentOrText` may be null (or omitted) for a map with no variant yet: the caller
 * gets an empty variant named by `opts` instead. A content file that names a different
 * map, or that carries entries for regions the map does not have, is refused rather
 * than silently loaded with content dropped (spec §3).
 */
export function resolveProject(mapOrText, contentOrText = null, opts = {}) {
  const map = parseMap(mapOrText);
  const content = contentOrText == null
    ? emptyContentVariant({
        mapId: map.mapId,
        sourceLanguage: opts.sourceLanguage || FALLBACK_LANGUAGE,
        destinationLanguage: opts.destinationLanguage || opts.sourceLanguage || FALLBACK_LANGUAGE,
        label: opts.label || '',
        name: opts.name || defaultContentName(map.meta?.name || 'document', opts.sourceLanguage || FALLBACK_LANGUAGE, opts.destinationLanguage || opts.sourceLanguage || FALLBACK_LANGUAGE),
      })
    : parseContent(contentOrText);
  const merged = joinProject(map, content);
  // Canonicalize the items (legacy flat values, missing style defaults, …) exactly as
  // the old single-file loader did, so everything downstream sees the current shape.
  for (const p of merged.pages) for (const r of p.regions) normalizeRegion(r);
  return { map, content, merged };
}
