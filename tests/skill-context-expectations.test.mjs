import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { expectedSkillContextPrefix } from "./skill-context-expectations.mjs";

test("only the exact initial release identity uses the legacy skill context expectation", () => {
  const root = mkdtempSync(join(tmpdir(), "skill-context-expectations-"));
  const initial = { name: "@soulwaxx/pi-skill-autocomplete", version: "0.1.0", gitHead: "8cb8df8921457d3da72081ac11e19173347d9713" };
  const prefixFor = (manifest) => {
    writeFileSync(join(root, "package.json"), JSON.stringify(manifest));
    return expectedSkillContextPrefix(root);
  };
  try {
    assert.equal(prefixFor(initial), "");
    for (const manifest of [
      { name: initial.name, version: initial.version }, // Current source still uses 0.1.0.
      { ...initial, gitHead: "f".repeat(40) },
      { ...initial, version: "0.1.1" },
      { ...initial, name: "@fixture/other" },
    ]) {
      assert.match(prefixFor(manifest), /^\n\nThe following referenced skills are already loaded\./);
      assert.match(prefixFor(manifest), /do not read their SKILL\.md files again/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
