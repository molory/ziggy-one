// @ts-check
// Fenêtre de confirmation réutilisable, basée sur <dialog> : le navigateur gère le focus,
// la touche Échap et le blocage de la page en arrière-plan.

const dialog = /** @type {HTMLDialogElement} */ (document.getElementById("modal"));
const title = /** @type {HTMLElement} */ (document.getElementById("modal-title"));
const message = /** @type {HTMLElement} */ (document.getElementById("modal-message"));
const confirmButton = /** @type {HTMLButtonElement} */ (document.getElementById("modal-confirm"));
const cancelButton = /** @type {HTMLButtonElement} */ (document.getElementById("modal-cancel"));
const extra = /** @type {HTMLElement} */ (document.getElementById("modal-extra"));

/** Le bouton de confirmation n'est actif que si le contenu ajouté (formulaire…) le permet. */
let canConfirm = () => true;
const refreshConfirm = () => {
  confirmButton.disabled = !canConfirm();
};
dialog.addEventListener("input", refreshConfirm);
dialog.addEventListener("change", refreshConfirm);

// Un clic sur le fond (hors du contenu) annule.
dialog.addEventListener("click", (event) => {
  if (event.target === dialog) dialog.close("cancel");
});

export const isDialogOpen = () => dialog.open;

/** Ferme la fenêtre sans réponse : la promesse de confirmDialog renvoie false. */
export function dismissDialog() {
  if (dialog.open) dialog.close("dismiss");
}

/** @param {() => void} listener appelé à chaque fermeture de la fenêtre */
export const onDialogClose = (listener) => dialog.addEventListener("close", listener);

/**
 * Affiche une demande de confirmation et attend la réponse.
 *
 * @param {object} options
 * @param {string} options.title
 * @param {string} options.message
 * @param {string} [options.confirmLabel]
 * @param {string} [options.cancelLabel]
 * @param {boolean} [options.danger] bouton de confirmation en rouge, focus initial sur « Annuler »
 * @param {HTMLElement} [options.content] contenu affiché sous le message (un formulaire…)
 * @param {() => boolean} [options.canConfirm] la confirmation n'est possible que si elle renvoie true
 * @returns {Promise<boolean>} true si l'utilisateur confirme
 */
export function confirmDialog({
  title: heading, message: text, confirmLabel = "Confirmer", cancelLabel = "Annuler", danger = false,
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
