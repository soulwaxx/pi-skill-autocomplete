import assert from "node:assert/strict";
import { resolve } from "node:path";
import { runIsolated } from "./isolated-runner.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const packageRoot = process.argv[2] ? resolve(process.argv[2]) : repoRoot;
for (const [script, args] of [
  ["row5-probe-runtime.mjs", []],
  ["row5-json-runtime.mjs", []],
  ["row5-editor-runtime.mjs", []],
  ["row5-rpc-runtime.mjs", []],
  ["row5-interactive-runtime.mjs", ["failure"]],
  ["row5-interactive-runtime.mjs", ["attachment-retry"]],
  ["row5-interactive-runtime.mjs", ["abort"]],
  ["row5-interactive-runtime.mjs", ["success"]],
]) {
  const result = runIsolated(resolve(repoRoot, `tests/${script}`), args, { settings: { packages: [packageRoot] } });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${script} failed:\n${result.stdout}\n${result.stderr}`);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
}
