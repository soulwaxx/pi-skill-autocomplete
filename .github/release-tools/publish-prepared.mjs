import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";
import { createAdapters } from "./adapters.mjs";
import { artifactIntegrity, publishRelease } from "./release-coordinator.mjs";

const tagPattern = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const shaPattern = /^[0-9a-f]{40}$/;
const integrityPattern = /^sha512-[A-Za-z0-9+/]{86}==$/;

export function readPrepared(directory, { sourceSha, trustedSha, expectedVersion, expectedTag, expectedMode, expectedIntegrity, recoveryTag = null } = {}) {
  assert.equal(path.resolve(directory), directory, "prepared artifact directory must be an absolute normalized path");
  assert.match(directory, /^\/[A-Za-z0-9_./-]+$/, "prepared artifact directory must be an absolute runner path");
  assert.match(sourceSha ?? "", shaPattern);
  assert.match(trustedSha ?? "", shaPattern);
  assert.ok(expectedMode === "release" || expectedMode === "recovery");
  assert.match(expectedVersion ?? "", /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  assert.match(expectedTag ?? "", tagPattern);
  assert.match(expectedIntegrity ?? "", integrityPattern);
  const metadataPath = path.join(directory, "release.json");
  const tarballPath = path.join(directory, "release.tgz");
  assert.ok(fs.lstatSync(directory).isDirectory() && !fs.lstatSync(directory).isSymbolicLink(), "prepared artifact directory must be a real directory");
  assert.ok(fs.lstatSync(metadataPath).isFile() && !fs.lstatSync(metadataPath).isSymbolicLink(), "release metadata must be a regular file");
  assert.ok(fs.lstatSync(tarballPath).isFile() && !fs.lstatSync(tarballPath).isSymbolicLink(), "prepared package must be a regular file");
  assert.ok(fs.statSync(metadataPath).size > 0 && fs.statSync(metadataPath).size <= 8192, "release metadata is missing or oversized");
  const info = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  assert.deepEqual(Object.keys(info).sort(), ["integrity", "mode", "source"], "prepared release metadata has unexpected fields");
  assert.ok(info.source && typeof info.source === "object" && !Array.isArray(info.source), "prepared release source is malformed");
  assert.deepEqual(Object.keys(info.source).sort(), ["sha", "tag", "version"], "prepared release source has unexpected fields");
  assert.ok(info.mode === "release" || info.mode === "recovery", "prepared release mode is invalid");
  const { sha, version, tag } = info.source;
  assert.match(sha ?? "", shaPattern);
  assert.equal(sha, sourceSha, "prepared artifact source differs from verified source SHA");
  assert.equal(version, expectedVersion, "prepared artifact version differs from verified job output");
  assert.equal(tag, expectedTag, "prepared artifact tag differs from verified job output");
  assert.equal(info.mode, expectedMode, "prepared artifact mode differs from verified job output");
  assert.ok(semver.valid(version) && !semver.prerelease(version));
  assert.equal(tag, `v${version}`);
  if (recoveryTag !== null) {
    assert.match(recoveryTag, tagPattern);
    assert.equal(info.mode, "recovery", "manual recovery must use recovery mode");
    assert.equal(tag, recoveryTag, "prepared artifact differs from the requested existing recovery tag");
  }
  assert.match(info.integrity ?? "", integrityPattern);
  assert.equal(info.integrity, expectedIntegrity, "prepared artifact integrity differs from verified job output");
  const stats = fs.statSync(tarballPath);
  assert.ok(stats.size > 0 && stats.size <= 10 * 1024 * 1024, "prepared package tarball is missing or oversized");
  const bytes = fs.readFileSync(tarballPath);
  assert.equal(artifactIntegrity(bytes), info.integrity, "prepared tarball changed after read-only verification");
  return { source: { sha, version, tag }, artifact: { bytes, version, sourceSha: sha, integrity: info.integrity }, mode: info.mode };
}

export async function publishPrepared(directory, options = {}) {
  const { source, artifact, mode } = readPrepared(directory, options);
  const api = options.adapters ?? await createAdapters({ repository: options.repository, trustedSha: options.trustedSha });
  return publishRelease({ source, artifact, packageName: "@soulwaxx/pi-skill-autocomplete" }, api, { mode });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory] = process.argv.slice(2);
  assert.ok(directory, "prepared artifact directory is required");
  const result = await publishPrepared(directory, {
    repository: process.env.GITHUB_REPOSITORY,
    sourceSha: process.env.SOURCE_SHA,
    trustedSha: process.env.TRUSTED_SHA,
    expectedVersion: process.env.PREPARED_VERSION,
    expectedTag: process.env.PREPARED_TAG,
    expectedMode: process.env.PREPARED_MODE,
    expectedIntegrity: process.env.PREPARED_INTEGRITY,
    recoveryTag: process.env.RECOVERY_TAG || null,
  });
  console.log(JSON.stringify(result));
}
