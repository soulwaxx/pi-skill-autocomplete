import assert from "node:assert/strict";
import { resolve } from "node:path";
import { runIsolated } from "./isolated-runner.mjs";

const root = resolve(import.meta.dirname, "..");
const result = runIsolated(resolve(root, "tests/bench-skill-autocomplete.mjs"), [resolve(root, "extensions/skill-autocomplete.ts")]);
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
assert.equal(result.status, 0, `benchmark failed (${result.status})`);
