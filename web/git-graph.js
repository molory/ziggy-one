// @ts-check
// Branch graph of the history (Sourcetree style). No DOM: testable with Node.
//
// Commits arrive from newest to oldest. Each "lane" (column) waits for a commit: when it shows up, its dot
// is drawn in that lane, then the lane waits for its first parent; its other parents (merges) take a free
// lane, or join the one already waiting for them.

/** @typedef {{hash: string, parents: string[]}} GraphCommit */
/** @typedef {{x1: number, y1: number, x2: number, y2: number, lane: number}} Segment */
/** @typedef {{lane: number, width: number, segments: Segment[]}} GraphRow */

/**
 * One graph row per commit. Coordinates in lane units: x = lane number,
 * y from 0 (top of the row) to 1 (bottom); the commit dot is at (lane, 0.5).
 *
 * @param {GraphCommit[]} commits
 * @returns {GraphRow[]}
 */
export function computeGraph(commits) {
  /** @type {(string | null)[]} hash awaited by each lane */
  let lanes = [];
  return commits.map((commit) => {
    let lane = lanes.indexOf(commit.hash);
    if (lane === -1) {
      // Branch head: first free lane.
      lane = lanes.indexOf(null);
      if (lane === -1) lane = lanes.length;
    }
    const before = [...lanes];
    before[lane] = commit.hash;
    /** @type {Segment[]} */
    const segments = [];

    // Top half: lanes arriving at this commit join it, the others pass through.
    before.forEach((expected, j) => {
      if (expected === null) return;
      if (expected === commit.hash) {
        if (j !== lane || lanes[lane] === commit.hash) segments.push({ x1: j, y1: 0, x2: lane, y2: 0.5, lane: j });
      } else {
        segments.push({ x1: j, y1: 0, x2: j, y2: 1, lane: j });
      }
    });

    // The commit frees the lanes that awaited it; its own lane now awaits its first parent.
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
      // Bottom half: from the commit dot to the lane of each parent.
      segments.push({ x1: lane, y1: 0.5, x2: target, y2: 1, lane: target });
    });

    while (after.length && after[after.length - 1] === null) after.pop();
    lanes = after;
    const width = Math.max(before.length, after.length, lane + 1);
    return { lane, width, segments };
  });
}
