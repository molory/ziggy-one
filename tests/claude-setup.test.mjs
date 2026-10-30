// Claude Code not ready screen (no DOM): node --test tests/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { adaptPrompt, claudeProblem, fixPrompt } from "../web/claude-setup.js";

test("claudeProblem: missing, signed out, error, or ready", () => {
  assert.equal(claudeProblem(null), null);
  assert.equal(claudeProblem({ error: "`claude auth status` failed: [Errno 2] No such file or directory: 'claude'" }), "missing");
  assert.equal(claudeProblem({ error: "Unreadable answer" }), "error");
  assert.equal(claudeProblem({ loggedIn: false, apiProvider: "firstParty" }), "signed-out");
  assert.equal(claudeProblem({ loggedIn: true, apiProvider: "firstParty" }), null);
  assert.equal(claudeProblem({ loggedIn: false, apiProvider: "bedrock" }), null, "cloud provider: no claude.ai sign-in");
});

test("fixPrompt: says what is wrong and where Ziggy One looks for claude", () => {
  const server = { folder: "/Users/me/ziggy-one", path: "/usr/bin:/bin", platform: "darwin" };
  const prompt = fixPrompt("missing", {}, server);
  assert.match(prompt, /`claude` command is not found/);
  assert.match(prompt, /folder: \/Users\/me\/ziggy-one/);
  assert.match(prompt, /PATH: \/usr\/bin:\/bin/);
  assert.match(prompt, /claude auth login/);
  assert.match(fixPrompt("error", { error: "boom" }, null), /fails: boom/);
  assert.doesNotMatch(fixPrompt("signed-out", {}, null), /PATH:/);
});

test("adaptPrompt: names the chosen agent, or asks for it", () => {
  const prompt = adaptPrompt("  Codex ", { folder: "/z" });
  assert.match(prompt, /another coding agent: Codex\./);
  assert.match(prompt, /\(folder: \/z\)/);
  assert.match(prompt, /what maps directly to Codex/);
  assert.match(adaptPrompt("", null), /ask me which one/);
});
