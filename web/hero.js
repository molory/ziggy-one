// @ts-check
// Écran d'accueil (aucun agent ouvert) : Ziggy en chef d'orchestre. L'emblème Z au centre, tes agents qui
// gravitent autour sur trois orbites inclinées (devant / derrière, en 3D), reliés par des faisceaux où passent
// des « notes » : les consignes du chef d'orchestre. Puis le titre et les deux boutons pour créer.
// SVG et JavaScript, sans bibliothèque. Sans animation si le système le demande ; en pause onglet caché.

const SVG = "http://www.w3.org/2000/svg";
const ORBITS = [
  { rx: 118, ry: 40, tilt: -18, speed: 0.32 },
  { rx: 176, ry: 60, tilt: 14, speed: -0.22 },
  { rx: 232, ry: 78, tilt: -6, speed: 0.15 },
];
const MAX_AGENTS = 12;

/**
 * @typedef {{letter: string, hue: number, state: string}} HeroAgent
 * @typedef {object} HeroOptions
 * @property {(tag: string, className?: string, text?: string) => HTMLElement} el
 * @property {(d: string) => SVGElement} icon
 * @property {{agent: string, workspace: string}} icons
 * @property {HeroAgent[]} agents tes agents (actifs d'abord) : ils gravitent autour de Ziggy
 * @property {string} stats ligne de chiffres sous le titre
 * @property {() => void} onAgent
 * @property {() => void} onWorkspace
 */

/**
 * @param {string} tag
 * @param {Record<string, string | number>} [attrs]
 */
function svg(tag, attrs = {}) {
  const node = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

/**
 * Construit l'écran et lance l'animation ; elle s'arrête d'elle-même quand l'écran quitte la page.
 *
 * @param {HeroOptions} options
 * @returns {HTMLElement}
 */
export function createHero(options) {
  const { el } = options;
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  const root = el("div", `hero${reduced ? " reduced" : ""}`);

  // Fond : une aurore de taches colorées qui dérivent.
  const aurora = el("div", "hero-aurora");
  aurora.setAttribute("aria-hidden", "true");
  aurora.append(el("span", "blob b1"), el("span", "blob b2"), el("span", "blob b3"));

  // Scène : orbites, faisceaux, agents, emblème.
  const stage = el("div", "hero-stage");
  stage.setAttribute("aria-hidden", "true");
  const scene = svg("svg", { viewBox: "-300 -150 600 300", class: "hero-scene" });
  const defs = svg("defs");
  defs.innerHTML = `
    <linearGradient id="hero-z" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="var(--hero-a)"/><stop offset="1" stop-color="var(--hero-b)"/>
    </linearGradient>
    <radialGradient id="hero-glow"><stop offset="0" stop-color="var(--hero-a)" stop-opacity=".55"/>
      <stop offset="1" stop-color="var(--hero-a)" stop-opacity="0"/></radialGradient>
`;
  scene.append(defs);
  const orbitLayer = svg("g", { class: "hero-orbits" });
  for (const orbit of ORBITS) {
    orbitLayer.append(svg("ellipse", { rx: orbit.rx, ry: orbit.ry, transform: `rotate(${orbit.tilt})`, class: "hero-orbit" }));
  }
  const back = svg("g");
  const beams = svg("g", { class: "hero-beams" });
  const front = svg("g");
  // Emblème : halo, anneau qui tourne, carré dégradé, Z.
  const emblem = svg("g", { class: "hero-emblem" });
  emblem.append(
    svg("circle", { r: 70, fill: "url(#hero-glow)", class: "hero-halo" }),
    svg("circle", { r: 46, class: "hero-ring" }),
    svg("rect", { x: -32, y: -32, width: 64, height: 64, rx: 16, fill: "url(#hero-z)", class: "hero-tile" }),
  );
  const z = svg("text", { x: 0, y: 1, class: "hero-z" });
  z.textContent = "Z";
  emblem.append(z);
  // Parallaxe par plans, en déplacements 2D dans le SVG (le dessin reste vectoriel, donc net) : les orbites
  // et les agents bougent plus que l'emblème. Chaque plan a son groupe : les animations CSS des éléments
  // (apparition de l'emblème, ouverture des orbites) n'entrent pas en conflit avec ce déplacement.
  const farPlane = svg("g");
  farPlane.append(orbitLayer, back, beams);
  const emblemPlane = svg("g");
  emblemPlane.append(emblem);
  const nearPlane = svg("g");
  nearPlane.append(front);
  scene.append(farPlane, emblemPlane, nearPlane);
  stage.append(scene);

  // Agents : répartis sur les orbites, chacun avec sa couleur, son initiale et son état.
  const agents = options.agents.slice(0, MAX_AGENTS).map((agent, index) => {
    const orbit = ORBITS[index % ORBITS.length];
    const onOrbit = Math.floor(index / ORBITS.length);
    const perOrbit = Math.ceil(Math.min(options.agents.length, MAX_AGENTS) / ORBITS.length) || 1;
    const node = svg("g", { class: `hero-agent state-${agent.state}` });
    const color = `hsl(${agent.hue} 62% 52%)`;
    node.append(svg("circle", { r: 15, fill: color, class: "hero-agent-disc" }));
    const letter = svg("text", { class: "hero-agent-letter", y: 1 });
    letter.textContent = agent.letter;
    node.append(letter);
    if (agent.state === "busy" || agent.state === "waiting") node.append(svg("circle", { r: 15, class: "hero-agent-pulse" }));
    const beam = svg("line", { class: "hero-beam", stroke: color });
    const note = svg("circle", { r: 2.4, fill: color, stroke: color, class: "hero-note" });
    beams.append(beam, note);
    return { node, beam, note, orbit, phase: (onOrbit / perOrbit) * Math.PI * 2 + index * 0.7, delay: 0.45 + index * 0.06 };
  });

  // Texte et boutons.
  const copy = el("div", "hero-copy");
  const title = el("h2", "hero-title");
  [..."Ziggy One"].forEach((char, i) => {
    const span = el("span", "", char === " " ? " " : char);
    span.style.setProperty("--i", String(i));
    title.append(span);
  });
  copy.append(title, el("p", "hero-tagline", "Agent cockpit"));
  if (options.stats) copy.append(el("p", "hero-stats", options.stats));
  const actions = el("div", "hero-actions");
  const make = (/** @type {string} */ label, /** @type {string} */ sub, /** @type {string} */ path, /** @type {string} */ kind, /** @type {() => void} */ onClick) => {
    const button = el("button", `hero-button ${kind}`);
    /** @type {HTMLButtonElement} */ (button).type = "button";
    const iconBox = el("span", "hero-button-icon");
    iconBox.append(options.icon(path));
    const text = el("span", "hero-button-text");
    text.append(el("strong", "", label), el("span", "", sub));
    button.append(iconBox, text);
    button.addEventListener("click", onClick);
    return button;
  };
  actions.append(
    make("Nouvel agent", "Claude Code dans le dossier de ton choix", options.icons.agent, "primary-hero", options.onAgent),
    make("Nouveau workspace", "Un groupe pour ranger tes agents", options.icons.workspace, "ghost-hero", options.onWorkspace),
  );
  copy.append(actions, el("p", "hero-hint", "ou reprends un agent dans la liste à gauche"));
  root.append(aurora, stage, copy);

  // Parallaxe : la scène s'incline un peu vers la souris.
  let tiltX = 0;
  let tiltY = 0;
  root.addEventListener("pointermove", (event) => {
    const box = root.getBoundingClientRect();
    tiltX = ((event.clientX - box.left) / box.width - 0.5) * 2;
    tiltY = ((event.clientY - box.top) / box.height - 0.5) * 2;
  });
  root.addEventListener("pointerleave", () => {
    tiltX = 0;
    tiltY = 0;
  });

  // Animation : position de chaque agent sur son orbite, devant ou derrière l'emblème, faisceaux et notes.
  const start = performance.now();
  let smoothX = 0;
  let smoothY = 0;
  /** @param {number} now */
  function frame(now) {
    if (!root.isConnected) return; // écran quitté : l'animation s'arrête
    const t = (now - start) / 1000;
    smoothX += (tiltX - smoothX) * 0.06;
    smoothY += (tiltY - smoothY) * 0.06;
    const shift = (/** @type {number} */ x, /** @type {number} */ y) => `translate(${(smoothX * x).toFixed(2)} ${(smoothY * y).toFixed(2)})`;
    farPlane.setAttribute("transform", shift(10, 6));
    emblemPlane.setAttribute("transform", shift(4, 3));
    nearPlane.setAttribute("transform", shift(18, 11));
    for (const agent of agents) {
      const { orbit } = agent;
      const angle = agent.phase + t * orbit.speed;
      const ex = Math.cos(angle) * orbit.rx;
      const ey = Math.sin(angle) * orbit.ry;
      const rad = (orbit.tilt * Math.PI) / 180;
      // Entrée : chaque agent jaillit du centre vers son orbite.
      const enter = Math.min(1, Math.max(0, (t - agent.delay) / 0.9));
      const ease = 1 - (1 - enter) ** 3;
      const x = (ex * Math.cos(rad) - ey * Math.sin(rad)) * ease;
      const y = (ex * Math.sin(rad) + ey * Math.cos(rad)) * ease;
      const depth = Math.sin(angle); // > 0 : devant
      const scale = (0.78 + (depth + 1) * 0.17) * (0.4 + 0.6 * ease);
      agent.node.setAttribute("transform", `translate(${x.toFixed(1)} ${y.toFixed(1)}) scale(${scale.toFixed(3)})`);
      // Profondeur : un peu moins présent à l'arrière, sans voile (78 % au moins une fois entré).
      agent.node.style.opacity = String(((0.78 + (depth + 1) * 0.11) * ease).toFixed(3));
      const layer = depth > 0 ? front : back;
      if (agent.node.parentNode !== layer) layer.append(agent.node);
      agent.beam.setAttribute("x2", x.toFixed(1));
      agent.beam.setAttribute("y2", y.toFixed(1));
      agent.beam.style.opacity = String((0.12 + 0.18 * (0.5 + 0.5 * Math.sin(t * 1.6 + agent.phase * 3))) * ease);
      // Une note part de Ziggy vers l'agent, régulièrement.
      const travel = (t * 0.45 + agent.phase) % 1;
      agent.note.setAttribute("cx", (x * travel).toFixed(1));
      agent.note.setAttribute("cy", (y * travel).toFixed(1));
      agent.note.style.opacity = String((Math.sin(travel * Math.PI) * 0.9 * ease).toFixed(3));
    }
    requestAnimationFrame(frame);
  }
  if (reduced) {
    // Sans mouvement : agents posés sur leurs orbites, pas de boucle.
    for (const agent of agents) {
      const { orbit } = agent;
      const rad = (orbit.tilt * Math.PI) / 180;
      const ex = Math.cos(agent.phase) * orbit.rx;
      const ey = Math.sin(agent.phase) * orbit.ry;
      const x = ex * Math.cos(rad) - ey * Math.sin(rad);
      const y = ex * Math.sin(rad) + ey * Math.cos(rad);
      agent.node.setAttribute("transform", `translate(${x.toFixed(1)} ${y.toFixed(1)})`);
      (Math.sin(agent.phase) > 0 ? front : back).append(agent.node);
      agent.beam.setAttribute("x2", x.toFixed(1));
      agent.beam.setAttribute("y2", y.toFixed(1));
      agent.beam.style.opacity = "0.2";
      agent.note.remove();
    }
  } else {
    requestAnimationFrame(frame);
  }
  return root;
}
