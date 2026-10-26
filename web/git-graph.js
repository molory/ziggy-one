// @ts-check
// Graphe des branches de l'historique (façon Sourcetree). Sans DOM : testable avec Node.
//
// Les commits arrivent du plus récent au plus ancien. Chaque « couloir » (colonne) attend un commit :
// quand il apparaît, on dessine son point dans ce couloir, puis le couloir attend son premier parent ;
// ses autres parents (fusions) prennent un couloir libre, ou rejoignent celui qui les attend déjà.

/** @typedef {{hash: string, parents: string[]}} GraphCommit */
/** @typedef {{x1: number, y1: number, x2: number, y2: number, lane: number}} Segment */
/** @typedef {{lane: number, width: number, segments: Segment[]}} GraphRow */

/**
 * Une ligne de graphe par commit. Coordonnées en unités de couloir : x = n° de couloir,
 * y de 0 (haut de la ligne) à 1 (bas) ; le point du commit est en (lane, 0.5).
 *
 * @param {GraphCommit[]} commits
 * @returns {GraphRow[]}
 */
export function computeGraph(commits) {
  /** @type {(string | null)[]} hash attendu par chaque couloir */
  let lanes = [];
  return commits.map((commit) => {
    let lane = lanes.indexOf(commit.hash);
    if (lane === -1) {
      // Tête de branche : premier couloir libre.
      lane = lanes.indexOf(null);
      if (lane === -1) lane = lanes.length;
    }
    const before = [...lanes];
    before[lane] = commit.hash;
    /** @type {Segment[]} */
    const segments = [];

    // Moitié haute : les couloirs qui arrivent sur ce commit le rejoignent, les autres passent.
    before.forEach((expected, j) => {
      if (expected === null) return;
      if (expected === commit.hash) {
        if (j !== lane || lanes[lane] === commit.hash) segments.push({ x1: j, y1: 0, x2: lane, y2: 0.5, lane: j });
      } else {
        segments.push({ x1: j, y1: 0, x2: j, y2: 1, lane: j });
      }
    });

    // Le commit libère les couloirs qui l'attendaient ; son couloir attend désormais son premier parent.
    const after = before.map((expected) => (expected === commit.hash ? null : expected));
    commit.parents.forEach((parent, index) => {
      let target;
      if (index === 0) {
        target = lane;
      } else {
        target = after.indexOf(parent);
        if (target === -1) {
          target = after.indexOf(null);
          if (target === -1 || target === lane) target = after.length;
        }
      }
      after[target] = parent;
      // Moitié basse : du point du commit vers le couloir de chaque parent.
      segments.push({ x1: lane, y1: 0.5, x2: target, y2: 1, lane: target });
    });

    while (after.length && after[after.length - 1] === null) after.pop();
    lanes = after;
    const width = Math.max(before.length, after.length, lane + 1);
    return { lane, width, segments };
  });
}
