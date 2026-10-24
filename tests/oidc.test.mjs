import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareArtifact } from "../.github/release-tools/prepare-artifact.mjs";
import { createAdapters } from "../.github/release-tools/adapters.mjs";
import { artifactIntegrity } from "../.github/release-tools/release-coordinator.mjs";

// Recovery must preserve the exact public archive from verified run 40081540625.
const bytes = Buffer.from(fs.readFileSync(new URL("./fixtures/initial-release.tgz.base64", import.meta.url), "utf8").trim(), "base64");
const integrity = "sha512-97vyneSMTuZDxoA+qk95EVQv7ymKovscvO/UoKJwDrGfY1kf+Qc1Wo8yhrUI75N46ejrvX1+o3RNmPF82ouFzw==";
assert.equal(artifactIntegrity(bytes), integrity);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-oidc-test-"));
const keys = ["FAKE_NPM_LOG", "NPM_TOKEN", "NODE_AUTH_TOKEN", "LEGACY_NPM_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_TOKEN", "npm_config_registry", "NPM_CONFIG_USERCONFIG"];
const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
try {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const prepared = prepareArtifact({ sourceRoot: root, trustedRoot: root, sourceSha: "8cb8df8921457d3da72081ac11e19173347d9713", version: "0.1.0", workRoot: path.join(dir, "initial-recovery") });
  assert.deepEqual(prepared.bytes, bytes, "initial release recovery retains the original compressed bytes across Node/zlib versions");
  assert.equal(prepared.integrity, integrity);

  const command = path.join(dir, "npm-mock"), log = path.join(dir, "calls.jsonl");
  fs.writeFileSync(command, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") process.stdout.write("11.21.0\\n");
else fs.appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify({args, cwd:process.cwd(), home:fs.realpathSync(process.env.HOME), npm:process.env.NPM_TOKEN, auth:process.env.NODE_AUTH_TOKEN, legacy:process.env.LEGACY_NPM_TOKEN, registry:process.env.npm_config_registry, oidc:process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, config:fs.readFileSync(process.env.NPM_CONFIG_USERCONFIG,"utf8"), globalConfig:fs.readFileSync(process.env.NPM_CONFIG_GLOBALCONFIG,"utf8"), mode:fs.statSync(process.env.NPM_CONFIG_USERCONFIG).mode & 0o777, bytes:args[0] === "publish" ? fs.readFileSync(args[1]).toString("base64") : null}) + "\\n");
`);
  fs.chmodSync(command, 0o755);
  const hostileConfig = path.join(dir, "hostile.npmrc");
  fs.writeFileSync(hostileConfig, "//registry.npmjs.org/:_authToken=must-not-be-used\n");
  Object.assign(process.env, { FAKE_NPM_LOG: log, NPM_TOKEN: "ambient-no", NODE_AUTH_TOKEN: "ambient-no", LEGACY_NPM_TOKEN: "ambient-no", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fake-oidc", npm_config_registry: "https://untrusted.invalid", NPM_CONFIG_USERCONFIG: hostileConfig });
  const api = await createAdapters({ repository: "soulwaxx/pi-skill-autocomplete", token: "mock-github", npmCommand: command });
  await api.publishTarball("@soulwaxx/pi-skill-autocomplete", bytes, { tag: "pi-release-candidate" });
  await api.promoteLatest("@soulwaxx/pi-skill-autocomplete", "0.1.0");
  fs.appendFileSync(command, '\nif (args[0] === "publish") { process.stderr.write("npm notice tarball contents\\n".repeat(200) + "npm error simulated OIDC publish failure"); process.exit(1); }\n');
  await assert.rejects(() => api.publishTarball("@soulwaxx/pi-skill-autocomplete", bytes, { tag: "pi-release-candidate" }), (error) => {
    assert.match(error.message, /npm error simulated OIDC publish failure/, "npm errors must survive verbose tarball notices");
    assert.ok(error.message.length < 1100, "npm failure diagnostics remain bounded");
    return true;
  });
  const calls = fs.readFileSync(log, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.equal(calls.length, 3, "an OIDC failure must not retry with an npm token");
  assert.equal(calls[0].bytes, bytes.toString("base64"));
  assert.deepEqual(calls[0].args.slice(2), ["--access", "public", "--provenance", "--tag", "pi-release-candidate"]);
  assert.deepEqual(calls[1].args, ["dist-tag", "add", "@soulwaxx/pi-skill-autocomplete@0.1.0", "latest"]);
  for (const call of calls) {
    assert.equal(call.npm, undefined);
    assert.equal(call.auth, undefined);
    assert.equal(call.legacy, undefined);
    assert.equal(call.registry, undefined);
    assert.equal(call.oidc, "fake-oidc");
    assert.equal(call.config, "\n");
    assert.equal(call.globalConfig, "\n");
    if (call.args[0] === "publish") assert.equal(call.mode, 0o600);
    assert.equal(call.home, path.join(call.cwd, "home"));
    assert.equal(fs.existsSync(call.cwd), false, "temporary publishing directories are removed on success and failure");
  }
} finally {
  for (const key of keys) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log("Initial artifact recovery, OIDC-only publication/promotion, ambient credential exclusion, failure diagnostics and cleanup PASS");
