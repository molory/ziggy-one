// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";

import { browserLabel } from "../web/browsers-logic.js";

test("browserLabel: browser and system", () => {
  const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)";
  assert.equal(browserLabel(`${mac} Chrome/142.0.0.0 Safari/537.36`), "Chrome on macOS");
  assert.equal(browserLabel(`${mac} Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0`), "Edge on macOS");
  assert.equal(browserLabel(`${mac} Version/26.0 Safari/605.1.15`), "Safari on macOS");
  assert.equal(browserLabel("Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0"), "Firefox on Linux");
  assert.equal(browserLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/142.0 Safari/537.36 OPR/120.0"), "Opera on Windows");
});

test("browserLabel: scripts and unknown agents", () => {
  assert.equal(browserLabel("curl/8.7.1"), "curl");
  assert.equal(browserLabel("Python-urllib/3.14"), "Python");
  assert.equal(browserLabel(""), "Unknown browser");
});
