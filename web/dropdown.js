// @ts-check
// Menu déroulant réutilisable, ouvert sous (ou au-dessus d') un bouton : une liste d'actions.
//
// Le menu est posé sur la page (position fixe), pas dans le conteneur du bouton : une zone qui se
// redessine (la discussion relue toutes les 2 s) ne le referme pas, il suffit de lui redonner son bouton
// avec `reanchor`. Clavier : ↑ / ↓, Début / Fin, Entrée ; Échap ou Tab referme. Un clic à côté referme.

/**
 * @typedef {{label: string, icon?: string, onSelect: () => void, disabled?: boolean}} MenuAction
 * @typedef {MenuAction | "separator"} MenuItem
 *
 * @typedef {object} DropdownDeps
 * @property {(tag: string, className?: string, text?: string) => HTMLElement} el
 * @property {(d: string) => SVGElement} [icon] icône d'une action (tracé SVG 24×24)
 */

/**
 * @param {DropdownDeps} deps
 */
export function createDropdown({ el, icon }) {
  const menu = el("div", "dropdown-menu");
  menu.setAttribute("role", "menu");
  menu.hidden = true;
  document.body.append(menu);
  /** @type {HTMLElement | null} */
  let anchor = null;

  const items = () => /** @type {HTMLButtonElement[]} */ ([...menu.querySelectorAll("[role=menuitem]:not(:disabled)")]);

  /** Sous le bouton, aligné à droite ; au-dessus s'il n'y a pas la place en bas. */
  function place() {
    if (!anchor) return;
    const box = anchor.getBoundingClientRect();
    const height = menu.offsetHeight;
    const below = box.bottom + 4 + height <= window.innerHeight - 8;
    menu.style.top = `${Math.max(8, below ? box.bottom + 4 : box.top - 4 - height)}px`;
    menu.style.left = `${Math.max(8, Math.min(box.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8))}px`;
  }

  /** @param {boolean} [refocus] rendre le focus au bouton (fermeture au clavier ou après un choix) */
  function close(refocus = false) {
    if (menu.hidden) return;
    menu.hidden = true;
    anchor?.setAttribute("aria-expanded", "false");
    const previous = anchor;
    anchor = null;
    document.removeEventListener("pointerdown", onOutside, true);
    window.removeEventListener("resize", place);
    document.removeEventListener("scroll", onScroll, true);
    if (refocus && previous?.isConnected) previous.focus();
  }

  /** @param {PointerEvent} event */
  function onOutside(event) {
    const target = /** @type {Node} */ (event.target);
    if (!menu.contains(target) && !anchor?.contains(target)) close();
  }

  function onScroll() {
    if (anchor?.isConnected) place();
    else close();
  }

  menu.addEventListener("keydown", (event) => {
    const list = items();
    const index = list.indexOf(/** @type {HTMLButtonElement} */ (document.activeElement));
    const move = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: list.length - 1 }[event.key];
    if (move !== undefined && list.length) {
      event.preventDefault();
      list[(move + list.length) % list.length].focus();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation(); // Échap referme le menu, pas la carte qui le contient
      close(true);
    } else if (event.key === "Tab") {
      close();
    }
  });

  return {
    /**
     * Ouvre le menu sous `target` (ou le referme s'il y est déjà ouvert).
     *
     * @param {HTMLElement} target
     * @param {MenuItem[]} entries
     */
    toggle(target, entries) {
      if (anchor === target) {
        close(true);
        return;
      }
      close();
      menu.replaceChildren(...entries.map((entry) => {
        if (entry === "separator") {
          const line = el("div", "dropdown-separator");
          line.setAttribute("role", "separator");
          return line;
        }
        const button = /** @type {HTMLButtonElement} */ (el("button", "dropdown-item"));
        button.type = "button";
        button.setAttribute("role", "menuitem");
        button.disabled = Boolean(entry.disabled);
        if (entry.icon && icon) button.append(icon(entry.icon));
        button.append(el("span", "", entry.label));
        button.addEventListener("click", () => {
          close(true);
          entry.onSelect();
        });
        return button;
      }));
      anchor = target;
      target.setAttribute("aria-expanded", "true");
      menu.hidden = false;
      place();
      document.addEventListener("pointerdown", onOutside, true);
      window.addEventListener("resize", place);
      document.addEventListener("scroll", onScroll, true);
      items()[0]?.focus();
    },
    /**
     * Le bouton a été redessiné : le menu ouvert suit le nouveau, sans se refermer.
     *
     * @param {HTMLElement | null} target null : le bouton n'existe plus, le menu se referme
     */
    reanchor(target) {
      if (menu.hidden) return;
      if (!target) {
        close();
        return;
      }
      anchor = target;
      target.setAttribute("aria-expanded", "true");
      place();
    },
    close,
    isOpen: () => !menu.hidden,
  };
}
