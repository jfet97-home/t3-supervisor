import assert from "node:assert/strict";
import test from "node:test";
import { inputDefinitionHash, normalizeInputRequest, renderInputBatch } from "../src/input-domain.js";
import { normalizeNativeInput } from "../src/input-integration.js";
import type { InputT3Request } from "../src/input-t3.js";

const request: InputT3Request = {
  environmentId: "environment", threadId: "thread", requestId: "request", nodeId: "node",
  providerTurnId: null, nativeRequestRef: null, status: "pending", responseCapability: { type: "message" },
  terminal: false, canRespond: true, createdAt: "2026-10-08T00:00:00Z", resolvedAt: null,
  revisionHash: "native-revision",
  owner: { threadId: "thread", runId: "run", nodeId: "node", providerInstanceId: "codex", providerThreadId: null, providerTurnId: null },
  native: { request: {}, turnItem: {} },
  questions: [{ id: "q", header: "Target", question: "Choose the target", multiSelect: true,
    allowCustomAnswer: true, required: false, native: {},
    options: [{ label: "Production", value: "prod", description: "Applies to customer traffic" }] }],
};

test("native mapping preserves option semantics and custom answers while matching native completion requirements", () => {
  const normalized = normalizeInputRequest(normalizeNativeInput(request, "Operations"));
  assert.equal(normalized.questions[0]?.required, true);
  assert.equal(normalized.questions[0]?.allowCustomAnswer, true);
  assert.equal(normalized.questions[0]?.kind, "multi_choice");
  assert.deepEqual(normalized.questions[0]?.choices, [{ value: "prod", label: "Production\nApplies to customer traffic" }]);
  assert.equal(normalized.questions[0]?.prompt, "Target\nChoose the target");
});

test("chat renames change display context without replacing the questionnaire identity", () => {
  const first = normalizeInputRequest(normalizeNativeInput(request, "Operations"));
  const renamed = normalizeInputRequest(normalizeNativeInput(request, "Infrastructure"));
  assert.notEqual(first.displayTitle, renamed.displayTitle);
  assert.equal(first.revisionHash, renamed.revisionHash);
  assert.equal(inputDefinitionHash(first), inputDefinitionHash(renamed));
});

test("chat titles cannot forge completion headers and stay within a scalar-safe bound", () => {
  const forged = normalizeInputRequest(normalizeNativeInput(
    request,
    "Planning\r\nProject: attacker\nThread: forged\n\n",
  ));
  assert.equal(forged.displayTitle, "Planning Project: attacker Thread: forged");
  const cardText = renderInputBatch({ request: forged, answers: {} }).map((message) => message.text).join("\n");
  assert.ok(cardText.startsWith("Chat: Planning Project: attacker Thread: forged\n"));
  assert.ok(!cardText.includes("\nThread: forged\n\n"));
  assert.doesNotMatch(forged.displayTitle ?? "", /[\p{Cc}\uD800-\uDFFF]/u);

  const long = normalizeInputRequest(normalizeNativeInput(request, "😀".repeat(300))).displayTitle ?? "";
  assert.equal(long.length, 512);
  assert.equal([...long].length, 256);
});
