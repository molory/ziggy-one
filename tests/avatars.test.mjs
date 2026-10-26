// Tests des avatars d'agents (Node, sans dépendance) : node --test tests/*.test.mjs
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { ANIMALS, abbrSuggestions, animalOf, avatarLook, clipAbbr, foldText } from "../web/avatars.js";

const root = new URL("..", import.meta.url);

test("les animaux sont ceux des noms générés, chacun avec son image", () => {
  const python = readFileSync(new URL("names.py", root), "utf8");
  const tuple = python.match(/ANIMALS = \(([\s\S]*?)\)/)[1];
  const names = [...tuple.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(ANIMALS.map((animal) => animal.name), names);
  for (const animal of ANIMALS) assert.ok(existsSync(new URL(`web/vendor/twemoji/${animal.file}.svg`, root)), animal.name);
});

test("l'animal d'un nom généré", () => {
  assert.equal(animalOf("Loutre agile"), "Loutre");
  assert.equal(animalOf("Écureuil sage 2"), "Écureuil");
  assert.equal(animalOf("Revue du connecteur"), null);
  assert.equal(animalOf(undefined), null);
});

test("l'abréviation garde 2 caractères visibles, sans espaces", () => {
  assert.equal(clipAbbr(" ZM "), "ZM");
  assert.equal(clipAbbr("abc"), "ab");
  assert.equal(clipAbbr("L A"), "LA");
  assert.equal(clipAbbr("🧑‍💻🦦x"), "🧑‍💻🦦"); // un emoji composé compte pour un
  assert.equal(clipAbbr("Éé"), "Éé");
});

test("suggestions d'abréviation d'après le nom et le dossier", () => {
  assert.deepEqual(abbrSuggestions("Loutre agile", "/home/x/ziggy-one"), ["L", "LA", "Lo", "ZO"]);
  assert.deepEqual(abbrSuggestions("Revue", "/home/x/atlas"), ["R", "Re", "A"]);
  assert.deepEqual(abbrSuggestions(undefined, undefined), []);
});

test("ce qu'affiche l'avatar", () => {
  assert.deepEqual(avatarLook(undefined, "L"), { kind: "letters", text: "L" });
  assert.deepEqual(avatarLook({ abbr: "LA" }, "L"), { kind: "letters", text: "LA" });
  assert.deepEqual(avatarLook({ kind: "animal", animal: "Loutre" }, "L"), { kind: "animal", text: "L", src: "/vendor/twemoji/1f9a6.svg" });
  assert.deepEqual(avatarLook({ kind: "animal", animal: "Licorne" }, "L"), { kind: "letters", text: "L" });
  assert.equal(avatarLook({ kind: "image", image: "0123456789abcdef" }, "L").src, "/api/agents/avatars/0123456789abcdef");
  assert.equal(avatarLook({ kind: "image", image: "../x" }, "L").kind, "letters");
});

test("recherche sans accents ni majuscules", () => {
  assert.equal(foldText("Écureuil"), "ecureuil");
});
