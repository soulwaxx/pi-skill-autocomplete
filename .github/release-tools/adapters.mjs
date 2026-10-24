import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import semver from "semver";

const githubOrigin = "https://api.github.com";
const npmOrigin = "https://registry.npmjs.org";
const maxBody = 2 * 1024 * 1024;
const timeoutMs = 15_000;
const npmMutationTimeoutMs = 5 * 60_000;
const packagePattern = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;
const shaPattern = /^[0-9a-f]{40}$/;

async function request(url, { token, method = "GET", body, accept = "application/json" } = {}) {
  const target = new URL(url);
  assert.ok(target.protocol === "https:" && [githubOrigin, npmOrigin].includes(target.origin), "outbound URL must use an approved HTTPS origin");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      signal: controller.signal,
      redirect: "error",
      headers: { accept, ...(token ? { authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28" } : {}), ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (response.status === 404 && method === "GET") {
      await response.body?.cancel();
      return { status: 404, data: null };
    }
    const declared = Number(response.headers.get("content-length") ?? 0);
    assert.ok(!declared || declared <= maxBody, `response exceeds ${maxBody} bytes`);
    const reader = response.body?.getReader();
    const chunks = [];
    let size = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBody) {
          await reader.cancel();
          throw new Error(`response exceeds ${maxBody} bytes`);
        }
        chunks.push(Buffer.from(value));
      }
    }
    const bytes = Buffer.concat(chunks, size);
    if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status} from ${target.origin}`), { status: response.status });
    if (accept === "application/zip") return { status: response.status, data: bytes };
    let data;
    try { data = JSON.parse(bytes.toString("utf8")); } catch { throw new Error(`invalid JSON from ${target.origin}`); }
    return { status: response.status, data };
  } finally { clearTimeout(timer); }
}

function npmPackage(packageName) {
  assert.match(packageName, packagePattern, "invalid scoped package name");
  return encodeURIComponent(packageName);
}

function repoPath(repository, ...parts) {
  assert.match(repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  return `${githubOrigin}/repos/${repository}/${parts.map(encodeURIComponent).join("/")}`;
}

function npmCli(args, options = {}, command = "npm") {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: options.timeout ?? timeoutMs, maxBuffer: maxBody, stdio: ["ignore", "pipe", "pipe"], ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm ${args[0]} failed (${result.status}): ${result.stderr.slice(0, 1000)}`);
  return result.stdout;
}

export async function createAdapters({ repository, token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN, trustedSha = process.env.TRUSTED_SHA, cwd = process.cwd(), npmCommand = "npm" } = {}) {
  assert.match(repository ?? "", /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "repository is invalid");
  assert.ok(token, "GitHub API token is required");
  const requestGithub = async (parts, options) => {
    const response = await request(repoPath(repository, ...parts), { token, ...options });
    return response.data;
  };
  const runGit = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", timeout: timeoutMs, maxBuffer: maxBody }).trim();
  const api = {
    async validateSource(source, { mode = "release" } = {}) {
      assert.match(source.sha, shaPattern);
      assert.match(source.tag, /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/);
      assert.equal(source.tag, `v${source.version}`);
      runGit("merge-base", "--is-ancestor", source.sha, "origin/main");
      assert.equal(runGit("rev-parse", `${source.sha}^{commit}`), source.sha, "source SHA must identify an exact git commit");
      assert.ok(mode === "release" || mode === "recovery");
      assert.match(trustedSha ?? "", shaPattern, "verified trusted main SHA is required before publishing");
      const main = await requestGithub(["git", "ref", "heads", "main"]);
      assert.equal(main?.object?.sha, trustedSha, "GitHub main moved after trusted-source verification");
      const localMain = runGit("rev-parse", "origin/main");
      assert.equal(localMain, trustedSha, "local trusted checkout is not the verified current main SHA");
      if (mode === "release") assert.equal(source.sha, trustedSha, "release source is no longer current main");
    },
    async readTag(tag) {
      assert.match(tag, /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/);
      const ref = await requestGithub(["git", "ref", "tags", tag]);
      if (ref === null) return null;
      assert.equal(ref.ref, `refs/tags/${tag}`, "tag ref response mismatch");
      let object = ref.object;
      for (let depth = 0; object.type === "tag" && depth < 5; depth++) {
        const annotated = await requestGithub(["git", "tags", object.sha]);
        assert.ok(annotated && annotated.object, "annotated tag object is malformed");
        object = annotated.object;
      }
      assert.equal(object.type, "commit", "tag does not resolve to a commit");
      assert.match(object.sha, shaPattern);
      return { sha: object.sha };
    },
    async readNpm(packageName, version) {
      const encoded = npmPackage(packageName);
      assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
      const result = await request(`${npmOrigin}/${encoded}/${version}`);
      if (result.status === 404) return null;
      assert.equal(result.data.name, packageName, "npm package identity mismatch");
      return result.data;
    },
    async readDistTags(packageName) {
      const result = await request(`${npmOrigin}/${npmPackage(packageName)}`);
      if (result.status === 404) return {};
      assert.equal(result.data.name, packageName, "npm package identity mismatch");
      return result.data["dist-tags"] ?? {};
    },
    async readRelease(tag) {
      assert.match(tag, /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/);
      const release = await requestGithub(["releases", "tags", tag]);
      if (release === null) return null;
      assert.equal(release.tag_name, tag);
      const linkedTag = await api.readTag(tag);
      assert.ok(linkedTag, "GitHub Release exists without its immutable tag");
      return { tag_name: release.tag_name, name: release.name, body: release.body === null ? "" : release.body, targetSha: linkedTag.sha, draft: release.draft, prerelease: release.prerelease, assets: release.assets };
    },
    async createTag(tag, sha) {
      assert.match(tag, /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/);
      assert.match(sha, shaPattern);
      const created = await requestGithub(["git", "refs"], { method: "POST", body: { ref: `refs/tags/${tag}`, sha } });
      assert.equal(created.ref, `refs/tags/${tag}`);
    },
    async createRelease(tag, sha) {
      assert.match(tag, /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/);
      assert.match(sha, shaPattern);
      const release = await requestGithub(["releases"], { method: "POST", body: { tag_name: tag, target_commitish: sha, name: tag, body: "", draft: false, prerelease: false } });
      assert.equal(release.tag_name, tag);
      assert.equal(release.draft, false);
      assert.equal(release.prerelease, false);
    },
    async publishTarball(packageName, bytes, { tag }) {
      npmPackage(packageName);
      assert.equal(tag, "pi-release-candidate");
      assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-release-publish-"));
      try {
        const file = path.join(dir, `${packageName.replaceAll("/", "-")}.tgz`);
        fs.writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });
        const home = path.join(dir, "home");
        fs.mkdirSync(home);
        const userConfig = path.join(dir, "user.npmrc");
        const globalConfig = path.join(dir, "global.npmrc");
        fs.writeFileSync(userConfig, "\n");
        fs.writeFileSync(globalConfig, "\n");
        const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:NPM_TOKEN|NODE_AUTH_TOKEN|npm_config_.*|NPM_CONFIG_.*)$/i.test(key)));
        Object.assign(env, { HOME: home, NPM_CONFIG_USERCONFIG: userConfig, NPM_CONFIG_GLOBALCONFIG: globalConfig, npm_config_userconfig: userConfig, npm_config_globalconfig: globalConfig });
        const version = npmCli(["--version"], { cwd: dir, env }, npmCommand).trim();
        assert.ok(semver.gte(version, "11.21.0"), "npm 11.21.0+ is required for trusted publishing and dist-tag OIDC");
        npmCli(["publish", file, "--access", "public", "--provenance", "--tag", tag], { cwd: dir, env, timeout: npmMutationTimeoutMs }, npmCommand);
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    },
    async promoteLatest(packageName, version) {
      npmPackage(packageName);
      assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-release-dist-tag-"));
      try {
        const home = path.join(dir, "home");
        fs.mkdirSync(home);
        const userConfig = path.join(dir, "user.npmrc");
        const globalConfig = path.join(dir, "global.npmrc");
        fs.writeFileSync(userConfig, "\n");
        fs.writeFileSync(globalConfig, "\n");
        const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:NPM_TOKEN|NODE_AUTH_TOKEN|npm_config_.*|NPM_CONFIG_.*)$/i.test(key)));
        Object.assign(env, { HOME: home, NPM_CONFIG_USERCONFIG: userConfig, NPM_CONFIG_GLOBALCONFIG: globalConfig, npm_config_userconfig: userConfig, npm_config_globalconfig: globalConfig });
        const npmVersion = npmCli(["--version"], { cwd: dir, env }, npmCommand).trim();
        assert.ok(semver.gte(npmVersion, "11.21.0"), "npm 11.21.0+ is required for OIDC dist-tag promotion");
        npmCli(["dist-tag", "add", `${packageName}@${version}`, "latest"], { cwd: dir, env, timeout: npmMutationTimeoutMs }, npmCommand);
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    },
  };
  return api;
}
