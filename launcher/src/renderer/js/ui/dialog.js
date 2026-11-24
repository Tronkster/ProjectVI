// One modal at a time, built on the native <dialog> element (focus trap and Esc for free).
//
// openDialog({ title, html, actions, cancelValue, onReady }) resolves with the chosen action's value.
// An action can have validate(dialogEl) -> boolean | Promise<boolean> to keep the dialog open,
// and value can be a function of the dialog element, for dialogs with inputs.

import { $, esc } from "../util.js";

const KIND = { accent: "btn-accent", danger: "btn-danger", ghost: "btn-ghost" };

export function openDialog({ title, html = "", actions = [{ label: "OK", value: true, kind: "accent" }], cancelValue = null, onReady }) {
  const dlg = $("dialog");
  dlg.innerHTML = `
    <form method="dialog">
      <div class="dialog-body"><h2>${esc(title)}</h2>${html}</div>
      <div class="dialog-actions">
        ${actions.map((a, i) => `<button type="button" class="btn ${KIND[a.kind] || "btn-ghost"}" data-index="${i}">${esc(a.label)}</button>`).join("")}
      </div>
    </form>`;

  return new Promise((resolve) => {
    const controller = new AbortController();
    const { signal } = controller;

    const finish = (value) => {
      controller.abort();
      dlg.close();
      resolve(value);
    };

    const choose = async (action) => {
      if (action.validate && !(await action.validate(dlg))) return;
      finish(typeof action.value === "function" ? action.value(dlg) : action.value);
    };

    dlg.querySelectorAll("[data-index]").forEach((btn) => {
      btn.addEventListener("click", () => choose(actions[btn.dataset.index]), { signal });
    });
    // Enter in a text field picks the first accent action instead of closing the dialog.
    dlg.querySelector("form").addEventListener("submit", (e) => {
      e.preventDefault();
      const primary = actions.find((a) => a.kind === "accent");
      if (primary) choose(primary);
    }, { signal });
    dlg.addEventListener("cancel", (e) => {
      e.preventDefault();
      finish(cancelValue);
    }, { signal });

    dlg.showModal();
    onReady?.(dlg);
  });
}

export function confirmDialog({ title, text, confirmLabel, danger = false }) {
  return openDialog({
    title,
    html: `<p>${esc(text)}</p>`,
    cancelValue: false,
    actions: [
      { label: "Cancel", value: false, kind: "ghost" },
      { label: confirmLabel, value: true, kind: danger ? "danger" : "accent" }
    ]
  });
}
