// A progress modal on the shared <dialog>. Returns controls to update it and close it.

import { $, esc } from "../util.js";

export function openProgress({ title, text = "", onCancel, cancellable = true }) {
  const dlg = $("dialog");
  dlg.innerHTML = `
    <div class="dialog-body">
      <h2>${esc(title)}</h2>
      <p id="progress-text">${esc(text)}</p>
      <div class="progress indeterminate" id="progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100"><i id="progress-bar"></i></div>
      <p class="hint nums" id="progress-detail"></p>
    </div>
    <div class="dialog-actions" ${cancellable ? "" : "hidden"}>
      <button type="button" class="btn btn-ghost" id="progress-cancel">Cancel</button>
    </div>`;

  const controller = new AbortController();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    controller.abort();
    dlg.close();
  };
  const cancel = () => {
    close();
    onCancel?.();
  };
  dlg.querySelector("#progress-cancel").addEventListener("click", cancel, { signal: controller.signal });
  dlg.addEventListener("cancel", (e) => {
    e.preventDefault();
    if (cancellable) cancel();
  }, { signal: controller.signal });
  if (!dlg.open) dlg.showModal();

  return {
    get closed() {
      return closed;
    },
    update({ text, fraction, detail }) {
      if (closed) return;
      if (text !== undefined) $("progress-text").textContent = text;
      if (detail !== undefined) $("progress-detail").textContent = detail;
      if (fraction !== undefined) {
        const pct = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
        $("progress-track").classList.remove("indeterminate");
        $("progress-track").setAttribute("aria-valuenow", String(pct));
        $("progress-bar").style.width = `${pct}%`;
      }
    },
    close
  };
}
