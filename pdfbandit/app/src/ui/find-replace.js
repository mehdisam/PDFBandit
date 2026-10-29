// Find & replace — extracted from main.js
import { appState, els } from '../app.js';
import {
  contentIsImprove, langLabel, digitalSourceState,
  touch, rerender, setStatus, refreshChrome, history
} from '../main.js';
import { compileFind, countInTextItem, replaceInTextItem } from '../model/findreplace.js';

let findUpdateTimer = null;

// The active content variant is the model's whole document, not just the visible page, so
// a search covers every page whose text is currently loaded. Transitional flows (paragraph,
// list item, table cell) are separate search units; a match never crosses one.
export function activeFindEntries() {
  return (appState.pmap?.pages || []).flatMap(pg => (pg.regions || []).map(r => ({
    id: r.id,
    page: pg.page,
    region: r,
    get: () => r.content,
    set: (c) => { r.content = c; },
  }))).filter(e => (e.get()?.items || []).some(it => it.type === 'text'));
}

export function variantFindEntries(content) {
  return Object.keys(content?.regions || {}).map(id => ({
    id,
    page: null,
    region: null,
    get: () => content.regions[id],
    set: (c) => { content.regions[id] = c; },
  })).filter(e => (e.get()?.items || []).some(it => it.type === 'text'));
}

export function findReplaceTarget() {
  if (!appState.pmap || !appState.content) return null;
  if (contentIsImprove()) {
    const source = digitalSourceState();
    if (source.active) {
      return { entries: activeFindEntries(), label: `Selectable text · ${appState.content.name} (${langLabel(appState.content)}) · all pages` };
    }
    if (source.content) {
      return { entries: variantFindEntries(source.content), label: `Selectable text · ${source.content.meta?.name || 'source variant'} (${langLabel(source.content)}) · all pages` };
    }
    // No PDF-language variant has been identified yet. Improve is working in the only
    // loaded variant; searching it is more useful than refusing, and the label says so.
    if (!appState.pdfLanguage) {
      return { entries: activeFindEntries(), label: `Current content · ${appState.content.name} (${langLabel(appState.content)}) · all pages` };
    }
    return null;
  }
  return { entries: activeFindEntries(), label: `Translate content · ${appState.content.name} (${langLabel(appState.content)}) · all pages` };
}

export function findOptions() {
  return { regex: !!els.findRegex?.checked, matchCase: !!els.findCase?.checked };
}

export function findStats(target, regex) {
  let matches = 0, items = 0, regions = 0;
  for (const entry of target.entries) {
    const content = entry.get();
    if (!content) continue;
    let entryMatches = 0, entryItems = 0;
    for (const item of content.items || []) {
      if (item.type !== 'text') continue;
      const n = countInTextItem(item, regex);
      if (n) { entryMatches += n; entryItems += 1; }
    }
    if (entryMatches) { matches += entryMatches; items += entryItems; regions += 1; }
  }
  return { matches, items, regions };
}

export function updateFindStatus() {
  if (!els.findStatus) return;
  const target = findReplaceTarget();
  if (els.findScope) els.findScope.textContent = target
    ? `${target.label}.`
    : 'No Selectable text content is loaded yet. Run Improve ▸ Make this selectable first.';
  const set = (text, canReplace = false) => {
    els.findStatus.textContent = text;
    if (els.findReplaceAll) els.findReplaceAll.disabled = !canReplace;
  };
  if (!target) return set('');
  const pattern = els.findText?.value || '';
  if (!pattern) return set('Type text to search the loaded content.');
  const regex = compileFind(pattern, findOptions());
  if (!regex) return set('Invalid regular expression.');
  const s = findStats(target, regex);
  if (!s.matches) return set('No matches.');
  const noun = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  set(`${noun(s.matches, 'match', 'matches')} in ${noun(s.items, 'text item', 'text items')} across ${noun(s.regions, 'region', 'regions')}.`, true);
}

export function scheduleFindUpdate() {
  clearTimeout(findUpdateTimer);
  findUpdateTimer = setTimeout(updateFindStatus, 100);
}

export function openFindReplace() {
  if (!els.findModal) return;
  els.findModal.hidden = false;
  updateFindStatus();
  els.findText?.focus();
  els.findText?.select();
}

export function closeFindReplace() {
  if (!els.findModal) return;
  els.findModal.hidden = true;
  // A hidden input would otherwise keep focus, and the global shortcut guard ignores
  // every key while a field is focused.
  if (els.findModal.contains(document.activeElement)) document.activeElement.blur();
}

export function replaceAllFound() {
  const target = findReplaceTarget();
  if (!target || !els.findText?.value) { updateFindStatus(); return; }
  const options = findOptions();
  const regex = compileFind(els.findText.value, options);
  if (!regex) { updateFindStatus(); return; }
  const replacement = els.replaceText?.value || '';
  const changes = [];
  let total = 0, itemCount = 0;
  for (const entry of target.entries) {
    const before = entry.get();
    if (!before) continue;
    const after = structuredClone(before);
    let entryMatches = 0, entryItems = 0;
    for (const item of after.items || []) {
      if (item.type !== 'text') continue;
      const n = replaceInTextItem(item, regex, replacement, { regex: options.regex });
      if (n) {
        // A find/replace is a deliberate user edit: the item no longer needs review.
        delete item.needsReview;
        entryMatches += n;
        entryItems += 1;
      }
    }
    if (entryMatches) {
      changes.push({ entry, before: structuredClone(before), after });
      total += entryMatches;
      itemCount += entryItems;
    }
  }
  if (!total) { setStatus('No matches to replace.'); updateFindStatus(); return; }
  const commit = (side) => {
    for (const c of changes) c.entry.set(structuredClone(c[side]));
    rerender();
  };
  history.exec({
    label: 'find and replace',
    do() { commit('after'); touch(appState.pmap); refreshChrome(); },
    undo() { commit('before'); refreshChrome(); },
  });
  const noun = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  setStatus(`Replaced ${noun(total, 'match', 'matches')} in ${noun(itemCount, 'text item', 'text items')} across ${noun(changes.length, 'region', 'regions')}.`);
  updateFindStatus();
}

export function initFindReplace() {
  if (els.findText) {
    els.findText.oninput = scheduleFindUpdate;
    els.findText.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); els.replaceText?.focus(); }
    };
  }
  if (els.replaceText) {
    els.replaceText.oninput = scheduleFindUpdate;
    els.replaceText.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); replaceAllFound(); }
    };
  }
  if (els.findRegex) els.findRegex.onchange = updateFindStatus;
  if (els.findCase) els.findCase.onchange = updateFindStatus;
  if (els.findReplaceAll) els.findReplaceAll.onclick = replaceAllFound;
  if (els.findClose) els.findClose.onclick = closeFindReplace;
  if (els.findModal) els.findModal.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeFindReplace(); }
  });
  if (els.findModal) els.findModal.addEventListener('pointerdown', (e) => {
    if (e.target === els.findModal) closeFindReplace();
  });
  if (els.helpClose) els.helpClose.onclick = () => { els.helpModal.hidden = true; };
  if (els.aboutClose) els.aboutClose.onclick = () => { els.aboutModal.hidden = true; };
}