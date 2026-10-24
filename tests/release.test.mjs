import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { githubEvidence, recordEvidence, validateEvidence, verifySource } from "../.github/release-tools/release-source.mjs";
import { artifactIntegrity, missingOnlyOn404, publishRelease, selectReleaseVersion, waitForNpm } from "../.github/release-tools/release-coordinator.mjs";
import { isolatedPreparationEnv, prepareArtifact } from "../.github/release-tools/prepare-artifact.mjs";
import { runRelease } from "../.github/release-tools/release.mjs";
import { createAdapters } from "../.github/release-tools/adapters.mjs";
import { publishPrepared } from "../.github/release-tools/publish-prepared.mjs";

const sha = (n) => String(n).repeat(40);

// Real adapter URL/status behavior is exercised through mocked HTTP responses only.
const savedFetch = globalThis.fetch;
const adapterUrls = [];
const adapterWrites = [];
const nullBodyBytes = Buffer.from("pre-existing exact release artifact");
try {
  globalThis.fetch = async (url, options = {}) => {
    const value = String(url);
    adapterUrls.push(value);
    if (options.method === "POST" && value.endsWith("/git/refs")) {
      adapterWrites.push({ url: value, token: new Headers(options.headers).get("authorization"), body: JSON.parse(options.body) });
      return Response.json({ ref: "refs/tags/v0.1.0" });
    }
    if (options.method === "POST" && value.endsWith("/releases")) {
      adapterWrites.push({ url: value, token: new Headers(options.headers).get("authorization"), body: JSON.parse(options.body) });
      return Response.json({ ...JSON.parse(options.body), id: 1 });
    }
    if (value.endsWith("/git/ref/tags/v0.1.0")) return Response.json({ ref: "refs/tags/v0.1.0", object: { type: "tag", sha: sha(2) } });
    if (value.endsWith(`/git/tags/${sha(2)}`)) return Response.json({ object: { type: "commit", sha: sha(3) } });
    if (value.endsWith("/releases/tags/v0.1.0")) return Response.json({ tag_name: "v0.1.0", name: "v0.1.0", body: null, draft: false, prerelease: false, assets: [] });
    if (value.endsWith("/%40fixture%2Fpkg/0.1.0")) return Response.json({ name: "@fixture/pkg", version: "0.1.0", gitHead: sha(3), dist: { integrity: artifactIntegrity(nullBodyBytes) } });
    if (value.endsWith("/%40fixture%2Fpkg")) return new Response("", { status: 404 });
    return new Response("forbidden", { status: 403 });
  };
  const remote = await createAdapters({ repository: "fixture/project", token: "mock-token" });
  assert.deepEqual(await remote.readTag("v0.1.0"), { sha: sha(3) }, "annotated Git tags resolve to their exact commit");
  assert.deepEqual(await remote.readNpm("@fixture/pkg", "0.1.0"), { name: "@fixture/pkg", version: "0.1.0", gitHead: sha(3), dist: { integrity: artifactIntegrity(nullBodyBytes) } });
  assert.deepEqual(await remote.readRelease("v0.1.0"), { tag_name: "v0.1.0", name: "v0.1.0", body: "", targetSha: sha(3), draft: false, prerelease: false, assets: [] });
  assert.deepEqual(await remote.readDistTags("@fixture/pkg"), {});
  const idempotentAdapter = {
    validateSource: async () => {},
    readTag: remote.readTag,
    readNpm: remote.readNpm,
    readRelease: remote.readRelease,
    readDistTags: async () => ({ latest: "0.1.0" }),
  };
  const mutationCount = adapterWrites.length;
  const idempotentArtifact = { version: "0.1.0", sourceSha: sha(3), bytes: nullBodyBytes, integrity: artifactIntegrity(nullBodyBytes) };
  await publishRelease({ source: { sha: sha(3), version: "0.1.0", tag: "v0.1.0" }, artifact: idempotentArtifact, packageName: "@fixture/pkg" }, idempotentAdapter);
  assert.equal(adapterWrites.length, mutationCount, "real adapter normalizes documented null release body and coordinator stays idempotent");
  await remote.createTag("v0.1.0", sha(3));
  await remote.createRelease("v0.1.0", sha(3));
  assert.deepEqual(adapterWrites.map(({ body }) => body), [{ ref: "refs/tags/v0.1.0", sha: sha(3) }, { tag_name: "v0.1.0", target_commitish: sha(3), name: "v0.1.0", body: "", draft: false, prerelease: false }]);
  assert.ok(adapterWrites.every(({ token }) => token === "Bearer mock-token"), "GitHub mutations use the workflow token");
  assert.ok(adapterUrls.every((url) => url.startsWith("https://api.github.com/") || url.startsWith("https://registry.npmjs.org/")), "adapter requests remain pinned to the official API origins");
  globalThis.fetch = async () => new Response("missing", { status: 404 });
  const absentAdapter = await createAdapters({ repository: "fixture/project", token: "mock-token" });
  assert.equal(await absentAdapter.readNpm("@fixture/pkg", "0.1.0"), null, "only exact HTTP 404 is absence on reads");
  await assert.rejects(() => absentAdapter.createTag("v0.1.0", sha(3)), /HTTP 404/, "write 404 is an error, never missing-state recovery");
  globalThis.fetch = async () => new Response("unauthorized", { status: 401 });
  await assert.rejects(() => createAdapters({ repository: "fixture/project", token: "mock-token" }).then((api) => api.readNpm("@fixture/pkg", "0.1.0")), /HTTP 401/);
  await assert.rejects(() => createAdapters({ repository: "fixture/project", token: "mock-token" }).then((api) => api.readNpm("attacker/pkg", "0.1.0")), /invalid scoped package name/);
  globalThis.fetch = async () => new Response("{", { status: 200 });
  await assert.rejects(() => createAdapters({ repository: "fixture/project", token: "mock-token" }).then((api) => api.readDistTags("@fixture/pkg")), /invalid JSON/);
  globalThis.fetch = async () => new Response("x".repeat(2 * 1024 * 1024 + 1), { status: 200 });
  await assert.rejects(() => createAdapters({ repository: "fixture/project", token: "mock-token" }).then((api) => api.readDistTags("@fixture/pkg")), /response exceeds/);
  globalThis.fetch = async () => { throw new Error("mock network failure"); };
  await assert.rejects(() => createAdapters({ repository: "fixture/project", token: "mock-token" }).then((api) => api.readDistTags("@fixture/pkg")), /mock network failure/);

  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "pi-release-npm-mock-"));
  const fakeNpm = path.join(fakeBin, "npm-mock");
  const logFile = path.join(fakeBin, "calls.jsonl");
  fs.writeFileSync(fakeNpm, `#!/usr/bin/env node\nconst fs = require("node:fs");\nconst args = process.argv.slice(2);\nif (args[0] === "--version") process.stdout.write("11.21.0\\n");\nelse fs.appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify({args, npmToken: process.env.NPM_TOKEN, nodeAuth: process.env.NODE_AUTH_TOKEN, oidc: process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, bytes: args[0] === "publish" ? fs.readFileSync(args[1]).toString("utf8") : null, userConfig: fs.readFileSync(process.env.NPM_CONFIG_USERCONFIG, "utf8")}) + "\\n");\n`);
  fs.chmodSync(fakeNpm, 0o755);
  const savedNpmEnv = Object.fromEntries(["NPM_TOKEN", "NODE_AUTH_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_TOKEN", "FAKE_NPM_LOG"].map((key) => [key, process.env[key]]));
  try {
    process.env.NPM_TOKEN = "must-not-reach-npm";
    process.env.NODE_AUTH_TOKEN = "must-not-reach-npm";
    process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = "mock-oidc-token";
    process.env.FAKE_NPM_LOG = logFile;
    const cliAdapters = await createAdapters({ repository: "fixture/project", token: "mock-token", npmCommand: fakeNpm });
    const tarballBytes = Buffer.from("mock retained npm tarball bytes");
    await cliAdapters.publishTarball("@fixture/pkg", tarballBytes, { tag: "pi-release-candidate" });
    await cliAdapters.promoteLatest("@fixture/pkg", "0.1.0");
    const calls = fs.readFileSync(logFile, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.deepEqual(calls[0].args.slice(0, 1).concat(calls[0].args.slice(2)), ["publish", "--access", "public", "--provenance", "--tag", "pi-release-candidate"]);
    assert.equal(calls[0].bytes, tarballBytes.toString(), "publish adapter passes the retained exact tarball file, without repacking");
    assert.equal(calls[0].npmToken, undefined);
    assert.equal(calls[0].nodeAuth, undefined);
    assert.equal(calls[0].oidc, "mock-oidc-token");
    assert.equal(calls[0].userConfig, "\n", "npm uses an empty user config rather than ambient credentials");
    assert.deepEqual(calls[1].args, ["dist-tag", "add", "@fixture/pkg@0.1.0", "latest"]);
    assert.equal(calls[1].npmToken, undefined);
  } finally {
    fs.rmSync(fakeBin, { recursive: true, force: true });
    for (const [key, value] of Object.entries(savedNpmEnv)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
} finally { globalThis.fetch = savedFetch; }

// Source-evidence predicate tests remain part of this slice.
const fixedNow = Date.parse("2026-02-01T00:00:00.000Z");
const pr = { number: 8, head: { sha: sha(1) }, merged_at: "2026-01-31", merge_commit_sha: sha(3), base: { ref: "main", repo: { full_name: "fixture/project" } } };
const run = { id: 90, run_attempt: 2, created_at: "2026-01-31T00:00:00.000Z", repository: { full_name: "fixture/project" }, path: ".github/workflows/test.yml", event: "pull_request", head_sha: sha(1), status: "completed", conclusion: "success" };
const proof = { repository: "fixture/project", workflow: ".github/workflows/test.yml", event: "pull_request", runId: 90, runAttempt: 2, pr: 8, headSha: sha(1), baseSha: sha(2), testedSha: sha(4), tree: sha(5), parents: [sha(2), sha(1)], createdAt: "2026-01-31T00:00:01.000Z" };
const git = (...args) => {
  if (args[0] === "show" && args[1] === "-s" && args[2] === "--format=%s") return "feat: add feature";
  if (args[0] === "merge-base") return "";
  if (args[0] === "rev-parse") return sha(5);
  if (args[0] === "show" && args[2] === "--format=%P") return sha(2);
  throw Error(`unexpected git ${args}`);
};
const api = async (route) => route.includes("/pulls?") ? [pr] : route.includes("/workflows/") ? { workflow_runs: [run] } : { sha: sha(4), tree: { sha: sha(5) }, parents: [{ sha: sha(2) }, { sha: sha(1) }] };
const result = await verifySource({ repository: "fixture/project", sha: sha(3), git, api, evidence: async () => proof, now: fixedNow });
assert.equal(result.runId, 90);
const evidenceFixture = path.join(os.tmpdir(), `release-evidence-${process.pid}.json`);
const recordEnv = { GITHUB_EVENT_NAME: "pull_request", GITHUB_REPOSITORY: "fixture/project", GITHUB_RUN_ID: "90", GITHUB_RUN_ATTEMPT: "2", PR_NUMBER: "8", PR_HEAD_SHA: sha(1), PR_BASE_SHA: sha(2), GITHUB_SHA: sha(4) };
const recordGit = (...args) => args[0] === "rev-parse" && args[1] === "HEAD" ? sha(4) : args[0] === "rev-parse" ? sha(5) : args[0] === "show" ? `${sha(2)} ${sha(1)}` : "";
recordEvidence(evidenceFixture, recordEnv, recordGit, new Date("2026-01-31T00:00:01.000Z"));
assert.deepEqual(JSON.parse(fs.readFileSync(evidenceFixture, "utf8")).parents, [sha(2), sha(1)]);
fs.rmSync(evidenceFixture);
assert.throws(() => recordEvidence(evidenceFixture, recordEnv, (...args) => args[0] === "show" ? sha(2) : recordGit(...args), new Date("2026-01-31T00:00:01.000Z")), /exactly base and PR-head parents/);
assert.ok(!fs.existsSync(evidenceFixture), "invalid evidence is rejected before writing the proof file");

// The evidence checkout must expose both merge parents to git show %P.
const workflow = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.github/workflows/test.yml"), "utf8");
assert.match(workflow, /name: Checkout tested source for evidence[\s\S]*?ref: \$\{\{ github\.sha \}\}[\s\S]*?fetch-depth: 0[\s\S]*?persist-credentials: false/);
const mergeFixture = fs.mkdtempSync(path.join(os.tmpdir(), "pi-release-shallow-evidence-"));
try {
  const gitFixture = (...args) => execFileSync("git", args, { cwd: mergeFixture, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  gitFixture("init", "-q");
  gitFixture("config", "user.name", "Fixture");
  gitFixture("config", "user.email", "fixture@example.invalid");
  fs.writeFileSync(path.join(mergeFixture, "source.txt"), "fixture\n");
  gitFixture("add", "source.txt");
  const fixtureTree = gitFixture("write-tree");
  const baseParent = gitFixture("commit-tree", fixtureTree, "-m", "base");
  const headParent = gitFixture("commit-tree", fixtureTree, "-p", baseParent, "-m", "head");
  const mergeSha = gitFixture("commit-tree", fixtureTree, "-p", baseParent, "-p", headParent, "-m", "merge");
  gitFixture("update-ref", "HEAD", mergeSha);
  const fixtureEnv = { ...recordEnv, PR_BASE_SHA: baseParent, PR_HEAD_SHA: headParent, GITHUB_SHA: mergeSha };
  const fixtureProof = path.join(mergeFixture, "source.json");
  fs.writeFileSync(path.join(mergeFixture, ".git", "shallow"), `${mergeSha}\n`);
  assert.equal(gitFixture("show", "-s", "--format=%P", mergeSha), "", "depth-one merge boundary hides its parents from git show %P");
  assert.throws(() => recordEvidence(fixtureProof, fixtureEnv, gitFixture), /exactly base and PR-head parents/);
  assert.ok(!fs.existsSync(fixtureProof), "shallow evidence recording rejects without creating proof");
  fs.rmSync(path.join(mergeFixture, ".git", "shallow"));
  assert.deepEqual(gitFixture("show", "-s", "--format=%P", mergeSha).split(" "), [baseParent, headParent]);
  recordEvidence(fixtureProof, fixtureEnv, gitFixture);
  assert.deepEqual(JSON.parse(fs.readFileSync(fixtureProof, "utf8")).parents, [baseParent, headParent]);
} finally { fs.rmSync(mergeFixture, { recursive: true, force: true }); }

await assert.rejects(() => githubEvidence("fixture/project", run, pr, { api: () => ({ artifacts: [{ id: 9, name: "verified-source-2", expired: true, size_in_bytes: 128, created_at: run.created_at, workflow_run: { id: run.id } }] }), now: fixedNow }), /missing, oversized, or expired/);
for (const invalid of [{ ...proof, tree: sha(6) }, { ...proof, runAttempt: 1 }, { ...proof, baseSha: sha(7) }, { ...proof, workflow: "other.yml" }, { ...proof, repository: "attacker/project" }, { ...proof, createdAt: "2025-12-01T00:00:00.000Z" }, { ...proof, createdAt: "2026-02-01T00:10:00.000Z" }]) {
  assert.throws(() => validateEvidence(invalid, { repository: "fixture/project", run, pr, tree: sha(5), parent: sha(2), testedSha: sha(4) }, fixedNow));
}
await assert.rejects(() => verifySource({ repository: "fixture/project", sha: sha(3), git, api: async (route) => route.includes("/pulls?") ? [] : api(route), evidence: async () => proof, now: fixedNow }));
await assert.rejects(() => verifySource({ repository: "fixture/project", sha: sha(3), git: (...args) => args[0] === "show" && args[2] === "--format=%P" ? `${sha(2)} ${sha(8)}` : git(...args), api, evidence: async () => proof, now: fixedNow }));
await assert.rejects(() => verifySource({ repository: "fixture/project", sha: sha(3), git, api: async () => { throw Object.assign(new Error("forbidden"), { status: 403 }); }, evidence: async () => proof, now: fixedNow }), /forbidden/);
await assert.rejects(() => verifySource({ repository: "fixture/project", sha: sha(3), git, api: async (route) => route.includes("/git/commits/") ? { sha: sha(4), tree: { sha: sha(6) }, parents: [{ sha: sha(2) }, { sha: sha(1) }] } : api(route), evidence: async () => proof, now: fixedNow }));

// Version selection uses the Conventional Commits parser, including footers.
assert.deepEqual(selectReleaseVersion({ tags: [], commits: ["feat: initial feature"] }), { version: "0.1.0", tag: "v0.1.0", bootstrap: true, previous: null });
assert.deepEqual(selectReleaseVersion({ tags: [], commits: ["fix!: initial contract"] }), { version: "0.1.0", tag: "v0.1.0", bootstrap: true, previous: null });
assert.throws(() => selectReleaseVersion({ tags: [], commits: [] }), /requires relevant/);
assert.throws(() => selectReleaseVersion({ tags: [], commits: ["malformed bootstrap commit"] }));
assert.equal(selectReleaseVersion({ tags: ["v0.1.0"], commits: ["feat(ui): add panel"] }).version, "0.2.0");
assert.equal(selectReleaseVersion({ tags: ["v0.1.0"], commits: ["fix: resolve edge case"] }).version, "0.1.1");
assert.equal(selectReleaseVersion({ tags: ["v0.1.0"], commits: ["feat: add API\n\nBREAKING CHANGE: callers must migrate"] }).version, "1.0.0");
assert.equal(selectReleaseVersion({ tags: ["v0.1.0"], commits: ["fix: change API\n\nBREAKING-CHANGE: callers must migrate"] }).version, "1.0.0");
assert.equal(selectReleaseVersion({ tags: ["v0.4.0"], commits: ["fix!: change contract"] }).version, "1.0.0");
assert.equal(selectReleaseVersion({ tags: ["v0.1.0"], commits: ["chore: adjust build", "feat: add capability"] }).version, "0.2.0");
assert.equal(selectReleaseVersion({ tags: ["v0.1.0"], commits: ["docs: update usage"] }).version, "0.1.1");
assert.equal(selectReleaseVersion({ tags: ["v0.1.0"], commits: ["chore: update release process"] }).version, "0.1.1");
assert.throws(() => selectReleaseVersion({ tags: ["v0.1.0"], commits: ["not conventional"] }));
assert.throws(() => selectReleaseVersion({ tags: ["vbad"] , commits: [] }));

const source = { sha: sha(7), version: "0.1.0", tag: "v0.1.0" };
const bytes = Buffer.from("verified exact packed package bytes");
const artifact = { version: source.version, sourceSha: source.sha, integrity: artifactIntegrity(bytes), bytes };
const noMutationAfterInvalid = async (mutate) => {
  const adapter = makeAdapters();
  mutate(adapter.state);
  await assert.rejects(() => publishRelease({ source, artifact, packageName: "@fixture/pkg" }, adapter.api));
  assert.deepEqual(adapter.writes, [], "invalid state must be rejected before all remote writes");
};
function makeAdapters(initial = {}, packageVersion = source.version) {
  const state = { tag: null, npm: null, release: null, distTags: {}, npmReads: 0, ...(initial) };
  const writes = [];
  const api = {
    validateSource: async (identity) => { assert.equal(identity.sha, source.sha); },
    readTag: async () => state.tag,
    readNpm: async (_name, version) => version === packageVersion ? state.npm : state.latestMetadata,
    readRelease: async () => state.release,
    readDistTags: async () => state.distTags,
    publishTarball: async (_name, tarball, options) => { writes.push(`npm:${options.tag}`); assert.deepEqual(tarball, bytes); state.npm = { version: source.version, gitHead: source.sha, dist: { integrity: artifact.integrity } }; },
    waitForNpm: async () => state.npm,
    createTag: async (tag, shaValue) => { writes.push(`tag:${tag}`); state.tag = { sha: shaValue }; },
    createRelease: async (tag, shaValue) => { writes.push(`release:${tag}`); state.release = { tag_name: tag, targetSha: shaValue }; },
    promoteLatest: async (_name, version) => { writes.push(`latest:${version}`); state.distTags.latest = version; },
  };
  return { state, writes, api };
}

// Prepared cross-job artifact metadata, digest and caller outputs must agree before adapters can write.
const preparedDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-release-prepared-test-"));
try {
  fs.writeFileSync(path.join(preparedDir, "release.tgz"), bytes);
  const preparedInfo = { source: { sha: source.sha, version: source.version, tag: source.tag }, mode: "release", integrity: artifact.integrity };
  fs.writeFileSync(path.join(preparedDir, "release.json"), JSON.stringify(preparedInfo));
  const preparedAdapter = makeAdapters();
  const preparedResult = await publishPrepared(preparedDir, { repository: "fixture/project", sourceSha: source.sha, trustedSha: sha(2), expectedVersion: source.version, expectedTag: source.tag, expectedMode: "release", expectedIntegrity: artifact.integrity, adapters: preparedAdapter.api });
  assert.equal(preparedResult.version, source.version);
  assert.deepEqual(preparedAdapter.writes, ["tag:v0.1.0", "npm:pi-release-candidate", "release:v0.1.0", "latest:0.1.0"]);
  const noWriteForPreparedError = async (changes, options) => {
    fs.writeFileSync(path.join(preparedDir, "release.json"), JSON.stringify({ ...preparedInfo, ...changes }));
    const adapter = makeAdapters();
    await assert.rejects(() => publishPrepared(preparedDir, { repository: "fixture/project", sourceSha: source.sha, trustedSha: sha(2), expectedVersion: source.version, expectedTag: source.tag, expectedMode: "release", expectedIntegrity: artifact.integrity, adapters: adapter.api, ...options }));
    assert.deepEqual(adapter.writes, []);
  };
  await noWriteForPreparedError({ integrity: "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==" });
  await noWriteForPreparedError({ mode: "unknown" });
  await noWriteForPreparedError({}, { recoveryTag: "v0.2.0" });
} finally { fs.rmSync(preparedDir, { recursive: true, force: true }); }

// No pre-existing output: bootstrap and normal release share the same publisher.
const initial = makeAdapters();
const published = await publishRelease({ source, artifact, packageName: "@fixture/pkg" }, initial.api);
assert.deepEqual(published, { version: "0.1.0", tag: "v0.1.0", published: true, createdTag: true, createdRelease: true, promotedLatest: true });
assert.deepEqual(initial.writes, ["tag:v0.1.0", "npm:pi-release-candidate", "release:v0.1.0", "latest:0.1.0"]);
const normalSource = { sha: sha(4), version: "0.2.0", tag: "v0.2.0" };
const normalBytes = Buffer.from("normal selected-version artifact");
const normalArtifact = { version: normalSource.version, sourceSha: normalSource.sha, integrity: artifactIntegrity(normalBytes), bytes: normalBytes };
const normal = makeAdapters({ distTags: { latest: "0.1.0" }, latestMetadata: { version: "0.1.0", gitHead: source.sha, dist: { integrity: artifact.integrity } } }, normalSource.version);
normal.api.validateSource = async (identity) => { assert.equal(identity.sha, normalSource.sha); };
normal.api.publishTarball = async (_name, tarball, options) => { normal.writes.push(`npm:${options.tag}`); assert.deepEqual(tarball, normalBytes); normal.state.npm = { version: "0.2.0", gitHead: normalSource.sha, dist: { integrity: normalArtifact.integrity } }; };
await publishRelease({ source: normalSource, artifact: normalArtifact, packageName: "@fixture/pkg" }, normal.api);
assert.deepEqual(normal.writes, ["tag:v0.2.0", "npm:pi-release-candidate", "release:v0.2.0", "latest:0.2.0"]);

// Recovery resumes each partial state after verifying all existing identities.
const npmOnly = makeAdapters({ npm: { version: source.version, gitHead: source.sha, dist: { integrity: artifact.integrity } } });
await assert.rejects(() => publishRelease({ source, artifact, packageName: "@fixture/pkg" }, npmOnly.api, { mode: "recovery" }), /requires an existing stable tag/);
assert.deepEqual(npmOnly.writes, [], "recovery blocks a pre-existing npm-only state without silently creating history");
const npmWithTag = makeAdapters({ tag: { sha: source.sha }, npm: { version: source.version, gitHead: source.sha, dist: { integrity: artifact.integrity } } });
assert.equal((await publishRelease({ source, artifact, packageName: "@fixture/pkg" }, npmWithTag.api, { mode: "recovery" })).createdRelease, true);
assert.deepEqual(npmWithTag.writes, ["release:v0.1.0", "latest:0.1.0"]);
const tagOnly = makeAdapters({ tag: { sha: source.sha } });
await publishRelease({ source, artifact, packageName: "@fixture/pkg" }, tagOnly.api, { mode: "recovery" });
assert.deepEqual(tagOnly.writes, ["npm:pi-release-candidate", "release:v0.1.0", "latest:0.1.0"]);
const releaseOnly = makeAdapters({ tag: { sha: source.sha }, npm: { version: source.version, gitHead: source.sha, dist: { integrity: artifact.integrity } }, release: { tag_name: source.tag, name: source.tag, body: "", targetSha: source.sha, draft: false, prerelease: false, assets: [] } });
assert.deepEqual((await publishRelease({ source, artifact, packageName: "@fixture/pkg" }, releaseOnly.api, { mode: "recovery" })).promotedLatest, true);
assert.deepEqual(releaseOnly.writes, ["latest:0.1.0"]);
const complete = makeAdapters({ tag: { sha: source.sha }, npm: { version: source.version, gitHead: source.sha, dist: { integrity: artifact.integrity } }, release: { tag_name: source.tag, name: source.tag, body: "", targetSha: source.sha, draft: false, prerelease: false, assets: [] }, distTags: { latest: source.version } });
assert.deepEqual(await publishRelease({ source, artifact, packageName: "@fixture/pkg" }, complete.api, { mode: "recovery" }), { version: source.version, tag: source.tag, published: false, createdTag: false, createdRelease: false, promotedLatest: false });
assert.deepEqual(complete.writes, []);

await noMutationAfterInvalid((state) => { state.tag = { sha: sha(8) }; });
await noMutationAfterInvalid((state) => { state.npm = { version: source.version, gitHead: sha(8), dist: { integrity: artifact.integrity } }; });
await noMutationAfterInvalid((state) => { state.npm = { version: source.version, gitHead: source.sha, dist: { integrity: "sha512-wrong" } }; });
await noMutationAfterInvalid((state) => { state.release = { tag_name: source.tag, name: source.tag, body: "", targetSha: sha(8), draft: false, prerelease: false, assets: [] }; });
await noMutationAfterInvalid((state) => { state.release = { tag_name: source.tag, name: source.tag, body: "", targetSha: source.sha, draft: true, prerelease: false, assets: [] }; });
await noMutationAfterInvalid((state) => { state.release = { tag_name: source.tag, name: source.tag, body: "conflicting release notes", targetSha: source.sha, draft: false, prerelease: false, assets: [] }; });
await noMutationAfterInvalid((state) => { state.release = { tag_name: source.tag, name: source.tag, body: "", targetSha: source.sha, draft: false, prerelease: false, assets: [{ name: "unexpected.zip" }] }; });
await noMutationAfterInvalid((state) => { state.distTags = { latest: "bad-version" }; });
const mismatchedArtifact = { ...artifact, bytes: Buffer.from("different prepared bytes") };
const mismatchBytesAdapter = makeAdapters();
await assert.rejects(() => publishRelease({ source, artifact: mismatchedArtifact, packageName: "@fixture/pkg" }, mismatchBytesAdapter.api));
assert.deepEqual(mismatchBytesAdapter.writes, []);
const mismatchVersionAdapter = makeAdapters();
await assert.rejects(() => publishRelease({ source, artifact: { ...artifact, version: "0.2.0" }, packageName: "@fixture/pkg" }, mismatchVersionAdapter.api));
assert.deepEqual(mismatchVersionAdapter.writes, []);
const forbiddenCalls = makeAdapters();
forbiddenCalls.api.validateSource = async () => { throw new Error("source invalid"); };
await assert.rejects(() => publishRelease({ source, artifact, packageName: "@fixture/pkg" }, forbiddenCalls.api));
assert.deepEqual(forbiddenCalls.writes, []);

// Only exact 404 is absence; auth/network failures abort before writes.
assert.equal(await missingOnlyOn404(async () => { throw Object.assign(new Error("not found"), { status: 404 }); }), null);
assert.equal(await missingOnlyOn404(async () => { throw Object.assign(new Error("not found"), { code: "E404" }); }), null);
await assert.rejects(() => missingOnlyOn404(async () => { throw Object.assign(new Error("forbidden"), { status: 403 }); }));
await assert.rejects(() => missingOnlyOn404(async () => { throw new Error("network timeout"); }));
for (const error of [Object.assign(new Error("403 forbidden"), { status: 403 }), new Error("network timeout"), new Error("malformed registry response")]) {
  const adapter = makeAdapters();
  adapter.api.readNpm = async () => { throw error; };
  await assert.rejects(() => publishRelease({ source, artifact, packageName: "@fixture/pkg" }, adapter.api));
  assert.deepEqual(adapter.writes, []);
}

// A delayed registry view is retried within the adapter's bounded visibility wait.
const delayed = makeAdapters();
let visibilityReads = 0;
const originalReadNpm = delayed.api.readNpm;
delayed.api.readNpm = async (...args) => {
  visibilityReads++;
  if (visibilityReads < 4) return null;
  return originalReadNpm(...args);
};
assert.equal((await publishRelease({ source, artifact, packageName: "@fixture/pkg" }, delayed.api, { attempts: 4, delayMs: 0, sleep: async () => {} })).published, true);
assert.equal(visibilityReads, 4);
await assert.rejects(() => waitForNpm({ readNpm: async () => null, sleep: async () => {} }, "@fixture/pkg", source, artifact, { attempts: 2, delayMs: 0 }), /did not become visible/);
let authVisibilityReads = 0;
await assert.rejects(() => waitForNpm({ readNpm: async () => { authVisibilityReads++; throw Object.assign(new Error("unauthorized"), { status: 403 }); }, sleep: async () => {} }, "@fixture/pkg", source, artifact, { attempts: 5, delayMs: 0 }));
assert.equal(authVisibilityReads, 1, "auth failures are not retried as registry propagation");
const authAfterPublish = makeAdapters();
let authReadCount = 0;
authAfterPublish.api.readNpm = async () => {
  authReadCount++;
  if (authReadCount === 1) return null;
  throw Object.assign(new Error("registry authentication required"), { status: 403 });
};
await assert.rejects(() => publishRelease({ source, artifact, packageName: "@fixture/pkg" }, authAfterPublish.api, { attempts: 5, delayMs: 0, sleep: async () => {} }));
assert.deepEqual(authAfterPublish.writes, ["tag:v0.1.0", "npm:pi-release-candidate"], "auth error after publish halts later GitHub/latest writes");
assert.equal(authReadCount, 2, "auth error during visibility check is not retried");

// Recovery of an old version uses non-latest staging and cannot regress latest.
const olderSource = { sha: sha(9), version: "0.8.0", tag: "v0.8.0" };
const newerSha = sha(6);
const olderBytes = Buffer.from("older exact tarball");
const olderArtifact = { version: olderSource.version, sourceSha: olderSource.sha, integrity: artifactIntegrity(olderBytes), bytes: olderBytes };
const newerBytes = Buffer.from("valid newer latest artifact");
const older = makeAdapters({ distTags: { latest: "1.0.0" }, latestMetadata: { version: "1.0.0", gitHead: newerSha, dist: { integrity: artifactIntegrity(newerBytes) } } }, olderSource.version);
older.api.validateSource = async (identity) => { assert.equal(identity.sha, olderSource.sha); };
older.api.publishTarball = async (_name, tarball, options) => { older.writes.push(`npm:${options.tag}`); assert.deepEqual(tarball, olderBytes); older.state.npm = { version: "0.8.0", gitHead: olderSource.sha, dist: { integrity: olderArtifact.integrity } }; };
older.api.waitForNpm = async () => older.state.npm;
await publishRelease({ source: olderSource, artifact: olderArtifact, packageName: "@fixture/pkg" }, older.api);
assert.ok(older.writes.includes("npm:pi-release-candidate"));
assert.ok(!older.writes.some((write) => write.startsWith("latest:")));

// Re-read dist-tags after publication: another release can advance latest while visibility waits.
const race = makeAdapters({ distTags: { latest: "0.9.0" }, latestMetadata: { version: "0.9.0", gitHead: sha(5), dist: { integrity: artifactIntegrity(Buffer.from("prior latest")) } } }, olderSource.version);
race.api.validateSource = async () => {};
race.api.publishTarball = async (_name, tarball, options) => {
  race.writes.push(`npm:${options.tag}`);
  assert.deepEqual(tarball, olderBytes);
  race.state.npm = { version: olderSource.version, gitHead: olderSource.sha, dist: { integrity: olderArtifact.integrity } };
  race.state.distTags.latest = "1.0.0";
  race.state.latestMetadata = { version: "1.0.0", gitHead: newerSha, dist: { integrity: artifactIntegrity(newerBytes) } };
};
await publishRelease({ source: olderSource, artifact: olderArtifact, packageName: "@fixture/pkg" }, race.api);
assert.ok(!race.writes.some((write) => write.startsWith("latest:")), "fresh newer latest is not downgraded");
await noMutationAfterInvalid((state) => { state.distTags = { latest: "1.0.0" }; state.latestMetadata = { version: "1.0.0", gitHead: sha(6), dist: { integrity: "sha512-YWJjZA==" } }; });

// Prepare a real tarball from an isolated disposable git fixture, then verify exact staged version and package bytes.
const thisRepo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "pi-release-coordinator-fixture-"));
try {
  const fixture = path.join(work, "repo");
  fs.mkdirSync(fixture);
  const fixtureEnv = isolatedPreparationEnv(work, { ...process.env, GH_TOKEN: "hostile-gh-token", NPM_TOKEN: "hostile-npm-token", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "hostile-oidc-token", ANTHROPIC_API_KEY: "hostile-provider-key" });
  const envProbe = execFileSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify({home:process.env.HOME,agent:process.env.PI_CODING_AGENT_DIR,gh:process.env.GH_TOKEN,npm:process.env.NPM_TOKEN,oidc:process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,api:process.env.ANTHROPIC_API_KEY}))"], { env: fixtureEnv, encoding: "utf8" });
  const probedEnv = JSON.parse(envProbe);
  assert.equal(probedEnv.home, fixtureEnv.HOME);
  assert.equal(probedEnv.agent, fixtureEnv.PI_CODING_AGENT_DIR);
  assert.equal(probedEnv.gh, undefined);
  assert.equal(probedEnv.npm, undefined);
  assert.equal(probedEnv.oidc, undefined);
  assert.equal(probedEnv.api, undefined);
  assert.equal(fixtureEnv.GH_TOKEN, undefined);
  assert.equal(fixtureEnv.NPM_TOKEN, undefined);
  assert.equal(fixtureEnv.ACTIONS_ID_TOKEN_REQUEST_TOKEN, undefined);
  assert.equal(fixtureEnv.ANTHROPIC_API_KEY, undefined);
  assert.equal(fixtureEnv.PI_CODING_AGENT_DIR, path.join(fixtureEnv.HOME, ".pi", "agent"));
  for (const name of ["extensions", "tests", "README.md", "LICENSE", "package.json", "package-lock.json"]) {
    const from = path.join(thisRepo, name);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(fixture, name), { recursive: true });
  }
  fs.symlinkSync(path.join(thisRepo, "node_modules"), path.join(fixture, "node_modules"), "dir");
  const gitRun = (args) => execFileSync("git", args, { cwd: fixture, env: fixtureEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  gitRun(["init", "-q"]);
  gitRun(["config", "user.name", "Fixture"]);
  gitRun(["config", "user.email", "fixture@example.invalid"]);
  gitRun(["add", "extensions", "tests", "README.md", "LICENSE", "package.json", "package-lock.json"]);
  gitRun(["commit", "-qm", "feat: disposable release fixture"]);
  const fixtureSha = gitRun(["rev-parse", "HEAD"]).trim();
  const runtimePath = "extensions/skill-autocomplete.ts";
  const committedRuntime = gitRun(["show", `${fixtureSha}:${runtimePath}`]);
  const committedLockText = gitRun(["show", `${fixtureSha}:package-lock.json`]);
  fs.appendFileSync(path.join(fixture, runtimePath), "\n// uncommitted fixture mutation must not ship\n");
  const dirtyRuntime = fs.readFileSync(path.join(fixture, runtimePath), "utf8");
  const dirtyLock = JSON.parse(committedLockText);
  dirtyLock.version = "9.9.9";
  dirtyLock.packages[""].version = "9.9.9";
  fs.writeFileSync(path.join(fixture, "package-lock.json"), `${JSON.stringify(dirtyLock, null, 2)}\n`);
  const prepareRoot = path.join(work, "prepared");
  const prepared = prepareArtifact({ sourceRoot: fixture, trustedRoot: thisRepo, sourceSha: fixtureSha, version: "0.2.0", workRoot: prepareRoot });
  assert.equal(prepared.sourceSha, fixtureSha);
  assert.equal(prepared.version, "0.2.0");
  const stagedRuntime = fs.readFileSync(path.join(prepared.workRoot, "stage", runtimePath), "utf8");
  assert.equal(stagedRuntime, committedRuntime, "preparation reads runtime bytes from the immutable source commit, not dirty worktree");
  assert.ok(!stagedRuntime.includes("uncommitted fixture mutation"));
  assert.equal(fs.readFileSync(path.join(fixture, runtimePath), "utf8"), dirtyRuntime, "preparation does not modify worktree files");
  const stagedManifest = JSON.parse(fs.readFileSync(path.join(prepared.workRoot, "unpacked/package/package.json"), "utf8"));
  assert.equal(stagedManifest.version, "0.2.0");
  assert.equal(stagedManifest.gitHead, fixtureSha);
  const stagedLock = JSON.parse(fs.readFileSync(path.join(prepared.workRoot, "stage", "package-lock.json"), "utf8"));
  assert.equal(stagedLock.version, prepared.version);
  assert.equal(stagedLock.packages[""].version, prepared.version);
  const committedLock = JSON.parse(committedLockText);
  assert.deepEqual(stagedLock.packages[""].devDependencies, committedLock.packages[""].devDependencies, "staged lock content comes from the verified commit");
  assert.equal(JSON.parse(fs.readFileSync(path.join(fixture, "package-lock.json"), "utf8")).version, "9.9.9", "preparation leaves dirty source lock bytes untouched");
  assert.equal(prepared.integrity, artifactIntegrity(prepared.bytes));
  assert.deepEqual(prepared.bytes, fs.readFileSync(path.join(prepared.workRoot, prepared.filename)), "publisher bytes are the exact validated tarball");
  assert.equal(JSON.parse(fs.readFileSync(path.join(fixture, "package.json"), "utf8")).version, "0.1.0", "staging did not mutate source checkout");

  const releaseState = { tag: null, npm: null, release: null, distTags: {} };
  const releaseWrites = [];
  const releaseAdapters = {
    validateSource: async () => {},
    readTag: async () => releaseState.tag,
    readNpm: async (_name, version) => version === "0.1.0" || version === releaseState.distTags.latest ? releaseState.npm : null,
    readRelease: async () => releaseState.release,
    readDistTags: async () => releaseState.distTags,
    createTag: async (tag, tagSha) => { releaseWrites.push(`tag:${tag}`); releaseState.tag = { sha: tagSha }; },
    publishTarball: async (_name, tarball, { tag }) => { releaseWrites.push(`npm:${tag}`); releaseState.npm = { version: "0.1.0", gitHead: fixtureSha, dist: { integrity: artifactIntegrity(tarball) } }; },
    createRelease: async (tag, tagSha) => { releaseWrites.push(`release:${tag}`); releaseState.release = { tag_name: tag, name: tag, body: "", targetSha: tagSha, draft: false, prerelease: false, assets: [] }; },
    promoteLatest: async (_name, version) => { releaseWrites.push(`latest:${version}`); releaseState.distTags.latest = version; },
  };
  const firstRun = await runRelease({ root: fixture, trustedRoot: thisRepo, sourceSha: fixtureSha, repository: "fixture/project", adapters: releaseAdapters, workRoot: path.join(work, "entrypoint-stage") });
  assert.equal(firstRun.version, "0.1.0", "first verified merge enters the dedicated 0.1.0 bootstrap path");
  assert.deepEqual(releaseWrites, ["tag:v0.1.0", "npm:pi-release-candidate", "release:v0.1.0", "latest:0.1.0"]);
  gitRun(["tag", "v0.1.0", fixtureSha]);
  const writesBeforeRecovery = releaseWrites.slice();
  const retry = await runRelease({ root: fixture, trustedRoot: thisRepo, sourceSha: fixtureSha, repository: "fixture/project", adapters: releaseAdapters, workRoot: path.join(work, "entrypoint-retry") });
  assert.equal(retry.version, "0.1.0", "same-source retry recovers the existing version instead of selecting another bump");
  assert.deepEqual(releaseWrites, writesBeforeRecovery, "complete same-source retry is idempotent");

  fs.writeFileSync(path.join(fixture, "next.txt"), "next release fixture\n");
  gitRun(["add", "next.txt"]);
  gitRun(["commit", "-qm", "feat: next release fixture"]);
  const nextSha = gitRun(["rev-parse", "HEAD"]).trim();
  const incompletePrevious = { ...releaseAdapters, readNpm: async () => null };
  await assert.rejects(() => runRelease({ root: fixture, trustedRoot: thisRepo, sourceSha: nextSha, repository: "fixture/project", adapters: incompletePrevious, prepareOnly: true }), /previous stable release v0.1.0 is incomplete/);
  assert.deepEqual(releaseWrites, writesBeforeRecovery, "incomplete earlier stable releases stop before any write or next-version preparation");
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

console.log("Source evidence freshness/ancestry, release selection, exact staged and transferred bytes, mocked GitHub/npm adapters, isolated CLI publish options, recovery/idempotency, and prior-partial fail-closed tests PASS");
