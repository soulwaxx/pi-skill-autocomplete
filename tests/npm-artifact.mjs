import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runIsolated } from "./isolated-runner.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = mkdtempSync(join(tmpdir(), "pi-skill-autocomplete-artifact-"));
const packageRoot = join(tempRoot, "packed");
const installRoot = join(tempRoot, "npm-install");
const home = join(tempRoot, "home");
const agentDir = join(home, ".pi", "agent");
const npmCache = join(tempRoot, "npm-cache");
const npmUserConfig = join(tempRoot, "empty.npmrc");
mkdirSync(packageRoot);
mkdirSync(installRoot);
mkdirSync(agentDir, { recursive: true });
mkdirSync(npmCache);

const inheritedAllowlist = ["PATH", "TMPDIR", "TMP", "TEMP", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"];
const childEnv = Object.fromEntries(
  inheritedAllowlist.filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]),
);
Object.assign(childEnv, {
  CI: "1",
  HOME: home,
  PI_CODING_AGENT_DIR: agentDir,
  PI_OFFLINE: "1",
  NPM_CONFIG_USERCONFIG: npmUserConfig,
  npm_config_userconfig: npmUserConfig,
  NPM_CONFIG_CACHE: npmCache,
  npm_config_cache: npmCache,
  NPM_CONFIG_OFFLINE: "true",
  npm_config_offline: "true",
});

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 120000,
    env: childEnv,
    ...options,
  });
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  return result;
}

try {
  const sourceManifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const pack = run("npm", ["pack", "--json", "--pack-destination", tempRoot], { cwd: repoRoot });
  const packed = JSON.parse(pack.stdout)[0];
  const tarball = join(tempRoot, packed.filename);
  const expectedFiles = ["LICENSE", "README.md", "extensions/skill-autocomplete.ts", "extensions/skill-reference-parser.ts", "package.json"].sort();
  assert.deepEqual(packed.files.map(({ path }) => path).sort(), expectedFiles, "tarball contains only the public runtime allowlist");
  assert.equal(packed.name, sourceManifest.name);
  assert.equal(packed.version, sourceManifest.version);
  run("tar", ["-xzf", tarball, "-C", packageRoot]);
  const unpackedRoot = join(packageRoot, "package");
  const manifest = JSON.parse(readFileSync(join(unpackedRoot, "package.json"), "utf8"));
  assert.equal(manifest.name, sourceManifest.name);
  assert.equal(manifest.version, sourceManifest.version, "prepared pack version equals source manifest; no fixed bootstrap version assumption");
  assert.equal(manifest.license, "MIT");
  assert.equal(manifest.repository.url, "git+https://github.com/soulwaxx/pi-skill-autocomplete.git");
  assert.equal(manifest.engines.node, ">=22.19.0");
  assert.equal(manifest.private, undefined);
  assert.deepEqual(manifest.publishConfig, { access: "public" });
  assert.ok(manifest.keywords.includes("pi-package"));
  assert.deepEqual(manifest.pi.extensions, ["./extensions/skill-autocomplete.ts"]);
  assert.deepEqual(manifest.peerDependencies, {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
  });
  assert.equal(manifest.dependencies, undefined);
  assert.equal(manifest.bundledDependencies, undefined);
  assert.equal(manifest.scripts?.preinstall, undefined);
  assert.equal(manifest.scripts?.install, undefined);
  assert.equal(manifest.scripts?.postinstall, undefined);
  assert.match(readFileSync(join(unpackedRoot, "LICENSE"), "utf8"), /MIT License/);
  assert.match(readFileSync(join(unpackedRoot, "README.md"), "utf8"), /npm:@soulwaxx\/pi-skill-autocomplete/);

  run("npm", ["install", "--offline", "--ignore-scripts", "--omit=peer", "--legacy-peer-deps", "--prefix", installRoot, tarball]);
  const installedRoot = join(installRoot, "node_modules/@soulwaxx/pi-skill-autocomplete");
  assert.deepEqual(readdirSync(installedRoot).sort(), ["LICENSE", "README.md", "extensions", "package.json"]);

  // Unit helpers use Node's TS stripper, which rejects .ts beneath node_modules.
  // They consume the exact unpacked pack bytes; test-only links provide locked
  // host APIs, while Pi's own loader is tested below against the npm-installed copy.
  const testHostRoot = join(unpackedRoot, "node_modules/@earendil-works");
  mkdirSync(testHostRoot, { recursive: true });
  for (const hostPackage of ["pi-coding-agent", "pi-tui"]) {
    const hostPath = resolve(repoRoot, `node_modules/@earendil-works/${hostPackage}`);
    const target = join(testHostRoot, hostPackage);
    if (!readdirSync(testHostRoot).includes(hostPackage)) symlinkSync(hostPath, target, "dir");
  }
  const unitSuite = runIsolated(resolve(repoRoot, "tests/run-tests.mjs"), [unpackedRoot]);
  process.stdout.write(unitSuite.stdout);
  process.stderr.write(unitSuite.stderr);
  assert.equal(unitSuite.status, 0, `packed artifact unit/TUI tests failed:\n${unitSuite.stdout}\n${unitSuite.stderr}`);
  assert.match(unitSuite.stdout, /real Pi InteractiveMode autocomplete/);

  const cli = resolve(repoRoot, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
  run(process.execPath, [cli, "install", installedRoot], { cwd: tempRoot });
  const installedSettingsPath = join(agentDir, "settings.json");
  const installedSettings = JSON.parse(readFileSync(installedSettingsPath, "utf8"));
  assert.ok(Array.isArray(installedSettings.packages), "Pi install wrote package settings");
  run(process.execPath, [cli, "list"], { cwd: tempRoot });

  // Pi 1.4.0's SDK/CLI host suites use the Pi resource loader with the exact
  // installed package path and its pi manifest. The fake observer/provider is
  // a separate extension; it never imports or duplicates the package runtime.
  const hostSuite = runIsolated(
    resolve(repoRoot, "tests/row5-feasibility.mjs"),
    [installedRoot],
  );
  process.stdout.write(hostSuite.stdout);
  process.stderr.write(hostSuite.stderr);
  assert.equal(hostSuite.status, 0, `installed packed package host suites failed:\n${hostSuite.stdout}\n${hostSuite.stderr}`);
  assert.match(hostSuite.stdout, /actual Pi RPC registry\/body composition/);
  assert.match(hostSuite.stdout, /actual Pi CLI JSON mode/);
  assert.match(hostSuite.stdout, /Pi SDK print-mode\/source boundary/);
  assert.match(hostSuite.stdout, /real InteractiveMode error\/recovery preserves draft and newer typed\/pasted content/);
  assert.match(hostSuite.stdout, /real InteractiveMode successful transformation preserves separately supplied initialImages/);
  console.log(`PASS public npm pack/install, implicit Pi manifest load from installed package, and packed-artifact host suites (${packed.filename})`);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
