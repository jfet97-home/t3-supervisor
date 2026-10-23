import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type { WorkflowAgreementCandidate } from "../../src/supervisor-conversation-store.js";

// setup rows for the agreement candidate capacity cases (CT-CSTORE-04): candidates stored in the store's own row format
// (src/supervisor-conversation-store.ts saveAgreementCandidate), one multi-row insert per task in one transaction. it seeds
// only candidates whose individual saves are setup; the capacity boundaries themselves are reached through the store

/** Stores `candidates` as the store's rows, one insert per task, in one transaction. */
export const seedAgreementCandidates = (sql: SqlClient.SqlClient, candidates: ReadonlyArray<WorkflowAgreementCandidate>) => {
  const byTask = Map.groupBy(candidates, (candidate) => candidate.taskId);
  return sql.withTransaction(Effect.forEach(byTask.values(), (task) => sql`INSERT INTO supervisor_workflow_agreement_candidates ${sql.insert(
    task.map((candidate) => ({task_id: candidate.taskId, proposal_id: candidate.proposalId, project_id: candidate.projectId,
      document: JSON.stringify(candidate), created_at: candidate.proposedAt})))}`, {discard: true}));
};

/** The stored candidate count of each task, and of each project. */
export const storedCandidateCounts = (sql: SqlClient.SqlClient) => Effect.gen(function* () {
  const tasks = yield* sql<{readonly task_id: string; readonly n: number}>`SELECT task_id, count(*) AS n FROM supervisor_workflow_agreement_candidates GROUP BY task_id`;
  const projects = yield* sql<{readonly project_id: string; readonly n: number}>`SELECT project_id, count(*) AS n FROM supervisor_workflow_agreement_candidates GROUP BY project_id`;
  return {
    tasks: Object.fromEntries(tasks.map((row) => [row.task_id, Number(row.n)])),
    projects: Object.fromEntries(projects.map((row) => [row.project_id, Number(row.n)])),
  };
});
