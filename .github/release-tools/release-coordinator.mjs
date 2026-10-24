import assert from "node:assert/strict";
import { CommitParser } from "conventional-commits-parser";
import semver from "semver";
import { createHash } from "node:crypto";

const stableTag = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const shaPattern = /^[0-9a-f]{40}$/;
const parser = new CommitParser({
  headerPattern: /^(\w*)(?:\(([^)]+)\))?(!)?: (.+)$/,
  headerCorrespondence: ["type", "scope", "breaking", "subject"],
});
const releaseTypes = new Set(["build", "chore", "ci", "docs", "feat", "fix", "perf", "refactor", "revert", "style", "test"]);

export function parseReleaseCommit(message) {
  const parsed = parser.parse(message);
  assert.ok(parsed.type && releaseTypes.has(parsed.type) && parsed.subject, `invalid or unsupported Conventional Commit: ${message}`);
  return { type: parsed.type, breaking: Boolean(parsed.breaking) || parsed.notes.some((note) => /^BREAKING[ -]CHANGE$/i.test(note.title)) };
}

export function latestStableTag(tags) {
  const versions = [];
  for (const tag of tags) {
    if (!tag.startsWith("v")) continue;
    assert.ok(stableTag.test(tag), `invalid or prerelease tag in release history: ${tag}`);
    versions.push(tag.slice(1));
  }
  versions.sort(semver.rcompare);
  return versions[0] ?? null;
}

export function selectReleaseVersion({ tags, commits }) {
  const previous = latestStableTag(tags);
  assert.ok(Array.isArray(commits) && commits.length > 0, "release selection requires relevant Conventional Commit messages");
  const parsedCommits = commits.map(parseReleaseCommit);
  if (!previous) return { version: "0.1.0", tag: "v0.1.0", bootstrap: true, previous: null };
  let bump = null;
  for (let index = 0; index < commits.length; index++) {
    const commit = parsedCommits[index];
    const candidate = commit.breaking ? "major" : commit.type === "feat" ? "minor" : "patch";
    if (bump === null || semver.gt(semver.inc(previous, candidate), semver.inc(previous, bump))) bump = candidate;
  }
  if (!bump) return null;
  const version = semver.inc(previous, bump);
  assert.ok(version, "could not calculate next stable release");
  return { version, tag: `v${version}`, bootstrap: false, previous };
}

export function artifactIntegrity(bytes) {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

export async function missingOnlyOn404(read) {
  try {
    return await read();
  } catch (error) {
    if (error?.status === 404 || error?.code === "E404") return null;
    throw error;
  }
}

function assertSource(source) {
  assert.ok(source && shaPattern.test(source.sha), "release source SHA is malformed");
  assert.equal(source.tag, `v${source.version}`, "release tag/version mismatch");
  assert.ok(semver.valid(source.version) && !semver.prerelease(source.version), "release requires a stable SemVer version");
}

function validateExisting({ source, artifact, tag, npm, release }) {
  if (tag !== null) assert.equal(tag.sha, source.sha, "immutable Git tag points to different source");
  if (npm !== null) {
    assert.equal(npm.version, source.version, "registry returned a different version");
    assert.equal(npm.gitHead, source.sha, "existing npm version belongs to different source");
    assert.equal(npm.dist?.integrity, artifact.integrity, "existing npm artifact bytes differ from the prepared artifact");
  }
  if (release !== null) {
    assert.equal(release.tag_name, source.tag, "GitHub Release tag mismatch");
    assert.equal(release.name, source.tag, "existing GitHub Release title conflicts with the canonical tag");
    assert.equal(release.body, "", "existing GitHub Release body conflicts with the canonical empty release notes");
    assert.equal(release.targetSha, source.sha, "existing GitHub Release points to different source");
    assert.equal(release.draft, false, "existing GitHub Release is still a draft");
    assert.equal(release.prerelease, false, "existing GitHub Release is a prerelease");
    assert.deepEqual(release.assets, [], "existing GitHub Release has unexpected immutable assets");
  }
}

function compareStable(a, b) {
  assert.ok(semver.valid(a) && !semver.prerelease(a) && semver.valid(semver.clean(a)), `invalid latest version ${a}`);
  assert.ok(semver.valid(b) && !semver.prerelease(b) && semver.valid(semver.clean(b)), `invalid release version ${b}`);
  assert.equal(semver.clean(a), a, `latest version is not canonical: ${a}`);
  assert.equal(semver.clean(b), b, `release version is not canonical: ${b}`);
  return semver.compare(a, b);
}

function validIntegrity(value) {
  if (typeof value !== "string" || !value.startsWith("sha512-")) return false;
  const encoded = value.slice("sha512-".length);
  const bytes = Buffer.from(encoded, "base64");
  return bytes.length === 64 && bytes.toString("base64") === encoded;
}

async function readLatest(adapters, packageName) {
  const latest = (await adapters.readDistTags(packageName)).latest ?? null;
  if (latest === null) return null;
  assert.ok(semver.valid(latest) && !semver.prerelease(latest) && semver.clean(latest) === latest, "registry latest tag is malformed, noncanonical, or prerelease");
  const metadata = await adapters.readNpm(packageName, latest);
  assert.ok(metadata, "registry latest points at a missing package version");
  assert.equal(metadata.version, latest, "registry latest metadata identity mismatch");
  assert.match(metadata.gitHead ?? "", shaPattern, "registry latest source identity is malformed");
  assert.ok(validIntegrity(metadata.dist?.integrity), "registry latest SRI must be a SHA-512 digest");
  return latest;
}

/**
 * Idempotent publisher shared by bootstrap, ordinary releases, and recovery.
 * All source/artifact/remote identities are checked before the first mutation.
 * Adapters must map only exact remote 404 responses to null; every other read
 * error must reject.
 */
export async function waitForNpm({ readNpm, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }, packageName, source, artifact, { attempts = 90, delayMs = 10000 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const info = await readNpm(packageName, source.version);
    if (info !== null) {
      assert.equal(info.version, source.version);
      assert.equal(info.gitHead, source.sha);
      assert.equal(info.dist?.integrity, artifact.integrity);
      return info;
    }
    if (attempt + 1 < attempts) await sleep(delayMs);
  }
  throw new Error(`npm ${packageName}@${source.version} did not become visible after ${attempts} checks`);
}

export async function publishRelease({ source, artifact, packageName }, adapters, { mode = "release", ...visibility } = {}) {
  assert.ok(mode === "release" || mode === "recovery", "publisher mode must be release or recovery");
  assertSource(source);
  assert.equal(artifact.version, source.version);
  assert.equal(artifact.sourceSha, source.sha);
  assert.ok(Buffer.isBuffer(artifact.bytes) && artifact.bytes.length > 0, "prepared artifact is empty");
  assert.equal(artifact.integrity, artifactIntegrity(artifact.bytes), "prepared bytes/integrity disagree");
  await adapters.validateSource(source, { mode });

  assert.match(packageName, /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/, "package name must be a canonical scoped npm name");
  const [tag, npm, release, latestAtPreflight] = await Promise.all([
    adapters.readTag(source.tag),
    adapters.readNpm(packageName, source.version),
    adapters.readRelease(source.tag),
    readLatest(adapters, packageName),
  ]);
  validateExisting({ source, artifact, tag, npm, release });
  assert.ok(latestAtPreflight === null || typeof latestAtPreflight === "string", "preflight latest version is invalid");
  if (mode === "recovery" && tag === null) assert.fail("recovery requires an existing stable tag; npm-only historical states need manual source review");
  if (tag === null && (npm !== null || release !== null)) assert.fail("incomplete release state has immutable outputs but no source tag; manual recovery review is required");

  // Create the exact-source tag first so an interrupted npm publication always
  // has a stable, source-verified tag from which the shared recovery path can run.
  if (tag === null) {
    await adapters.validateSource(source, { mode });
    await adapters.createTag(source.tag, source.sha);
  }
  if (npm === null) {
    await adapters.validateSource(source, { mode });
    await adapters.publishTarball(packageName, artifact.bytes, { tag: "pi-release-candidate" });
    const visible = await waitForNpm(adapters, packageName, source, artifact, visibility);
    assert.equal(visible.version, source.version);
    assert.equal(visible.gitHead, source.sha);
    assert.equal(visible.dist?.integrity, artifact.integrity);
  }
  if (release === null) {
    await adapters.validateSource(source, { mode });
    await adapters.createRelease(source.tag, source.sha);
  }

  // Re-read just before promotion: never act on the stale pre-publication value.
  const latest = await readLatest(adapters, packageName);
  const promotedLatest = latest === null || compareStable(source.version, latest) > 0;
  if (promotedLatest) {
    await adapters.validateSource(source, { mode });
    await adapters.promoteLatest(packageName, source.version);
  }
  return { version: source.version, tag: source.tag, published: npm === null, createdTag: tag === null, createdRelease: release === null, promotedLatest };
}
