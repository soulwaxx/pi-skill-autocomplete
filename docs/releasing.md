# Release operations

This repository contains a dedicated release coordinator, not semantic-release core or its plugins. The coordinator uses locked `conventional-commits-parser` and `semver` dependencies in `.github/release-tools/`; `npm run test:release` exercises it with fake adapters. These instructions describe automation and its prerequisites. They do not authorize creating tags, publishing, or changing GitHub/npm settings.

## Release version policy

A release is derived from Conventional Commit messages since the most recent stable tag:

- `feat` selects a minor bump.
- A `!` breaking marker or `BREAKING CHANGE` note selects a major bump, including while the current version is `0.x`.
- Other supported releasable Conventional Commit types select a patch bump.
- A new release requires a nonempty set of valid supported Conventional Commits. Empty, malformed, or unsupported commit input is rejected. Every supported type selects a patch, minor, or major bump; the selector does not provide a no-releasable-commit no-op case. If the source commit already has a reachable stable tag, the coordinator uses recovery for that existing release instead of calculating a new version.

The PR-title check requires one of `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, or `revert`, optionally scoped or marked breaking. Branch protection must require both the `PR title passed` check and the aggregate `CI passed` check. Release eligibility assumes squash-only merges so the squash commit subject carries the reviewed Conventional Commit PR title. Do not enable direct pushes or a merge method inconsistent with that tested-source policy.

If there is no stable tag yet, the coordinator bootstraps **`0.1.0` only**; it does not use the usual semantic-release initial `1.0.0` default. Later versions use the policy above. The source `package.json` can remain at `0.1.0`: release preparation copies the exact source files from `git show`, changes the staged package/lock version, and records the verified source commit in packed metadata. It does not check out and rewrite the source tree to bump the version.

## Automated release checks and publication

On `main`, the release workflow:

1. Verifies current trusted `main`. For an ordinary release it uses that commit as the source. It checks that source is an exact reachable commit and that it is a squash merge of a PR into this repository's `main`.
2. Finds a successful `test.yml` pull-request run for the exact PR head. It downloads the run/attempt-specific, 30-day evidence and checks repository, PR, merge-ref head/base/parents/tree, timestamps, tested tree, and merged tree. Missing, stale, expired, future-dated, direct-push, mismatched, or malformed evidence fails closed. The release rechecks trusted current `main` before elevated writes.
3. Runs the verification suite, audits, workflow checks, and release tests in the read-only verification job. It prepares the package from immutable `git show <source>:<path>` bytes, checks the strict five-file pack allowlist, and runs packed-artifact tests. It retains the tarball and source/version/mode/SHA-512 metadata as a short-lived artifact.
4. Transfers that artifact to a separate publisher job with `contents: write` and `id-token: write`. The publisher verifies metadata and bytes, checks current main, and revalidates source before each remote write. The publish job does not rerun the test suite.
5. Creates the immutable version tag first, publishes the tarball with provenance under the temporary npm dist-tag `pi-release-candidate`, waits for exact registry version/`gitHead`/integrity visibility, and creates the canonical GitHub Release (`vX.Y.Z` title, empty body, no assets). It rereads `latest` before promotion and only moves it forward. Normal npm publication and dist-tag promotion use pinned npm `11.21.0` or newer under trusted publishing/OIDC; no npm token is used by those paths. The separately gated one-time first-publish exception below uses an explicitly supplied temporary credential.

The workflow serializes its own release runs, but that does not coordinate with external writers. Because npm dist-tags have no compare-and-swap operation, operations must have one exclusive publisher: no other workflow or manual publisher may publish the same package or mutate `latest` concurrently with this release workflow. External actors can still race it, so maintainers must enforce this operational boundary. The source/artifact are validated before the first mutation. Existing immutable output must exactly match the source tag, source commit, version, and SHA-512 integrity; conflicts fail closed. Only an exact HTTP 404 is interpreted as absent. Authentication, network, malformed response, and other failures are errors, not evidence of absence.

## One-time first-publish bootstrap (`v0.1.0` only)

Trusted publishing cannot create this new package before its npm package settings exist. The initial run created `v0.1.0` but failed with `ENEEDAUTH` before npm publication, so no GitHub Release was created. Do not move/delete that tag, publish a placeholder version, rebuild a substitute package, or create a GitHub-only release to hide this failed publication.

The manual `Release` workflow has a narrowly scoped, owner-authorized bootstrap exception. It still runs the read-only source/evidence verification, tests, audits and exact-artifact preparation before any credential-bearing job. Its separate bootstrap job has `contents: read` and `id-token: write`, not GitHub write permission. It only publishes npm under `pi-release-candidate`; normal OIDC recovery creates the GitHub Release and promotes `latest` afterward.

The bootstrap script requires manual dispatch on `main`, the exact confirmation below, the existing `v0.1.0` tag at `8cb8df8921457d3da72081ac11e19173347d9713`, a completely absent public npm package, no existing GitHub Release, recovery-mode metadata, and the original verified tarball integrity:

```text
sha512-97vyneSMTuZDxoA+qk95EVQv7ymKovscvO/UoKJwDrGfY1kf+Qc1Wo8yhrUI75N46ejrvX1+o3RNmPF82ouFzw==
```

It rejects any other source, version, bytes, existing package or conflicting state. This is not a reusable token-based release route. The archive in `tests/fixtures/initial-release.tgz.base64` is the exact public five-file package from verified run `40081540625`; it contains no credentials and is not shipped in the npm package. Initial bootstrap and recovery both retain these original compressed bytes: Node/zlib versions can produce different gzip bytes for identical tar contents. Preparation checks the pinned archive hash, compares every unpacked file with the immutable staged source, and runs packed host tests against that archive. Release tests also exercise this real initial-source preparation, so development clones and the CI matrix need full Git history (`fetch-depth: 0`).

After the bootstrap change is reviewed and merged through protected `main`:

1. The npm scope owner creates a short-lived granular access token with the minimum publishing access needed to create this package. If account policy requires it for CI publication, use the token's bypass-2FA permission; do not disable account 2FA. If the necessary permission cannot be granted safely, stop. Do not send the token in chat, put it in source/command arguments, or expose it in logs.
2. In GitHub **Settings → Secrets and variables → Actions**, store it as repository secret **`NPM_BOOTSTRAP_TOKEN`**. Only the manual bootstrap step receives it. A private disposable npm config references its environment variable; the token is never written into config contents, and the temporary directory is removed on success or failure. Ambient npm/bootstrap credentials remain excluded from normal publication and dist-tag subprocesses.
3. An authorized maintainer dispatches the workflow on current `main`:

   ```sh
   gh workflow run release.yml --ref main \
     -f recovery_tag=v0.1.0 \
     -f bootstrap_npm=true \
     -f bootstrap_confirmation=publish-v0.1.0
   ```

   Do not blindly retry. The automatic release triggered by merging this fix may stop at the previous incomplete-release guard; that does not replace this explicit bootstrap dispatch.
4. Observe successful publication and exact registry `0.1.0`, `gitHead`, SHA-512 integrity and provenance. If publication was interrupted after npm accepted it, inspect registry state; bootstrap deliberately refuses an already existing package. Do not try to overwrite it.
5. Revoke the npm token and delete GitHub secret `NPM_BOOTSTRAP_TOKEN`. Configure the new package's trusted publisher for `soulwaxx` / `pi-skill-autocomplete` / **`release.yml`**, allowing **npm publish** and **npm dist-tag** independently. Leave Environment name blank because this workflow does not use a GitHub environment.
6. Run the existing-tag OIDC recovery below with `bootstrap_npm` left **false**. It validates the already published package, creates the missing GitHub Release and promotes `latest` without republishing or moving the tag.

A new trusted-publisher binding still requires its first successful OIDC **publication** within two days. Recovery of an already published version does not perform a new `npm publish`; do not count a dist-tag operation as proof of that first-publication requirement. Plan the next ordinary release within the window or recreate an expired binding before that release. Live bootstrap, OIDC configuration and recovery require owner action; passing offline tests does not prove npm credentials or permissions.

## Authorized recovery of an existing release

Recovery is for an interrupted release of an already existing canonical version tag; it is not a new-release command. An authorized maintainer must first inspect the state and current `main`. From the GitHub Actions UI, dispatch **Release** on the current `main` branch with `recovery_tag` set to the exact existing stable tag, e.g. `v0.1.0`. The equivalent command, only when authorized and after inspection, is:

```sh
gh workflow run release.yml --ref main -f recovery_tag=vX.Y.Z
```

Replace `vX.Y.Z` with the exact tag; do not run this example as-is. Recovery still verifies trusted current `main` and independently selects/verifies the existing tag's source from current history. The current verified main tools and workflows orchestrate recovery; source bytes are read from the old source commit using `git show`. Do not check out an old source tree to run old release tooling.

The shared publisher checks the existing tag, npm version metadata (`gitHead` and package integrity), and GitHub Release metadata against the prepared artifact. It creates only missing outputs and never overwrites mismatches. It waits for npm visibility. `latest` is promoted only if the recovered version is newer than the currently verified stable `latest`; an older recovery cannot move it backward.

A previous incomplete release blocks a newer release until the existing tag is recovered. A tagless partial output, such as an npm-only version, requires manual source review; automation does not recreate a tag for it. A conflict, manual remote mutation, stale proof, missing/nonmatching artifact, or other failed precondition is not a reason to blindly rerun, republish, delete, or move tags. Stop and investigate the exact error. Only an exact not-found response is treated as a missing remote object.

## First-publication prerequisites and external configuration

Nothing has been published by this change. Before the first automated publication, an authorized repository/package owner must verify and configure all required external controls:

- GitHub `main` protection/rules require CI and PR-title checks, require squash-only merges, and prevent bypass/direct pushes consistent with the evidence model.
- The `@soulwaxx` npm scope and target package must be owned/managed by the publisher with public package access. Configure npm trusted publishing for repository `soulwaxx/pi-skill-autocomplete`; in npm's **Workflow filename** field enter `release.yml` (the workflow file in this repository is `.github/workflows/release.yml`; npm requires the filename, not its path).
- npm trusted publishing configuration and package access must permit the required OIDC package publication **and separately permit dist-tag changes**. The workflow requires npm 11.21.0+ for OIDC trusted publishing and dist-tag promotion. Verify permissions and workflow binding in the actual npm/GitHub consoles; this repository does not configure those settings.
- npm's [trusted-publisher documentation](https://docs.npmjs.com/trusted-publishers/) says a newly created trusted-publisher configuration must complete its first successful publish within **two days**; that publish validates the setup and binds it to the repository's immutable identity. If it expires before that first success, delete the expired configuration, create a new one, and complete the first successful publish within the new two-day window. Plan any required first-publish bootstrap and configuration accordingly.
- The first publish may require an authorized maintainer bootstrap before npm can bind a trusted publisher to the package. A registry 404 only showed that the package was not found at the time checked; it does not prove scope ownership or publish rights. Do not assume a trusted publisher can be configured for a nonexistent package, and do not request or place a long-lived npm token in this workflow.
- If an authorized manual bootstrap is necessary, it must publish the exact already verified prepared bytes for the intended `0.1.0` source and provenance, and must satisfy the same immutable tag, source SHA, integrity, npm, GitHub Release, and `latest` checks as the shared recovery coordinator. Arrange the required existing stable tag and use the documented same-source recovery path; do not create an unverified substitute artifact.

On 2026-10-24, the owner authorized and we verified `main` protection requiring one approval, current `CI passed`/`PR title passed` checks from GitHub Actions, resolved conversations, linear history, administrator enforcement, no force pushes/deletion, and squash-only repository merges. npm ownership, publisher binding, and registry write permissions remain unverified; the first release failed authentication. Remote Linux/macOS CI for the then-current branch head had not been observed at that documentation snapshot; check final PR-head CI evidence separately. These are external prerequisites, not claims that this release is ready to run.

## Maintenance and local validation

For repository development, use Node `>=22.19.0` and the locked dependency installs. Core checks are `npm ci --ignore-scripts`, `npm run check`, `npm run test:feasibility`, `npm run test:artifact`, `npm run bench`, `npm ci --prefix .github/release-tools --ignore-scripts`, `npm run release:check`, and `npm run test:release`. CI also runs root and release-tool `npm audit --audit-level=critical` and validates workflows with actionlint `1.7.11`; its archive checksum is pinned in `.github/workflows/test.yml`.

Dependabot maintains root npm, release-tool npm, and GitHub Actions updates. Renovate maintains inline npm and actionlint pins. When updating actionlint, update both version and archive SHA-256 consistently; CI validates the pinned download. Workflow actions are pinned to full commit SHAs. Keep the release-tool manifest and lockfile consistent. Never treat local fake-adapter tests as proof of registry permissions or a live publication.
