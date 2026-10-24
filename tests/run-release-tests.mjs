import assert from "node:assert/strict";
import { resolve } from "node:path";
import { runIsolated } from "./isolated-runner.mjs";

for (const name of ["ci-config.test.mjs", "release.test.mjs", "oidc.test.mjs"]) {
  const script = resolve(import.meta.dirname, name);
  const result = runIsolated(script, [], {
    parentEnv: {
      ...process.env,
      GITHUB_TOKEN: "hostile-parent-github-token",
      GH_TOKEN: "hostile-parent-gh-token",
      NPM_TOKEN: "hostile-parent-npm-token",
      NODE_AUTH_TOKEN: "hostile-parent-node-token",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "hostile-parent-oidc-token",
      ANTHROPIC_API_KEY: "hostile-provider-key",
      PI_HOSTILE_HOME: process.env.HOME ?? "host-profile",
      PI_HOSTILE_CWD: process.cwd(),
    },
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `release tests failed (status ${result.status}):\n${result.stdout}\n${result.stderr}`);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
}
console.log("✔ release tests isolated from parent credentials, Pi profile, and Git global configuration");
