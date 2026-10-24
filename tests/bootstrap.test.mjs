import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareArtifact } from "../.github/release-tools/prepare-artifact.mjs";
import { bootstrapPrepared } from "../.github/release-tools/bootstrap-prepared.mjs";
import { createAdapters } from "../.github/release-tools/adapters.mjs";
import { artifactIntegrity } from "../.github/release-tools/release-coordinator.mjs";

// Exact public five-file tarball from verified run 40081540625, not repacked test data.
const bytes = Buffer.from(fs.readFileSync(new URL("./fixtures/initial-release.tgz.base64", import.meta.url), "utf8").trim(), "base64");
const source = { sha: "8cb8df8921457d3da72081ac11e19173347d9713", tag: "v0.1.0", version: "0.1.0" };
const integrity = "sha512-97vyneSMTuZDxoA+qk95EVQv7ymKovscvO/UoKJwDrGfY1kf+Qc1Wo8yhrUI75N46ejrvX1+o3RNmPF82ouFzw==";
assert.equal(artifactIntegrity(bytes), integrity);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bootstrap-test-"));
const options = {
  repository: "soulwaxx/pi-skill-autocomplete", eventName: "workflow_dispatch", ref: "refs/heads/main",
  confirmation: "publish-v0.1.0", recoveryTag: "v0.1.0", expectedMode: "recovery",
  sourceSha: source.sha, trustedSha: "a".repeat(40), expectedVersion: source.version,
  expectedTag: source.tag, expectedIntegrity: integrity, bootstrapToken: "fixture-only-token",
  visibility: { attempts: 1 },
};
function mockApi(changes = {}) {
  const writes = [];
  let npm = null, validations = 0;
  return {
    writes,
    api: {
      validateSource: async (identity, mode) => { validations++; assert.deepEqual(identity, source); assert.deepEqual(mode, { mode: "recovery" }); },
      readTag: async () => ({ sha: source.sha }), readPackage: async () => null, readRelease: async () => null,
      publishTarball: async (name, body, opts) => {
        assert.equal(validations, 2, "live main is rechecked immediately before publication");
        assert.equal(name, "@soulwaxx/pi-skill-autocomplete");
        assert.deepEqual(body, bytes);
        assert.deepEqual(opts, { tag: "pi-release-candidate", bootstrapToken: options.bootstrapToken });
        writes.push("npm"); npm = { version: source.version, gitHead: source.sha, dist: { integrity } };
      },
      readNpm: async () => npm,
      ...changes,
    },
  };
}
try {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const prepared = prepareArtifact({ sourceRoot: root, trustedRoot: root, sourceSha: source.sha, version: source.version, workRoot: path.join(dir, "initial-preparation") });
  assert.deepEqual(prepared.bytes, bytes, "first-release preparation and recovery retain the original compressed bytes across Node/zlib versions");
  assert.equal(prepared.integrity, integrity);
  const info = { source, mode: "recovery", integrity };
  fs.writeFileSync(path.join(dir, "release.tgz"), bytes);
  fs.writeFileSync(path.join(dir, "release.json"), JSON.stringify(info));
  const valid = mockApi();
  assert.equal((await bootstrapPrepared(dir, { ...options, adapters: valid.api })).bootstrapped, true);
  assert.deepEqual(valid.writes, ["npm"], "bootstrap never creates tags, GitHub Releases, or latest");
  for (const change of [
    { repository: "other/project" }, { eventName: "push" }, { ref: "refs/heads/feature" },
    { confirmation: "" }, { recoveryTag: "v0.2.0" }, { expectedMode: "release" },
    { bootstrapToken: "" }, { bootstrapToken: "token\nunsafe" }, { sourceSha: "b".repeat(40) }, { trustedSha: "invalid" },
    { expectedVersion: "0.2.0" }, { expectedIntegrity: "sha512-wrong" },
  ]) {
    const rejected = mockApi();
    await assert.rejects(() => bootstrapPrepared(dir, { ...options, ...change, adapters: rejected.api }));
    assert.deepEqual(rejected.writes, []);
  }
  for (const change of [
    { readTag: async () => null }, { readTag: async () => ({ sha: "b".repeat(40) }) },
    { readPackage: async () => ({ name: "@soulwaxx/pi-skill-autocomplete" }) },
    { readRelease: async () => ({ tag_name: "v0.1.0" }) },
    { readPackage: async () => { throw new Error("HTTP 401"); } },
    { validateSource: async () => { throw new Error("main moved"); } },
  ]) {
    const rejected = mockApi(change);
    await assert.rejects(() => bootstrapPrepared(dir, { ...options, adapters: rejected.api }));
    assert.deepEqual(rejected.writes, []);
  }
  let checks = 0;
  const moved = mockApi({ validateSource: async () => { if (++checks === 2) throw new Error("main moved before write"); } });
  await assert.rejects(() => bootstrapPrepared(dir, { ...options, adapters: moved.api }), /main moved/);
  assert.deepEqual(moved.writes, []);
  const forged = mockApi();
  fs.writeFileSync(path.join(dir, "release.json"), JSON.stringify({ ...info, source: { ...source, sha: "b".repeat(40) } }));
  await assert.rejects(() => bootstrapPrepared(dir, { ...options, sourceSha: "b".repeat(40), adapters: forged.api }), /already verified initial source/);
  assert.deepEqual(forged.writes, []);
  const substitute = Buffer.from("different self-consistent artifact");
  const substituteIntegrity = artifactIntegrity(substitute);
  fs.writeFileSync(path.join(dir, "release.tgz"), substitute);
  fs.writeFileSync(path.join(dir, "release.json"), JSON.stringify({ ...info, integrity: substituteIntegrity }));
  await assert.rejects(() => bootstrapPrepared(dir, { ...options, expectedIntegrity: substituteIntegrity, adapters: forged.api }), /original verified tarball bytes/);
  assert.deepEqual(forged.writes, []);
  fs.writeFileSync(path.join(dir, "release.json"), JSON.stringify(info));
  fs.writeFileSync(path.join(dir, "release.tgz"), bytes);
  fs.appendFileSync(path.join(dir, "release.tgz"), "tampered");
  const tampered = mockApi();
  await assert.rejects(() => bootstrapPrepared(dir, { ...options, adapters: tampered.api }), /tarball changed/);
  assert.deepEqual(tampered.writes, []);
} finally { fs.rmSync(dir, { recursive: true, force: true }); }

const bin = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bootstrap-npm-"));
const command = path.join(bin, "npm-mock"), log = path.join(bin, "calls.jsonl");
fs.writeFileSync(command, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") process.stdout.write("11.21.0\\n");
else fs.appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify({args, cwd:process.cwd(), npm:process.env.NPM_TOKEN, auth:process.env.NODE_AUTH_TOKEN, bootstrap:process.env.BOOTSTRAP_NPM_TOKEN, otherBootstrap:process.env.NPM_BOOTSTRAP_TOKEN, oidc:process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, config:fs.readFileSync(process.env.NPM_CONFIG_USERCONFIG,"utf8"), mode:fs.statSync(process.env.NPM_CONFIG_USERCONFIG).mode & 0o777, bytes:args[0] === "publish" ? fs.readFileSync(args[1]).toString("base64") : null}) + "\\n");
`);
fs.chmodSync(command, 0o755);
const keys = ["FAKE_NPM_LOG", "NPM_TOKEN", "NODE_AUTH_TOKEN", "BOOTSTRAP_NPM_TOKEN", "NPM_BOOTSTRAP_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_TOKEN"];
const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
try {
  Object.assign(process.env, { FAKE_NPM_LOG: log, NPM_TOKEN: "ambient-no", NODE_AUTH_TOKEN: "ambient-no", BOOTSTRAP_NPM_TOKEN: "ambient-no", NPM_BOOTSTRAP_TOKEN: "ambient-no", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fake-oidc" });
  const api = await createAdapters({ repository: options.repository, token: "mock-github", npmCommand: command });
  await api.publishTarball("@soulwaxx/pi-skill-autocomplete", bytes, { tag: "pi-release-candidate" });
  await api.publishTarball("@soulwaxx/pi-skill-autocomplete", bytes, { tag: "pi-release-candidate", bootstrapToken: options.bootstrapToken });
  await api.promoteLatest("@soulwaxx/pi-skill-autocomplete", "0.1.0");
  await assert.rejects(() => api.publishTarball("@other/package", bytes, { tag: "pi-release-candidate", bootstrapToken: options.bootstrapToken }));
  fs.appendFileSync(command, '\nif (args[0] === "publish") { process.stderr.write("npm notice tarball contents\\n".repeat(200) + "npm error simulated publish failure"); process.exit(1); }\n');
  await assert.rejects(() => api.publishTarball("@soulwaxx/pi-skill-autocomplete", bytes, { tag: "pi-release-candidate", bootstrapToken: options.bootstrapToken }), (error) => {
    assert.match(error.message, /npm error simulated publish failure/, "npm errors must survive verbose tarball notices");
    assert.ok(error.message.length < 1100, "npm failure diagnostics remain bounded");
    return true;
  });
  const calls = fs.readFileSync(log, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.equal(calls.length, 4);
  assert.equal(calls[0].auth, undefined, "normal publication remains OIDC-only despite ambient bootstrap credentials");
  assert.equal(calls[0].config, "\n");
  assert.equal(calls[1].auth, options.bootstrapToken);
  assert.equal(calls[1].config, `//registry.npmjs.org/:_authToken=\${NODE_AUTH_TOKEN}\n`);
  assert.equal(calls[1].mode, 0o600);
  assert.equal(calls[1].bytes, bytes.toString("base64"));
  assert.deepEqual(calls[1].args.slice(2), ["--access", "public", "--provenance", "--tag", "pi-release-candidate"]);
  assert.equal(calls[2].auth, undefined, "latest promotion never inherits bootstrap credentials");
  for (const call of calls) {
    assert.equal(call.npm, undefined);
    assert.equal(call.bootstrap, undefined);
    assert.equal(call.otherBootstrap, undefined);
    assert.equal(call.oidc, "fake-oidc");
    assert.equal(fs.existsSync(call.cwd), false, "temporary credential/config/cache directories are removed");
  }
} finally {
  for (const key of keys) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  fs.rmSync(bin, { recursive: true, force: true });
}
console.log("One-time bootstrap gates, pinned initial artifact, missing-package preflight, exact bytes/provenance, isolated explicit credential and OIDC-only normal paths PASS");
