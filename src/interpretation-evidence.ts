import { createHash } from "node:crypto";
import { Schema } from "effect";
import { InterpretationAttempt, InterpretationAttemptId, InterpretationSourcePin } from "./interpretation-submission.js";
import { AgreementEvidence } from "./project-supervisor-contract.js";
import type { WorkflowPlanValue } from "./supervisor-workflow.js";

// the evidence an interpretation or a proposal rests on (plan 3.12 item 8). a new interpretation rests on its attempt's
// recorded tool submission; a later negotiated proposal, and an interpretation converted once at the s6e deployment (item 11),
// rest on a supervisor message. evidence is current only while its native item or message still matches
const Text = Schema.String.check(Schema.isNonEmpty());
const Hash = Schema.String.check(Schema.isNonEmpty());

export const InterpretationSubmissionEvidence = Schema.Struct({
  kind: Schema.Literal("interpretation_submission"),
  taskId: Text,
  attemptId: InterpretationAttemptId,
  itemId: Text,
  runId: Text,
  argumentsHash: Hash,
  sourcePin: InterpretationSourcePin,
  // the canonical digest of the submitted plan; null when the submission carries none (bare Start, not needed, no workflow)
  planDigest: Schema.NullOr(Hash),
});
export type InterpretationSubmissionEvidence = typeof InterpretationSubmissionEvidence.Type;

export const SupervisorMessageEvidence = Schema.Struct({
  kind: Schema.Literal("supervisor_message"),
  messageId: Text,
  runId: Text,
  runOrdinal: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  textHash: Hash,
  // set at the s6e conversion for a candidate-free interpretation: the plan digest and the source it interpreted
  planDigest: Schema.optional(Schema.NullOr(Hash)),
  sourcePin: Schema.optional(InterpretationSourcePin),
  // recorded at the s6e conversion when no valid native message existed; stale evidence is never current
  stale: Schema.optional(Schema.Boolean),
});
export type SupervisorMessageEvidence = typeof SupervisorMessageEvidence.Type;

export const InterpretationEvidence = Schema.Union([InterpretationSubmissionEvidence, SupervisorMessageEvidence]);
export type InterpretationEvidence = typeof InterpretationEvidence.Type;

// the identity an agreement records of its proposal's evidence; currency (text hash, pin, digest, staleness) stays with the candidate's
export const agreementEvidenceOf = (evidence: InterpretationEvidence): AgreementEvidence => evidence.kind === "supervisor_message"
  ? {kind: "supervisor_message", messageId: evidence.messageId}
  : {kind: "interpretation_submission", taskId: evidence.taskId, attemptId: evidence.attemptId, itemId: evidence.itemId, runId: evidence.runId,
    argumentsHash: evidence.argumentsHash};
const sameAgreementEvidence = Schema.toEquivalence(AgreementEvidence);
// whether an agreement's recorded evidence names exactly this evidence
export const agreementEvidenceNames = (agreement: AgreementEvidence, evidence: InterpretationEvidence): boolean =>
  sameAgreementEvidence(agreement, agreementEvidenceOf(evidence));

// the two TaskRecord fields S6e adds (project-supervisor-store.ts): the pointer to the task's current attempt and, for a
// candidate-free interpretation, its evidence
export const TaskInterpretationFields = Schema.Struct({
  attempt: Schema.optional(InterpretationAttempt),
  interpretationEvidence: Schema.optional(InterpretationEvidence),
});
export type TaskInterpretationFields = typeof TaskInterpretationFields.Type;

// the one digest of an interpretation's plan, for interpretation_submission.planDigest, the converted
// supervisor_message.planDigest and every digest comparison: sha256 of the JSON of the plan fields in this order with every
// nodeId omitted (node ids are minted per attempt and never part of the plan's identity, as today's interpretation match
// compares shapes); null without a workflow
export const interpretationPlanDigest = (workflow: WorkflowPlanValue | null | undefined): string | null =>
  workflow ? createHash("sha256").update(JSON.stringify({
    definitionsStatus: workflow.definitionsStatus,
    definitionsComplete: workflow.definitionsComplete,
    requirementsKnown: workflow.requirementsKnown,
    requirements: workflow.requirements,
    issues: workflow.issues,
    plan: workflow.plan,
  }, (key, item: unknown) => key === "nodeId" ? undefined : item)).digest("hex") : null;
