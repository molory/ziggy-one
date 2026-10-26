// Tests d'un message tapé depuis l'onglet Discussion (Node, sans dépendance) : node --test tests/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { typedText } from "../web/terminal-input.js";

test("chaque saut de ligne devient Échap+Entrée, comme Maj+Entrée dans le terminal", () => {
  assert.equal(typedText("une\ndeux\r\ntrois"), "une\x1b\rdeux\x1b\rtrois");
});

test("pas de séquence glissée au terminal ; tabulations en espaces ; bouts vides retirés", () => {
  assert.equal(typedText("  \n\x1b[2Jsalut\x07\t!\x9b \n\n"), "[2Jsalut    !");
});
