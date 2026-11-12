// A cancellable progress dialog for long jobs (translate, OCR, extract).
//
// The dialog is advisory, not pre-emptive: it exposes an AbortSignal and each job loop
// checks `job.cancelled` between items, so Cancel takes effect at the next safe point
// (a provider call or one OCR pass is allowed to finish). Closing the job is idempotent.

let host = null;
let nodes = null;
let current = null;

function build() {
  host = document.createElement('div');
  host.id = 'job-dialog';
  host.hidden = true;
  host.innerHTML = `
    <div class="job-card" role="dialog" aria-live="polite" aria-labelledby="job-title">
      <div class="job-head">
        <h3 id="job-title"><span class="job-spinner" aria-hidden="true"></span><span id="job-title-text"></span></h3>
        <button id="job-cancel" type="button">Cancel</button>
      </div>
      <progress id="job-bar" max="1" value="0"></progress>
      <div class="job-meta"><span id="job-label"></span><span id="job-count"></span></div>
    </div>`;
  document.body.appendChild(host);
  nodes = {
    title: host.querySelector('#job-title-text'),
    bar: host.querySelector('#job-bar'),
    label: host.querySelector('#job-label'),
    count: host.querySelector('#job-count'),
    cancel: host.querySelector('#job-cancel'),
  };
}

/**
 * Open the job dialog. Only one job runs at a time.
 * @param {{ title?: string, text?: string, total?: number }} opts
 * @returns {{
 *   signal: AbortSignal, cancelled: boolean,
 *   update: (done: number, total: number, label?: string) => void,
 *   fraction: (fraction: number, label?: string) => void,
 *   indeterminate: (label?: string) => void,
 *   close: () => void
 * }}
 */
export function openJobDialog({ title = 'Working…', text = '', total = 0 } = {}) {
  if (!host) build();
  current?.close();

  const controller = new AbortController();
  const api = {
    signal: controller.signal,
    get cancelled() { return controller.signal.aborted; },
    update(done, totalCount, label) {
      const n = Math.max(0, Number(done) || 0);
      const t = Math.max(0, Number(totalCount) || 0);
      nodes.bar.removeAttribute('data-indeterminate');
      nodes.bar.max = t || 1;
      nodes.bar.value = t ? Math.min(n, t) : 0;
      nodes.count.textContent = t ? `${Math.min(n, t)} / ${t}` : '';
      if (label != null) nodes.label.textContent = label;
    },
    fraction(fraction, label) {
      const f = Math.max(0, Math.min(1, Number(fraction) || 0));
      nodes.bar.removeAttribute('data-indeterminate');
      nodes.bar.max = 1;
      nodes.bar.value = f;
      nodes.count.textContent = `${Math.round(f * 100)}%`;
      if (label != null) nodes.label.textContent = label;
    },
    indeterminate(label) {
      nodes.bar.removeAttribute('value');
      nodes.count.textContent = '';
      if (label != null) nodes.label.textContent = label;
    },
    close() {
      if (current === api) current = null;
      if (!host) return;
      host.hidden = true;
      document.body.classList.remove('job-running', 'job-cancelling');
      nodes.cancel.disabled = false;
      nodes.cancel.textContent = 'Cancel';
      nodes.bar.removeAttribute('data-indeterminate');
      nodes.bar.max = 1;
      nodes.bar.value = 0;
      nodes.title.textContent = '';
      nodes.label.textContent = '';
      nodes.count.textContent = '';
    },
  };

  current = api;
  nodes.title.textContent = title;
  nodes.label.textContent = text;
  nodes.count.textContent = total ? `0 / ${total}` : '';
  nodes.bar.max = total || 1;
  nodes.bar.value = 0;
  nodes.cancel.disabled = false;
  nodes.cancel.textContent = 'Cancel';
  nodes.cancel.onclick = () => {
    if (controller.signal.aborted) return;
    controller.abort();
    nodes.cancel.disabled = true;
    nodes.cancel.textContent = 'Cancelling…';
    nodes.label.textContent = 'Finishing the current step…';
    nodes.bar.removeAttribute('value');
    nodes.count.textContent = '';
    document.body.classList.add('job-cancelling');
  };
  host.hidden = false;
  document.body.classList.add('job-running');
  return api;
}
