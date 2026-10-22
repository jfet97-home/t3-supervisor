import assert from "node:assert/strict";
import { it } from "vitest";
import { compactProposalDigest, resolveCompactProposal, workflowAgreementPlanHash } from "../src/supervisor-workflow-agreement.js";
import { canonicalizeProposalDraft, prepareWorkflowRequest } from "../src/supervisor-workflow.js";
import { goldenDraft, goldenPins, goldenProposalId, goldenSeed, goldenSnapshot } from "./support/c1-workflow-fixture.js";

const digest = "80f74bf9526d4e8080e9d46d56ddb38ac1212ce61d95b73a155f3e67d4935352";
const planHash = "795daa05bf4d60fa1474a2f02696f51f88d2e3d758f84338af42b92bec074134";

it("CT-SWA-01: compactProposalDigest and workflowAgreementPlanHash are golden hex values for a fixture proposal", {timeout: 10_000}, () => {
  const context = prepareWorkflowRequest("thread-a", "message-a", "Check this task.", goldenSnapshot).context;
  assert.ok(context);
  const canonical = canonicalizeProposalDraft(goldenDraft, context, goldenSeed);
  assert.ok(canonical.ok);
  const value = {workspaceRoot: "/work/project", revision: "revision-ready", workflow: canonical.workflow};
  assert.equal(compactProposalDigest(goldenPins, value), digest);
  assert.equal(workflowAgreementPlanHash(value), planHash);
  // the chat protocol path stores the same digest for the same draft
  const resolved = resolveCompactProposal({...goldenPins, proposalId: goldenProposalId, revision: "revision-ready", draft: goldenDraft}, goldenPins, context, () => null);
  assert.ok(resolved.ok);
  assert.equal(resolved.proposal.digest, digest);
  assert.equal(resolved.proposal.formal, true);
  assert.equal(workflowAgreementPlanHash(resolved.proposal), planHash);
  // each pin is bound into the digest
  assert.notEqual(compactProposalDigest({...goldenPins, taskRevision: "source-hash-2"}, value), digest);
  assert.notEqual(compactProposalDigest({...goldenPins, taskId: "task-b"}, value), digest);
  assert.equal(workflowAgreementPlanHash({...value}), planHash);
});
