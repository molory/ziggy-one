// Tests of the agent avatars (Node, no dependency): node --test tests/*.test.mjs
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { ANIMALS, abbrSuggestions, animalId, animalOf, avatarLook, clipAbbr, foldText } from "../web/avatars.js";

const root = new URL("..", import.meta.url);

test("the animals are those of the generated names, each with its image", () => {
  const python = readFileSync(new URL("names.py", root), "utf8");
  const tuple = python.match(/ANIMALS = \(([\s\S]*?)\)/)[1];
  const names = [...tuple.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(ANIMALS.map((animal) => animal.name), names);
  for (const animal of ANIMALS) assert.ok(existsSync(new URL(`web/vendor/twemoji/${animal.file}.svg`, root)), animal.name);
});

test("the French names are those of names.py", () => {
  const python = readFileSync(new URL("names.py", root), "utf8");
  const map = python.match(/FRENCH_ANIMALS = \{([\s\S]*?)\}/)[1];
  const pairs = [...map.matchAll(/"([^"]+)": "([^"]+)"/g)].map((match) => [match[1], match[2]]).sort();
  assert.deepEqual(ANIMALS.map((animal) => [animal.fr, animal.name]).sort(), pairs);
});

test("the animal of a generated name, English or older French", () => {
  assert.equal(animalOf("Agile Otter"), "Otter");
  assert.equal(animalOf("Wise Squirrel 2"), "Squirrel");
  assert.equal(animalOf("Loutre agile"), "Otter");
  assert.equal(animalOf("Écureuil sage 2"), "Squirrel");
  assert.equal(animalOf("Bison brave"), "Bison");
  assert.equal(animalOf("Connector review"), null);
  assert.equal(animalOf(undefined), null);
});

test("an animal saved under its French name keeps its image", () => {
  assert.equal(animalId("Otter"), "Otter");
  assert.equal(animalId("Loutre"), "Otter");
  assert.equal(animalId("Unicorn"), null);
  assert.equal(animalId(undefined), null);
});

test("the abbreviation keeps 2 visible characters, without spaces", () => {
  assert.equal(clipAbbr(" ZM "), "ZM");
  assert.equal(clipAbbr("abc"), "ab");
  assert.equal(clipAbbr("L A"), "LA");
  assert.equal(clipAbbr("🧑‍💻🦦x"), "🧑‍💻🦦"); // a composed emoji counts as one
  assert.equal(clipAbbr("Éé"), "Éé");
});

test("abbreviation suggestions from the name and the folder", () => {
  assert.deepEqual(abbrSuggestions("Agile Otter", "/home/x/ziggy-one"), ["A", "AO", "Ag", "ZO"]);
  assert.deepEqual(abbrSuggestions("Review", "/home/x/atlas"), ["R", "Re", "A"]);
  assert.deepEqual(abbrSuggestions(undefined, undefined), []);
});

test("what the avatar shows", () => {
  assert.deepEqual(avatarLook(undefined, "L"), { kind: "letters", text: "L" });
  assert.deepEqual(avatarLook({ abbr: "LA" }, "L"), { kind: "letters", text: "LA" });
  assert.deepEqual(avatarLook({ kind: "animal", animal: "Otter" }, "L"), { kind: "animal", text: "L", src: "/vendor/twemoji/1f9a6.svg" });
  assert.deepEqual(avatarLook({ kind: "animal", animal: "Loutre" }, "L"), { kind: "animal", text: "L", src: "/vendor/twemoji/1f9a6.svg" });
  assert.deepEqual(avatarLook({ kind: "animal", animal: "Unicorn" }, "L"), { kind: "letters", text: "L" });
  assert.equal(avatarLook({ kind: "image", image: "0123456789abcdef" }, "L").src, "/api/agents/avatars/0123456789abcdef");
  assert.equal(avatarLook({ kind: "image", image: "../x" }, "L").kind, "letters");
});

test("search ignores accents and case", () => {
  assert.equal(foldText("Écureuil"), "ecureuil");
});
