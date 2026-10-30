// @ts-check
// Interface translations, without any library.
//
// English is the source language: every visible text is written in English in the code and wrapped in
// t("…"). Other languages are dictionaries keyed by that English text (web/locales/<code>.js); a text missing
// from a dictionary falls back to English. The language is chosen in the global Configuration (General tab),
// saved by the server, and written by it into <html lang> when it serves the page: it is known before any
// module runs, so texts built at import time are translated too. Changing it reloads the page.

import ar from "./locales/ar.js";
import es from "./locales/es.js";
import fr from "./locales/fr.js";
import hi from "./locales/hi.js";
import zh from "./locales/zh.js";

/** Languages offered in the Configuration, with their name in their own language: the most spoken ones. */
export const LANGUAGES = /** @type {const} */ ([
  ["en", "English"], ["zh", "中文"], ["hi", "हिन्दी"], ["es", "Español"], ["ar", "العربية"], ["fr", "Français"],
]);

/** @type {Record<string, Record<string, string>>} */
const CATALOGS = { ar, es, fr, hi, zh };

/** BCP 47 locale of each language, for dates and numbers. */
const LOCALES = { en: "en-US", zh: "zh-CN", hi: "hi-IN", es: "es-ES", ar: "ar", fr: "fr-FR" };

/** @type {string} */
let language = "en";
/** @type {Record<string, string> | null} */
let catalog = null;

/**
 * Sets the language (unknown codes fall back to English).
 *
 * @param {string | null | undefined} code
 */
export function setLanguage(code) {
  language = code && (code === "en" || code in CATALOGS) ? code : "en";
  catalog = CATALOGS[language] ?? null;
}

/** Current language code ("en", "fr"…). */
export const currentLanguage = () => language;

/** BCP 47 locale for dates and numbers (toLocaleString, Intl). */
export const locale = () => LOCALES[/** @type {keyof typeof LOCALES} */ (language)] ?? "en-US";

/**
 * Replaces {name} placeholders.
 *
 * @param {string} text
 * @param {Record<string, unknown>} [params]
 */
function fill(text, params) {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
}

/**
 * Translated text. `text` is the English source, used as the key; `{name}` placeholders are filled from `params`.
 *
 * @param {string} text
 * @param {Record<string, unknown>} [params]
 */
export function t(text, params) {
  return fill(catalog?.[text] ?? text, params);
}

/**
 * Translated text that depends on a count: `one` when the language's plural rule says so (1 in English, 0 and 1
 * in French and Hindi, never in Chinese), `other` otherwise. `{n}` is the count; other placeholders come from `params`.
 *
 * @param {number} n
 * @param {string} one English singular, e.g. "{n} agent"
 * @param {string} other English plural, e.g. "{n} agents"
 * @param {Record<string, unknown>} [params]
 */
export function tn(n, one, other, params) {
  const singular = new Intl.PluralRules(locale()).select(n) === "one";
  return t(singular ? one : other, { n, ...params });
}

const TRANSLATED_ATTRIBUTES = ["title", "aria-label", "placeholder", "alt"];

/**
 * Translates the static markup of the page (index.html): text nodes and title / aria-label / placeholder / alt
 * attributes whose whole (trimmed) value is a key of the dictionary.
 *
 * @param {Element} root
 */
export function translateStatic(root) {
  if (!catalog) return;
  const known = /** @type {Record<string, string>} */ (catalog);
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue?.trim();
    if (text && known[text]) node.nodeValue = /** @type {string} */ (node.nodeValue).replace(text, known[text]);
  }
  for (const element of [root, ...root.querySelectorAll("*")]) {
    for (const name of TRANSLATED_ATTRIBUTES) {
      const value = element.getAttribute(name);
      if (value && known[value.trim()]) element.setAttribute(name, known[value.trim()]);
    }
  }
}

// The server writes the chosen language into <html lang> (see server.py) before any script runs.
setLanguage(globalThis.document?.documentElement.lang);
