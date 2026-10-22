// Tests for the legacy .pmap -> v2 project migration (spec §4).
// Run: npm test   (node --test tools/)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  splitLegacyPmap, joinProject, normalizeLegacyPmap, validateRoundTrip, detectFileKind,
  deepDiff, extForMime, CONTENT_FORMAT, MAP_VERSION, CONTENT_SUFFIX,
} from '../src/storage/project-migrate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'pmap-migrate.mjs');
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys)
  : (v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => [k, sortKeys(v[k])])) : v));

function fixture() {
  return {
    format: 'pmap',
    version: '1.1',
    meta: { name: 'doc.pmap', language: 'en', label: 'Base map', created: '2026-01-01T00:00:00Z', modified: '2026-01-02T00:00:00Z' },
    source: { filename: 'doc.pdf', sha256: 'a'.repeat(64), page_count: 3 },
    pages: [
      {
        page: 1, width: 595, height: 842,
        regions: [
          {   // full-featured text region
            id: 'r001',
            geometry: { type: 'polygon', points: [[72, 80], [300, 80], [300, 115], [72, 115]] },
            content: {
              background: '#ffffff',
              items: [{
                type: 'text', box: [4, 4, 220, 27], needsReview: true,
                style: { size: 14, bold: false, italic: false, underline: false, font: 'sans', color: '#111111', align: 'left', direction: 'ltr', lineHeight: 1.5 },
                blocks: [
                  { type: 'heading', level: 2, value: 'Invoice', runs: [], align: 'left', direction: 'ltr' },
                  { type: 'paragraph', value: 'Total 42', runs: [{ start: 0, end: 5, bold: true }], align: 'left', direction: 'ltr' },
                  { type: 'list', ordered: true, direction: 'ltr', items: [{ value: 'one', runs: [], level: 0 }] },
                  { type: 'table', dir: 'ltr', border: { color: '#333333', width: 1 }, columns: [{ width: 90 }, { width: 90 }], rows: [{ height: 24, cells: [{ value: 'a', runs: [], align: 'left', direction: 'ltr' }, { value: 'b', runs: [], align: 'right', direction: 'rtl' }] }] },
                ],
              }],
            },
          },
          {   // image items, two of them the same bytes -> one asset
            id: 'r002',
            geometry: { type: 'polygon', points: [[72, 200], [300, 200], [300, 300], [72, 300]] },
            content: {
              background: '#ee2b8c',
              items: [
                { type: 'image', box: [0, 0, 228, 60], source: PNG, fit: 'cover' },
                { type: 'image', box: [0, 62, 228, 30], source: PNG, fit: 'contain' },
                { type: 'image', box: [0, 94, 228, 20], source: 'assets/old.png', fit: 'contain' },
              ],
            },
          },
          {   // locked multipolygon
            id: 'r003',
            locked: true,
            geometry: { type: 'multipolygon', points: [[[10, 400], [90, 400], [90, 440], [10, 440]], [[110, 400], [190, 400], [190, 440], [110, 440]]] },
            content: { background: '#ffffff', items: [{ type: 'text', box: [0, 0, 60, 40], style: { size: 12, bold: false, italic: false, underline: false, font: 'sans', color: '#111111', align: 'left', direction: 'ltr' }, blocks: [{ type: 'paragraph', value: 'Aa', runs: [], align: 'left', direction: 'rtl' }] }] },
          },
          {   // fully default -> no content entry in v2
            id: 'r004',
            geometry: { type: 'polygon', points: [[0, 500], [50, 500], [50, 520], [0, 520]] },
            content: { background: '#ffffff', items: [] },
          },
        ],
      },
      { page: 2, width: 595, height: 842, regions: [] },
    ],
  };
}

test('detectFileKind distinguishes the three shapes', () => {
  assert.equal(detectFileKind(fixture()), 'map-legacy');
  assert.equal(detectFileKind({ format: 'pmap', version: '2.0', pages: [] }), 'map-v2');
  assert.equal(detectFileKind({ format: 'pmap-content', version: '1.0' }), 'content');
  assert.equal(detectFileKind({ format: 'nope' }), null);
});

test('split produces a structure-only map and one content variant', async () => {
  const { map, content, report } = await splitLegacyPmap(fixture(), { mapName: 'doc.pmap', contentName: 'doc.en.content.json' });
  assert.equal(map.format, 'pmap');
  assert.equal(map.version, MAP_VERSION);
  assert.match(map.mapId, /^map_[0-9a-f]{16}$/);
  assert.equal(content.format, CONTENT_FORMAT);
  assert.equal(content.mapId, map.mapId);
  assert.equal(content.meta.language, 'en');
  assert.equal(content.meta.label, 'Base map');
  assert.deepEqual(content.meta.created, '2026-01-01T00:00:00Z');

  // The map carries identity + geometry + lock, and nothing content-shaped or binary.
  assert.equal(JSON.stringify(map).includes('"content"'), false);
  assert.equal(JSON.stringify(map).includes('base64'), false);
  assert.deepEqual(Object.keys(map.pages[0].regions[0]), ['id', 'geometry']);
  assert.deepEqual(map.pages[0].regions[2].locked, true);
  assert.equal(map.pages[0].regions[2].geometry.type, 'multipolygon');
  assert.deepEqual(map.source, { filename: 'doc.pdf', sha256: 'a'.repeat(64), page_count: 3 });

  // Content is keyed by id, keeps order/boxes/styles/blocks/review flags, and omits
  // the region whose content is exactly the default.
  assert.deepEqual(Object.keys(content.regions), ['r001', 'r002', 'r003']);
  assert.equal(content.regions.r001.items[0].needsReview, true);
  assert.equal(content.regions.r001.items[0].blocks[3].type, 'table');
  assert.equal(content.regions.r002.background, '#ee2b8c');
  assert.equal(report.regions, 4);
  assert.equal(report.withContent, 3);
  assert.equal(report.omitted, 1);
  assert.equal(report.items, 5);
  assert.equal(report.textItems, 2);
  assert.equal(report.imageItems, 3);
  assert.equal(report.needsReview, 1);
  assert.equal(report.tables, 1);
  assert.equal(report.locked, 1);
  assert.equal(report.normalized, false);
});

test('mapId is stable for the same structure and changes with the geometry', async () => {
  const a = await splitLegacyPmap(fixture());
  const b = await splitLegacyPmap(fixture());
  assert.equal(a.map.mapId, b.map.mapId);
  const moved = fixture();
  moved.pages[0].regions[0].geometry.points[0][0] += 1;
  const c = await splitLegacyPmap(moved);
  assert.notEqual(a.map.mapId, c.map.mapId);
});

test('data URIs are externalized by content hash and deduplicated', async () => {
  const { map, content, assets, report } = await splitLegacyPmap(fixture(), { assetsDir: 'assets' });
  assert.equal(assets.length, 1, 'the same bytes twice must yield one asset');
  assert.match(assets[0].name, /^[0-9a-f]{32}\.png$/);
  assert.equal(assets[0].mime, 'image/png');
  assert.equal(assets[0].path, `assets/${assets[0].name}`);
  assert.ok(assets[0].bytes.length > 0);
  assert.deepEqual(content.assets, [{ id: assets[0].id, path: assets[0].path, mime: 'image/png' }]);
  const items = content.regions.r002.items;
  assert.equal(items[0].source, assets[0].path);
  assert.equal(items[1].source, assets[0].path, 'the duplicate points at the same file');
  assert.equal(items[2].source, 'assets/old.png', 'a path reference is kept verbatim');
  assert.equal(items[0].fit, 'cover');
  assert.equal(report.externalized, 2);
  assert.equal(report.deduped, 1);
  assert.deepEqual(report.assetRefs, ['assets/old.png']);
  assert.equal(JSON.stringify(map).includes('base64'), false);
});

test('--keep-data-uris leaves image bytes inline', async () => {
  const { content, assets, report } = await splitLegacyPmap(fixture(), { externalizeDataUris: false });
  assert.equal(assets.length, 0);
  assert.equal(content.regions.r002.items[0].source, PNG);
  assert.equal(report.assetRefs.includes(PNG), false);
});

test('a full-featured legacy map round-trips losslessly', async () => {
  const legacy = fixture();
  const legacyNorm = normalizeLegacyPmap(legacy);
  const { map, content } = await splitLegacyPmap(legacy, { mapName: 'doc.pmap', contentName: 'doc.en.content.json' });
  const check = await validateRoundTrip(legacyNorm, joinProject(map, content));
  assert.deepEqual(check.errors, []);
  assert.equal(check.ok, true);
  assert.equal(check.checks.length, 9);
});

test('legacy pre-items content shapes are normalized like the app loads them', async () => {
  const legacy = fixture();
  legacy.pages[0].regions = [{
    id: 'r009',
    geometry: { type: 'polygon', points: [[0, 0], [100, 0], [100, 40], [0, 40]] },
    content: { type: 'text', source: { value: 'Hello\nWorld' } },
  }];
  const { content, report } = await splitLegacyPmap(legacy, { mapName: 'a.pmap', contentName: 'a.de.content.json' });
  assert.equal(report.normalized, true);
  const blocks = content.regions.r009.items[0].blocks;
  assert.deepEqual(blocks.map(b => b.value), ['Hello', 'World']);
  // The normalized form is what round-trips (the raw legacy shape is what the app
  // itself rewrites on load), so validate against the normalized map.
  const legacyNorm = normalizeLegacyPmap(legacy);
  const split = await splitLegacyPmap(legacyNorm, { mapName: 'a.pmap', contentName: 'a.de.content.json' });
  const check = await validateRoundTrip(legacyNorm, joinProject(split.map, split.content));
  assert.equal(check.ok, true, check.errors.join('; '));
});

test('a legacy table content becomes a table block', async () => {
  const legacy = fixture();
  legacy.pages[0].regions = [{
    id: 'r010',
    geometry: { type: 'polygon', points: [[0, 0], [100, 0], [100, 40], [0, 40]] },
    content: { type: 'table', rows: [{ cells: [{ value: 'a' }, { value: 'b' }] }] },
  }];
  const { content } = await splitLegacyPmap(legacy, { mapName: 'a.pmap', contentName: 'a.en.content.json' });
  assert.equal(content.regions.r010.items[0].blocks[0].type, 'table');
  assert.equal(content.regions.r010.items[0].blocks[0].rows[0].cells[1].value, 'b');
});

test('duplicate region ids are refused (content is keyed by id)', async () => {
  const legacy = fixture();
  legacy.pages[1].regions = [{ id: 'r001', geometry: { type: 'polygon', points: [[0, 0], [1, 0], [1, 1]] }, content: { background: '#ffffff', items: [] } }];
  await assert.rejects(() => splitLegacyPmap(legacy), /Duplicate region id/);
});

test('join needs a matching mapId, ignores inert entries for deleted regions, and defaults missing content', async () => {
  const legacy = fixture();
  const { map, content } = await splitLegacyPmap(legacy, { mapName: 'doc.pmap', contentName: 'doc.en.content.json' });
  assert.throws(() => joinProject(map, { ...content, mapId: 'map_other' }), /belongs to map/);
  const joined = joinProject(map, { ...content, regions: {} });
  assert.deepEqual(joined.pages[0].regions[0].content, { background: '#ffffff', items: [] });
  assert.equal(joined.pages[0].regions[0].geometry.type, 'polygon');
  // A region deleted while another variant was active leaves an inert entry. The file
  // still opens; the entry is simply not part of the resolved page.
  const full = joinProject(map, content);
  const withInert = joinProject(map, { ...content, regions: { ...content.regions, r999: { background: '#ffffff', items: [] } } });
  assert.deepEqual(withInert, full);
});

test('detection provenance is additive on the map and survives a round trip', async () => {
  const legacy = fixture();
  legacy.pages[0].regions[0].detected = true;
  legacy.pages[0].regions[0].fingerprint = 'deadbeef';
  legacy.pages[0].regions[0].detectedType = 'image';
  const { map, content } = await splitLegacyPmap(legacy, { mapName: 'doc.pmap', contentName: 'doc.en.content.json' });
  assert.equal(map.pages[0].regions[0].detected, true);
  assert.equal(map.pages[0].regions[0].fingerprint, 'deadbeef');
  assert.equal(map.pages[0].regions[0].detectedType, 'image');
  // Provenance belongs to geometry, never to content.
  assert.equal('detected' in content.regions.r001, false);
  assert.equal('detectedType' in content.regions.r001, false);
  const joined = joinProject(map, content);
  assert.equal(joined.pages[0].regions[0].detected, true);
  assert.equal(joined.pages[0].regions[0].fingerprint, 'deadbeef');
  assert.equal(joined.pages[0].regions[0].detectedType, 'image');
  // Additive: a region without provenance serializes exactly as before.
  assert.deepEqual(Object.keys(map.pages[0].regions[1]), ['id', 'geometry']);
  // An unknown class is dropped rather than trusted; the rest of the provenance stays.
  map.pages[0].regions[0].detectedType = 'banana';
  assert.equal(joinProject(map, content).pages[0].regions[0].detectedType, undefined);
  map.pages[0].regions[0].detectedType = 'image';
  const check = await validateRoundTrip(normalizeLegacyPmap(legacy), joinProject(map, content));
  assert.equal(check.ok, true, check.errors.join('; '));
});

test('deepDiff reports the first differing path', () => {
  assert.equal(deepDiff({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }), null);
  assert.match(deepDiff({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] }), /a\[1\]\.b/);
  assert.match(deepDiff([1, 2], [1, 2, 3]), /length 2 vs 3/);
  assert.match(deepDiff({ a: 1 }, { b: 1 }), /missing a, unexpected b/);
});

test('extForMime covers the image types and falls back to bin', () => {
  assert.equal(extForMime('image/jpeg'), 'jpg');
  assert.equal(extForMime('image/svg+xml'), 'svg');
  assert.equal(extForMime('application/octet-stream'), 'bin');
});

// ------------------------------------------------------------------ the CLI
async function tmpdir() { return fs.mkdtemp(path.join(os.tmpdir(), 'pmap-migrate-')); }
const run = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

test('CLI splits a file, leaves the original untouched and joins it back', async () => {
  const dir = await tmpdir();
  const input = path.join(dir, 'doc.pmap');
  const legacy = fixture();
  await fs.writeFile(input, JSON.stringify(legacy, null, 2));
  const before = await fs.readFile(input);

  const r = run(['--out', path.join(dir, 'v2'), input]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /round-trip OK/);
  assert.deepEqual(await fs.readFile(input), before, 'the legacy file must not be written to');

  const mapPath = path.join(dir, 'v2', 'doc.pmap');
  const contentPath = path.join(dir, 'v2', `doc.en${CONTENT_SUFFIX}`);
  const map = JSON.parse(await fs.readFile(mapPath, 'utf8'));
  const content = JSON.parse(await fs.readFile(contentPath, 'utf8'));
  assert.equal(map.version, '2.0');
  assert.equal(content.format, 'pmap-content');
  assert.equal(JSON.stringify(map).includes('"content"'), false);
  assert.equal(map.meta.name, 'doc.pmap', 'the map declares its own file name');
  assert.equal(content.meta.name, `doc.en${CONTENT_SUFFIX}`);
  assert.deepEqual(await fs.readdir(path.join(dir, 'v2', 'assets')), [content.assets[0].path.split('/')[1]]);

  // ... and the inverse, with the file-level payloads identical bar the map's own name
  // and the one intended representation change: the inline data URI is now the asset
  // file the split wrote (the same bytes — the module's round-trip check proves it).
  const back = run(['--to', 'v1.1', '--map', mapPath, '--out', path.join(dir, 'back'), contentPath]);
  assert.equal(back.status, 0, back.stderr);
  const joined = JSON.parse(await fs.readFile(path.join(dir, 'back', `doc.en.pmap`), 'utf8'));
  assert.equal(joined.version, '1.1');
  const expected = JSON.parse(JSON.stringify(legacy));
  expected.pages[0].regions[1].content.items[0].source = content.assets[0].path;
  expected.pages[0].regions[1].content.items[1].source = content.assets[0].path;
  const strip = (o) => { const c = JSON.parse(JSON.stringify(o)); delete c.meta.name; return sortKeys(c); };
  assert.equal(deepDiff(strip(expected), strip(joined)), null);
  // The old asset path survives, the externalized one is now a path in both.
  assert.equal(joined.pages[0].regions[1].content.items[2].source, 'assets/old.png');
});

test('CLI --dry-run writes nothing and still validates', async () => {
  const dir = await tmpdir();
  const input = path.join(dir, 'doc.pmap');
  await fs.writeFile(input, JSON.stringify(fixture()));
  const r = run(['--dry-run', '--out', path.join(dir, 'v2'), input]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /round-trip OK/);
  assert.match(r.stdout, /nothing written/);
  await assert.rejects(() => fs.readdir(path.join(dir, 'v2')));
});

test('CLI refuses to write over the legacy input, and over an existing output without --force', async () => {
  const dir = await tmpdir();
  const input = path.join(dir, 'doc.pmap');
  const legacy = fixture();
  await fs.writeFile(input, JSON.stringify(legacy, null, 2));

  const same = run(['--out', dir, input]);
  assert.equal(same.status, 1);
  assert.match(same.stderr, /refusing to overwrite it/);
  assert.deepEqual(JSON.parse(await fs.readFile(input, 'utf8')), legacy);

  const out = path.join(dir, 'v2');
  assert.equal(run(['--out', out, input]).status, 0);
  const again = run(['--out', out, input]);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /already exists \(use --force/);
  assert.equal(run(['--force', '--out', out, input]).status, 0);
});

test('CLI usage errors exit 2', () => {
  assert.equal(run([]).status, 2);
  assert.equal(run(['--nope']).status, 2);
  assert.equal(run(['--to', 'v9', 'x.pmap']).status, 2);
  assert.equal(run(['--to', 'v1.1', 'x.content.json']).status, 2);
  assert.equal(run(['--help']).status, 0);
});

test('CLI reports bad JSON and a non-map input', async () => {
  const dir = await tmpdir();
  const bad = path.join(dir, 'bad.pmap');
  await fs.writeFile(bad, '{oops');
  const r = run([bad]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not valid JSON/);
  const content = path.join(dir, 'c.content.json');
  await fs.writeFile(content, JSON.stringify({ format: 'pmap-content', version: '1.0' }));
  const r2 = run([content]);
  assert.equal(r2.status, 1);
  assert.match(r2.stderr, /is a content variant/);
});

test('CLI --variant/--label/--suffix/--assets name the outputs and still validate', async () => {
  const dir = await tmpdir();
  const input = path.join(dir, 'doc.pmap');
  await fs.writeFile(input, JSON.stringify(fixture(), null, 2));
  const out = path.join(dir, 'v2');
  const r = run(['--out', out, '--variant', 'de', '--label', 'German', '--suffix', '.v2', '--assets', 'media', input]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /round-trip OK/);
  const content = JSON.parse(await fs.readFile(path.join(out, 'doc.v2.de.content.json'), 'utf8'));
  assert.equal(content.meta.language, 'de');
  assert.equal(content.meta.label, 'German');
  assert.equal(content.meta.name, 'doc.v2.de.content.json');
  assert.match(content.assets[0].path, /^media\//);
  const map = JSON.parse(await fs.readFile(path.join(out, 'doc.v2.pmap'), 'utf8'));
  assert.equal(map.meta.name, 'doc.v2.pmap');
  assert.deepEqual(await fs.readdir(path.join(out, 'media')), [content.assets[0].path.split('/')[1]]);
});

test('re-labelling the content variant is not a data-loss failure', async () => {
  const legacy = fixture();
  const { map, content } = await splitLegacyPmap(legacy, { variant: 'de', label: 'German', mapName: 'doc.pmap', contentName: 'doc.de.content.json' });
  const check = await validateRoundTrip(normalizeLegacyPmap(legacy), joinProject(map, content), { expect: { language: 'de', label: 'German' } });
  assert.equal(check.ok, true, check.errors.join('; '));
  assert.equal(content.meta.language, 'de');
  const lost = await validateRoundTrip(normalizeLegacyPmap(legacy), joinProject(map, { ...content, meta: { ...content.meta, label: '' } }), { expect: { language: 'de', label: 'German' } });
  assert.equal(lost.ok, false);
  assert.match(lost.errors.join(' '), /content variant metadata/);
});

test('the variant metadata defaults to the legacy file’s own', async () => {
  const legacy = fixture();
  const { content } = await splitLegacyPmap(legacy);
  assert.equal(content.meta.language, 'en');
  assert.equal(content.meta.label, 'Base map');
  const bare = fixture();
  delete bare.meta.language;
  delete bare.meta.label;
  const r = await splitLegacyPmap(bare, { mapId: 'map_x' });
  assert.equal(r.content.meta.language, 'und');
  assert.equal('label' in r.content.meta, false);
});
