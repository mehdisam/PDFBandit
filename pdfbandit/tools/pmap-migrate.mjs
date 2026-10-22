#!/usr/bin/env node
// Migrate legacy v1.1 .pmap files to the v2 project layout (structure-only map +
// one content variant), or join a map + content variant back into v1.1 (spec §4).
//
// The conversion itself lives in ../src/storage/project-migrate.js so the app can
// reuse it; this file only does argv, file I/O and the report.
//
//   node tools/pmap-migrate.mjs [options] <file.pmap ...>
//
// Exit codes: 0 ok · 1 a file failed (bad JSON, validation, refused overwrite) · 2 usage.
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  splitLegacyPmap, joinProject, normalizeLegacyPmap, validateRoundTrip, detectFileKind,
  CONTENT_SUFFIX, DEFAULT_ASSETS_DIR, FALLBACK_LANGUAGE,
} from '../src/storage/project-migrate.js';

const USAGE = `pmap-migrate — split a legacy v1.1 .pmap into a v2 map + content variant

Usage:
  node tools/pmap-migrate.mjs [options] <file.pmap ...>        # legacy -> v2
  node tools/pmap-migrate.mjs --to v1.1 --map <map.pmap> <file.content.json>   # v2 -> legacy

Options:
  --out <dir>        output directory (default: <input dir>/migrated)
  --variant <code>   language code of the content variant (default: meta.language, else "und")
  --label <text>     label of the content variant (default: meta.label)
  --suffix <text>    appended to output file names (default: none)
  --assets <name>    asset subdirectory inside the output (default: "assets")
  --keep-data-uris   leave base64 image sources inline instead of externalizing them
  --to v2|v1.1       direction (default v2)
  --map <file>       the shared map to join (required for --to v1.1)
  --dry-run          validate and print the plan, write nothing
  --force            overwrite existing output files
  --strict           treat an unresolved image reference as an error
  --quiet            print only errors and the final summary
  -h, --help         this text

The original file is never written to: the migrated map lands in another directory
(or under another name), and a legacy map is refused as its own output target.`;

class UsageError extends Error {}

function parseArgs(argv) {
  const opts = {
    out: '', variant: '', label: '', suffix: '', assets: DEFAULT_ASSETS_DIR, to: 'v2', map: '',
    dryRun: false, force: false, strict: false, keepDataUris: false, quiet: false, help: false,
  };
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    let inline = null;
    if (a.startsWith('--') && a.includes('=')) { const at = a.indexOf('='); inline = a.slice(at + 1); a = a.slice(0, at); }
    const value = () => (inline !== null ? inline : (argv[++i] ?? (() => { throw new UsageError(`missing value for ${a}`); })()));
    switch (a) {
      case '--out': opts.out = value(); break;
      case '--variant': opts.variant = value(); break;
      case '--label': opts.label = value(); break;
      case '--suffix': opts.suffix = value(); break;
      case '--assets': opts.assets = value(); break;
      case '--to': opts.to = value(); break;
      case '--map': opts.map = value(); break;
      case '--dry-run': opts.dryRun = true; break;
      case '--force': opts.force = true; break;
      case '--strict': opts.strict = true; break;
      case '--keep-data-uris': opts.keepDataUris = true; break;
      case '--quiet': opts.quiet = true; break;
      case '-h': case '--help': opts.help = true; break;
      default:
        if (a.startsWith('-')) throw new UsageError(`unknown option ${a}`);
        files.push(a);
    }
  }
  if (opts.to !== 'v2' && opts.to !== '1.1' && opts.to !== 'v1.1') throw new UsageError(`--to must be v2 or v1.1 (got ${opts.to})`);
  return { opts, files };
}

const json = (obj) => JSON.stringify(obj, null, 2);   // same shape the app's serializer writes
const stemOf = (file) => path.basename(file).replace(/\.pmap$/i, '');
async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }

async function readJson(file) {
  const text = await fs.readFile(file, 'utf8');
  try { return JSON.parse(text); } catch (e) { throw new Error(`${file}: not valid JSON (${e.message})`); }
}

// A legacy map must never be its own output target, even with --force.
function guardNotLegacyInput(inputFile, outFile) {
  if (path.resolve(inputFile) === path.resolve(outFile)) {
    throw new Error(`${outFile} is the original file — refusing to overwrite it (split-only migration)`);
  }
}

async function writeFile(outFile, text, { force, dryRun, log }) {
  if (await exists(outFile)) {
    if (!force) throw new Error(`${outFile} already exists (use --force to overwrite)`);
    if (dryRun) { log(`  would overwrite ${outFile}`); return; }
  }
  if (dryRun) { log(`  would write ${outFile} (${text.length} bytes)`); return; }
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await fs.writeFile(outFile, text);
  log(`  wrote ${outFile}`);
}

// ---------------------------------------------------------------- legacy -> v2
async function migrateV2(file, opts, log) {
  const legacy = await readJson(file);
  if (detectFileKind(legacy) === 'content') throw new Error(`${file} is a content variant, not a legacy map`);
  const outDir = path.resolve(opts.out || path.join(path.dirname(file), 'migrated'));
  const stem = stemOf(file) + opts.suffix;
  const mapPath = path.join(outDir, `${stem}.pmap`);
  guardNotLegacyInput(file, mapPath);

  const variantGuess = opts.variant || legacy?.meta?.language || FALLBACK_LANGUAGE;
  const contentPath = path.join(outDir, `${stem}.${variantGuess}${CONTENT_SUFFIX}`);
  const { map, content, assets, report, warnings } = await splitLegacyPmap(legacy, {
    variant: variantGuess,
    label: opts.label || legacy?.meta?.label || '',
    mapName: path.basename(mapPath),
    contentName: path.basename(contentPath),
    assetsDir: opts.assets,
    externalizeDataUris: !opts.keepDataUris,
  });

  // Prove the split is lossless before writing anything (spec §4 round-trip).
  const legacyNorm = normalizeLegacyPmap(legacy);
  const check = await validateRoundTrip(legacyNorm, joinProject(map, content), {
    assetsDir: opts.assets,
    expect: { language: content.meta.language, label: content.meta.label },
  });

  // Image items that point at a relative path (not a data URI) are kept verbatim;
  // report whether the file they name is actually there.
  const dir = path.dirname(path.resolve(file));
  const missing = [];
  for (const ref of new Set(report.assetRefs)) {
    if (/^(https?:)?\/\//i.test(ref)) continue;
    if (!(await exists(path.join(dir, ref)))) missing.push(ref);
  }

  log(`${path.basename(file)}  ->  ${mapPath}`);
  log(`  ${report.pages} pages · ${report.regions} regions (${report.locked} locked) · ` +
      `${report.items} items (${report.textItems} text, ${report.imageItems} image${report.tables ? `, ${report.tables} with tables` : ''}) · ` +
      `${report.needsReview} flagged to review`);
  log(`  content  ${path.basename(contentPath)}  (language ${content.meta.language}${content.meta.label ? ` · "${content.meta.label}"` : ''}) · ` +
      `${report.withContent} regions with content, ${report.omitted} left to the default`);
  log(`  assets   ${report.assets.length ? `${report.assets.length} externalized${report.deduped ? ` (${report.deduped} deduplicated)` : ''}: ${assets.map(a => a.name).join(', ')}` : 'none'}`);
  if (report.normalized) log('  legacy   pre-items content shapes normalized the way the app loads them');
  if (!check.ok) {
    log(`  round-trip FAILED`);
    for (const e of check.errors) log(`    ${e}`);
    throw new Error(`${path.basename(file)}: migration is not lossless — nothing written`);
  }
  log(`  round-trip OK  (${check.checks.length} checks: ${check.checks.map(c => c.name).join(' · ')})`);
  for (const w of warnings) log(`  warning  ${w}`);
  if (missing.length) {
    const msg = `${missing.length} image reference(s) not found next to the input: ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ', …' : ''}`;
    if (opts.strict) throw new Error(`${path.basename(file)}: ${msg}`);
    log(`  warning  ${msg}`);
  }

  await writeFile(mapPath, json(map), { force: opts.force, dryRun: opts.dryRun, log });
  await writeFile(contentPath, json(content), { force: opts.force, dryRun: opts.dryRun, log });
  for (const a of assets) {
    const assetPath = path.join(outDir, a.path);
    if (opts.dryRun) { log(`  would write ${assetPath} (${a.bytes.length} bytes)`); continue; }
    await fs.mkdir(path.dirname(assetPath), { recursive: true });
    await fs.writeFile(assetPath, a.bytes);
    log(`  wrote ${assetPath}`);
  }
  return { map, content, report, check, assets };
}

// ---------------------------------------------------------------- v2 -> legacy
async function joinV1(contents, opts, log) {
  if (contents.length !== 1) throw new UsageError('--to v1.1 takes exactly one content file');
  if (!opts.map) throw new UsageError('--to v1.1 needs --map <file.pmap>');
  const content = await readJson(contents[0]);
  const map = await readJson(opts.map);
  if (detectFileKind(content) !== 'content') throw new Error(`${contents[0]} is not a content variant`);
  if (detectFileKind(map) !== 'map-v2') throw new Error(`${opts.map} is not a v2 shared map`);
  const legacy = joinProject(map, content);
  const outDir = path.resolve(opts.out || path.dirname(contents[0]));
  const outFile = path.join(outDir, path.basename(contents[0]).replace(/\.content\.json$/i, '') + opts.suffix + '.pmap');
  guardNotLegacyInput(opts.map, outFile);
  const regions = legacy.pages.reduce((n, p) => n + p.regions.length, 0);
  const items = legacy.pages.reduce((n, p) => n + p.regions.reduce((m, r) => m + r.content.items.length, 0), 0);
  log(`${path.basename(contents[0])} + ${path.basename(opts.map)}  ->  ${outFile}`);
  log(`  ${legacy.pages.length} pages · ${regions} regions · ${items} items · content joined by region id`);
  await writeFile(outFile, json(legacy), { force: opts.force, dryRun: opts.dryRun, log });
  return { legacy, regions, items };
}

// ---------------------------------------------------------------- main
async function main() {
  const { opts, files } = parseArgs(process.argv.slice(2));
  const log = opts.quiet ? () => {} : (s) => console.log(s);
  if (opts.help) { console.log(USAGE); return 0; }
  if (!files.length) { console.error('error: no input files\n'); console.error(USAGE); return 2; }
  if (opts.to === 'v2' && opts.map) throw new UsageError('--map is only used with --to v1.1');

  let regions = 0, withContent = 0, assetCount = 0, migrated = 0;
  for (const file of files) {
    try {
      if (opts.to === 'v2') {
        const r = await migrateV2(file, opts, log);
        regions += r.report.regions; withContent += r.report.withContent; assetCount += r.assets.length;
      } else {
        const r = await joinV1([file], opts, log);
        regions += r.regions;
      }
      migrated += 1;
    } catch (e) {
      if (e instanceof UsageError) throw e;
      console.error(`error: ${e.message}`);
      return 1;
    }
  }

  const dst = opts.out ? path.resolve(opts.out) : '(each input directory)/migrated';
  if (opts.to === 'v2') {
    console.log(`${migrated} file(s) ${opts.dryRun ? 'checked (nothing written)' : 'migrated'} -> ${opts.dryRun ? '(dry run)' : dst} · ` +
                `${regions} regions (${withContent} with content) · ${assetCount} asset(s) · round-trip OK`);
  } else {
    console.log(`${migrated} file(s) ${opts.dryRun ? 'checked (nothing written)' : 'joined'}, ${regions} regions -> ${opts.dryRun ? '(dry run)' : dst}`);
  }
  return 0;
}

main().then(code => process.exit(code), (e) => {
  if (e instanceof UsageError) { console.error(`error: ${e.message}\n`); console.error(USAGE); process.exit(2); }
  console.error(`error: ${e.message}`);
  process.exit(1);
});
