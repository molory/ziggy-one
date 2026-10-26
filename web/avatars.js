// @ts-check
// Agent avatars: abbreviation (1 or 2 characters), animal (Twemoji images copied into vendor/twemoji)
// or an image picked from the disk. Pure logic, tested by tests/avatars.test.mjs.

/**
 * The animals of the generated names (names.py), in the same order, with their image. `name` is the English
 * name, also the id saved in the avatar; `fr` is the French name, found in the names generated in French
 * ("Loutre agile") and in older avatars. "approx": no emoji for this animal, the image is a close animal's.
 *
 * @type {{name: string, fr: string, file: string, approx?: boolean}[]}
 */
export const ANIMALS = [
  { name: "Antelope", fr: "Antilope", file: "1f98c", approx: true },
  { name: "Badger", fr: "Blaireau", file: "1f9a1" },
  { name: "Bear", fr: "Ours", file: "1f43b" },
  { name: "Beaver", fr: "Castor", file: "1f9ab" },
  { name: "Bison", fr: "Bison", file: "1f9ac" },
  { name: "Blackbird", fr: "Merle", file: "1f426-200d-2b1b" },
  { name: "Chameleon", fr: "Caméléon", file: "1f98e" },
  { name: "Chamois", fr: "Chamois", file: "1f410", approx: true },
  { name: "Condor", fr: "Condor", file: "1f985", approx: true },
  { name: "Deer", fr: "Daim", file: "1f98c" },
  { name: "Dolphin", fr: "Dauphin", file: "1f42c" },
  { name: "Duck", fr: "Canard", file: "1f986" },
  { name: "Eagle", fr: "Aigle", file: "1f985" },
  { name: "Ermine", fr: "Hermine", file: "1f401", approx: true },
  { name: "Falcon", fr: "Faucon", file: "1f985", approx: true },
  { name: "Fennec", fr: "Fennec", file: "1f98a", approx: true },
  { name: "Ferret", fr: "Furet", file: "1f9a1", approx: true },
  { name: "Flamingo", fr: "Flamant", file: "1f9a9" },
  { name: "Fox", fr: "Renard", file: "1f98a" },
  { name: "Frog", fr: "Grenouille", file: "1f438" },
  { name: "Gazelle", fr: "Gazelle", file: "1f98c", approx: true },
  { name: "Gecko", fr: "Gecko", file: "1f98e" },
  { name: "Giraffe", fr: "Girafe", file: "1f992" },
  { name: "Hare", fr: "Lièvre", file: "1f407" },
  { name: "Hedgehog", fr: "Hérisson", file: "1f994" },
  { name: "Heron", fr: "Héron", file: "1f426", approx: true },
  { name: "Hummingbird", fr: "Colibri", file: "1f426", approx: true },
  { name: "Iguana", fr: "Iguane", file: "1f98e" },
  { name: "Jaguar", fr: "Jaguar", file: "1f406" },
  { name: "Koala", fr: "Koala", file: "1f428" },
  { name: "Llama", fr: "Lama", file: "1f999" },
  { name: "Lynx", fr: "Lynx", file: "1f408", approx: true },
  { name: "Marmot", fr: "Marmotte", file: "1f9ab", approx: true },
  { name: "Meerkat", fr: "Suricate", file: "1f9ab", approx: true },
  { name: "Mongoose", fr: "Mangouste", file: "1f9a1", approx: true },
  { name: "Moose", fr: "Élan", file: "1face" },
  { name: "Ocelot", fr: "Ocelot", file: "1f406", approx: true },
  { name: "Octopus", fr: "Poulpe", file: "1f419" },
  { name: "Okapi", fr: "Okapi", file: "1f993", approx: true },
  { name: "Orca", fr: "Orque", file: "1f40b", approx: true },
  { name: "Otter", fr: "Loutre", file: "1f9a6" },
  { name: "Owl", fr: "Hibou", file: "1f989" },
  { name: "Owlet", fr: "Chouette", file: "1f989" },
  { name: "Panda", fr: "Panda", file: "1f43c" },
  { name: "Parrot", fr: "Perroquet", file: "1f99c" },
  { name: "Pelican", fr: "Pélican", file: "1f426", approx: true },
  { name: "Penguin", fr: "Manchot", file: "1f427" },
  { name: "Puma", fr: "Puma", file: "1f406", approx: true },
  { name: "Rabbit", fr: "Lapin", file: "1f430" },
  { name: "Raven", fr: "Corbeau", file: "1f426-200d-2b1b" },
  { name: "Salamander", fr: "Salamandre", file: "1f98e", approx: true },
  { name: "Seahorse", fr: "Hippocampe", file: "1f420", approx: true },
  { name: "Seal", fr: "Phoque", file: "1f9ad" },
  { name: "Sparrow", fr: "Moineau", file: "1f426" },
  { name: "Squirrel", fr: "Écureuil", file: "1f43f" },
  { name: "Stag", fr: "Cerf", file: "1f98c" },
  { name: "Swan", fr: "Cygne", file: "1f9a2" },
  { name: "Tapir", fr: "Tapir", file: "1f417", approx: true },
  { name: "Tiger", fr: "Tigre", file: "1f42f" },
  { name: "Toucan", fr: "Toucan", file: "1f99c", approx: true },
  { name: "Turtle", fr: "Tortue", file: "1f422" },
  { name: "Vulture", fr: "Vautour", file: "1f985", approx: true },
  { name: "Walrus", fr: "Morse", file: "1f9ad", approx: true },
  { name: "Whale", fr: "Baleine", file: "1f40b" },
  { name: "Wolf", fr: "Loup", file: "1f43a" },
  { name: "Wombat", fr: "Wombat", file: "1f428", approx: true },
  { name: "Yak", fr: "Yak", file: "1f402", approx: true },
  { name: "Zebra", fr: "Zèbre", file: "1f993" },
];

const BY_NAME = new Map(ANIMALS.map((animal) => [animal.name, animal]));
const BY_FRENCH = new Map(ANIMALS.map((animal) => [animal.fr, animal.name]));

/**
 * Id of a saved animal: its English name, also for an older avatar saved with the French name; null if unknown.
 *
 * @param {string | undefined} name
 */
export const animalId = (name) => (!name ? null : BY_NAME.has(name) ? name : BY_FRENCH.get(name) ?? null);

/** @param {string} name */
export const animalImage = (name) => `/vendor/twemoji/${BY_NAME.get(animalId(name) ?? "")?.file}.svg`;

/** @param {string} name */
export const isApprox = (name) => Boolean(BY_NAME.get(animalId(name) ?? "")?.approx);

/**
 * The animal of a generated name, as its id: "Agile Otter" and the older French "Loutre agile" both give
 * "Otter"; null if the name is not built on one.
 *
 * @param {string | undefined} name
 */
export const animalOf = (name) => {
  const words = name?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (words.length > 2 && /^\d+$/.test(words[words.length - 1])) words.pop(); // "Agile Otter 2"
  if (words.length === 2 && BY_NAME.has(words[1])) return words[1];
  return BY_FRENCH.get(words[0] ?? "") ?? null;
};

/** @param {string} text */
const graphemes = (text) => Array.from(new Intl.Segmenter("fr", { granularity: "grapheme" }).segment(text), (part) => part.segment);

/**
 * Typed abbreviation: without spaces, cut to 2 visible characters (a composed emoji counts as one).
 *
 * @param {string} text
 */
export const clipAbbr = (text) => graphemes(text.replace(/\s+/gu, "")).slice(0, 2).join("");

/** @param {string} text */
export const foldText = (text) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/**
 * Suggested abbreviations, from the agent's name and its folder: "A", "AO", "Ag", "ZM".
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
 * What an agent's avatar shows.
 *
 * @param {{abbr?: string, kind?: string, animal?: string, image?: string} | undefined} avatar saved avatar
 * @param {string} fallback default letter (initial of the name, of the folder…)
 * @returns {{kind: "letters" | "animal" | "image", text: string, src?: string, title?: string}}
 */
export function avatarLook(avatar, fallback) {
  const text = avatar?.abbr || fallback;
  const animal = avatar?.kind === "animal" ? animalId(avatar.animal) : null;
  if (animal) {
    return { kind: "animal", text, src: animalImage(animal) };
  }
  if (avatar?.kind === "image" && avatar.image && /^[0-9a-f]{16}$/.test(avatar.image)) {
    return { kind: "image", text, src: `/api/agents/avatars/${avatar.image}` };
  }
  return { kind: "letters", text };
}

/**
 * Fills an avatar (.agent-avatar): the abbreviation, or the image. The status dot is added afterwards.
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
