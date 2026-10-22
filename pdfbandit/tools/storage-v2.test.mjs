// Storage-layer tests for the v2 app: what the editor reads in and writes out.
//
// Everything here is pure (no DOM, no pdf.js), which is the point of keeping the file
// shapes in src/storage/*: the same code the browser runs is checked here under Node.
//
//     node --test tools/storage-v2.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseMap, serializeMap, matchSidecars } from '../src/storage/pmap.js';
import {
  createEmptyProject, resolveProject, emptyContentVariant, parseContent, serializeContent,
  matchContentFiles, defaultContentName, defaultMapName, isContentFileName, isMapFileName, contentStem,
} from '../src/storage/content-file.js';
import { createTextItem, createImageItem } from '../src/model/region.js';
import { splitProject, detectFileKind, CONTENT_SUFFIX } from '../src/storage/project-migrate.js';

// The editor's in-memory project, as src/main.js sees it: one resolved object.
const emptyProject = (over = {}) => createEmptyProject({ filename: 'doc.pdf', sha256: 'a'.repeat(64), pageCount: 2, ...over });

// Add one page + region to a resolved project (the shape the editor mutates).
function addRegion(merged, { id = 'r001', points = [[10, 10], [110, 10], [110, 60], [10, 60]], content = null, locked = false } = {}) {
  merged.pages.push({
    page: 1, width: 200, height: 300,
    regions: [{
      id,
      geometry: { type: 'polygon', points },
      ...(locked ? { locked: true } : {}),
      content: content || { background: '#ffffff', items: [] },
    }],
  });
  return merged;
}

// Exactly what src/main.js `projectTexts()` does, minus the DOM/status bookkeeping:
// rebuild both files from the resolved model, then canonicalize the halves the way the
// dirty check does (meta.modified is a timestamp, not data).
async function saveLoad(merged, project) {
  const { map, content } = await splitProject(merged, {
    mapId: project.map.mapId, mapName: project.map.meta.name, contentName: project.content.meta.name,
    variant: project.content.meta.language, label: project.content.meta.label, externalizeDataUris: false,
  });
  const again = resolveProject(serializeMap(map), serializeContent(content));
  return { map, content, again };
}

test('a new project is a map plus one empty variant, sharing one id', () => {
  const { map, content, merged } = emptyProject();
  assert.match(map.mapId, /^map_[0-9a-f]{16}$/);
  assert.equal(content.mapId, map.mapId);
  assert.equal(map.format, 'pmap');
  assert.equal(map.version, '2.0');
  assert.equal(content.format, 'pmap-content');
  assert.equal(map.meta.name, 'doc.pmap');
  assert.equal(content.meta.name, `doc.en${CONTENT_SUFFIX}`);
  assert.equal(content.meta.language, 'en');
  assert.deepEqual(content.regions, {});
  assert.deepEqual(merged.pages, []);
  // A map never carries content, and a variant never carries geometry.
  assert.equal(JSON.stringify(map).includes('"content"'), false);
  assert.equal(JSON.stringify(content).includes('"geometry"'), false);
});

test('a saved project reloads as the same resolved project (save -> load identity)', async () => {
  const project = emptyProject();
  const merged = addRegion(project.merged, {
    content: {
      background: '#ffffff',
      items: [createTextItem({ value: 'Hallo', box: [0, 0, 90, 20], style: { size: 12 }, needsReview: true })],
    },
  });
  const { again } = await saveLoad(merged, project);
  assert.deepEqual(again.merged.pages, merged.pages);
  assert.equal(again.map.mapId, project.map.mapId);         // identity, not checksum: kept as given
  assert.equal(again.content.meta.language, 'en');
  assert.equal(again.content.meta.name, `doc.en${CONTENT_SUFFIX}`);
  assert.equal(again.content.meta.created, project.content.meta.created);
});

test('default content gets no entry, and comes back as the default', async () => {
  const project = emptyProject();
  const merged = addRegion(project.merged);                       // nothing set: the default
  merged.pages[0].regions.push({
    id: 'r002',
    geometry: { type: 'polygon', points: [[10, 70], [110, 70], [110, 120], [10, 120]] },
    content: { background: '#ee2b8c', items: [] },
  });
  const { content, again } = await saveLoad(merged, project);
  assert.deepEqual(Object.keys(content.regions), ['r002']);        // r001 omitted
  assert.equal(again.merged.pages[0].regions[0].content.background, '#ffffff');
  assert.deepEqual(again.merged.pages[0].regions[0].content.items, []);
  assert.equal(again.merged.pages[0].regions[1].content.background, '#ee2b8c');
});

test('locks, multipolygons and review flags survive the save', async () => {
  const project = emptyProject();
  const merged = addRegion(project.merged, { locked: true });
  merged.pages[0].regions.push({
    id: 'r002',
    geometry: { type: 'multipolygon', points: [[[0, 0], [10, 0], [10, 10]], [[50, 50], [60, 50], [60, 60], [50, 60]]] },
    content: { background: '#ffffff', items: [createTextItem({ value: 'x', box: [0, 0, 30, 10], style: { size: 10, lineHeight: 3 }, needsReview: true })] },
  });
  const { map, again } = await saveLoad(merged, project);
  assert.equal(map.pages[0].regions[0].locked, true);
  assert.equal(map.pages[0].regions[1].geometry.type, 'multipolygon');
  assert.equal(map.pages[0].regions[1].geometry.points.length, 2);
  assert.equal(again.merged.pages[0].regions[1].content.items[0].needsReview, true);
  assert.equal(again.merged.pages[0].regions[1].content.items[0].style.lineHeight, 3);
  assert.equal(again.merged.pages[0].regions[0].locked, true);
});

test('the save is deterministic: split -> resolve -> split is byte-identical', async () => {
  const project = emptyProject();
  const merged = addRegion(project.merged, {
    content: { background: '#bebfc1', items: [createTextItem({ value: 'a', box: [0, 0, 40, 12], style: { size: 10 } })] },
  });
  const opts = { mapId: project.mapId, mapName: project.map.meta.name, contentName: project.content.meta.name, variant: 'en', label: 'Base map', externalizeDataUris: false };
  const one = await splitProject(merged, opts);
  const two = await splitProject(resolveProject(one.map, one.content).merged, opts);
  assert.equal(JSON.stringify(two.map), JSON.stringify(one.map));
  assert.equal(JSON.stringify(two.content), JSON.stringify(one.content));
});

test('the app writes image sources inline; the CLI is what externalizes them', async () => {
  const project = emptyProject();
  const dataUri = 'data:image/png;base64,' + Buffer.from('hello').toString('base64');
  const merged = addRegion(project.merged, {
    content: { background: '#ffffff', items: [createImageItem({ source: dataUri, box: [0, 0, 10, 10] })] },
  });
  const { content } = await splitProject(merged, { mapId: project.map.mapId, mapName: 'doc.pmap', contentName: 'doc.en.content.json', variant: 'en', externalizeDataUris: false });
  assert.equal(content.regions.r001.items[0].source, dataUri);
  assert.deepEqual(content.assets, []);
  const external = await splitProject(merged, { mapId: project.map.mapId, mapName: 'doc.pmap', contentName: 'doc.en.content.json', variant: 'en', assetsDir: 'assets', externalizeDataUris: true });
  assert.match(external.content.regions.r001.items[0].source, /^assets\/[0-9a-f]{32}\.png$/);
  assert.equal(external.content.assets.length, 1);
});

test('a v1.1 single-file map is refused, with the way forward named', () => {
  const legacy = { format: 'pmap', version: '1.1', meta: { name: 'old.pmap' }, source: {}, pages: [] };
  assert.equal(detectFileKind(legacy), 'map-legacy');
  assert.throws(() => parseMap(legacy), /pmap-migrate\.mjs/);
  assert.throws(() => parseMap({ format: 'pmap', version: '1.0', pages: [] }), /Unsupported \.pmap version/);
  assert.throws(() => parseMap({ format: 'pmap', version: '2.0', pages: [] }), /mapId missing/);
  assert.throws(() => parseMap('{"format":"nope"}'), /Not a \.pmap file/);
});

test('a v2 map validates its regions and page list', () => {
  const { map } = emptyProject();
  assert.deepEqual(parseMap(map), map);
  const noPages = { ...map, pages: undefined };
  assert.throws(() => parseMap(noPages), /pages missing/);
  const badRegion = { ...map, pages: [{ page: 1, regions: [{ id: 'r1' }] }] };
  assert.throws(() => parseMap(badRegion), /has no polygon/);
  const badMulti = { ...map, pages: [{ page: 1, regions: [{ id: 'r1', geometry: { type: 'multipolygon', points: [[[0, 0], [1, 0]]] } }] }] };
  assert.throws(() => parseMap(badMulti), /invalid multipolygon/);
  const typed = parseMap({ ...map, pages: [{ page: 1, regions: [{ id: 'r1', geometry: { points: [[0, 0], [1, 0], [1, 1]] } }] }] });
  assert.equal(typed.pages[0].regions[0].geometry.type, 'polygon');   // absent type means polygon
});

test('a content variant must name its map and carry a regions object', () => {
  const { content } = emptyProject();
  assert.deepEqual(parseContent(JSON.stringify(content)), content);
  assert.throws(() => parseContent({ format: 'pmap-content', regions: {} }), /mapId missing/);
  assert.throws(() => parseContent({ format: 'pmap-content', mapId: 'map_x' }), /regions missing/);
  assert.throws(() => parseContent({ format: 'pmap', version: '2.0', mapId: 'map_x', regions: {} }), /Not a content variant/);
  // A missing items array is a region with no content, not a crash.
  const loose = parseContent({ format: 'pmap-content', mapId: 'map_x', regions: { r1: { background: '#000000' } } });
  assert.deepEqual(loose.regions.r1.items, []);
  assert.throws(() => parseContent({ format: 'pmap-content', mapId: 'map_x', regions: { r1: 'nope' } }), /not an object/);
});

test('a variant for another map is refused; inert deleted-region entries are kept, not loaded', () => {
  const { map } = emptyProject();
  const other = emptyContentVariant({ mapId: 'map_deadbeefdeadbeef', language: 'de' });
  assert.throws(() => resolveProject(map, other), /Content belongs to map/);
  // A region deleted while another variant was active leaves an inert entry: the file
  // still opens (spec 1.5 §22), and the entry stays in the file object until it is saved.
  const stray = emptyContentVariant({ mapId: map.mapId, language: 'de' });
  stray.regions.ghost = { background: '#ffffff', items: [createTextItem({ value: 'boo', box: [0, 0, 1, 1] })] };
  const resolved = resolveProject(map, stray);
  assert.deepEqual(resolved.merged.pages, []);
  assert.ok(stray.regions.ghost, 'the inert entry is kept on the content object');
});

test('a map with no variant resolves to an empty one, ready to edit', () => {
  const { map } = emptyProject();
  const { content, merged } = resolveProject(map, null, { language: 'en', label: 'Base map', name: 'doc.en.content.json' });
  assert.equal(content.mapId, map.mapId);
  assert.equal(content.meta.language, 'en');
  assert.equal(content.meta.label, 'Base map');
  assert.deepEqual(merged.pages, []);
  assert.deepEqual(merged.meta.language, 'en');
});

test('an empty variant for a map derives a file name from the map name', () => {
  const { map } = emptyProject();
  const v = emptyContentVariant({ mapId: map.mapId, language: 'de', name: defaultContentName(map.meta.name, 'de') });
  assert.equal(v.meta.name, `doc.de${CONTENT_SUFFIX}`);
  assert.equal(defaultMapName('Some File.pdf'), 'Some File.pmap');
  assert.equal(isContentFileName(v.meta.name), true);
  assert.equal(isMapFileName('doc.pmap'), true);
  assert.equal(isMapFileName(v.meta.name), false);
  assert.equal(contentStem(`doc.de${CONTENT_SUFFIX}`), 'doc.de');
});

test('content files are offered by stem first, any .content.json as fallback', () => {
  const f = (name) => ({ name });
  assert.deepEqual(
    matchContentFiles('doc.pdf', [f('doc.de.content.json'), f('doc.en.content.json'), f('other.fr.content.json'), f('doc.pmap')]).map(x => x.name),
    ['doc.de.content.json', 'doc.en.content.json']);
  assert.deepEqual(
    matchContentFiles('doc.pdf', [f('other.fr.content.json')]).map(x => x.name),
    ['other.fr.content.json']);
  assert.deepEqual(matchContentFiles('doc.pdf', [f('doc.pmap')]), []);
});

test('map sidecars are still matched by stem', () => {
  const f = (name) => ({ name });
  assert.deepEqual(matchSidecars('doc.pdf', [f('doc.pmap'), f('doc.en.pmap'), f('other.pmap')]).map(x => x.name), ['doc.pmap', 'doc.en.pmap']);
});

test('a variant created by copying keeps the geometry and flags the text for review', async () => {
  // The app's "New content variant… + copy" path, at the storage level: take the current
  // variant's entries (as projectTexts builds them) and re-badge the text items.
  const project = emptyProject();
  const merged = addRegion(project.merged, {
    content: { background: '#ffffff', items: [createTextItem({ value: 'Hallo', box: [0, 0, 40, 12], style: { size: 10 } })] },
  });
  const { content, map } = await saveLoad(merged, project);
  const next = emptyContentVariant({ mapId: map.mapId, language: 'de', label: 'German', name: `doc.de${CONTENT_SUFFIX}` });
  next.regions = JSON.parse(JSON.stringify(content.regions));
  for (const entry of Object.values(next.regions)) for (const it of entry.items || []) if (it.type === 'text') it.needsReview = true;
  const resolved = resolveProject(serializeMap(map), next);
  assert.equal(resolved.merged.pages[0].regions[0].geometry.points.length, 4);
  assert.equal(resolved.merged.pages[0].regions[0].content.items[0].needsReview, true);
  assert.equal(resolved.content.meta.language, 'de');
  assert.equal(resolved.content.mapId, project.map.mapId);
});
