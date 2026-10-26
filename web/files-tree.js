// @ts-check
// Logique pure de l'onglet Fichiers (sans DOM, testée par tests/files-tree.test.mjs) : surlignage
// des recherches, fil d'Ariane, tailles, indentation dans l'éditeur.

/**
 * @typedef {{text: string, match: boolean}} Segment morceau de texte, surligné ou non
 */

/**
 * Positions des caractères de la requête retrouvés dans l'ordre dans le chemin (recherche floue), ou
 * null. On cherche d'abord dans le nom du fichier, plus parlant que les dossiers.
 *
 * @param {string} query
 * @param {string} path
 * @returns {number[] | null}
 */
export function fuzzyIndices(query, path) {
  const wanted = query.toLowerCase().replace(/\s+/g, "");
  if (!wanted) return [];
  const text = path.toLowerCase();
  /** @param {number} from */
  const scan = (from) => {
    const found = [];
    let at = from;
    for (const char of wanted) {
      at = text.indexOf(char, at);
      if (at < 0) return null;
      found.push(at++);
    }
    return found;
  };
  return scan(path.lastIndexOf("/") + 1) ?? scan(0);
}

/**
 * Découpe un texte en morceaux selon les positions à surligner (consécutives regroupées).
 *
 * @param {string} text
 * @param {number[] | null} indices
 * @returns {Segment[]}
 */
export function segmentsFromIndices(text, indices) {
  const marked = new Set(indices ?? []);
  /** @type {Segment[]} */
  const segments = [];
  for (let i = 0; i < text.length; i++) {
    const match = marked.has(i);
    const last = segments[segments.length - 1];
    if (last && last.match === match) last.text += text[i];
    else segments.push({ text: text[i], match });
  }
  return segments;
}

/**
 * Surligne toutes les occurrences de la requête dans le texte, sans tenir compte de la casse.
 *
 * @param {string} text
 * @param {string} query
 * @returns {Segment[]}
 */
export function highlightOccurrences(text, query) {
  if (!query) return text ? [{ text, match: false }] : [];
  const lower = text.toLowerCase();
  const needle = query.toLowerCase();
  /** @type {Segment[]} */
  const segments = [];
  let from = 0;
  for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, from)) {
    if (at > from) segments.push({ text: text.slice(from, at), match: false });
    segments.push({ text: text.slice(at, at + needle.length), match: true });
    from = at + needle.length;
  }
  if (from < text.length) segments.push({ text: text.slice(from), match: false });
  return segments;
}

/**
 * Fil d'Ariane d'un chemin relatif : chaque élément avec le chemin qui y mène.
 *
 * @param {string} file
 * @returns {{name: string, path: string}[]}
 */
export function breadcrumbs(file) {
  const parts = file.split("/").filter(Boolean);
  return parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join("/") }));
}

/**
 * Dossiers parents d'un fichier, du plus haut au plus proche : ceux à déplier pour le montrer.
 *
 * @param {string} file
 */
export function parentDirs(file) {
  return breadcrumbs(file).slice(0, -1).map((crumb) => crumb.path);
}

/**
 * Taille lisible, à la française : « 512 o », « 1,5 Ko », « 3,2 Mo ».
 *
 * @param {number} bytes
 */
export function formatSize(bytes) {
  const number = (/** @type {number} */ n) => n.toLocaleString("fr-FR", { maximumFractionDigits: 1 });
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${number(bytes / 1024)} Ko`;
  return `${number(bytes / (1024 * 1024))} Mo`;
}

/** @param {string} file */
export const isMarkdown = (file) => /\.(md|markdown|mdx)$/i.test(file);

/**
 * Regroupe les résultats de recherche dans le contenu par fichier, dans l'ordre d'arrivée.
 *
 * @param {{file: string, line: number, text: string}[]} results
 * @returns {{file: string, lines: {line: number, text: string}[]}[]}
 */
export function groupByFile(results) {
  /** @type {Map<string, {line: number, text: string}[]>} */
  const groups = new Map();
  for (const { file, line, text } of results) {
    if (!groups.has(file)) groups.set(file, []);
    groups.get(file)?.push({ line, text });
  }
  return [...groups].map(([file, lines]) => ({ file, lines }));
}

/**
 * Indentation du fichier : tabulation si ses lignes en commencent par une, sinon 2 ou 4 espaces.
 *
 * @param {string} text
 */
export function detectIndent(text) {
  let tabs = 0;
  let spaces = 0;
  let twos = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("\t")) tabs++;
    else {
      const width = /^ +(?=\S)/.exec(line)?.[0].length ?? 0;
      if (width) spaces++;
      if (width % 4 === 2) twos++;
    }
  }
  if (tabs > spaces) return "\t";
  return twos ? "  " : "    ";
}

/**
 * Touche Tab dans l'éditeur : insère une indentation au curseur, ou indente (désindente avec Maj)
 * toutes les lignes de la sélection. Renvoie le nouveau texte et la nouvelle sélection.
 *
 * @param {string} value
 * @param {number} start
 * @param {number} end
 * @param {boolean} outdent
 * @param {string} [unit] indentation (voir detectIndent)
 */
export function indentSelection(value, start, end, outdent, unit = "\t") {
  if (start === end && !outdent) {
    return { value: value.slice(0, start) + unit + value.slice(end), start: start + unit.length, end: start + unit.length };
  }
  const first = value.lastIndexOf("\n", start - 1) + 1;
  // Une sélection qui s'arrête en début de ligne n'inclut pas cette ligne.
  const stop = end > start && value[end - 1] === "\n" ? end - 1 : end;
  const lineEnd = value.indexOf("\n", stop);
  const last = lineEnd < 0 ? value.length : lineEnd;
  const lines = value.slice(first, last).split("\n");
  let startShift = 0;
  let total = 0;
  const changed = lines.map((line, i) => {
    let delta;
    let next;
    if (outdent) {
      const removed = line.startsWith("\t") ? 1 : (/^ {1,4}/.exec(line)?.[0].length ?? 0);
      next = line.slice(removed);
      delta = -removed;
    } else {
      next = unit + line;
      delta = unit.length;
    }
    if (i === 0) startShift = delta;
    total += delta;
    return next;
  });
  // Le début de sélection suit le texte, sauf s'il est en début de ligne (la ligne reste entière).
  const newStart = start === first && start !== end ? first : Math.max(first, start + startShift);
  return {
    value: value.slice(0, first) + changed.join("\n") + value.slice(last),
    start: newStart,
    end: start === end ? newStart : end + total,
  };
}
