import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(process.cwd(), "..");
assert.equal(process.cwd(), realpathSync(resolve(root, "work")));
assert.equal(realpathSync(process.env.HOME), realpathSync(resolve(root, "home")));
assert.equal(
  realpathSync(process.env.PI_CODING_AGENT_DIR),
  realpathSync(resolve(root, "home/.pi/agent")),
);
assert.equal(
  readFileSync(resolve(process.env.PI_CODING_AGENT_DIR, "settings.json"), "utf8"),
  "{}\n",
);

for (const name of [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "AWS_SECRET_ACCESS_KEY",
  "PI_PARENT_CREDENTIAL",
  "PI_HOSTILE_HOME",
  "PI_HOSTILE_AGENT_DIR",
  "PI_HOSTILE_CWD",
]) {
  assert.equal(process.env[name], undefined, `${name} leaked into the test process`);
}
