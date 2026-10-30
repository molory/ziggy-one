// Interface translations (Node, no dependency): node --test tests/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { currentLanguage, locale, setLanguage, t, tn } from "../web/i18n.js";
import ar from "../web/locales/ar.js";
import es from "../web/locales/es.js";
import fr from "../web/locales/fr.js";
import hi from "../web/locales/hi.js";
import zh from "../web/locales/zh.js";

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

test("every dictionary keeps every placeholder of its English key, with no empty entry", () => {
  for (const [code, catalog] of Object.entries({ ar, es, fr, hi, zh })) {
    for (const [key, value] of Object.entries(catalog)) {
      assert.ok(value.trim(), `${code}: empty translation for « ${key} »`);
      assert.deepEqual(placeholders(value), placeholders(key), `${code}: placeholders of « ${key} »`);
    }
  }
});

test("every dictionary translates the same texts as the French one", () => {
  const keys = Object.keys(fr).sort();
  for (const [code, catalog] of Object.entries({ ar, es, hi, zh })) assert.deepEqual(Object.keys(catalog).sort(), keys, code);
});

test("plural rules and locales follow the language", () => {
  const one = "{n} item", other = "{n} items";
  setLanguage("zh");
  assert.equal(locale(), "zh-CN");
  assert.equal(tn(1, one, other), "1 items", "Chinese: a single form");
  setLanguage("hi");
  assert.equal(tn(0, one, other), "0 item");
  setLanguage("ar");
  assert.equal(tn(1, one, other), "1 item");
  assert.equal(tn(3, one, other), "3 items");
  setLanguage("en");
});
