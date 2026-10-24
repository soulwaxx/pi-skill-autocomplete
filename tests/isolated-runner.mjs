import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const INHERITED_ENV_ALLOWLIST = [
  "PATH",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
];

/** Run a test process with a disposable home, Pi profile, settings file, and cwd. */
export function runIsolated(script, args = [], { parentEnv = process.env, settings = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "pi-skill-autocomplete-test-"));
  const home = join(root, "home");
  const agentDir = join(home, ".pi", "agent");
  const cwd = join(root, "work");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);

  const env = Object.fromEntries(
    INHERITED_ENV_ALLOWLIST.filter((name) => parentEnv[name] !== undefined).map(
      (name) => [name, parentEnv[name]],
    ),
  );
  Object.assign(env, {
    CI: "1",
    HOME: home,
    PI_CODING_AGENT_DIR: agentDir,
  });

  try {
    return spawnSync(process.execPath, [resolve(script), ...args], {
      cwd,
      env,
      encoding: "utf8",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
