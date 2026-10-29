// Block <-> editor-DOM bridge. A text item is a document of blocks (spec §7);
// this module renders that document into the inline contenteditable and parses
// the DOM back into the model. Character formatting reuses the rich-text helpers
// (runs are per-character overrides on a block's base style).
import {
  normalizeStyle, DEFAULT_STYLE, HEADING_SCALE, DEFAULT_TABLE_BORDER, DEFAULT_COL_WIDTH, DEFAULT_ROW_HEIGHT,
  normalizeBlocks, normalizeTableBlock, charStyles,
} from './region.js';
import { richToHtml, readRich } from './richtext.js';

// Base style for a flow (paragraph / heading / list-item / table-cell).
export function flowBase(itemStyle, type, level, align, direction) {
  const s = normalizeStyle(itemStyle);
  let size = s.size, bold = s.bold;
  if (type === 'heading') { size = Math.max(4, Math.round(s.size * (HEADING_SCALE[level] || 1))); bold = true; }
  return { ...s, size, bold, align: align || s.align, direction: direction === 'rtl' ? 'rtl' : (direction === 'ltr' ? 'ltr' : s.direction) };
}

function flowHtml(value, base, runs) {
  const html = richToHtml(value, base, runs);
  return html || '<div class="rt-line"><br></div>';
}

function orderedMark(ordered, level, counters) {
  if (!ordered) return level ? '◦' : '•';
  const n = (counters[level] || 0);
  return `${n}.`;
}

// blocks -> HTML for #inline-edit (one element per block, one [data-flow] per editable text unit).
export function blocksToHtml(blocks, itemStyle) {
  const bs = normalizeBlocks(blocks);
  const out = [];
  bs.forEach((b, bi) => {
    if (b.type === 'heading') {
      const base = flowBase(itemStyle, 'heading', b.level, b.align, b.direction);
      out.push(`<div class="rt-blk rt-head" data-blk="${bi}" data-flow="${bi}" data-type="heading" data-level="${b.level}" data-align="${b.align}" data-dir="${b.direction}">${flowHtml(b.value, base, b.runs)}</div>`);
    } else if (b.type === 'list') {
      const base = flowBase(itemStyle, 'paragraph', null, null, b.direction);
      const counters = {};
      const items = b.items.map((it, ii) => {
        const lvl = it.level || 0;
        counters[lvl] = (counters[lvl] || 0) + 1;
        for (const k of Object.keys(counters)) if (+k > lvl) delete counters[k];
        // Bullet/number glyph size matches the first character of the line so the
        // mark stays in proportion with the text instead of the item's default size.
        const cs = charStyles(it, base);
        const firstSize = (cs && cs.length ? cs[0].size : null) || base.size || DEFAULT_STYLE.size;
        const mark = `<span class="rt-li-mark" contenteditable="false" style="font-size:${firstSize}px">${orderedMark(b.ordered, lvl, counters)}</span>`;
        return `<div class="rt-li" data-level="${lvl}" style="padding-left:${lvl * 18}px">${mark}<div class="rt-li-body" data-flow="${bi}.${ii}">${flowHtml(it.value, base, it.runs)}</div></div>`;
      }).join('');
      out.push(`<div class="rt-blk rt-list" data-blk="${bi}" data-type="list" data-ordered="${b.ordered ? 1 : 0}" data-dir="${b.direction}">${items}</div>`);
    } else if (b.type === 'table') {
      const border = b.border || DEFAULT_TABLE_BORDER;
      const colW = b.columns.map(c => Math.max(8, c.width || DEFAULT_COL_WIDTH));
      const totalW = colW.reduce((a, w) => a + w, 0);
      const cols = colW.map(w => `<col style="width:${w}px" />`).join('');
      const rows = b.rows.map((row, ri) => {
        const tds = row.cells.map((cell, ci) => {
          const base = flowBase(itemStyle, 'paragraph', null, cell.align, cell.direction);
          const grips = `${ri === 0 ? `<span class="rt-colgrip" contenteditable="false" data-grip="${ci}" title="Drag to resize column"></span>` : ''}`
            + `${ci === 0 ? `<span class="rt-rowgrip" contenteditable="false" data-rgrip="${ri}" title="Drag to resize row"></span>` : ''}`;
          return `<td class="rt-cell" data-flow="${bi}.${ri}.${ci}" data-r="${ri}" data-c="${ci}" dir="${cell.direction}" `
            + `style="border:${border.width}px solid ${border.color};text-align:${cell.align};vertical-align:top;padding:2px 4px;">`
            + `${flowHtml(cell.value, base, cell.runs)}${grips}</td>`;
        }).join('');
        return `<tr data-row="${ri}" style="height:${Math.max(8, row.height || DEFAULT_ROW_HEIGHT)}px">${tds}</tr>`;
      }).join('');
      out.push(`<div class="rt-blk rt-table" data-blk="${bi}" data-type="table" dir="${b.dir}" style="margin-left:${b.offsetX || 0}px;position:relative"><div class="rt-table-move-handle" data-table-move="${bi}" title="Drag to move table"></div><table class="rt-table-el" style="width:${totalW}px;border-collapse:collapse;table-layout:fixed;"><colgroup>${cols}</colgroup><tbody>${rows}</tbody></table></div>`);
    } else {
      const base = flowBase(itemStyle, 'paragraph', null, b.align, b.direction);
      out.push(`<div class="rt-blk rt-para" data-blk="${bi}" data-flow="${bi}" data-type="paragraph" data-align="${b.align}" data-dir="${b.direction}">${flowHtml(b.value, base, b.runs)}</div>`);
    }
  });
  return out.join('');
}

function tdAlign(td) {
  const s = String(td.style?.textAlign || '');
  if (['left', 'right', 'center', 'justify'].includes(s)) return s;
  if (td.getAttribute('align')) return td.getAttribute('align');
  return 'left';
}

function readFlow(el, itemStyle, kind) {
  const align = el.dataset.align || null;
  const dir = el.dataset.dir || el.getAttribute?.('dir') || null;
  const base = flowBase(itemStyle, kind === 'heading' ? 'heading' : 'paragraph', kind === 'heading' ? +el.dataset.level || 1 : null, align, dir);
  const { value, runs } = readRich(el, base);
  return { value, runs };
}

// editor DOM -> blocks. Tolerates flat text nodes (e.g. when tests assign textContent).
export function htmlToBlocks(root, itemStyle) {
  const blocks = [];
  let pending = null; // implicit paragraph for stray text / inline nodes
  const pushPending = () => { if (pending && (pending.value.length || blocks.length === 0)) { blocks.push(pending); pending = null; } };

  const walkStray = (node) => {
    if (node.nodeType === 3) {
      if (!pending) pending = { type: 'paragraph', value: '', runs: [], align: 'left', direction: 'ltr' };
      pending.value += node.nodeValue.replace(/\u200b/g, '');
    } else if (node.nodeType === 1 && node.tagName === 'BR') {
      if (!pending) pending = { type: 'paragraph', value: '', runs: [], align: 'left', direction: 'ltr' };
      pending.value += '\n';
    }
  };

  for (const el of [...root.childNodes]) {
    if (el.nodeType !== 1) { walkStray(el); continue; }
    const type = el.dataset ? el.dataset.type : null;
    if (!type) { walkStray(el); continue; }
    pushPending();
    if (type === 'heading') {
      const f = readFlow(el, itemStyle, 'heading');
      blocks.push({ type: 'heading', level: +el.dataset.level || 1, value: f.value, runs: f.runs, align: el.dataset.align || 'left', direction: el.dataset.dir === 'rtl' ? 'rtl' : 'ltr' });
    } else if (type === 'list') {
      const dir = el.dataset.dir === 'rtl' ? 'rtl' : 'ltr';
      const items = [...el.children].filter(c => c.classList.contains('rt-li')).map(li => {
        const body = li.querySelector(':scope > .rt-li-body') || li;
        const base = flowBase(itemStyle, 'paragraph', null, null, dir);
        const { value, runs } = readRich(body, base);
        return { value, runs, level: Math.max(0, Math.min(3, +li.dataset.level || 0)) };
      });
      blocks.push({ type: 'list', ordered: el.dataset.ordered === '1', direction: dir, items: items.length ? items : [{ value: '', runs: [], level: 0 }] });
    } else if (type === 'table') {
      const trs = [...el.querySelectorAll('table > tbody > tr')];
      const cols = [...el.querySelectorAll('colgroup > col')];
      const rows = trs.map(tr => {
        const cells = [...tr.children].map(td => {
          const align = tdAlign(td);
          const dir = td.getAttribute('dir') === 'rtl' ? 'rtl' : 'ltr';
          const base = flowBase(itemStyle, 'paragraph', null, align, dir);
          const { value, runs } = readRich(td, base);
          return { value, runs, align, direction: dir };
        });
        return { height: parseFloat(tr.style.height) || DEFAULT_ROW_HEIGHT, cells };
      });
      const firstTd = el.querySelector('td');
      const border = { ...DEFAULT_TABLE_BORDER };
      if (firstTd) {
        const bw = parseFloat(firstTd.style.borderTopWidth);
        if (Number.isFinite(bw)) border.width = bw;
        if (firstTd.style.borderTopColor) border.color = firstTd.style.borderTopColor;
      }
      const offsetX = parseFloat(el.style.marginLeft) || 0;
      blocks.push(normalizeTableBlock({
        type: 'table',
        dir: el.getAttribute('dir') === 'rtl' ? 'rtl' : 'ltr',
        offsetX,
        border,
        columns: cols.map(c => ({ width: parseFloat(c.style.width) || DEFAULT_COL_WIDTH })),
        rows,
      }));
    } else {
      const f = readFlow(el, itemStyle, 'paragraph');
      blocks.push({ type: 'paragraph', value: f.value, runs: f.runs, align: el.dataset.align || 'left', direction: el.dataset.dir === 'rtl' ? 'rtl' : 'ltr' });
    }
  }
  pushPending();
  return normalizeBlocks(blocks);
}
