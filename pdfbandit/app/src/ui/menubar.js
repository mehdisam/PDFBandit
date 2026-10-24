// Dependency-free dropdown menu bar (diagrams.net style). Pure view; actions come from caller.
export function createMenubar(rootEl, menus) {
  rootEl.innerHTML = '';
  const bar = document.createElement('div');
  bar.className = 'menubar';
  rootEl.appendChild(bar);
  let openIdx = -1;
  let sourceMenus = menus;
  const getMenus = () => (typeof sourceMenus === 'function' ? sourceMenus() : sourceMenus);
  const titles = [];

  const panel = document.createElement('div');
  panel.className = 'menu-panel';
  panel.hidden = true;
  document.body.appendChild(panel);

  function close() {
    openIdx = -1;
    panel.hidden = true;
    panel.innerHTML = '';
    titles.forEach(t => t.classList.remove('active'));
  }

  function itemsFor(menu) {
    return typeof menu.items === 'function' ? menu.items() : menu.items;
  }

  function renderPanel(menu, titleBtn) {
    panel.innerHTML = '';
    const items = itemsFor(menu);
    for (const it of items) {
      if (it.type === 'sep') { const s = document.createElement('div'); s.className = 'menu-sep'; panel.appendChild(s); continue; }
      if (it.type === 'header') { const h = document.createElement('div'); h.className = 'menu-header'; h.textContent = it.label; panel.appendChild(h); continue; }
      const enabled = it.enabled ? it.enabled() : true;
      const checked = it.checked ? it.checked() : false;
      const b = document.createElement('button');
      b.className = 'menu-item';
      b.type = 'button';
      b.disabled = !enabled;
      const chk = document.createElement('span'); chk.className = 'mi-check'; chk.textContent = checked ? '✓' : '';
      const lbl = document.createElement('span'); lbl.className = 'mi-label'; lbl.textContent = it.label;
      b.append(chk, lbl);
      if (it.shortcut) { const s = document.createElement('span'); s.className = 'mi-shortcut'; s.textContent = it.shortcut; b.appendChild(s); }
      b.addEventListener('click', () => { if (b.disabled) return; close(); it.run?.(); });
      b.addEventListener('keydown', (e) => onItemKey(e, b));
      panel.appendChild(b);
    }
    const r = titleBtn.getBoundingClientRect();
    panel.style.left = `${Math.round(r.left)}px`;
    panel.style.top = `${Math.round(r.bottom) + 2}px`;
    panel.hidden = false;
    const first = panel.querySelector('.menu-item:not(:disabled)');
    first?.focus();
  }

  function onItemKey(e, btn) {
    const items = [...panel.querySelectorAll('.menu-item:not(:disabled)')];
    const i = items.indexOf(btn);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); const t = titles[openIdx]; close(); t?.focus(); }
  }

  function open(i) {
    const menu = getMenus()[i];
    if (!menu) return;
    const btn = titles[i];
    openIdx = i;
    titles.forEach((t, k) => t.classList.toggle('active', k === i));
    renderPanel(menu, btn);
  }

  function buildTitles() {
    close();
    bar.innerHTML = '';
    titles.length = 0;
    getMenus().forEach((menu, i) => {
      const btn = document.createElement('button');
      btn.className = 'menu-title';
      btn.type = 'button';
      btn.textContent = menu.label;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (openIdx === i) close(); else open(i);
      });
      btn.addEventListener('mouseenter', () => { if (openIdx >= 0 && openIdx !== i) open(i); });
      btn.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); open(i); }
        else if (e.key === 'Escape') { close(); }
      });
      titles.push(btn);
      bar.appendChild(btn);
    });
    const brand = document.createElement('a');
    brand.className = 'menubar-brand';
    brand.href = '/';
    brand.title = 'PDFBandit home';
    const name = document.createElement('strong');
    name.textContent = 'PDFBandit';
    const tagline = document.createElement('span');
    tagline.textContent = 'Fix/Translate PDFs, your way.';
    brand.append(name, tagline);
    bar.appendChild(brand);
  }
  buildTitles();

  document.addEventListener('pointerdown', (e) => {
    if (panel.hidden) return;
    if (panel.contains(e.target) || bar.contains(e.target)) return;
    close();
  }, true);
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.hidden) close(); });

  return {
    refresh() { if (openIdx >= 0) open(openIdx); },
    close,
    setMenus(next) { sourceMenus = next; buildTitles(); },
  };
}
