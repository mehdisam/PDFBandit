// Clipboard -> blocks. Word / LibreOffice put `text/html` on the clipboard and
// spreadsheets put tab-separated `text/plain`; both are converted into the same
// block model the editor uses. Nothing here touches the DOM outside a detached
// DOMParser document, and all recognised markup is sanitised to a small subset.
import { normalizeStyle, normalizeTableBlock, blocksFromValue } from '../model/region.js';
import { baseFmt, mergeFmt, runsFromPerChar } from '../model/richtext.js';

const HEADING_LEVEL = { H1: 1, H2: 2, H3: 3, H4: 4, H5: 5, H6: 6 };
const SKIP = new Set(['SCRIPT', 'STYLE', 'HEAD', 'META', 'LINK', 'TITLE', 'BASE', 'NOSCRIPT']);
const BLOCK_TAGS = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'BLOCKQUOTE', 'PRE', 'TABLE', 'UL', 'OL', 'LI', 'TR', 'TD', 'TH', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);

// Accumulate inline content of a subtree into a per-character format buffer.
function collectInline(node, fmt, buf) {
  if (node.nodeType === 3) {
    for (const ch of String(node.nodeValue)) { if (ch === '\u200b') continue; buf.text += ch; buf.chars.push(fmt); }
    return;
  }
  if (node.nodeType !== 1) return;
  const tag = node.tagName;
  if (SKIP.has(tag)) return;
  if (tag === 'BR') { buf.text += '\n'; buf.chars.push(fmt); return; }
  const f2 = mergeFmt(fmt, node);
  for (const child of node.childNodes) collectInline(child, f2, buf);
}

function dirOf(chars, fallback) {
  for (const c of chars) if (c && c.direction) return c.direction === 'rtl' ? 'rtl' : 'ltr';
  return fallback === 'rtl' ? 'rtl' : 'ltr';
}

function bufToFlow(buf, st) {
  const runs = runsFromPerChar(buf.chars, st, buf.text.length, buf.text);
  return { value: buf.text, runs, direction: dirOf(buf.chars, st.direction) };
}

function cellAlign(td) {
  const s = String(td.style?.textAlign || '');
  if (['left', 'right', 'center', 'justify'].includes(s)) return s;
  const a = td.getAttribute?.('align');
  if (['left', 'right', 'center', 'justify'].includes(a)) return a;
  return 'left';
}

function tableBlockFromEl(tbl, st, fmt) {
  const rows = [...tbl.querySelectorAll('tr')].map(tr => {
    const cells = [...tr.children].filter(c => c.tagName === 'TD' || c.tagName === 'TH').map(td => {
      const buf = { text: '', chars: [] };
      collectInline(td, fmt, buf);
      const flow = bufToFlow(buf, st);
      return { value: flow.value, runs: flow.runs, align: cellAlign(td), direction: td.getAttribute?.('dir') === 'rtl' ? 'rtl' : flow.direction };
    });
    return { cells };
  }).filter(r => r.cells.length);
  return rows.length ? normalizeTableBlock({ type: 'table', rows, columns: colsFromTable(tbl) }) : null;
}

function colsFromTable(tbl) {
  const cols = [...tbl.querySelectorAll('colgroup > col')];
  if (cols.length) return cols.map(c => ({ width: parseFloat(c.style.width) || undefined }));
  return [];
}

// Collect <li> items, flattening nested lists into `level`.
function collectList(listEl, ordered, fmt, level, items, st, dirRef) {
  for (const li of [...listEl.children]) {
    if (li.tagName !== 'LI') continue;
    const buf = { text: '', chars: [] };
    for (const child of li.childNodes) {
      if (child.nodeType === 1 && (child.tagName === 'UL' || child.tagName === 'OL')) continue;
      collectInline(child, fmt, buf);
    }
    const flow = bufToFlow(buf, st);
    if (flow.value.length && dirRef && !dirRef.d) dirRef.d = flow.direction;
    items.push({ value: flow.value, runs: flow.runs, level: Math.min(3, level) });
    for (const child of li.children) {
      if (child.tagName === 'UL' || child.tagName === 'OL') collectList(child, child.tagName === 'OL', fmt, level + 1, items, st, dirRef);
    }
  }
}

// Convert an HTML fragment (Word / LibreOffice / Excel / web) into blocks.
export function clipboardHtmlToBlocks(html, itemStyle = {}) {
  const st = normalizeStyle(itemStyle);
  const base = baseFmt(st);
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  const body = doc.body;
  const blocks = [];

  const emitTextBlock = (node, fmt, kind, level) => {
    const buf = { text: '', chars: [] };
    collectInline(node, fmt, buf);
    if (!buf.text.length) return;
    const flow = bufToFlow(buf, st);
    if (kind === 'heading') blocks.push({ type: 'heading', level, value: flow.value, runs: flow.runs, align: 'left', direction: flow.direction });
    else blocks.push({ type: 'paragraph', value: flow.value, runs: flow.runs, align: 'left', direction: flow.direction });
  };

  const walk = (parent, fmt) => {
    for (const el of parent.childNodes) {
      if (el.nodeType === 3) { if (el.nodeValue.trim()) emitTextBlock(el, fmt); continue; }
      if (el.nodeType !== 1) continue;
      const tag = el.tagName;
      if (SKIP.has(tag)) continue;
      const f2 = mergeFmt(fmt, el);
      if (tag === 'TABLE') { const t = tableBlockFromEl(el, st, f2); if (t) blocks.push(t); continue; }
      if (tag === 'UL' || tag === 'OL') {
        const items = [];
        const dirRef = { d: null };
        collectList(el, tag === 'OL', f2, 0, items, st, dirRef);
        if (items.length) blocks.push({ type: 'list', ordered: tag === 'OL', direction: dirRef.d || st.direction, items });
        continue;
      }
      if (HEADING_LEVEL[tag]) { emitTextBlock(el, f2, 'heading', HEADING_LEVEL[tag]); continue; }
      if ([...el.children].some(c => BLOCK_TAGS.has(c.tagName))) { walk(el, f2); continue; }
      emitTextBlock(el, f2, 'paragraph');
    }
  };
  walk(body, base);

  return blocks.length ? blocks : blocksFromValue(body.textContent || '', []);
}

// Convert plain text (tab-separated grids from spreadsheets become tables).
export function plainToBlocks(text, itemStyle = {}) {
  void itemStyle;
  const t = String(text ?? '').replace(/\r\n?/g, '\n');
  const lines = t.split('\n');
  const tabbed = lines.filter(l => l.includes('\t'));
  if (tabbed.length && tabbed.length >= Math.ceil(lines.filter(l => l.length).length * 0.6)) {
    const rows = lines.filter(l => l.length).map(l => ({ cells: l.split('\t').map(v => ({ value: v })) }));
    if (rows.length) return [normalizeTableBlock({ type: 'table', rows })];
  }
  return blocksFromValue(t, []);
}

// Readable images from pasted HTML (data/blob URIs only; local file paths are dropped).
export function imagesFromHtml(html) {
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  return [...doc.querySelectorAll('img')]
    .map(img => img.getAttribute('src') || '')
    .filter(src => /^(data:image\/|blob:)/i.test(src));
}

export function clipboardToBlocks({ html, text }, itemStyle = {}) {
  if (html && /<(table|ul|ol|h[1-6]|p|div|span|b|i|u|strong|em)\b/i.test(html)) {
    const blocks = clipboardHtmlToBlocks(html, itemStyle);
    if (blocks.length) return blocks;
  }
  return plainToBlocks(text || '', itemStyle);
}
