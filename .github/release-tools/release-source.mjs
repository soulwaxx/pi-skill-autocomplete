import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const shaPattern = /^[0-9a-f]{40}$/;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const titlePattern = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)]+\))?!?: .+/;
const maxProofAgeMs = 30 * 24 * 60 * 60 * 1000;

export function validateEvidence(proof, expected, now = Date.now()) {
  assert.equal(proof.repository, expected.repository);
  assert.equal(proof.workflow, ".github/workflows/test.yml");
  assert.equal(proof.event, "pull_request");
  assert.equal(proof.runId, expected.run.id);
  assert.equal(proof.runAttempt, expected.run.run_attempt);
  assert.equal(proof.pr, expected.pr.number);
  assert.equal(proof.headSha, expected.pr.head.sha);
  assert.equal(proof.baseSha, expected.parent);
  assert.equal(proof.tree, expected.tree);
  assert.equal(proof.testedSha, expected.testedSha);
  assert.deepEqual(proof.parents, [proof.baseSha, proof.headSha], "tested merge-ref commit must have exactly the expected base and PR head parents");
  const recorded = Date.parse(proof.createdAt);
  assert.ok(Number.isFinite(recorded) && recorded <= now + 5 * 60 * 1000 && now - recorded <= maxProofAgeMs, "tested-source evidence is missing, stale, or future-dated");
}

export async function verifySource({ repository, sha, git, api, evidence, now = Date.now() }) {
  assert.match(repository, repositoryPattern);
  assert.match(sha, shaPattern);
  assert.match(git("show", "-s", "--format=%s", sha), titlePattern, "main commit must use a Conventional Commit title");
  git("merge-base", "--is-ancestor", sha, "origin/main");
  const tree = git("rev-parse", `${sha}^{tree}`);
  const parents = git("show", "-s", "--format=%P", sha).split(" ").filter(Boolean);
  assert.equal(parents.length, 1, "only squash-merged PRs are eligible for release");
  const parent = parents[0];
  const prs = await api(`repos/${repository}/commits/${sha}/pulls?per_page=100`);
  assert.ok(Array.isArray(prs), "GitHub associated-PR response is malformed");
  const matches = prs.filter((item) => item.merged_at && item.merge_commit_sha === sha && item.base.ref === "main" && item.base.repo.full_name === repository);
  assert.equal(matches.length, 1, "release commit must correspond to exactly one merged PR into this repository's main");
  const pr = matches[0];
  assert.match(pr.head.sha, shaPattern);
  const runsResponse = await api(`repos/${repository}/actions/workflows/test.yml/runs?event=pull_request&head_sha=${pr.head.sha}&per_page=100`);
  const runs = runsResponse.workflow_runs;
  assert.ok(Array.isArray(runs), "GitHub workflow-runs response is malformed");
  const eligibleRuns = runs.filter((item) => item.repository.full_name === repository && item.path === ".github/workflows/test.yml" && item.event === "pull_request" && item.head_sha === pr.head.sha && item.status === "completed" && item.conclusion === "success").sort((a, b) => b.id - a.id);
  assert.ok(eligibleRuns.length, "no successful current PR CI run for the exact PR head");
  const selectedRun = eligibleRuns[0];
  const run = await api(`repos/${repository}/actions/runs/${selectedRun.id}/attempts/${selectedRun.run_attempt}`);
  assert.equal(run.id, selectedRun.id);
  assert.equal(run.run_attempt, selectedRun.run_attempt);
  assert.equal(run.repository?.full_name, repository);
  assert.equal(run.path, ".github/workflows/test.yml");
  assert.equal(run.event, "pull_request");
  assert.equal(run.head_sha, pr.head.sha);
  assert.equal(run.status, "completed");
  assert.equal(run.conclusion, "success");
  const attemptStartedAt = Date.parse(run.run_started_at);
  assert.ok(Number.isFinite(attemptStartedAt) && attemptStartedAt <= now + 5 * 60 * 1000 && now - attemptStartedAt <= maxProofAgeMs, "successful PR CI attempt is missing, stale, or future-dated");
  const proof = await evidence(run, pr);
  assert.match(proof.testedSha ?? "", shaPattern, "artifact tested-source SHA is malformed");
  const testedCommit = await api(`repos/${repository}/git/commits/${proof.testedSha}`);
  assert.equal(testedCommit.sha, proof.testedSha, "GitHub returned a different tested-source commit");
  const actualTree = testedCommit.tree?.sha;
  const actualParents = testedCommit.parents?.map((item) => item.sha);
  assert.equal(actualTree, proof.tree, "artifact tested-source tree differs from the actual Git commit");
  assert.equal(actualTree, tree, "tested PR merge-ref tree differs from merged main source tree");
  assert.deepEqual(actualParents, [parent, pr.head.sha], "artifact tested-source commit is not the exact tested PR merge ref");
  validateEvidence(proof, { repository, sha, tree, parent, testedSha: proof.testedSha, pr, run }, now);
  assert.ok(Math.abs(Date.parse(proof.createdAt) - attemptStartedAt) <= maxProofAgeMs, "artifact evidence timestamp is unrelated to its successful CI attempt");
  return proof;
}

export function recordEvidence(file, env, git, now = new Date()) {
  assert.equal(env.GITHUB_EVENT_NAME, "pull_request");
  const testedSha = git("rev-parse", "HEAD");
  const proof = {
    repository: env.GITHUB_REPOSITORY,
    workflow: ".github/workflows/test.yml",
    event: "pull_request",
    runId: Number(env.GITHUB_RUN_ID),
    runAttempt: Number(env.GITHUB_RUN_ATTEMPT),
    pr: Number(env.PR_NUMBER),
    headSha: env.PR_HEAD_SHA,
    baseSha: env.PR_BASE_SHA,
    testedSha,
    tree: git("rev-parse", `${testedSha}^{tree}`),
    parents: git("show", "-s", "--format=%P", testedSha).split(" ").filter(Boolean),
    createdAt: now.toISOString(),
  };
  assert.equal(proof.testedSha, env.GITHUB_SHA);
  assert.match(proof.repository, repositoryPattern);
  assert.match(proof.headSha, shaPattern);
  assert.match(proof.baseSha, shaPattern);
  assert.deepEqual(proof.parents, [proof.baseSha, proof.headSha], "recorded merge-ref must have exactly base and PR-head parents");
  assert.ok(Number.isSafeInteger(proof.runId) && proof.runId > 0 && Number.isSafeInteger(proof.runAttempt) && proof.runAttempt > 0 && Number.isSafeInteger(proof.pr) && proof.pr > 0);
  fs.writeFileSync(file, `${JSON.stringify(proof)}\n`);
}

export function githubApi(route) {
  assert.match(route, /^repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_./?=&-]+$/);
  const response = execFileSync("gh", ["api", route], { encoding: "utf8", timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
  return JSON.parse(response);
}

export async function githubEvidence(repository, run, pr, { api = githubApi, execute = execFileSync, now = Date.now() } = {}) {
  assert.match(repository, repositoryPattern);
  const { artifacts } = api(`repos/${repository}/actions/runs/${run.id}/artifacts?per_page=100`);
  assert.ok(Array.isArray(artifacts), "artifact listing is malformed");
  const artifact = artifacts.find((item) => item.name === `verified-source-${run.run_attempt}` && item.workflow_run?.id === run.id);
  assert.ok(artifact && !artifact.expired && artifact.size_in_bytes > 0 && artifact.size_in_bytes <= 65536, "exact-run tested-source artifact missing, oversized, or expired");
  const attemptStartedAt = Date.parse(run.run_started_at);
  const createdAt = Date.parse(artifact.created_at);
  assert.ok(Number.isFinite(attemptStartedAt) && attemptStartedAt <= now + 5 * 60 * 1000 && now - attemptStartedAt <= maxProofAgeMs, "successful CI attempt is missing, stale, or future-dated");
  assert.ok(Number.isFinite(createdAt) && createdAt <= now + 5 * 60 * 1000 && Math.abs(createdAt - attemptStartedAt) <= maxProofAgeMs, "tested-source artifact timestamp is invalid");
  const bytes = execute("gh", ["api", `repos/${repository}/actions/artifacts/${artifact.id}/zip`], { encoding: "buffer", timeout: 60000, maxBuffer: 1024 * 1024 });
  const json = execute("python3", ["-c", "import io,json,sys,zipfile\nz=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))\nassert z.namelist()==['source.json'] and z.getinfo('source.json').file_size<=8192\nprint(json.dumps(json.loads(z.read('source.json'))))"], { input: bytes, encoding: "utf8", timeout: 10000, maxBuffer: 16384 });
  const proof = JSON.parse(json);
  assert.equal(proof.repository, repository);
  assert.equal(proof.workflow, ".github/workflows/test.yml");
  assert.equal(proof.event, "pull_request");
  assert.equal(proof.runId, run.id);
  assert.equal(proof.runAttempt, run.run_attempt, "artifact proof runAttempt mismatch");
  assert.equal(proof.pr, pr.number);
  assert.equal(proof.headSha, pr.head.sha);
  return proof;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, value] = process.argv.slice(2);
  const git = (...args) => execFileSync("git", args, { encoding: "utf8", timeout: 15000, maxBuffer: 2 * 1024 * 1024 }).trim();
  if (command === "record") recordEvidence(value, process.env, git);
  else if (command === "verify") await verifySource({ repository: process.env.GITHUB_REPOSITORY, sha: value, git, api: githubApi, evidence: (run, pr) => githubEvidence(process.env.GITHUB_REPOSITORY, run, pr) });
  else throw new Error("usage: release-source.mjs record <file> | verify <sha>");
}
