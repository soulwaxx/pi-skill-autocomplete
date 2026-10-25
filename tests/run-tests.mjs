import assert from "node:assert/strict";
import { resolve } from "node:path";
import { runIsolated } from "./isolated-runner.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const artifactRoot = process.argv[2];
const extension = artifactRoot
  ? resolve(artifactRoot, "extensions/skill-autocomplete.ts")
  : resolve(repoRoot, "extensions/skill-autocomplete.ts");
const parser = resolve(artifactRoot ?? repoRoot, "extensions/skill-reference-parser.ts");

function assertSucceeded(result, label) {
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    0,
    `${label} failed (status ${result.status}):\n${result.stdout}\n${result.stderr}`,
  );
}

for (const [script, args] of [
  ["skill-context-expectations.test.mjs", []],
  ["skill-autocomplete.mjs", [extension]],
  ["skill-references.mjs", [extension, parser]],
]) {
  const result = runIsolated(resolve(repoRoot, `tests/${script}`), args);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  assertSucceeded(result, script);
}

const hostIntegration = runIsolated(
  resolve(repoRoot, "tests/row8-tui-autocomplete.mjs"),
  [],
  { settings: { packages: [artifactRoot ?? repoRoot] } },
);
process.stdout.write(hostIntegration.stdout ?? "");
process.stderr.write(hostIntegration.stderr ?? "");
assertSucceeded(hostIntegration, "real Pi TUI autocomplete integration");

const hostileParentEnv = {
  ...process.env,
  ANTHROPIC_API_KEY: "hostile-anthropic-key",
  OPENAI_API_KEY: "hostile-openai-key",
  GEMINI_API_KEY: "hostile-gemini-key",
  AWS_SECRET_ACCESS_KEY: "hostile-cloud-secret",
  PI_PARENT_CREDENTIAL: "hostile-parent-credential",
  PI_HOSTILE_HOME: process.env.HOME ?? "host-profile",
  PI_HOSTILE_AGENT_DIR: process.env.PI_CODING_AGENT_DIR ?? "host-agent-dir",
  PI_HOSTILE_CWD: process.cwd(),
};
const isolation = runIsolated(
  resolve(repoRoot, "tests/isolation-probe.mjs"),
  [],
  { parentEnv: hostileParentEnv },
);
assertSucceeded(isolation, "isolation self-test");
console.log("✔ test subprocess isolated from hostile parent environment");
