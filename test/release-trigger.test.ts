import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { it } from "@effect/vitest";
import { parse } from "yaml";

// execute the actual pre-checkout GitHub adapter so its trigger and API decisions stay covered
const workflow = parse(readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"));
const script = workflow.jobs.gate.steps[0].with.script as string;
const sha = "a".repeat(40);
const repository = "jfet97/t3-supervisor";
const green = { id: 42, head_sha: sha, head_repository: { full_name: repository }, head_branch: "main", event: "push" };
const nightly = { draft: false, prerelease: true, tag_name: "v0.0.3-nightly.20261024010000.gaaaaaaaaaaaa", target_commitish: sha };

const fixture = () => ({
  event: "schedule",
  trigger: sha,
  main: "b".repeat(40),
  comparison: "ahead",
  candidates: [green],
  runs: [green],
  jobs: [{ name: "check", conclusion: "success" }],
  versionPR: false,
  releases: [] as typeof nightly[],
  requested: sha,
  channel: "stable",
});

const execute = async (input = fixture()) => {
  const outputs: Record<string, string> = {};
  const actions = {
    getWorkflow: async () => ({ data: { id: 7 } }),
    listWorkflowRuns: async () => ({ data: { workflow_runs: input.runs } }),
    listJobsForWorkflowRun: async () => input.jobs,
  };
  const repos = {
    getBranch: async () => ({ data: { commit: { sha: input.main } } }),
    compareCommitsWithBasehead: async () => ({ data: { status: input.comparison } }),
    listReleases: async () => input.releases,
    listPullRequestsAssociatedWithCommit: async () => input.versionPR ? [{
      merged_at: "2026-10-24T01:00:00Z", merge_commit_sha: sha, base: { ref: "main" },
      head: { ref: "changeset-release/main", repo: { full_name: repository } },
    }] : [],
    getCommit: async () => ({ data: { commit: { committer: { date: "2026-10-24T01:00:00Z" } } } }),
  };
  await runInNewContext(`(async () => {${script}\n})()`, {
    github: {
      rest: { actions, repos },
      paginate: async (method: unknown) => {
        if (method === actions.listWorkflowRuns) return input.candidates;
        if (method === actions.listJobsForWorkflowRun) return input.jobs;
        if (method === repos.listReleases) return input.releases;
        if (method === repos.listPullRequestsAssociatedWithCommit) return repos.listPullRequestsAssociatedWithCommit();
        throw new Error("unexpected API pagination");
      },
    },
    context: { eventName: input.event, sha: input.trigger, repo: { owner: "jfet97", repo: "t3-supervisor" }, payload: { workflow_run: green } },
    process: { env: { REQUESTED_REVISION: input.event === "schedule" ? "" : input.requested, REQUESTED_CHANNEL: input.channel } },
    core: { setOutput: (key: string, value: string) => { outputs[key] = value; }, info: () => {} },
  });
  return outputs;
};

it("selects the checked scheduled revision even if main advances while the run starts", async () => {
  assert.equal(workflow.on.schedule.length, 1);
  assert.deepEqual(workflow.on.schedule[0], { cron: "17 3 * * *", timezone: "Europe/Rome" });
  assert.deepEqual(await execute(), { sha, channel: "nightly", commitTime: "2026-10-24T01:00:00Z" });
});

it("does nothing overnight without green main CI or when that source already has a completed nightly", async () => {
  assert.deepEqual(await execute({ ...fixture(), candidates: [] }), {});
  assert.deepEqual(await execute({ ...fixture(), trigger: "b".repeat(40) }), {});
  assert.deepEqual(await execute({ ...fixture(), releases: [nightly] }), {});
});

it("resumes partial nightly publications and does not confuse other channels or sources with completion", async () => {
  for (const receipt of [
    { ...nightly, draft: true }, { ...nightly, tag_name: nightly.tag_name.replace("nightly", "beta") },
    { ...nightly, target_commitish: "c".repeat(40) },
  ]) assert.equal((await execute({ ...fixture(), releases: [receipt] })).channel, "nightly");
});

it("ignores foreign CI and sources no longer on main, and still requires the aggregate check", async () => {
  assert.deepEqual(await execute({ ...fixture(), candidates: [{ ...green, head_repository: { full_name: "fork/repo" } }] }), {});
  assert.deepEqual(await execute({ ...fixture(), comparison: "diverged" }), {});
  await assert.rejects(execute({ ...fixture(), jobs: [{ name: "check", conclusion: "failure" }] }), /aggregate check/u);
  await assert.rejects(execute({ ...fixture(), runs: [] }), /successful main CI/u);
});

it("ordinary green merges wait for overnight, while approved version PRs publish stable immediately", async () => {
  assert.deepEqual(await execute({ ...fixture(), event: "workflow_run" }), {});
  assert.equal((await execute({ ...fixture(), event: "workflow_run", versionPR: true })).channel, "stable");
});

it("preserves explicit manual channels and exact-source checks", async () => {
  for (const channel of ["stable", "nightly", "alpha", "beta"]) {
    assert.equal((await execute({ ...fixture(), event: "workflow_dispatch", channel })).channel, channel);
  }
  await assert.rejects(execute({ ...fixture(), event: "workflow_dispatch", comparison: "diverged" }), /not on main/u);
  assert.equal((await execute({ ...fixture(), event: "workflow_dispatch", requested: "main" })).sha, sha);
});

it("rejects mismatched provenance before a new immutable image or npm publication", () => {
  const steps = workflow.jobs.release.steps as Array<{ name?: string; run?: string; if?: string; with?: { push?: boolean } }>;
  const index = steps.findIndex(step => step.name === "Require source-bound provenance for new publications");
  const guard = steps[index];
  assert.ok(guard?.run);
  assert.ok(index < steps.findIndex(step => step.with?.push === true));
  assert.match(guard.if!, /env.PUBLISH == 'true'/u);
  assert.match(guard.if!, /steps.registry.outputs.exists != 'true'/u);
  const check = (revision: string) => execFileSync("bash", ["-e", "-c", guard.run!], {
    env: { ...process.env, GITHUB_SHA: sha, REVISION: revision }, stdio: "pipe",
  });
  assert.doesNotThrow(() => check(sha));
  assert.throws(() => check("b".repeat(40)));
});

it("uses distinct platform manifest digests so Docker's legacy store cannot collide on the shared index", () => {
  const smoke = workflow.jobs.release.steps.find((step: { name?: string }) => step.name === "Verify both published image variants by immutable digest").run as string;
  const selector = /variant=\$\(jq -er --arg architecture [^\n]+ '([^']+)' release\/image-manifest\.json\)/u.exec(smoke)?.[1];
  assert.ok(selector);
  const variants = [
    { platform: { os: "linux", architecture: "amd64" }, digest: `sha256:${"1".repeat(64)}` },
    { platform: { os: "linux", architecture: "arm64" }, digest: `sha256:${"2".repeat(64)}` },
    { platform: { os: "unknown", architecture: "unknown" }, digest: `sha256:${"3".repeat(64)}` },
  ];
  const select = (architecture: string, manifests = variants) => execFileSync("jq", ["-er", "--arg", "architecture", architecture, selector], {
    input: JSON.stringify({ digest: `sha256:${"0".repeat(64)}`, manifests }), encoding: "utf8", stdio: "pipe",
  }).trim();
  assert.equal(select("amd64"), variants[0]!.digest);
  assert.equal(select("arm64"), variants[1]!.digest);
  assert.throws(() => select("arm64", variants.slice(0, 1)));
  assert.throws(() => select("amd64", [...variants, variants[0]!]));
  assert.throws(() => select("amd64", [{ ...variants[0]!, digest: "invalid" }]));
});
