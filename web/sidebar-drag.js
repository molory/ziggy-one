// @ts-check
// Drag and drop in the agent list (the browser's native drag and drop, no library), and the same
// moves with the keyboard: Alt + ↑/↓ on a row. The rules (which zone accepts what, what a drop
// changes) are in sidebar-order.js; this module only follows the pointer and shows where the item
// will land: an insertion line between two rows, or a highlighted workspace to drop into.
//
// The list is redrawn often (live states): app.js calls reset() before each drawing, then declares
// each row and each workspace; the row that had the keyboard focus gets it back. During a drag, the
// list must not be redrawn (see `dragging`).

import { accepts, containerZone, stepBefore } from "./sidebar-order.js";

const DRAG_TYPE = "application/x-ziggy-agent-list";
/** Height (px) of the top edge of a workspace header where an agent is placed before the workspace, not into it. */
const HEADER_EDGE = 8;

/**
 * @typedef {import("./sidebar-order.js").DragItem} DragItem
 * @typedef {import("./sidebar-order.js").Zone} Zone
 * @typedef {{item: DragItem, zone: Zone, key: string}} RowInfo `key`: the row's key in its zone's order
 * @typedef {{zone: Zone, before: string | null}} Target
 */

/**
 * @param {HTMLElement} list the agent list (<ul>)
 * @param {{onDrop: (item: DragItem, zone: Zone, before: string | null, order: string[]) => void,
 *   onEnd: () => void}} handlers `onDrop`: a move to apply; `onEnd`: the drag is over (redraw if needed)
 */
export function createSidebarDrag(list, { onDrop, onEnd }) {
  /** @type {Map<Element, RowInfo>} */
  let rows = new Map();
  /** @type {Map<Element, HTMLElement>} button of each row that receives Alt + ↑/↓ */
  let focusables = new Map();
  /** @type {Map<Element, string>} workspace blocks: a drop on one of them puts an agent into it */
  let containers = new Map();
  /** @type {{element: HTMLElement, info: RowInfo} | null} */
  let dragged = null;
  /** @type {Target | null} */
  let target = null;
  /** @type {string | null} row ("zone key") that gets the focus back once redrawn */
  let refocus = null;
  const rowId = (/** @type {RowInfo} */ info) => `${info.zone.id} ${info.key}`;
  const line = document.createElement("li");
  line.className = "drop-line";
  line.setAttribute("aria-hidden", "true");

  /** Rows of a zone, in the order on screen. */
  const zoneRows = (/** @type {string} */ zoneId) => [...rows].filter(([, info]) => info.zone.id === zoneId);
  const orderOf = (/** @type {string} */ zoneId) => zoneRows(zoneId).map(([, info]) => info.key);

  /** Closest declared ancestor (row or workspace block) of a node, up to the list. */
  function closest(/** @type {Element | null} */ node, /** @type {Map<Element, any>} */ map) {
    for (let current = node; current && current !== list; current = current.parentElement) {
      if (map.has(current)) return current;
    }
    return null;
  }

  function clearIndicator() {
    line.remove();
    for (const node of list.querySelectorAll(".drop-into")) node.classList.remove("drop-into");
  }

  /**
   * Where the dragged item would land under the pointer, and shows it.
   *
   * @param {Element} hovered
   * @param {number} y
   * @returns {Target | null}
   */
  function locate(hovered, y) {
    if (!dragged) return null;
    const { item } = dragged.info;
    const row = closest(hovered, rows);
    const rowInfo = row ? rows.get(row) : undefined;
    const block = closest(hovered, containers);
    const workspace = block ? /** @type {string} */ (containers.get(block)) : null;
    // An agent on a workspace's header goes into it, except on its top edge (to place it before the
    // workspace). Otherwise: between two rows of a zone that accepts the item, or else in the zone of
    // the hovered container.
    const onHeader = item.kind === "agent" && block !== null && hovered.closest(".workspace-head") !== null &&
      y > block.getBoundingClientRect().top + HEADER_EDGE;
    /** @type {Zone} */
    let zone;
    if (onHeader) zone = containerZone(item, workspace);
    else if (rowInfo && accepts(rowInfo.zone, item)) zone = rowInfo.zone;
    else zone = containerZone(item, item.kind === "agent" ? workspace : null);
    clearIndicator();
    const candidates = zoneRows(zone.id).filter(([element]) => element !== dragged?.element);
    // Into a workspace (its header, or no row of that kind shown in it): at the end.
    if (zone.workspace !== null && (onHeader || candidates.length === 0)) {
      block?.classList.add("drop-into");
      return { zone, before: null };
    }
    if (zone.kind === "loose") {
      // Sorted by date: no place to choose. The line shows that it goes back to the general list.
      const first = candidates[0]?.[0];
      if (first) first.before(line);
      else list.append(line);
      return { zone, before: null };
    }
    if (candidates.length === 0) {
      list.prepend(line);
      return { zone, before: null };
    }
    const index = candidates.findIndex(([element]) => {
      const box = element.getBoundingClientRect();
      return y < box.top + box.height / 2;
    });
    if (index === -1) candidates[candidates.length - 1][0].after(line);
    else candidates[index][0].before(line);
    return { zone, before: index === -1 ? null : candidates[index][1].key };
  }

  list.addEventListener("dragover", (event) => {
    if (!dragged || !event.dataTransfer?.types.includes(DRAG_TYPE)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    if (event.target instanceof Element && event.target !== line) target = locate(event.target, event.clientY);
  });
  list.addEventListener("dragleave", (event) => {
    // Out of the list (not just from one row to the next): no drop point any more.
    if (dragged && !(event.relatedTarget instanceof Node && list.contains(event.relatedTarget))) {
      clearIndicator();
      target = null;
    }
  });
  list.addEventListener("drop", (event) => {
    if (!dragged || !event.dataTransfer?.types.includes(DRAG_TYPE)) return;
    event.preventDefault();
    const { item } = dragged.info;
    const chosen = target;
    clearIndicator();
    if (chosen) onDrop(item, chosen.zone, chosen.before, orderOf(chosen.zone.id));
  });

  return {
    /** A drag is in progress: the list must not be redrawn under the pointer. */
    get dragging() {
      return dragged !== null;
    },

    /** Before each drawing of the list: forgets the previous rows (remembering the focused one). */
    reset() {
      for (const [element, button] of focusables) {
        const info = rows.get(element);
        if (info && button === document.activeElement) refocus = rowId(info);
      }
      rows = new Map();
      focusables = new Map();
      containers = new Map();
    },

    /**
     * Declares a row that can be moved.
     *
     * @param {HTMLElement} element the row (its place in the list)
     * @param {HTMLElement} handle what is grabbed (the row, or the header of a workspace)
     * @param {HTMLElement} focusable button that receives Alt + ↑/↓
     * @param {RowInfo} info
     */
    row(element, handle, focusable, info) {
      rows.set(element, info);
      focusables.set(element, focusable);
      if (refocus === rowId(info)) {
        refocus = null;
        queueMicrotask(() => focusable.focus()); // once the new list is in the page
      }
      handle.draggable = true;
      handle.addEventListener("dragstart", (event) => {
        // Grabbed from this handle (or an image in it), not from a nested row that moves on its own.
        if (!event.dataTransfer || !(event.target instanceof Element) || event.target.closest("[draggable=true]") !== handle) return;
        dragged = { element, info };
        target = null;
        event.dataTransfer.setData(DRAG_TYPE, info.key);
        event.dataTransfer.effectAllowed = "move";
        // On the next frame: the browser has already taken the image of the dragged row.
        requestAnimationFrame(() => {
          element.classList.add("dragging");
          list.classList.add("sorting");
        });
      });
      handle.addEventListener("dragend", () => {
        element.classList.remove("dragging");
        list.classList.remove("sorting");
        clearIndicator();
        dragged = null;
        target = null;
        onEnd();
      });
      if (info.zone.kind === "loose") return; // sorted by date: nothing to move with the keyboard
      focusable.setAttribute("aria-keyshortcuts", "Alt+ArrowUp Alt+ArrowDown");
      focusable.addEventListener("keydown", (event) => {
        if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
        event.preventDefault();
        const current = rows.get(element);
        if (!current) return;
        const order = orderOf(current.zone.id);
        const before = stepBefore(order, current.key, event.key === "ArrowUp" ? -1 : 1);
        if (before === undefined) return;
        refocus = rowId(current);
        onDrop(current.item, current.zone, before, order);
      });
    },

    /**
     * Declares a workspace block: an agent dropped on it (its header, or anywhere when it shows no
     * agent of that kind) goes into it.
     *
     * @param {HTMLElement} element
     * @param {string} workspace
     */
    container(element, workspace) {
      containers.set(element, workspace);
    },
  };
}
