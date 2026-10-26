// @ts-check
// Reusable confirmation window, based on <dialog>: the browser handles the focus,
// the Esc key and blocking the page in the background.

import { t } from "./i18n.js";

const dialog = /** @type {HTMLDialogElement} */ (document.getElementById("modal"));
const title = /** @type {HTMLElement} */ (document.getElementById("modal-title"));
const message = /** @type {HTMLElement} */ (document.getElementById("modal-message"));
const confirmButton = /** @type {HTMLButtonElement} */ (document.getElementById("modal-confirm"));
const cancelButton = /** @type {HTMLButtonElement} */ (document.getElementById("modal-cancel"));
const extra = /** @type {HTMLElement} */ (document.getElementById("modal-extra"));

/** The confirm button is only enabled if the added content (form…) allows it. */
let canConfirm = () => true;
const refreshConfirm = () => {
  confirmButton.disabled = !canConfirm();
};
dialog.addEventListener("input", refreshConfirm);
dialog.addEventListener("change", refreshConfirm);

// A click on the backdrop (outside the content) cancels.
dialog.addEventListener("click", (event) => {
  if (event.target === dialog) dialog.close("cancel");
});

export const isDialogOpen = () => dialog.open;

/** Closes the window without an answer: the confirmDialog promise returns false. */
export function dismissDialog() {
  if (dialog.open) dialog.close("dismiss");
}

/** @param {() => void} listener called each time the window closes */
export const onDialogClose = (listener) => dialog.addEventListener("close", listener);

/**
 * Shows a confirmation request and waits for the answer.
 *
 * @param {object} options
 * @param {string} options.title
 * @param {string} options.message
 * @param {string} [options.confirmLabel]
 * @param {string} [options.cancelLabel]
 * @param {boolean} [options.danger] confirm button in red, initial focus on "Cancel"
 * @param {HTMLElement} [options.content] content shown below the message (a form…)
 * @param {() => boolean} [options.canConfirm] confirming is only possible if it returns true
 * @returns {Promise<boolean>} true if the user confirms
 */
export function confirmDialog({
  title: heading, message: text, confirmLabel = t("Confirm"), cancelLabel = t("Cancel"), danger = false,
  content = undefined, canConfirm: check = () => true,
}) {
  if (dialog.open) return Promise.resolve(false);
  title.textContent = heading;
  message.textContent = text;
  message.hidden = !text;
  extra.replaceChildren(...(content ? [content] : []));
  extra.hidden = !content;
  canConfirm = check;
  refreshConfirm();
  confirmButton.textContent = confirmLabel;
  cancelButton.textContent = cancelLabel;
  confirmButton.classList.toggle("danger", danger);
  confirmButton.classList.toggle("primary", !danger);
  dialog.returnValue = "";
  dialog.showModal();
  if (!content) (danger ? cancelButton : confirmButton).focus();
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true });
  });
}
