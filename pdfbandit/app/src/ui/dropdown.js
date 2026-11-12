// A small dependency-free dropdown panel for the app bar (View / variants / export /
// region actions). The menu item contract is the same one the menubar uses:
//   { type: 'sep' } | { type: 'header', label }
//   { label, shortcut?, checked?(), enabled?(), run() }
export function createDropdown(button, panel, getItems, { align = 'left' } = {}) {
  let open = false;

  function close() {
    if (!open) return;
    open = false;
    panel.hidden = true;
    panel.innerHTML = '';
    button.setAttribute('aria-expanded', 'false');
  }

  function render() {
    panel.innerHTML = '';
    const items = typeof getItems === 'function' ? getItems() : getItems;
    for (const it of items || []) {
      if (it.type === 'sep') {
        const s = document.createElement('div');
        s.className = 'menu-sep';
        panel.appendChild(s);
        continue;
      }
      if (it.type === 'header') {
        const h = document.createElement('div');
        h.className = 'menu-header';
        h.textContent = it.label;
        panel.appendChild(h);
        continue;
      }
      const enabled = it.enabled ? it.enabled() : true;
      const checked = it.checked ? it.checked() : false;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'menu-item';
      b.disabled = !enabled;
      const chk = document.createElement('span');
      chk.className = 'mi-check';
      chk.textContent = checked ? '✓' : '';
      const lbl = document.createElement('span');
      lbl.className = 'mi-label';
      lbl.textContent = it.label;
      b.append(chk, lbl);
      if (it.shortcut) {
        const s = document.createElement('span');
        s.className = 'mi-shortcut';
        s.textContent = it.shortcut;
        b.appendChild(s);
      }
      b.addEventListener('click', () => {
        if (b.disabled) return;
        close();
        it.run?.();
      });
      b.addEventListener('keydown', (e) => onItemKey(e, b));
      panel.appendChild(b);
    }
    const r = button.getBoundingClientRect();
    panel.hidden = false;
    panel.style.minWidth = `${Math.max(220, Math.round(r.width))}px`;
    if (align === 'right') {
      panel.style.left = 'auto';
      panel.style.right = `${Math.max(8, Math.round(window.innerWidth - r.right))}px`;
    } else {
      panel.style.right = 'auto';
      panel.style.left = `${Math.round(r.left)}px`;
    }
    panel.style.top = `${Math.round(r.bottom) + 4}px`;
    panel.querySelector('.menu-item:not(:disabled)')?.focus();
  }

  function onItemKey(e, btn) {
    const items = [...panel.querySelectorAll('.menu-item:not(:disabled)')];
    const i = items.indexOf(btn);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); button.focus(); }
    else if (e.key === 'Home') { e.preventDefault(); items[0]?.focus(); }
    else if (e.key === 'End') { e.preventDefault(); items[items.length - 1]?.focus(); }
  }

  button.addEventListener('click', (e) => {
    e.stopPropagation();
    if (open) { close(); return; }
    open = true;
    button.setAttribute('aria-expanded', 'true');
    render();
  });

  document.addEventListener('pointerdown', (e) => {
    if (!open) return;
    if (panel.contains(e.target) || button.contains(e.target)) return;
    close();
  }, true);

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && open) {
      // The panel's own Escape normally runs first; this is the fallback when focus
      // moved back to the page.
      close();
      button.focus();
    }
  });

  window.addEventListener('resize', close);
  window.addEventListener('scroll', close, true);

  return {
    close,
    refresh() { if (open) render(); },
    get open() { return open; },
  };
}
