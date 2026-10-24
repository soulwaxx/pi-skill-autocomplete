import assert from "node:assert/strict";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createAdapters } from "./adapters.mjs";
import { readPrepared } from "./publish-prepared.mjs";
import { waitForNpm } from "./release-coordinator.mjs";

const packageName = "@soulwaxx/pi-skill-autocomplete";
const initialSha = "8cb8df8921457d3da72081ac11e19173347d9713";
const initialIntegrity = "sha512-97vyneSMTuZDxoA+qk95EVQv7ymKovscvO/UoKJwDrGfY1kf+Qc1Wo8yhrUI75N46ejrvX1+o3RNmPF82ouFzw==";

export async function bootstrapPrepared(directory, options = {}) {
  assert.equal(options.repository, "soulwaxx/pi-skill-autocomplete");
  assert.equal(options.eventName, "workflow_dispatch", "bootstrap must be manually dispatched");
  assert.equal(options.ref, "refs/heads/main", "bootstrap must run on main");
  assert.equal(options.confirmation, "publish-v0.1.0", "explicit first-publish confirmation is required");
  assert.equal(options.recoveryTag, "v0.1.0");
  assert.equal(options.expectedMode, "recovery");
  assert.ok(typeof options.bootstrapToken === "string" && /^\S{1,4096}$/.test(options.bootstrapToken), "NPM_BOOTSTRAP_TOKEN secret is required");
  const { source, artifact } = readPrepared(directory, options);
  assert.equal(source.sha, initialSha, "bootstrap is pinned to the already verified initial source");
  assert.equal(source.version, "0.1.0");
  assert.equal(artifact.integrity, initialIntegrity, "bootstrap must use the original verified tarball bytes");
  const api = options.adapters ?? await createAdapters({ repository: options.repository, trustedSha: options.trustedSha });
  await api.validateSource(source, { mode: "recovery" });
  const [tag, existingPackage, release] = await Promise.all([
    api.readTag(source.tag), api.readPackage(packageName), api.readRelease(source.tag),
  ]);
  assert.equal(tag?.sha, source.sha, "bootstrap requires the existing exact-source tag");
  assert.equal(existingPackage, null, "package already exists; use OIDC recovery instead of bootstrap");
  assert.equal(release, null, "unexpected GitHub Release; inspect the partial state before bootstrap");
  await api.validateSource(source, { mode: "recovery" });
  await api.publishTarball(packageName, artifact.bytes, { tag: "pi-release-candidate", bootstrapToken: options.bootstrapToken });
  await waitForNpm(api, packageName, source, artifact, options.visibility);
  return { version: source.version, bootstrapped: true, next: "Revoke the bootstrap token, configure trusted publishing for release.yml, then run OIDC recovery for v0.1.0." };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await bootstrapPrepared(process.argv[2], {
    repository: process.env.GITHUB_REPOSITORY,
    sourceSha: process.env.SOURCE_SHA,
    trustedSha: process.env.TRUSTED_SHA,
    expectedVersion: process.env.PREPARED_VERSION,
    expectedTag: process.env.PREPARED_TAG,
    expectedMode: process.env.PREPARED_MODE,
    expectedIntegrity: process.env.PREPARED_INTEGRITY,
    recoveryTag: process.env.RECOVERY_TAG,
    eventName: process.env.GITHUB_EVENT_NAME,
    ref: process.env.GITHUB_REF,
    confirmation: process.env.BOOTSTRAP_CONFIRMATION,
    bootstrapToken: process.env.BOOTSTRAP_NPM_TOKEN,
  });
  console.log(JSON.stringify(result));
}
