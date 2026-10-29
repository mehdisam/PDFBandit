// Background color picker and coloring mode (eyedropper) — extracted from main.js
import { appState, moduleState, els } from '../app.js';
import { getPage } from '../model/document.js';
import { history } from '../app.js';
import { touch, rerender, setStatus, selectedRegions, regionById, detectionSnapshot, restoreDetection, clearDetection, regionsUnderPoint, isRegionLocked, stagePdfPoint, DEFAULT_BACKGROUND, saveProjectNow } from '../main.js';

// ---- coloring mode: press C in Region mode to toggle eyedropper background sampling ----

export function toggleColoringMode() {
  if (!appState.mode === 'region') return;
  appState.coloringMode = !appState.coloringMode;
  document.body.classList.toggle('coloring-mode', appState.coloringMode);
  if (els.btnColoringMode) els.btnColoringMode.setAttribute('aria-pressed', String(appState.coloringMode));
  if (!appState.coloringMode) {
    cancelEyedropper();
    setStatus('Coloring mode off.');
  } else {
    setStatus('Coloring mode is active — drag over a region to sample its background colour.');
  }
  rerender();
}

let coloringMoveHandler = null;

export function startEyedropmerAt(e) {
  const mag = els.eyedropperMag;
  if (mag) mag.hidden = false;
  document.body.style.cursor = 'crosshair';
  appState.eyedropper = { regionId: null, color: null };
  coloringMoveHandler = (ev) => moveEyedropper(ev);
  window.addEventListener('pointermove', coloringMoveHandler);
  window.addEventListener('pointerup', endEyedropper);
  moveEyedropper(e);
}

export function startEyedropper(e, region) {
  appState.eyedropper = { regionId: region.id, color: null };
  const mag = els.eyedropperMag;
  if (mag) mag.hidden = false;
  document.body.style.cursor = 'crosshair';
  coloringMoveHandler = (ev) => moveEyedropper(ev);
  window.addEventListener('pointermove', coloringMoveHandler);
  window.addEventListener('pointerup', endEyedropper);
  moveEyedropper(e);
}

function moveEyedropper(e) {
  const mag = els.eyedropperMag;
  if (!mag) return;
  const magSize = 100;
  const left = Math.min(Math.max(e.clientX - magSize / 2, 0), window.innerWidth - magSize);
  const top = Math.min(Math.max(e.clientY - magSize / 2, 0), window.innerHeight - magSize);
  mag.style.left = left + 'px';
  mag.style.top = top + 'px';
  const color = sampleColor(e.clientX, e.clientY);
  if (color) {
    if (appState.eyedropper) appState.eyedropper.color = color;
    drawMagnifier(mag, e.clientX, e.clientY, color);
  }
}

function sampleColor(cx, cy) {
  const canvas = els.pdfCanvas;
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const ctx = canvas.getContext('2d');
  const px = Math.round((cx - rect.left) * dpr);
  const py = Math.round((cy - rect.top) * dpr);
  if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) return null;
  const data = ctx.getImageData(px, py, 1, 1).data;
  return `#${data[0].toString(16).padStart(2, '0')}${data[1].toString(16).padStart(2, '0')}${data[2].toString(16).padStart(2, '0')}`;
}

function drawMagnifier(mag, cx, cy, color) {
  const ctx = mag.getContext('2d');
  const size = 100;
  const sampleRadius = 12;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const canvas = els.pdfCanvas;
  ctx.clearRect(0, 0, size, size);
  if (canvas) {
    const rect = canvas.getBoundingClientRect();
    const srcX = Math.round((cx - rect.left) * dpr - sampleRadius * dpr);
    const srcY = Math.round((cy - rect.top) * dpr - sampleRadius * dpr);
    const srcW = Math.round(sampleRadius * 2 * dpr);
    const srcH = Math.round(sampleRadius * 2 * dpr);
    ctx.save();
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - 3, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(canvas, srcX, srcY, srcW, srcH, 3, 3, size - 6, size - 6);
    ctx.restore();
  }
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(size / 2 - 10, size / 2);
  ctx.lineTo(size / 2 + 10, size / 2);
  ctx.moveTo(size / 2, size / 2 - 10);
  ctx.lineTo(size / 2, size / 2 + 10);
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.font = '12px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(color, size / 2, size - 20);
}

function endEyedropper(e) {
  if (!appState.eyedropper) return;
  const mag = els.eyedropperMag;
  if (mag) mag.hidden = true;
  document.body.style.cursor = '';
  if (coloringMoveHandler) {
    window.removeEventListener('pointermove', coloringMoveHandler);
    coloringMoveHandler = null;
  }
  window.removeEventListener('pointerup', endEyedropper);
  
  // Apply color to the region where the drag STARTED (the region stored in eyedropper)
  // NOT the region under the cursor where the drag ended
  const startRegion = regionById(appState.eyedropper.regionId);
  const color = appState.eyedropper.color;
  appState.eyedropper = null;
  
  if (startRegion && color) {
    setRegionBackground([startRegion], color);
  }
}

export function cancelEyedropper() {
  const mag = els.eyedropperMag;
  if (mag) mag.hidden = true;
  document.body.style.cursor = '';
  if (coloringMoveHandler) {
    window.removeEventListener('pointermove', coloringMoveHandler);
    coloringMoveHandler = null;
  }
  window.removeEventListener('pointerup', endEyedropper);
  appState.eyedropper = null;
}

// ---- background color picker (I key / background button) ----

export function initBackgroundPicker() {
  // Background colour. macOS's native <input type="color"> fires `change` only when its panel
  // closes, so the region previews its own mask (bgPreview) and repaints live on `input`
  // while the picker has focus — otherwise the selected region is exactly the one region whose
  // mask is suppressed, and the chosen colour would not be visible. The previous colours are
  // snapshotted at focus so `change` stays the *single* undoable commit; a blur without a
  // change (the panel was dismissed) puts the live preview back.
  els.fBg.onfocus = () => {
    if (!moduleState.bgSnapshot) {
      const regions = selectedRegions();
      moduleState.bgRegions = regions;
      moduleState.bgSnapshot = new Map(regions.map(region => [region.id, { background: region.content?.background ?? DEFAULT_BACKGROUND, provenance: detectionSnapshot(region) }]));
    }
    appState.bgPreview = true; rerender();
  };
  els.fBg.oninput = () => {
    const colorValue = els.fBg.value;
    const regions = moduleState.bgRegions || selectedRegions();
    for (const region of regions) { if (!region.content) region.content = { background: DEFAULT_BACKGROUND, items: [] }; region.content.background = colorValue; }
    appState.bgPreview = true; rerender();
  };
  els.fBg.onchange = async () => {
    const colorValue = els.fBg.value;
    const snapshot = moduleState.bgSnapshot;
    moduleState.bgSnapshot = null;
    moduleState.bgRegions = null;
    appState.bgPreview = false;
    const regions = snapshot ? [...snapshot.keys()].map(id => regionById(id)).filter(Boolean) : [];
    if (!regions.length) { rerender(); return; }
    const before = regions.map(region => {
      const snapshotEntry = snapshot?.get(region.id);
      return snapshotEntry ? { id: region.id, background: snapshotEntry.background, provenance: snapshotEntry.provenance }
                 : { id: region.id, background: region.content?.background ?? DEFAULT_BACKGROUND, provenance: detectionSnapshot(region) };
    });
    setRegionBackground(regions, colorValue, before);
    await saveProjectNow();
  };
  els.fBg.onblur = () => {
    const hadInput = moduleState.bgRegions && moduleState.bgRegions.length > 0;
    if (moduleState.bgSnapshot && !hadInput) {
      for (const region of (moduleState.bgRegions || selectedRegions())) {
        const snapshotEntry = moduleState.bgSnapshot.get(region.id);
        if (snapshotEntry) { if (!region.content) region.content = { background: DEFAULT_BACKGROUND, items: [] }; region.content.background = snapshotEntry.background; }
      }
      moduleState.bgSnapshot = null;
      moduleState.bgRegions = null;
    }
    appState.bgPreview = false; rerender();
  };
}

// `I` is the "pick a colour" key (spec §11): it opens the region background colour control the
// same way a click on the swatch does, so the native picker — and its eyedropper — comes up.
// The control only exists while a region is selected, so the key is gated on it being on screen
// (the contextual-keys rule), exactly like `Shift+T`.
export function backgroundButtonVisible() {
  return !!els.fBg && !!els.regionTools && !els.regionTools.hidden && els.fBg.offsetParent !== null;
}
export function openBackgroundPicker() {
  els.fBg.focus();
  try {
    if (typeof els.fBg.showPicker === 'function') { els.fBg.showPicker(); return; }
  } catch { /* fall through to click */ }
  els.fBg.click();
}

// ---- set region background (shared by color picker, eyedropper, Color mode) ----

export function setRegionBackground(regions, color, before) {
  const page = getPage(appState.pmap, appState.page);
  if (!before) {
    before = regions.map(region => ({ id: region.id, background: region.content?.background ?? DEFAULT_BACKGROUND, provenance: detectionSnapshot(region) }));
  }
  history.exec({
    label: 'set region background',
    do() {
      for (const region of regions) {
        if (!region.content) region.content = { background: DEFAULT_BACKGROUND, items: [] };
        region.content.background = color;
        clearDetection(region);
        appState.awaitingOcr.delete(region.id);
      }
      touch(appState.pmap); rerender();
    },
    undo() {
      for (const beforeEntry of before) {
        const region = page.regions.find(x => x.id === beforeEntry.id);
        if (!region) continue;
        if (!region.content) region.content = { background: DEFAULT_BACKGROUND, items: [] };
        region.content.background = beforeEntry.background;
        restoreDetection(region, beforeEntry.provenance);
      }
      rerender();
    },
  });
  setStatus(`Region background set to ${color}.`);
}