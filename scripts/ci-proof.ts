import { Schema } from "effect";

const Sha = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u));
const Name = Schema.Struct({ full_name: Schema.String });
const Id = Schema.Number.check(Schema.makeFilter((value) => Number.isSafeInteger(value) && value > 0));
export const CiRun = Schema.Struct({
  id: Id,
  workflow_id: Id,
  head_sha: Sha,
  head_branch: Schema.NullOr(Schema.String),
  head_repository: Schema.NullOr(Name),
  repository: Name,
  event: Schema.String,
  status: Schema.String,
  conclusion: Schema.NullOr(Schema.String),
});
export const decodeCiRuns = Schema.decodeUnknownSync(Schema.Array(CiRun));
export const MergeProof = Schema.Struct({
  expected: Schema.Struct({ repository: Schema.String, workflowId: Id, head: Sha, branch: Schema.String, tree: Sha }),
  headTree: Sha,
  runs: Schema.Array(CiRun),
  jobs: Schema.Array(Schema.Struct({ name: Schema.String, run_id: Id, conclusion: Schema.NullOr(Schema.String) })),
});

// these are the full jobs in check.yml; a lightweight main run can never supply this proof
export const requiredFullJobs = ["static", "main (1/4)", "main (2/4)", "main (3/4)", "main (4/4)", "harness", "check"] as const;

export const newestPrRun = (runs: ReadonlyArray<typeof CiRun.Type>, expected: typeof MergeProof.Type.expected) =>
  runs.filter((run) => run.workflow_id === expected.workflowId && run.head_sha === expected.head &&
    run.repository.full_name === expected.repository && run.head_repository?.full_name === expected.repository &&
    (run.event === "pull_request" || (run.event === "workflow_dispatch" && run.head_branch === expected.branch)))
    .sort((left, right) => right.id - left.id)[0];

export const proveMergedValidation = (input: unknown): { readonly runId: number; readonly tree: string } => {
  const { expected, headTree, runs, jobs } = Schema.decodeUnknownSync(MergeProof)(input);
  if (headTree !== expected.tree) throw new Error("merged files differ from the checked PR head");
  const run = newestPrRun(runs, expected);
  if (!run || run.status !== "completed" || run.conclusion !== "success") throw new Error("latest PR validation is not successful");
  for (const name of requiredFullJobs) {
    const matches = jobs.filter((job) => job.name === name);
    if (matches.length !== 1 || matches[0]!.run_id !== run.id || matches[0]!.conclusion !== "success") {
      throw new Error("full validation job is missing or unsuccessful");
    }
  }
  return { runId: run.id, tree: headTree };
};
