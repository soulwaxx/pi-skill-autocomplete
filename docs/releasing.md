# Release operations

This repository contains a dedicated release coordinator, not semantic-release core or its plugins. The coordinator uses locked `conventional-commits-parser` and `semver` dependencies in `.github/release-tools/`; `npm run test:release` exercises it with fake adapters. These instructions describe automation and its prerequisites. They do not authorize creating tags, publishing, or changing GitHub/npm settings.

## Release version policy

A release is derived from Conventional Commit messages since the most recent stable tag:

- `feat` selects a minor bump.
- A `!` breaking marker or `BREAKING CHANGE` note selects a major bump, including while the current version is `0.x`.
- Other supported releasable Conventional Commit types select a patch bump, including `ci` and `chore`.
- A new release requires a nonempty set of valid supported Conventional Commits. Empty, malformed, or unsupported commit input is rejected. Every supported type selects a patch, minor, or major bump; the selector does not provide a no-releasable-commit no-op case. If the source commit already has a reachable stable tag, the coordinator uses recovery for that existing release instead of calculating a new version.

The PR-title check requires one of `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, or `revert`, optionally scoped or marked breaking. Branch protection must require both the `PR title passed` check and the aggregate `CI passed` check. Release eligibility assumes squash-only merges so the squash commit subject carries the reviewed Conventional Commit PR title. Do not enable direct pushes or a merge method inconsistent with that tested-source policy.

The initial version is **`0.1.0`**, which is already published on npm. Later versions use the policy above. A squash title such as `ci: align automation with obsidian-second-brain` produces a new patch release; with only patch-level commits since `v0.1.0`, that release is `0.1.1`. Accumulated feature or breaking commits can select a larger bump. Do not manually bump the source manifest for this change: the source `package.json` can remain at `0.1.0`. Release preparation copies the exact source files from `git show`, changes the staged package/lock version, and records the verified source commit in packed metadata. It does not check out and rewrite the source tree to bump the version.

## Pre-merge CI

`.github/workflows/test.yml` runs source, type, lint, runtime feasibility, packed-artifact, benchmark, and release regression checks on Linux/macOS with Node 22 and 24. Node 22 coverage matches the declared `>=22.19.0` runtime requirement. A separate Linux job audits both locked dependency trees and validates workflows with actionlint. Node setup checks for the latest matching patch; CI and release install the same Renovate-managed npm CLI version.

Code CI runs for PR creation, code updates, and reopening, with merge-group and manual diagnostic triggers. Title/body edits run only `.github/workflows/pr-title.yml`, which validates the Conventional Commit title without restarting the code matrix. Keep the required check names `CI passed` and `PR title passed` unchanged.

The aggregate CI job records successful PR source evidence only after the matrix and tooling job pass. Evidence is retained for 30 days; rerun stale PR checks before merging. Freshness is measured from the selected successful workflow-run attempt's `run_started_at`, not the run's original creation time, so a recent successful rerun can authorize recovery. Recent recovery still requires unexpired attempt-specific CI evidence; historical evidence refresh remains out of scope. The proof format authorizes ordinary squash merges, not multi-PR merge-queue publication. The `merge_group` trigger alone does not authorize a release; keep merge-queue enforcement disabled unless source verification is extended for that topology.

## Automated release checks and publication

On `main`, the release workflow:

1. Verifies current trusted `main`. For an ordinary release it uses that commit as the source. It checks that source is an exact reachable commit and that it is a squash merge of a PR into this repository's `main`.
2. Finds a successful `test.yml` pull-request run for the exact PR head. It downloads the run/attempt-specific evidence and checks repository, PR, merge-ref head/base/parents/tree, timestamps, tested tree, and merged tree. Missing, stale, expired, future-dated, direct-push, mismatched, or malformed evidence fails closed. The release rechecks trusted current `main` before elevated writes.
3. Reuses PR evidence rather than repeating the pre-merge suite and benchmarks. The read-only verification job installs locked dependencies, checks release configuration, and audits both dependency trees. It prepares the actual release version from immutable `git show <source>:<path>` bytes, checks the strict five-file pack allowlist, and runs source/runtime feasibility tests against that unpacked versioned artifact. It retains the tarball and source/version/mode/SHA-512 metadata as a short-lived artifact.
4. Transfers that artifact to a separate publisher job with `contents: write` and `id-token: write`. The publisher verifies metadata and bytes, checks current main, and revalidates source before each remote write. The publish job does not rerun the test suite.
5. Creates the immutable version tag first, publishes the tarball with provenance under the temporary npm dist-tag `pi-release-candidate`, waits for exact registry version/`gitHead`/integrity visibility, and creates the canonical GitHub Release (`vX.Y.Z` title, empty body, no assets). It rereads `latest` before promotion and only moves it forward. npm publication and dist-tag promotion use trusted publishing/OIDC only, with no npm-token fallback.

The workflow serializes its own release runs, but that does not coordinate with external writers. Because npm dist-tags have no compare-and-swap operation, operations must have one exclusive publisher: no other workflow or manual publisher may publish the same package or mutate `latest` concurrently with this release workflow. External actors can still race it, so maintainers must enforce this operational boundary. The source/artifact are validated before the first mutation. Existing immutable output must exactly match the source tag, source commit, version, and SHA-512 integrity; conflicts fail closed. Only an exact HTTP 404 is interpreted as absent. Authentication, network, malformed response, and other failures are errors, not evidence of absence.

## OIDC-only publishing and external configuration

The initial npm publication is complete, and the owner reports that the trusted publisher is configured. The one-time npm-token bootstrap workflow, inputs, and credential-handling code are retired. Revoke the old npm publishing token and delete its repository secret if still present. Do not add an npm publishing secret or token fallback when troubleshooting OIDC. Publishing subprocesses use disposable homes and empty npm configs, exclude ambient npm credentials/configuration, and retain GitHub's OIDC environment. The unrelated `RENOVATE_TOKEN` remains necessary for dependency-update PRs.

Before rollout, verify the external controls; repository files and offline tests do not establish that these settings work:

- GitHub `main` protection/rules require `CI passed` and `PR title passed`, require squash-only merges, and prevent bypass/direct pushes consistent with the evidence model. Use the reviewed PR title as the squash commit title.
- npm trusted publishing binds `soulwaxx/pi-skill-autocomplete` to **`release.yml`**. npm's Workflow filename field takes the filename, not `.github/workflows/release.yml`. Leave Environment name blank because this workflow does not use a GitHub environment.
- The binding authorizes package publication and the required dist-tag changes. The adapter requires npm `11.21.0+` for publication and dist-tag OIDC; workflows pin the same newer CLI for CI and release.
- npm's [trusted-publisher documentation](https://docs.npmjs.com/trusted-publishers/) requires a newly created configuration to complete its first successful publish within **two days**. That publish validates the setup and binds it to the repository's immutable identity. If it expires, delete and recreate the configuration before publication. A recovery that only creates a GitHub Release or promotes a dist-tag does not prove successful OIDC package publication.

The next new-version release must confirm OIDC publication, package provenance, matching source SHA/integrity, the GitHub Release, and correct `latest`. Provenance records how the package was built; it is not a substitute for the trusted-publisher authorization. If publication fails, inspect the actual npm error and publisher binding rather than restoring a token path. No live publication is performed by the local checks below.

## Authorized recovery of an existing release

Recovery is for an interrupted release of an already existing canonical version tag; it is not a new-release command. An authorized maintainer must first inspect the state and current `main`. From the GitHub Actions UI, dispatch **Release** on the current `main` branch with `recovery_tag` set to the exact existing stable tag, e.g. `v0.1.0`. The equivalent command, only when authorized and after inspection, is:

```sh
gh workflow run release.yml --ref main -f recovery_tag=vX.Y.Z
```

Replace `vX.Y.Z` with the exact tag; do not run this example as-is. Recovery still verifies trusted current `main` and independently selects/verifies the existing tag's source from current history. The current verified main tools and workflows orchestrate recovery; source bytes are read from the old source commit using `git show`. Do not check out an old source tree to run old release tooling.

The shared OIDC-only publisher checks the existing tag, npm version metadata (`gitHead` and package integrity), and GitHub Release metadata against the prepared artifact. For an existing npm version, recovery downloads its original tarball from the HTTPS npm registry without credentials or redirects, verifies its recorded SHA-512 SRI, safely unpacks its fixed five-file allowlist, compares every file with immutable staged source, and runs the packed host tests. The download is limited to 10 MiB, total unpacked file content to 50 MiB, and the decompressed tar stream to 64 MiB; revisit those bounds if the approved runtime package grows beyond them. Recovery does not depend on reproducing gzip bytes. Only an exact registry 404 means the version is absent and may be packed anew. It creates only missing outputs and never overwrites mismatches. It waits for npm visibility. `latest` is promoted only if the recovered version is newer than the currently verified stable `latest`; an older recovery cannot move it backward.

The archive in `tests/fixtures/initial-release.tgz.base64` is the exact public five-file package from verified run `40081540625`; it contains no credentials and is not shipped in the npm package. Initial-version recovery retains these original compressed bytes because Node/zlib versions can produce different gzip bytes for identical tar contents. Preparation checks the pinned archive hash, compares every unpacked file with the immutable staged source, and runs packed host tests against that archive. Release tests exercise this real initial-source preparation, so development clones and the CI matrix need full Git history (`fetch-depth: 0`). Skill-context tests use the legacy prompt format only for the exact initial package name, version, and source SHA; current source and other artifact identities must include the already-loaded notice. This keeps initial recovery compatible without rewriting the archive or relaxing current-package checks.

A previous incomplete release blocks a newer release until the existing tag is recovered. A tagless partial output, such as an npm-only version, requires manual source review; automation does not recreate a tag for it. A conflict, manual remote mutation, stale proof, missing/nonmatching artifact, or other failed precondition is not a reason to blindly rerun, republish, delete, or move tags. Stop and investigate the exact error. Only an exact not-found response is treated as a missing remote object.

## Dependency maintenance

`.github/workflows/renovate.yml` runs weekly on Saturday at 03:00 UTC and supports manual dispatch on `main`. It uses the existing `RENOVATE_TOKEN` repository secret with repository/workflow access so update PRs trigger CI. The workflow fails explicitly if the secret is missing. Check its first live run for repository discovery and authorization; a stored secret alone does not prove the maintenance loop works. Do not enable an additional hosted Renovate runner for the same repository.

Renovate replaces Dependabot and maintains root npm dependencies, the separate release-tool manifest/lockfile, SHA-pinned GitHub Actions, and annotated npm/actionlint/Renovate runtime versions. It groups non-major development dependencies, release tools, CI tools, and Actions updates. PR titles use `chore`, at most three update PRs remain open, and merges are manual. Security alerts remain enabled. Inspect major updates separately.

Inline tool versions use `# renovate: datasource=... depName=...` annotations and one regex manager. actionlint validation downloads the archive and checksum manifest from the same selected upstream release, checks SHA-256 before extraction, and runs the verified executable. This trusts upstream release checksums rather than a separately committed archive digest. Keep checksum verification when changing download steps. Configuration regression tests allow routine version/action-digest updates while rejecting token fallback, missing manager coverage, and weakened guards.

## Maintenance and local validation

For repository development, use Node `>=22.19.0` and the locked dependency installs:

```sh
npm ci --ignore-scripts
npm ci --prefix .github/release-tools --ignore-scripts
npm run check
npm run test:feasibility
npm run test:artifact
npm run bench
npm run release:check
npm run test:release
npm audit --audit-level=high
npm audit --prefix .github/release-tools --audit-level=high
```

Install the actionlint version selected in `.github/workflows/test.yml`, verify its archive against the matching upstream checksum manifest, and run `actionlint .github/workflows/*.yml`.

The audit gate prints findings at every severity and fails on high or critical advisories; moderate findings remain visible and nonblocking. The root development tree temporarily overrides `undici` to `8.12.2` only beneath Pi `1.4.0` because that pinned upstream development chain currently selects a vulnerable release. Remove the override when upstream Pi supplies a patched Undici version and the override is no longer needed. This development-tree override does not patch or constrain the Pi host/runtime installed by users; package peer dependencies remain wildcard ranges as required by Pi. A passing gate does not mean vulnerability-free dependencies. Do not run `npm audit fix --force` or accept a breaking Pi downgrade without compatibility review. Audit-service and authentication errors still fail the job. Never treat fake-adapter tests as proof of registry permissions or a live publication.
