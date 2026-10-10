import { Effect } from "effect";
import { readFile } from "node:fs/promises";
import { buildContext, eligibleRuns } from "../src/domain.js";
import { T3Client, makeT3Client } from "../src/t3.js";

const tokenPath = process.env.T3_TOKEN_FILE;
if (!tokenPath) throw new Error("Set T3_TOKEN_FILE to the private credential path");
const token = (await readFile(tokenPath, "utf8")).trim();
const baseUrl = process.env.T3_URL ?? "http://127.0.0.1:3773";
const response = await fetch(`${baseUrl}/api/orchestration/shell`, {
  headers: { Authorization: `Bearer ${token}`, "x-t3-orchestration-protocol": "2" },
  signal: AbortSignal.timeout(20_000),
});
if (!response.ok) throw new Error(`T3 read failed: ${response.status}`);
const snapshot = await response.json() as { threads: Array<{ id: string; status: string; lineage: { relationshipToParent: string | null } }> };
const candidates = snapshot.threads.filter((thread) => thread.status === "completed" &&
  thread.id !== "af0e5160-07d2-46c9-b60b-a329d6951d83" && thread.lineage.relationshipToParent !== "subagent").slice(0, 20);
let verified = false;
await Effect.runPromise(Effect.gen(function* () {
  const source = yield* T3Client;
  for (const candidate of candidates) {
    const result = yield* source.projection(candidate.id);
    const runs = eligibleRuns(result.projection, 0);
    const latest = runs.at(-1);
    if (!latest) continue;
    const context = buildContext(result.projection, latest.id, null);
    verified = context.finalAnswer.trim().length > 0;
    console.log(JSON.stringify({ readOnly: true, verified, eligibleRuns: runs.length, contextCharacters: JSON.stringify(context).length, notificationsSent: 0, modelCalls: 0 }));
    break;
  }
}).pipe(Effect.provide(makeT3Client({ baseUrl, token }))));
if (!verified) {
  console.log(JSON.stringify({ readOnly: true, verified: false, reason: "no_completed_idle_candidate", notificationsSent: 0 }));
  process.exitCode = 1;
}
