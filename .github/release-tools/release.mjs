import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import semver from "semver";
import { createAdapters } from "./adapters.mjs";
import { prepareArtifact } from "./prepare-artifact.mjs";
import { latestStableTag, publishRelease, selectReleaseVersion } from "./release-coordinator.mjs";

const tagPattern = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const shaPattern = /^[0-9a-f]{40}$/;

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 15_000, maxBuffer: 2 * 1024 * 1024 }).trim();
}

async function assertPreviousReleaseComplete(tag, root, adapters) {
  const version = tag.slice(1);
  const sha = git(root, "rev-parse", `${tag}^{commit}`);
  try {
    const [remoteTag, npm, release] = await Promise.all([
      adapters.readTag(tag),
      adapters.readNpm("@soulwaxx/pi-skill-autocomplete", version),
      adapters.readRelease(tag),
    ]);
    assert.equal(remoteTag?.sha, sha, "stable tag source differs from local history");
    assert.ok(npm, "npm version is missing");
    assert.equal(npm.version, version);
    assert.equal(npm.gitHead, sha);
    const integrity = npm.dist?.integrity;
    assert.match(integrity ?? "", /^sha512-[A-Za-z0-9+/]{86}==$/);
    assert.ok(release, "GitHub Release is missing");
    assert.equal(release.targetSha, sha);
    assert.equal(release.tag_name, tag);
    assert.equal(release.name, tag);
    assert.equal(release.body, "");
    assert.equal(release.draft, false);
    assert.equal(release.prerelease, false);
    assert.deepEqual(release.assets, []);
  } catch (error) {
    throw new Error(`previous stable release ${tag} is incomplete or conflicting; run the existing-tag recovery workflow before releasing a newer version`, { cause: error });
  }
}

function reachableStableTags(cwd, sourceSha) {
  const tags = git(cwd, "tag", "--list", "v*").split("\n").filter(Boolean);
  const reachable = [];
  for (const tag of tags) {
    assert.match(tag, tagPattern, `invalid or prerelease tag in repository history: ${tag}`);
    const sha = git(cwd, "rev-parse", `${tag}^{commit}`);
    assert.match(sha, shaPattern, `tag ${tag} does not resolve to an exact commit`);
    try {
      git(cwd, "merge-base", "--is-ancestor", sha, sourceSha);
      reachable.push({ tag, sha });
    } catch (error) {
      if (error.status !== 1) throw error;
    }
  }
  return reachable;
}

export async function runRelease({ root = process.cwd(), trustedRoot = root, sourceSha, recoveryTag = null, repository, adapters, workRoot, prepareOnly = false } = {}) {
  assert.match(sourceSha ?? "", shaPattern, "source SHA must be canonical");
  assert.equal(git(root, "rev-parse", `${sourceSha}^{commit}`), sourceSha, "source is not an exact commit");
  const refs = reachableStableTags(root, sourceSha);
  const api = adapters ?? await createAdapters({ repository, cwd: root });
  let release, mode = "release";
  const sameSource = refs.find(({ sha }) => sha === sourceSha);
  if (recoveryTag !== null) {
    assert.match(recoveryTag, tagPattern, "recovery tag must be a canonical stable tag");
    const existing = refs.find(({ tag }) => tag === recoveryTag);
    assert.ok(existing, "recovery requires a reachable existing stable tag");
    assert.equal(existing.sha, sourceSha, "recovery source must match the immutable tag commit");
    release = { version: recoveryTag.slice(1), tag: recoveryTag, bootstrap: false, previous: null };
    mode = "recovery";
  } else if (sameSource) {
    release = { version: sameSource.tag.slice(1), tag: sameSource.tag, bootstrap: false, previous: null };
    mode = "recovery";
  } else {
    const previousVersion = latestStableTag(refs.map(({ tag }) => tag));
    const previous = previousVersion === null ? null : `v${previousVersion}`;
    const history = previous ? git(root, "log", "--format=%B%x00", `${previous}..${sourceSha}`).split("\0").map((s) => s.trim()).filter(Boolean) : [git(root, "show", "-s", "--format=%B", sourceSha)];
    release = selectReleaseVersion({ tags: previous ? [previous] : [], commits: history });
    if (release === null) return { skipped: true, reason: "no releasable commits since latest stable tag" };
  }
  assert.ok(semver.valid(release.version) && !semver.prerelease(release.version));
  if (recoveryTag === null && !sameSource) {
    const previousVersion = latestStableTag(refs.map(({ tag }) => tag));
    if (previousVersion) await assertPreviousReleaseComplete(`v${previousVersion}`, root, api);
  }
  await api.validateSource({ sha: sourceSha, version: release.version, tag: release.tag }, { mode });
  const artifact = prepareArtifact({ sourceRoot: root, trustedRoot, sourceSha, version: release.version, ...(workRoot ? { workRoot } : {}) });
  const source = { sha: sourceSha, version: release.version, tag: release.tag };
  if (prepareOnly) return { source, mode, artifact };
  return publishRelease({ source, artifact, packageName: "@soulwaxx/pi-skill-autocomplete" }, api, { mode });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [command, value, outputDirectory] = process.argv.slice(2);
  assert.equal(command, "prepare", "usage: node .github/release-tools/release.mjs prepare <source-sha> <output-directory>");
  assert.ok(outputDirectory, "prepared release output directory is required");
  const root = process.cwd();
  const result = await runRelease({ root, trustedRoot: root, sourceSha: value, recoveryTag: process.env.RECOVERY_TAG || null, repository: process.env.GITHUB_REPOSITORY, prepareOnly: true });
  if (result.skipped) {
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, "prepared=false\n");
    console.log(JSON.stringify(result));
  } else {
    fs.mkdirSync(outputDirectory, { recursive: true });
    fs.writeFileSync(path.join(outputDirectory, "release.tgz"), result.artifact.bytes, { flag: "wx", mode: 0o600 });
    fs.writeFileSync(path.join(outputDirectory, "release.json"), `${JSON.stringify({ source: result.source, mode: result.mode, integrity: result.artifact.integrity })}\n`, { flag: "wx", mode: 0o600 });
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `prepared=true\ntag=${result.source.tag}\nversion=${result.source.version}\nmode=${result.mode}\nintegrity=${result.artifact.integrity}\n`);
    console.log(JSON.stringify({ prepared: true, version: result.source.version, tag: result.source.tag, sourceSha: result.source.sha, mode: result.mode, integrity: result.artifact.integrity }));
  }
}
