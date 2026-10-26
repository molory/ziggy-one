// @ts-check
// Reusable dropdown menu, opened below (or above) a button: a list of actions.
//
// The menu is placed on the page (fixed position), not in the button's container: an area that
// redraws itself (the discussion re-read every 2 s) does not close it, it is enough to give it back its button
// with `reanchor`. Keyboard: ↑ / ↓, Home / End, Enter; Esc or Tab closes. A click outside closes.

/**
 * @typedef {{label: string, icon?: string, onSelect: () => void, disabled?: boolean}} MenuAction
 * @typedef {MenuAction | "separator"} MenuItem
 *
 * @typedef {object} DropdownDeps
 * @property {(tag: string, className?: string, text?: string) => HTMLElement} el
 * @property {(d: string) => SVGElement} [icon] icon of an action (24×24 SVG path)
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

  /** Below the button, right-aligned; above if there is no room below. */
  function place() {
    if (!anchor) return;
    const box = anchor.getBoundingClientRect();
    const height = menu.offsetHeight;
    const below = box.bottom + 4 + height <= window.innerHeight - 8;
    menu.style.top = `${Math.max(8, below ? box.bottom + 4 : box.top - 4 - height)}px`;
    menu.style.left = `${Math.max(8, Math.min(box.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8))}px`;
  }

  /** @param {boolean} [refocus] give the focus back to the button (closing by keyboard or after a choice) */
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
      event.stopPropagation(); // Esc closes the menu, not the card that contains it
      close(true);
    } else if (event.key === "Tab") {
      close();
    }
  });

  return {
    /**
     * Opens the menu below `target` (or closes it if it is already open there).
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
     * The button was redrawn: the open menu follows the new one, without closing.
     *
     * @param {HTMLElement | null} target null: the button no longer exists, the menu closes
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
