import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ci-config-test-"));
try {
  fs.cpSync(path.join(root, ".github"), path.join(fixture, ".github"), { recursive: true, filter: (source) => !source.split(path.sep).includes("node_modules") });
  fs.copyFileSync(path.join(root, "package.json"), path.join(fixture, "package.json"));
  const check = () => spawnSync(process.execPath, [".github/release-tools/check.mjs"], { cwd: fixture, encoding: "utf8" });
  const baseline = check();
  assert.equal(baseline.status, 0, baseline.stderr);

  // Routine Renovate updates must not require matching literal changes in the checker.
  const ciPath = path.join(fixture, ".github/workflows/test.yml");
  const releasePath = path.join(fixture, ".github/workflows/release.yml");
  const ci = fs.readFileSync(ciPath, "utf8"), release = fs.readFileSync(releasePath, "utf8");
  fs.writeFileSync(ciPath, ci.replace(/NPM_VERSION: '[^']+'/, "NPM_VERSION: '11.99.0'").replace(/ACTIONLINT_VERSION: v\d+\.\d+\.\d+/, "ACTIONLINT_VERSION: v1.99.0"));
  fs.writeFileSync(releasePath, release.replace(/NPM_VERSION: '[^']+'/, "NPM_VERSION: '11.99.0'").replace(/actions\/download-artifact@[0-9a-f]{40}/, `actions/download-artifact@${"a".repeat(40)}`));
  const upgraded = check();
  assert.equal(upgraded.status, 0, upgraded.stderr);
  fs.writeFileSync(ciPath, ci);
  fs.writeFileSync(releasePath, release);

  const rejects = (relative, mutate, message) => {
    const file = path.join(fixture, relative), original = fs.readFileSync(file, "utf8");
    const changed = mutate(original);
    assert.notEqual(changed, original, "negative fixture must change the configuration");
    fs.writeFileSync(file, changed);
    try {
      const result = check();
      assert.notEqual(result.status, 0, message);
      assert.match(result.stderr, message);
    } finally { fs.writeFileSync(file, original); }
  };
  rejects(".github/workflows/release.yml", (text) => `${text}\n# \${{ secrets.NPM_TOKEN }}\n`, /OIDC-only/);
  rejects(".github/release-tools/adapters.mjs", (text) => `${text}\n// bootstrapToken fallback\n`, /must not accept npm credentials/);
  rejects(".github/workflows/test.yml", (text) => text.replace("[opened, synchronize, reopened]", "[opened, synchronize, reopened, edited]"), /AssertionError/);
  rejects(".github/workflows/test.yml", (text) => text.replace("sha256sum --check --ignore-missing", "echo unchecked"), /AssertionError/);
  rejects(".github/workflows/test.yml", (text) => text.replace("npm audit --audit-level=high", "npm audit --audit-level=critical"), /AssertionError/);
  rejects(".github/workflows/release.yml", (text) => text.replace("npm audit --audit-level=high", "npm audit --audit-level=critical"), /AssertionError/);
  rejects(".github/workflows/release.yml", (text) => text.replace(/NPM_VERSION: '[^']+'/, "NPM_VERSION: '11.98.0'"), /same npm CLI/);
  rejects(".github/workflows/renovate.yml", (text) => text.replace(/renovatebot\/github-action@[0-9a-f]{40}/, "renovatebot/github-action@main"), /must pin action digests/);
  rejects(".github/renovate.json", (text) => text.replace('"github-actions",', ''), /AssertionError/);
  rejects(".github/renovate.json", (text) => text.replace('"matchStrings": [', '"matchStrings": ["never-match",'), /must discover every inline CI tool pin/);
} finally { fs.rmSync(fixture, { recursive: true, force: true }); }
console.log("CI configuration accepts automated version/digest updates and rejects npm-token fallback, missing update coverage, and weakened workflow guards PASS");
