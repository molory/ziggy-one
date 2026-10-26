// @ts-check
// Section « Avatar » de la configuration d'un agent : abréviation, puis Initiales, Animal ou Image (glissée,
// choisie sur le disque ou collée, recadrée ici en carré de 256 px avant l'envoi). Chaque choix est
// enregistré aussitôt, comme les réglages de Claude.

import { ANIMALS, animalImage, avatarLook, clipAbbr, fillAvatar, foldText, isApprox } from "./avatars.js";

const CROP = 176; // côté du cadre de recadrage, en px (le même qu'en CSS)
const OUTPUT = 256; // côté de l'image enregistrée
const MAX_SOURCE = 20_000_000;
const ACCEPTED = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const TABS = /** @type {const} */ ([["letters", "Initiales"], ["animal", "Animal"], ["image", "Image"]]);

/**
 * @typedef {{abbr?: string, kind?: string, animal?: string, image?: string}} Avatar
 *
 * @typedef {object} AvatarInfo
 * @property {Avatar} avatar avatar enregistré
 * @property {string} fallback lettre par défaut, quand l'abréviation est vide
 * @property {string | null} ownAnimal l'animal du nom généré de l'agent
 * @property {string[]} suggestions abréviations proposées
 *
 * @typedef {object} AvatarEditorDeps
 * @property {(tag: string, className?: string, text?: string) => HTMLElement} el
 * @property {(avatar: Avatar, image?: string) => Promise<void>} save image : base64 d'une nouvelle image
 * @property {(err: unknown) => void} onError
 */

/** @param {Blob} blob @returns {Promise<string>} */
const readAsDataUrl = (blob) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Image illisible."));
    reader.readAsDataURL(blob);
  });

/** @param {HTMLCanvasElement} canvas @param {string} type @returns {Promise<Blob | null>} */
const toBlob = (canvas, type) => new Promise((resolve) => canvas.toBlob(resolve, type, 0.9));

/** @param {AvatarEditorDeps} deps */
export function createAvatarEditor({ el, save, onError }) {
  /** @type {AvatarInfo} */
  let info = { avatar: {}, fallback: "?", ownAnimal: null, suggestions: [] };
  /** @type {"letters" | "animal" | "image" | null} */
  let tab = null;

  const button = (/** @type {string} */ className, /** @type {string} */ text) => {
    const node = /** @type {HTMLButtonElement} */ (el("button", className, text));
    node.type = "button";
    return node;
  };
  const run = (/** @type {Avatar} */ avatar, /** @type {string} */ image = undefined) => save(avatar, image).catch(onError);
  // Ce qui est enregistré, à modifier : un changement d'abréviation garde l'animal ou l'image.
  const current = () => ({ abbr: info.avatar.abbr, kind: info.avatar.kind ?? "letters", animal: info.avatar.animal });

  const node = el("div", "settings-section avatar-section");
  node.append(el("h3", "settings-title", "Avatar"));
  const layout = el("div", "avatar-editor");

  // Grand aperçu, avec ce qu'il montre.
  const preview = el("div", "avatar-preview");
  const big = el("span", "agent-avatar avatar-big");
  big.setAttribute("aria-hidden", "true");
  const caption = el("p", "muted small");
  preview.append(big, caption);

  const controls = el("div", "avatar-controls");

  // Abréviation : enregistrée en quittant le champ ou avec Entrée.
  const abbrForm = el("form", "avatar-abbr");
  const abbrLabel = el("label", "settings-field-label", "Abréviation");
  abbrLabel.setAttribute("for", "agent-abbr");
  const abbrInput = /** @type {HTMLInputElement} */ (el("input", "text-input abbr-input"));
  Object.assign(abbrInput, { id: "agent-abbr", autocomplete: "off", spellcheck: false });
  const chips = el("div", "abbr-chips");
  abbrForm.append(abbrLabel, abbrInput, chips);
  const commitAbbr = () => {
    const abbr = clipAbbr(abbrInput.value);
    abbrInput.value = abbr;
    if (abbr !== (info.avatar.abbr ?? "")) run({ ...current(), abbr });
  };
  abbrInput.addEventListener("input", () => {
    const clipped = clipAbbr(abbrInput.value);
    if (clipped !== abbrInput.value) abbrInput.value = clipped;
  });
  abbrInput.addEventListener("change", commitAbbr);
  abbrForm.addEventListener("submit", (event) => {
    event.preventDefault();
    commitAbbr();
  });
  const abbrHint = el("p", "muted small", "1 ou 2 caractères : lettres, chiffres ou un emoji. Vide : la première lettre du nom.");

  // Type d'avatar.
  const tabs = el("div", "segmented avatar-tabs");
  tabs.setAttribute("role", "radiogroup");
  tabs.setAttribute("aria-label", "Type d'avatar");
  /** @type {Record<string, HTMLInputElement>} */
  const radios = {};
  /** @type {Record<string, HTMLElement>} */
  const panes = {};
  for (const [value, label] of TABS) {
    const option = el("label");
    const radio = /** @type {HTMLInputElement} */ (el("input"));
    Object.assign(radio, { type: "radio", name: "agent-avatar-kind", value });
    radio.addEventListener("change", () => showTab(value));
    option.append(radio, el("span", "", label));
    tabs.append(option);
    radios[value] = radio;
    panes[value] = el("div", "avatar-pane");
  }

  // Initiales.
  const useLetters = button("", "Utiliser les initiales");
  useLetters.addEventListener("click", () => run({ abbr: info.avatar.abbr, kind: "letters" }));
  panes.letters.append(el("p", "muted small", "L'abréviation, sur la couleur de l'agent."), useLetters);

  // Animal : celui de son nom en raccourci, puis tous, avec une recherche.
  const animalHead = el("div", "animal-head");
  const own = button("animal-own", "");
  const ownImage = /** @type {HTMLImageElement} */ (el("img"));
  ownImage.alt = "";
  const ownText = el("span", "animal-own-text");
  own.append(ownImage, ownText);
  own.addEventListener("click", () => info.ownAnimal && run({ ...current(), kind: "animal", animal: info.ownAnimal }));
  const search = /** @type {HTMLInputElement} */ (el("input", "text-input"));
  Object.assign(search, { type: "search", placeholder: "Chercher un animal…", autocomplete: "off" });
  search.setAttribute("aria-label", "Chercher un animal");
  animalHead.append(own, search);
  const grid = el("div", "animal-grid");
  const noAnimal = el("p", "muted small", "Aucun animal ne correspond.");
  noAnimal.hidden = true;
  /** @type {Map<string, HTMLButtonElement>} */
  const tiles = new Map();
  for (const animal of ANIMALS) {
    const tile = button("animal-tile", "");
    const image = /** @type {HTMLImageElement} */ (el("img"));
    Object.assign(image, { src: animalImage(animal.name), alt: "", loading: "lazy", draggable: false });
    tile.append(image, el("span", "animal-name", animal.name));
    tile.title = animal.approx ? `${animal.name} (image approchée)` : animal.name;
    tile.addEventListener("click", () => run({ ...current(), kind: "animal", animal: animal.name }));
    tiles.set(animal.name, tile);
    grid.append(tile);
  }
  search.addEventListener("input", () => {
    const query = foldText(search.value.trim());
    let shown = 0;
    for (const [name, tile] of tiles) {
      tile.hidden = Boolean(query) && !foldText(name).includes(query);
      if (!tile.hidden) shown += 1;
    }
    noAnimal.hidden = shown > 0;
  });
  const gridBox = el("div", "animal-grid-box");
  gridBox.append(grid, noAnimal);
  panes.animal.append(animalHead, gridBox);

  // Image : dépôt (glisser, parcourir, coller), puis recadrage.
  const drop = el("label", "avatar-drop");
  const file = /** @type {HTMLInputElement} */ (el("input", "visually-hidden"));
  Object.assign(file, { type: "file", accept: ACCEPTED.join(",") });
  drop.append(
    file,
    el("strong", "", "Glisser une image ici"),
    el("span", "muted small", "ou cliquer pour parcourir le disque · coller avec Ctrl+V"),
    el("span", "muted small", "PNG, JPEG, WebP ou GIF · recadrée en carré"),
  );
  file.addEventListener("change", () => {
    if (file.files?.[0]) loadImage(file.files[0]);
    file.value = "";
  });
  drop.addEventListener("dragover", (event) => {
    event.preventDefault();
    drop.classList.add("dragging");
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("dragging"));
  drop.addEventListener("drop", (event) => {
    event.preventDefault();
    drop.classList.remove("dragging");
    const dropped = event.dataTransfer?.files[0];
    if (dropped) loadImage(dropped);
  });
  const removeImage = button("link-button", "Retirer l'image");
  removeImage.addEventListener("click", () => run({ abbr: info.avatar.abbr, kind: "letters" }));

  const crop = el("div", "avatar-crop-editor");
  crop.hidden = true;
  const frame = el("div", "avatar-crop");
  frame.tabIndex = 0;
  frame.setAttribute("aria-label", "Recadrage : glisser ou flèches pour déplacer, molette pour zoomer");
  const cropImage = /** @type {HTMLImageElement} */ (el("img"));
  cropImage.alt = "";
  cropImage.draggable = false;
  frame.append(cropImage, el("span", "avatar-crop-mask"));
  const cropSide = el("div", "avatar-crop-side");
  const zoomLabel = el("label", "settings-field-label", "Zoom");
  zoomLabel.setAttribute("for", "agent-avatar-zoom");
  const zoom = /** @type {HTMLInputElement} */ (el("input", "avatar-zoom"));
  Object.assign(zoom, { id: "agent-avatar-zoom", type: "range", min: "1", max: "4", step: "0.01", value: "1" });
  const useImage = button("primary", "Utiliser cette image");
  const cancelImage = button("", "Annuler");
  const cropActions = el("div", "avatar-crop-actions");
  cropActions.append(useImage, cancelImage);
  cropSide.append(zoomLabel, zoom, el("p", "muted small", "Glisser l'image pour la centrer dans le cercle."), cropActions);
  crop.append(frame, cropSide);
  panes.image.append(drop, removeImage, crop);

  layout.append(preview, controls);
  const reset = button("link-button", "Revenir à l'avatar par défaut");
  reset.addEventListener("click", () => run({}));
  controls.append(abbrForm, abbrHint, tabs, ...Object.values(panes), reset);
  node.append(layout);

  // --- recadrage ---------------------------------------------------------------------------
  // L'image couvre toujours le cadre : (x, y) est son coin haut gauche dans le cadre, ≤ 0.
  let cropX = 0;
  let cropY = 0;
  const scale = () => (CROP / Math.min(cropImage.naturalWidth, cropImage.naturalHeight)) * Number(zoom.value);

  function layoutCrop() {
    const s = scale();
    const width = cropImage.naturalWidth * s;
    const height = cropImage.naturalHeight * s;
    cropX = Math.min(0, Math.max(CROP - width, cropX));
    cropY = Math.min(0, Math.max(CROP - height, cropY));
    cropImage.style.width = `${width}px`;
    cropImage.style.height = `${height}px`;
    cropImage.style.transform = `translate(${cropX}px, ${cropY}px)`;
  }

  /** Zoom autour du centre du cadre. @param {number} value */
  function setZoom(value) {
    const before = scale();
    const centerX = (CROP / 2 - cropX) / before;
    const centerY = (CROP / 2 - cropY) / before;
    zoom.value = String(Math.min(4, Math.max(1, value)));
    cropX = CROP / 2 - centerX * scale();
    cropY = CROP / 2 - centerY * scale();
    layoutCrop();
  }

  zoom.addEventListener("input", () => setZoom(Number(zoom.value)));
  frame.addEventListener("wheel", (event) => {
    event.preventDefault();
    setZoom(Number(zoom.value) * (event.deltaY < 0 ? 1.1 : 1 / 1.1));
  }, { passive: false });
  frame.addEventListener("pointerdown", (event) => {
    frame.setPointerCapture(event.pointerId);
    let lastX = event.clientX;
    let lastY = event.clientY;
    const move = (/** @type {PointerEvent} */ moved) => {
      cropX += moved.clientX - lastX;
      cropY += moved.clientY - lastY;
      lastX = moved.clientX;
      lastY = moved.clientY;
      layoutCrop();
    };
    const end = () => {
      frame.removeEventListener("pointermove", move);
      frame.removeEventListener("pointerup", end);
      frame.removeEventListener("pointercancel", end);
    };
    frame.addEventListener("pointermove", move);
    frame.addEventListener("pointerup", end);
    frame.addEventListener("pointercancel", end);
  });
  frame.addEventListener("keydown", (event) => {
    const moves = { ArrowLeft: [8, 0], ArrowRight: [-8, 0], ArrowUp: [0, 8], ArrowDown: [0, -8] };
    const delta = moves[/** @type {keyof typeof moves} */ (event.key)];
    if (!delta) return;
    event.preventDefault();
    cropX += delta[0];
    cropY += delta[1];
    layoutCrop();
  });

  /** @param {File} source */
  async function loadImage(source) {
    try {
      if (!ACCEPTED.includes(source.type)) throw new Error("Format non pris en charge : PNG, JPEG, WebP ou GIF.");
      if (source.size > MAX_SOURCE) throw new Error("Image trop lourde (20 Mo au plus).");
      cropImage.src = await readAsDataUrl(source);
      await cropImage.decode();
      zoom.value = "1";
      const s = scale(); // image centrée
      cropX = (CROP - cropImage.naturalWidth * s) / 2;
      cropY = (CROP - cropImage.naturalHeight * s) / 2;
      layoutCrop();
      showTab("image");
      crop.hidden = false;
      drop.hidden = true;
      removeImage.hidden = true;
      frame.focus();
    } catch (err) {
      onError(err instanceof DOMException ? new Error("Image illisible.") : err); // decode() : format abîmé
    }
  }

  function closeCrop() {
    crop.hidden = true;
    cropImage.removeAttribute("src");
    refresh();
  }

  cancelImage.addEventListener("click", closeCrop);
  useImage.addEventListener("click", async () => {
    useImage.disabled = true;
    try {
      const canvas = document.createElement("canvas");
      canvas.width = OUTPUT;
      canvas.height = OUTPUT;
      const context = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
      context.imageSmoothingQuality = "high";
      const s = scale();
      context.drawImage(cropImage, -cropX / s, -cropY / s, CROP / s, CROP / s, 0, 0, OUTPUT, OUTPUT);
      let blob = await toBlob(canvas, "image/webp");
      if (!blob || blob.type !== "image/webp") blob = await toBlob(canvas, "image/png");
      if (!blob) throw new Error("Image impossible à préparer.");
      const base64 = (await readAsDataUrl(blob)).split(",")[1];
      await save({ abbr: info.avatar.abbr, kind: "image" }, base64);
      closeCrop();
    } catch (err) {
      onError(err);
    } finally {
      useImage.disabled = false;
    }
  });

  // Coller une image (Ctrl+V) quand l'onglet Image est ouvert.
  const onPaste = (/** @type {ClipboardEvent} */ event) => {
    if (!node.isConnected) {
      document.removeEventListener("paste", onPaste);
      return;
    }
    const pasted = [...(event.clipboardData?.files ?? [])].find((item) => item.type.startsWith("image/"));
    if (tab !== "image" || !pasted) return;
    event.preventDefault();
    loadImage(pasted);
  };
  document.addEventListener("paste", onPaste);

  // --- affichage -----------------------------------------------------------------------------

  /** @param {"letters" | "animal" | "image"} value */
  function showTab(value) {
    tab = value;
    radios[value].checked = true;
    for (const [name, pane] of Object.entries(panes)) pane.hidden = name !== value;
  }

  function refresh() {
    const { avatar, fallback, ownAnimal, suggestions } = info;
    const kind = avatar.kind ?? "letters";
    const look = avatarLook(avatar, fallback);
    fillAvatar(big, look);
    caption.textContent = look.kind === "animal"
      ? `${avatar.animal}${isApprox(avatar.animal ?? "") ? " · image approchée" : ""}`
      : look.kind === "image" ? "Image choisie" : `Initiales « ${look.text} »`;

    abbrInput.placeholder = fallback;
    if (document.activeElement !== abbrInput) abbrInput.value = avatar.abbr ?? "";
    chips.replaceChildren(...suggestions.map((suggestion) => {
      const chip = button("abbr-chip", suggestion);
      chip.setAttribute("aria-pressed", String(suggestion === avatar.abbr));
      chip.addEventListener("click", () => {
        abbrInput.value = suggestion;
        commitAbbr();
      });
      return chip;
    }));

    useLetters.hidden = kind === "letters";
    reset.hidden = Object.keys(avatar).length === 0;
    own.hidden = !ownAnimal;
    if (ownAnimal) {
      ownImage.src = animalImage(ownAnimal);
      ownText.replaceChildren(el("strong", "", ownAnimal), el("span", "muted small", "l'animal de son nom"));
      own.setAttribute("aria-pressed", String(kind === "animal" && avatar.animal === ownAnimal));
    }
    for (const [name, tile] of tiles) tile.setAttribute("aria-pressed", String(kind === "animal" && avatar.animal === name));
    if (crop.hidden) {
      drop.hidden = false;
      removeImage.hidden = kind !== "image";
    }
  }

  return {
    node,
    /** @param {AvatarInfo} next */
    update(next) {
      info = next;
      if (tab === null) showTab(/** @type {"letters" | "animal" | "image"} */ (TABS.some(([v]) => v === next.avatar.kind) ? next.avatar.kind : "letters"));
      refresh();
    },
  };
}
