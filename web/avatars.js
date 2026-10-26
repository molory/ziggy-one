// @ts-check
// Avatars des agents : abréviation (1 ou 2 caractères), animal (images Twemoji copiées dans vendor/twemoji)
// ou image choisie sur le disque. Logique pure, testée par tests/avatars.test.mjs.

/**
 * Les animaux des noms générés (names.py), dans le même ordre, avec leur image. « approx » : pas d'emoji
 * pour cet animal, l'image est celle d'un animal proche.
 *
 * @type {{name: string, file: string, approx?: boolean}[]}
 */
export const ANIMALS = [
  { name: "Aigle", file: "1f985" },
  { name: "Antilope", file: "1f98c", approx: true },
  { name: "Baleine", file: "1f40b" },
  { name: "Bison", file: "1f9ac" },
  { name: "Blaireau", file: "1f9a1" },
  { name: "Caméléon", file: "1f98e" },
  { name: "Canard", file: "1f986" },
  { name: "Castor", file: "1f9ab" },
  { name: "Cerf", file: "1f98c" },
  { name: "Chamois", file: "1f410", approx: true },
  { name: "Chouette", file: "1f989" },
  { name: "Colibri", file: "1f426", approx: true },
  { name: "Condor", file: "1f985", approx: true },
  { name: "Corbeau", file: "1f426-200d-2b1b" },
  { name: "Cygne", file: "1f9a2" },
  { name: "Daim", file: "1f98c" },
  { name: "Dauphin", file: "1f42c" },
  { name: "Écureuil", file: "1f43f" },
  { name: "Élan", file: "1face" },
  { name: "Faucon", file: "1f985", approx: true },
  { name: "Fennec", file: "1f98a", approx: true },
  { name: "Flamant", file: "1f9a9" },
  { name: "Furet", file: "1f9a1", approx: true },
  { name: "Gazelle", file: "1f98c", approx: true },
  { name: "Gecko", file: "1f98e" },
  { name: "Girafe", file: "1f992" },
  { name: "Grenouille", file: "1f438" },
  { name: "Hérisson", file: "1f994" },
  { name: "Hermine", file: "1f401", approx: true },
  { name: "Héron", file: "1f426", approx: true },
  { name: "Hibou", file: "1f989" },
  { name: "Hippocampe", file: "1f420", approx: true },
  { name: "Iguane", file: "1f98e" },
  { name: "Jaguar", file: "1f406" },
  { name: "Koala", file: "1f428" },
  { name: "Lama", file: "1f999" },
  { name: "Lapin", file: "1f430" },
  { name: "Lièvre", file: "1f407" },
  { name: "Loup", file: "1f43a" },
  { name: "Loutre", file: "1f9a6" },
  { name: "Lynx", file: "1f408", approx: true },
  { name: "Manchot", file: "1f427" },
  { name: "Mangouste", file: "1f9a1", approx: true },
  { name: "Marmotte", file: "1f9ab", approx: true },
  { name: "Merle", file: "1f426-200d-2b1b" },
  { name: "Morse", file: "1f9ad", approx: true },
  { name: "Moineau", file: "1f426" },
  { name: "Ocelot", file: "1f406", approx: true },
  { name: "Okapi", file: "1f993", approx: true },
  { name: "Orque", file: "1f40b", approx: true },
  { name: "Ours", file: "1f43b" },
  { name: "Panda", file: "1f43c" },
  { name: "Pélican", file: "1f426", approx: true },
  { name: "Perroquet", file: "1f99c" },
  { name: "Phoque", file: "1f9ad" },
  { name: "Poulpe", file: "1f419" },
  { name: "Puma", file: "1f406", approx: true },
  { name: "Renard", file: "1f98a" },
  { name: "Salamandre", file: "1f98e", approx: true },
  { name: "Suricate", file: "1f9ab", approx: true },
  { name: "Tapir", file: "1f417", approx: true },
  { name: "Tigre", file: "1f42f" },
  { name: "Tortue", file: "1f422" },
  { name: "Toucan", file: "1f99c", approx: true },
  { name: "Vautour", file: "1f985", approx: true },
  { name: "Wombat", file: "1f428", approx: true },
  { name: "Yak", file: "1f402", approx: true },
  { name: "Zèbre", file: "1f993" },
];

const BY_NAME = new Map(ANIMALS.map((animal) => [animal.name, animal]));

/** @param {string} name */
export const animalImage = (name) => `/vendor/twemoji/${BY_NAME.get(name)?.file}.svg`;

/** @param {string} name */
export const isApprox = (name) => Boolean(BY_NAME.get(name)?.approx);

/**
 * L'animal d'un nom généré (« Loutre agile » → « Loutre ») ; null si le nom n'en commence pas par un.
 *
 * @param {string | undefined} name
 */
export const animalOf = (name) => {
  const first = name?.trim().split(/\s+/)[0] ?? "";
  return BY_NAME.has(first) ? first : null;
};

/** @param {string} text */
const graphemes = (text) => Array.from(new Intl.Segmenter("fr", { granularity: "grapheme" }).segment(text), (part) => part.segment);

/**
 * Abréviation saisie : sans espaces, coupée à 2 caractères visibles (un emoji composé en est un).
 *
 * @param {string} text
 */
export const clipAbbr = (text) => graphemes(text.replace(/\s+/gu, "")).slice(0, 2).join("");

/** @param {string} text */
export const foldText = (text) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/**
 * Abréviations proposées, d'après le nom de l'agent et son dossier : « L », « LA », « Lo », « ZM ».
 *
 * @param {string | undefined} name
 * @param {string | undefined} cwd
 */
export function abbrSuggestions(name, cwd) {
  const words = (/** @type {string} */ text) => text.split(/[\s\-_.]+/u).filter((word) => /[\p{L}\p{N}]/u.test(word));
  const initial = (/** @type {string} */ word) => (word.match(/[\p{L}\p{N}]/u)?.[0] ?? "").toUpperCase();
  const nameWords = words(name ?? "");
  const folderWords = words(cwd?.split("/").filter(Boolean).pop() ?? "");
  const first = nameWords[0] ?? "";
  const candidates = [
    initial(first),
    nameWords.length > 1 ? initial(first) + initial(nameWords[1]) : "",
    graphemes(first).length > 1 ? initial(first) + graphemes(first)[1].toLowerCase() : "",
    folderWords.length > 1 ? initial(folderWords[0]) + initial(folderWords[1]) : initial(folderWords[0] ?? ""),
  ];
  return [...new Set(candidates.filter(Boolean))];
}

/**
 * Ce qu'affiche l'avatar d'un agent.
 *
 * @param {{abbr?: string, kind?: string, animal?: string, image?: string} | undefined} avatar enregistré
 * @param {string} fallback lettre par défaut (initiale du nom, du dossier…)
 * @returns {{kind: "letters" | "animal" | "image", text: string, src?: string, title?: string}}
 */
export function avatarLook(avatar, fallback) {
  const text = avatar?.abbr || fallback;
  if (avatar?.kind === "animal" && avatar.animal && BY_NAME.has(avatar.animal)) {
    return { kind: "animal", text, src: animalImage(avatar.animal) };
  }
  if (avatar?.kind === "image" && avatar.image && /^[0-9a-f]{16}$/.test(avatar.image)) {
    return { kind: "image", text, src: `/api/agents/avatars/${avatar.image}` };
  }
  return { kind: "letters", text };
}

/**
 * Remplit un avatar (.agent-avatar) : l'abréviation, ou l'image. La pastille d'état s'ajoute après.
 *
 * @param {HTMLElement} node
 * @param {ReturnType<typeof avatarLook>} look
 */
export function fillAvatar(node, look) {
  node.classList.remove("is-animal", "is-image", "two-chars");
  node.classList.add(...(look.kind === "letters" ? [] : [`is-${look.kind}`]));
  if (look.kind === "letters" || !look.src) {
    if (graphemes(look.text).length > 1) node.classList.add("two-chars");
    const text = document.createElement("span");
    text.className = "avatar-text";
    text.textContent = look.text;
    node.replaceChildren(text);
    return;
  }
  const image = document.createElement("img");
  image.className = "avatar-picture";
  image.src = look.src;
  image.alt = "";
  image.draggable = false;
  node.replaceChildren(image);
}
