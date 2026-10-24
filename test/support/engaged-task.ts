import assert from "node:assert/strict";
import { genuineHumanMessage } from "../../src/domain.js";
import { fingerprint } from "../../src/guidance-store.js";
import type { TaskRecord } from "../../src/project-supervisor-store.js";
import { emptyConversation } from "../../src/supervision-conversation-contract.js";
import type { Projection } from "../../src/types.js";

/** Seed an authorized test task from an actual native human source, rather than implied plan presence. */
export const engagedTask = (task: TaskRecord, projection: Projection): TaskRecord => {
  const sourceMessage = genuineHumanMessage(projection, task.sourceMessageId);
  assert.ok(sourceMessage);
  const sourceRun = projection.runs.find(run => run.id === sourceMessage.runId)!;
  const source = {messageId: sourceMessage.id, runId: sourceRun.id, ordinal: sourceRun.ordinal, hash: fingerprint(sourceMessage.text), requester: "human" as const};
  const latestRun = [...projection.runs].filter(run => projection.messages.some(message => message.runId === run.id && genuineHumanMessage(projection, message.id)))
    .sort((a, b) => a.ordinal - b.ordinal).at(-1)!;
  const latest = projection.messages.find(message => message.runId === latestRun.id && genuineHumanMessage(projection, message.id))!;
  const considered = {...source, messageId: latest.id, runId: latestRun.id, ordinal: latestRun.ordinal, hash: fingerprint(latest.text)};
  return {...task, sourceRunId: source.runId, sourceOrdinal: source.ordinal, sourceHash: source.hash,
    conversation: {...emptyConversation(task.updatedAt), considered, observed: considered,
      authorization: {scopeRevision: source.hash, outcome: task.objective ?? sourceMessage.text, limits: [], scopeSources: [source],
        state: "authorized", stateSource: source, attemptId: "fixture-source"}}};
};
