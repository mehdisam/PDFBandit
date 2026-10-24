// Find & replace over a text item's block document. Pure: no DOM.
//
// A replacement is applied per text flow (paragraph, heading, list item, table cell),
// never across blocks, so a match cannot silently span a paragraph or cell boundary.
// Character runs are kept: text outside a match keeps its offsets, and the replaced
// characters inherit the run attributes of the first matched character.
import { itemBlocks, normalizeBlocks, normalizeRuns } from './region.js';

const RUN_KEYS = ['bold', 'italic', 'underline', 'font', 'color', 'size', 'direction', 'align'];

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Build the user's search regex. Plain search is escaped and case-insensitive unless
// Match case is on; regex mode is passed through (and is always global).
export function compileFind(pattern, { regex = false, matchCase = false } = {}) {
  const src = String(pattern ?? '');
  if (!src) return null;
  try {
    return new RegExp(regex ? src : escapeRegExp(src), `g${matchCase ? '' : 'i'}`);
  } catch {
    return null;
  }
}

function collectMatches(text, regex) {
  // Clone so one flow cannot disturb the next flow's lastIndex.
  const re = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : `${regex.flags}g`);
  const out = [];
  let m;
  while ((m = re.exec(text))) {
    if (m[0].length === 0) {
      // Zero-width matches have no unambiguous replacement span; skip them rather than
      // inserting text at every position in the document.
      re.lastIndex = m.index + 1;
      if (re.lastIndex > text.length) break;
      continue;
    }
    out.push(m);
    re.lastIndex = m.index + m[0].length;
  }
  return out;
}

// Expand the JavaScript replacement tokens ($&, $1, $<name>, $`, $', $$) from an
// exec() match. Plain (non-regex) replacement text is literal and is not passed here.
export function expandReplacement(template, match, text) {
  return String(template ?? '').replace(/\$(\$|&|`|'|\d{1,2}|<[^>]+>)/g, (all, token) => {
    if (token === '$') return '$';
    if (token === '&') return match[0];
    if (token === '`') return text.slice(0, match.index);
    if (token === "'") return text.slice(match.index + match[0].length);
    if (token[0] === '<') {
      const name = token.slice(1, -1);
      return match.groups && Object.prototype.hasOwnProperty.call(match.groups, name)
        ? (match.groups[name] ?? '')
        : '';
    }
    const n = Number(token);
    return n >= 1 && n < match.length ? (match[n] ?? '') : all;
  });
}

// The effective run overrides at one character position.
function overrideAt(runs, pos) {
  const out = {};
  for (const r of runs || []) {
    if (r.start <= pos && pos < r.end) {
      for (const k of RUN_KEYS) if (r[k] !== undefined) out[k] = r[k];
    }
  }
  return out;
}

function runAttrs(r) {
  const out = {};
  for (const k of RUN_KEYS) if (r[k] !== undefined) out[k] = r[k];
  return out;
}

// Replace one [start,end) range, shifting the runs after it and giving the replacement
// the run attributes captured at the match start.
function replaceRange(value, runs, start, end, replacement, attrs) {
  const delta = replacement.length - (end - start);
  const out = [];
  for (const r of runs) {
    const attrs0 = runAttrs(r);
    if (r.start < start) {
      const ne = Math.min(r.end, start);
      if (ne > r.start) out.push({ start: r.start, end: ne, ...attrs0 });
    }
    if (r.end > end) {
      const ns = Math.max(r.start, end) + delta;
      const ne = r.end + delta;
      if (ne > ns) out.push({ start: ns, end: ne, ...attrs0 });
    }
  }
  if (replacement.length && Object.keys(attrs).length) {
    out.push({ start, end: start + replacement.length, ...attrs });
  }
  const nextValue = value.slice(0, start) + replacement + value.slice(end);
  out.sort((a, b) => a.start - b.start || a.end - b.end);
  return { value: nextValue, runs: normalizeRuns(out, nextValue.length) };
}

function countFlow(value, regex) {
  return collectMatches(String(value ?? ''), regex).length;
}

function replaceFlow(value, runs, regex, replacement, { regex: regexMode = true } = {}) {
  const text = String(value ?? '');
  const matches = collectMatches(text, regex);
  let outValue = text;
  let outRuns = normalizeRuns(runs, text.length);
  // Right-to-left, so each original match offset is still valid when it is applied.
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i];
    const repl = regexMode ? expandReplacement(replacement, m, text) : String(replacement ?? '');
    const attrs = overrideAt(outRuns, m.index);
    const next = replaceRange(outValue, outRuns, m.index, m.index + m[0].length, repl, attrs);
    outValue = next.value;
    outRuns = next.runs;
  }
  return { value: outValue, runs: outRuns, count: matches.length };
}

function eachFlow(blocks, fn) {
  for (const b of blocks) {
    if (b.type === 'list') {
      for (const item of b.items || []) fn(item);
    } else if (b.type === 'table') {
      for (const row of b.rows || []) for (const cell of row.cells || []) fn(cell);
    } else {
      fn(b);
    }
  }
}

// Count matches in a block document without changing it.
export function countInBlocks(blocks, regex) {
  let count = 0;
  eachFlow(normalizeBlocks(blocks), b => { count += countFlow(b.value, regex); });
  return count;
}

// Replace inside a block document. Returns a normalized copy plus the match count.
export function replaceInBlocks(blocks, regex, replacement, opts = {}) {
  const out = JSON.parse(JSON.stringify(normalizeBlocks(blocks)));
  let count = 0;
  eachFlow(out, b => {
    const res = replaceFlow(b.value, b.runs, regex, replacement, opts);
    if (res.count) {
      b.value = res.value;
      b.runs = res.runs;
      count += res.count;
    }
  });
  return { blocks: out, count };
}

// Count matches in a content item's text (including legacy flat value/runs items).
export function countInTextItem(item, regex) {
  if (!item || item.type !== 'text') return 0;
  return countInBlocks(itemBlocks(item), regex);
}

// Replace in one content item. Mutates it, migrates legacy value/runs to blocks when
// something changed, and returns the replacement count.
export function replaceInTextItem(item, regex, replacement, opts = {}) {
  if (!item || item.type !== 'text') return 0;
  const res = replaceInBlocks(itemBlocks(item), regex, replacement, opts);
  if (!res.count) return 0;
  item.blocks = res.blocks;
  delete item.value;
  delete item.runs;
  return res.count;
}
