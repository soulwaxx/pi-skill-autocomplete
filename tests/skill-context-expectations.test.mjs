import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { expectedSkillContextPrefix, expectedSkillExpansion } from "./skill-context-expectations.mjs";

test("only the exact initial release identity uses the legacy skill context expectation", () => {
  const root = mkdtempSync(join(tmpdir(), "skill-context-expectations-"));
  const initial = { name: "@soulwaxx/pi-skill-autocomplete", version: "0.1.0", gitHead: "8cb8df8921457d3da72081ac11e19173347d9713" };
  const prefixFor = (manifest) => {
    writeFileSync(join(root, "package.json"), JSON.stringify(manifest));
    return expectedSkillContextPrefix(root);
  };
  try {
    assert.equal(prefixFor(initial), "");
    assert.equal(expectedSkillExpansion(root, "authored", [{ name: "alpha", directory: "/skills/alpha", body: "full body" }]), "authored\n\n--- Skill alpha (references relative to /skills/alpha) ---\nfull body", "only exact initial identity expects legacy unframed expansion");
    for (const manifest of [
      { name: initial.name, version: initial.version }, // Current source still uses 0.1.0.
      { ...initial, gitHead: "f".repeat(40) },
      { ...initial, version: "0.1.1" },
      { ...initial, name: "@fixture/other" },
    ]) {
      assert.match(prefixFor(manifest), /^\n\nThe following referenced skills are already loaded\./);
      assert.match(prefixFor(manifest), /do not read their SKILL\.md files again/);
      assert.match(expectedSkillExpansion(root, "authored", [{ name: "alpha", directory: "/skills/alpha", body: "full body" }]), /<!-- pi-skill-autocomplete:v1 --> names=alpha bytes=/, "noninitial identities keep current framing even when names/version resemble the release");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
