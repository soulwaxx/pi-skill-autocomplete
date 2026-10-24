import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { artifactIntegrity } from "./release-coordinator.mjs";

const runtimeFiles = ["LICENSE", "README.md", "extensions/skill-autocomplete.ts", "extensions/skill-reference-parser.ts", "package.json"];
const packedFiles = runtimeFiles.slice().sort();
const inheritedEnv = ["PATH", "TMPDIR", "TMP", "TEMP", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"];

export function isolatedPreparationEnv(workRoot, parentEnv = process.env) {
  const home = path.join(workRoot, "isolated-home");
  const agentDir = path.join(home, ".pi", "agent");
  const cache = path.join(workRoot, "isolated-npm-cache");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(cache, { recursive: true });
  const userConfig = path.join(workRoot, "isolated.npmrc");
  const globalConfig = path.join(workRoot, "isolated-global.npmrc");
  fs.writeFileSync(userConfig, "\n");
  fs.writeFileSync(globalConfig, "\n");
  const env = Object.fromEntries(inheritedEnv.filter((name) => parentEnv[name] !== undefined).map((name) => [name, parentEnv[name]]));
  Object.assign(env, {
    CI: "1",
    HOME: home,
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
    NPM_CONFIG_USERCONFIG: userConfig,
    npm_config_userconfig: userConfig,
    NPM_CONFIG_GLOBALCONFIG: globalConfig,
    npm_config_globalconfig: globalConfig,
    NPM_CONFIG_CACHE: cache,
    npm_config_cache: cache,
    NPM_CONFIG_OFFLINE: "true",
    npm_config_offline: "true",
  });
  return env;
}

function run(command, args, { env, ...options }) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 180000, env, ...options });
}

function committedFile(sourceRoot, sourceSha, file, env) {
  return run("git", ["show", `${sourceSha}:${file}`], { cwd: sourceRoot, env, encoding: "buffer" });
}

export function prepareArtifact({ sourceRoot, repoRoot, trustedRoot, sourceSha, version, workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-release-stage-")) }) {
  sourceRoot ??= repoRoot;
  trustedRoot ??= repoRoot ?? sourceRoot;
  assert.match(sourceSha, /^[0-9a-f]{40}$/);
  assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  fs.mkdirSync(workRoot, { recursive: true });
  const env = isolatedPreparationEnv(workRoot);
  assert.equal(run("git", ["rev-parse", "--verify", `${sourceSha}^{commit}`], { cwd: sourceRoot, env }).trim(), sourceSha, "verified source commit is unavailable");
  const stage = path.join(workRoot, "stage");
  const unpackRoot = path.join(workRoot, "unpacked");
  fs.mkdirSync(stage, { recursive: true });
  fs.mkdirSync(unpackRoot, { recursive: true });
  for (const file of runtimeFiles) {
    const target = path.join(stage, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, committedFile(sourceRoot, sourceSha, file, env));
  }
  const manifestPath = path.join(stage, "package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.version = version;
  manifest.gitHead = sourceSha;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const lock = JSON.parse(committedFile(sourceRoot, sourceSha, "package-lock.json", env));
  lock.version = version;
  lock.packages[""].version = version;
  fs.writeFileSync(path.join(stage, "package-lock.json"), `${JSON.stringify(lock, null, 2)}\n`);

  const pack = JSON.parse(run("npm", ["pack", "--json", "--ignore-scripts", "--offline", "--pack-destination", workRoot], { cwd: stage, env }))[0];
  assert.equal(pack.name, manifest.name);
  assert.equal(pack.version, version);
  assert.deepEqual(pack.files.map(({ path: file }) => file).sort(), packedFiles, "prepared tarball violates the runtime allowlist");
  const tarball = path.join(workRoot, pack.filename);
  run("tar", ["-xzf", tarball, "-C", unpackRoot], { cwd: workRoot, env });
  const unpacked = path.join(unpackRoot, "package");
  const actual = [];
  function collect(dir, prefix = "") {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const item = `${prefix}${entry.name}`;
      if (entry.isDirectory()) collect(path.join(dir, entry.name), `${item}/`);
      else actual.push(item);
    }
  }
  collect(unpacked);
  assert.deepEqual(actual.sort(), packedFiles, "unpacked bytes differ from the runtime allowlist");
  const packedManifest = JSON.parse(fs.readFileSync(path.join(unpacked, "package.json"), "utf8"));
  assert.equal(packedManifest.version, version);
  assert.equal(packedManifest.gitHead, sourceSha, "packed manifest lacks exact verified gitHead");
  assert.equal(packedManifest.name, manifest.name);

  const hostRoot = path.join(unpacked, "node_modules", "@earendil-works");
  fs.mkdirSync(hostRoot, { recursive: true });
  for (const name of ["pi-coding-agent", "pi-tui"]) {
    fs.symlinkSync(path.join(trustedRoot, "node_modules", "@earendil-works", name), path.join(hostRoot, name), "dir");
  }
  const testEnv = isolatedPreparationEnv(workRoot);
  run(process.execPath, [path.join(trustedRoot, "tests/run-tests.mjs"), unpacked], { cwd: stage, env: testEnv });
  run(process.execPath, [path.join(trustedRoot, "tests/row5-feasibility.mjs"), unpacked], { cwd: stage, env: testEnv });
  const bytes = fs.readFileSync(tarball);
  return { version, sourceSha, integrity: artifactIntegrity(bytes), bytes, filename: pack.filename, workRoot };
}
