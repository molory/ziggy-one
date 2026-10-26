// Interface translations (Node, no dependency): node --test tests/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { currentLanguage, locale, setLanguage, t, tn } from "../web/i18n.js";
import fr from "../web/locales/fr.js";

const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test("English is the default and the source: texts come back as written, placeholders filled", () => {
  setLanguage(undefined);
  assert.equal(currentLanguage(), "en");
  assert.equal(locale(), "en-US");
  assert.equal(t("Rename"), "Rename");
  assert.equal(t("{name} is ready", { name: "Otter" }), "Otter is ready");
  assert.equal(t("{missing} stays", {}), "{missing} stays");
  assert.equal(tn(1, "{n} agent", "{n} agents"), "1 agent");
  assert.equal(tn(0, "{n} agent", "{n} agents"), "0 agents");
});

test("French: translated when the dictionary has the text, English otherwise; singular for 0 and 1", () => {
  setLanguage("fr");
  assert.equal(locale(), "fr-FR");
  assert.equal(t("Language"), "Langue");
  assert.equal(t("Not translated yet"), "Not translated yet");
  setLanguage("xx");
  assert.equal(currentLanguage(), "en", "unknown language: English");
  setLanguage("fr");
  const one = "{n} item", other = "{n} items";
  assert.equal(tn(0, one, other), "0 item");
  assert.equal(tn(2, one, other), "2 items");
  setLanguage("en");
});

test("the French dictionary keeps every placeholder of its English key, with no empty entry", () => {
  for (const [key, value] of Object.entries(fr)) {
    assert.ok(value.trim(), `empty translation for « ${key} »`);
    assert.deepEqual(placeholders(value), placeholders(key), `placeholders of « ${key} »`);
  }
});
