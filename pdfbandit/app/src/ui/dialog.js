// A reusable in-page dialog, replacing the native confirm()/prompt() calls. One floating
// box, built on demand, with three capabilities (confirm, free-text and select), the same
// look as the app's other modals, Escape = cancel, Enter = primary, and a promise API so
// callers keep the shape of the code they replace. While a dialog is open this module
// records it on <body data-dialog-open>, so the page-level shortcut handler can stand down.

let modal = null;
let active = null; // { resolve } of the dialog currently open

function build() {
  const el = document.createElement('div');
  el.id = 'app-dialog';
  el.hidden = true;
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.innerHTML = `
    <div class="modal-box dialog-box">
      <h3 id="app-dialog-title"></h3>
      <p class="dialog-text" id="app-dialog-text" hidden></p>
      <div class="dialog-field" id="app-dialog-field" hidden></div>
      <p class="dialog-error" id="app-dialog-error" hidden aria-live="polite"></p>
      <div class="row dialog-buttons" id="app-dialog-buttons"></div>
    </div>`;
  document.body.appendChild(el);
  return el;
}

function fieldNode(spec) {
  // spec: { kind: 'text' | 'select', value, options: [{ value, label }], placeholder, aria-label }
  if (spec?.kind === 'select') {
    const sel = document.createElement('select');
    sel.id = 'app-dialog-input';
    for (const o of spec.options || []) {
      const opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.label;
      sel.appendChild(opt);
    }
    sel.value = spec.value ?? (spec.options?.[0]?.value ?? '');
    return sel;
  }
  const input = document.createElement('input');
  input.id = 'app-dialog-input';
  input.type = 'text';
  input.value = spec?.value ?? '';
  if (spec?.placeholder) input.placeholder = spec.placeholder;
  input.spellcheck = false;
  input.autocomplete = 'off';
  return input;
}

// Open the dialog. `buttons` is an ordered list of { value, label, primary } (a Cancel
// is appended automatically unless the caller already provided one). Resolves with
// `{ value, fieldValue }`, or `null` on cancel — the caller owns what cancelling means.
export function appDialog({ title, text = '', buttons = [{ value: 'ok', label: 'OK', primary: true }], cancelLabel = 'Cancel', field = null, validate = null }) {
  if (active) { // a second question while one is open: the first counts as cancelled
    active.resolve(null);
    active = null;
    delete document.body.dataset.dialogOpen;
  }
  modal = modal || build();
  modal.querySelector('#app-dialog-title').textContent = title || '';
  const textEl = modal.querySelector('#app-dialog-text');
  textEl.hidden = !text;
  textEl.textContent = text;
  const fieldWrap = modal.querySelector('#app-dialog-field');
  fieldWrap.hidden = !field;
  fieldWrap.innerHTML = '';
  const errorEl = modal.querySelector('#app-dialog-error');
  errorEl.hidden = true;
  errorEl.textContent = '';
  const buttonsWrap = modal.querySelector('#app-dialog-buttons');
  buttonsWrap.innerHTML = '';
  let inputEl = null;
  if (field) {
    inputEl = fieldNode(field);
    fieldWrap.appendChild(inputEl);
  }
  const close = (result) => {
    modal.hidden = true;
    modal.removeEventListener('keydown', onKey, true);
    const a = active;
    active = null;
    delete document.body.dataset.dialogOpen;
    a?.resolve(result);
  };
  const show = (result) => {
    if (validate && result && inputEl) {
      const err = validate(result.fieldValue);
      if (err) { errorEl.textContent = err; errorEl.hidden = false; return; }
    }
    close(result);
  };
  for (const b of buttons) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = b.label;
    if (b.primary) btn.className = 'primary';
    btn.onclick = () => show({ value: b.value, fieldValue: inputEl ? String(inputEl.value ?? '') : undefined });
    buttonsWrap.appendChild(btn);
  }
  // The caller's own buttons come first; the automatic Cancel closes the list, unless the
  // caller already supplied one.
  if (!buttons.some((b) => b.value === 'cancel')) {
    const c = document.createElement('button');
    c.type = 'button';
    c.textContent = cancelLabel;
    c.onclick = () => close(null);
    buttonsWrap.appendChild(c);
  }
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(null); }
    else if (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement)) {
      e.preventDefault();
      (buttonsWrap.querySelector('button.primary') || buttonsWrap.firstElementChild)?.click();
    }
  };
  modal.addEventListener('keydown', onKey, true);
  document.body.dataset.dialogOpen = '1';
  modal.hidden = false;
  return new Promise((resolve) => {
    active = { resolve };
    if (inputEl) inputEl.focus(); else buttonsWrap.querySelector('.primary')?.focus();
  });
}

// confirm()/window.confirm() replacement. Resolves `true` (the confirm button) or false.
export function confirmDialog({ title, text = '', confirmLabel = 'OK', cancelLabel = 'Cancel', primary = 'confirm' }) {
  return appDialog({
    title, text, cancelLabel,
    buttons: [
      { value: primary, label: confirmLabel, primary: true },
      { value: 'cancel', label: cancelLabel },
    ],
  }).then((res) => !!res && res.value === primary);
}

// Free-text prompt. Resolves the trimmed value, or null when cancelled. `validate`
// keeps the dialog open with an inline error while the value is unusable.
export function promptValue({ title, text = '', value = '', placeholder = '', okLabel = 'OK', validate = null, cancelLabel = 'Cancel' }) {
  return appDialog({ title, text, cancelLabel, buttons: [{ value: 'ok', label: okLabel, primary: true }, { value: 'cancel', label: cancelLabel }], field: { kind: 'text', value, placeholder }, validate }).then((res) => res ? res.fieldValue : null);
}

// Dropdown prompt — the "Source language" question, for instance. Resolves the chosen
// value, or null when cancelled.
export function promptSelect({ title, text = '', options, value, okLabel = 'OK', validate = null, cancelLabel = 'Cancel' }) {
  return appDialog({ title, text, cancelLabel, buttons: [{ value: 'ok', label: okLabel, primary: true }, { value: 'cancel', label: cancelLabel }], field: { kind: 'select', options, value }, validate }).then((res) => res ? res.fieldValue : null);
}
