// @ts-check
/** Signed-in browsers (Configuration › Server): a readable name from the User-Agent. */

import { t } from "./i18n.js";

// Order matters: Edge and Opera also say "Chrome", Chrome also says "Safari".
const BROWSERS = [
  [/Edg(e|A|iOS)?\//, "Edge"],
  [/OPR\/|Opera/, "Opera"],
  [/Firefox\/|FxiOS\//, "Firefox"],
  [/Chrome\/|CriOS\//, "Chrome"],
  [/Safari\//, "Safari"],
  [/^curl\//, "curl"],
  [/^Python-urllib\/|python-requests\//, "Python"],
];

const SYSTEMS = [
  [/iPhone|iPad|iPod/, "iOS"],
  [/Android/, "Android"],
  [/Mac OS X|Macintosh/, "macOS"],
  [/Windows/, "Windows"],
  [/CrOS/, "ChromeOS"],
  [/Linux/, "Linux"],
];

/**
 * "Chrome on macOS", "Firefox", "curl"… (an unknown User-Agent: "Unknown browser").
 *
 * @param {string} agent
 */
export function browserLabel(agent) {
  const browser = BROWSERS.find(([pattern]) => /** @type {RegExp} */ (pattern).test(agent || ""))?.[1];
  const system = SYSTEMS.find(([pattern]) => /** @type {RegExp} */ (pattern).test(agent || ""))?.[1];
  if (browser && system) return t("{browser} on {system}", { browser, system });
  return browser || system || t("Unknown browser");
}
