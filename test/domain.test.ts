import assert from "node:assert/strict";
import test from "node:test";
import {freshRuntimeRequestStatus, mainRunNodeReader, nativeUserMessageVisible, projectionHasOngoingWork} from "../src/domain.js";
import type {MessageInfo, Projection, RunInfo, ThreadInfo} from "../src/types.js";

const thread: ThreadInfo = {id: "thread", title: "Work", projectId: "project", lineage: {parentThreadId: null, relationshipToParent: null}};
const run: RunInfo = {
  id: "run",
  threadId: thread.id,
  ordinal: 1,
  status: "completed",
  requestedAt: "2026-10-17T10:00:00.000Z",
  startedAt: "2026-10-17T10:00:01.000Z",
  completedAt: "2026-10-17T10:00:02.000Z",
  rootNodeId: "root",
  userMessageId: "request",
  providerThreadId: "provider-main",
};
const rootNode = {id: "root", threadId: thread.id, runId: run.id, parentNodeId: null, rootNodeId: "root",
  providerThreadId: "provider-main", kind: "root_turn", status: "completed"};
const request: MessageInfo = {id: "request", threadId: thread.id, runId: run.id, nodeId: "root", role: "user", text: "Do the task",
  streaming: false, createdAt: run.requestedAt, updatedAt: run.requestedAt};
const projection = (overrides: Partial<Projection> = {}): Projection => ({thread, runs: [run], messages: [request], nodes: [rootNode], ...overrides});

test("native user-message evidence must match its retained root-turn node", () => {
  assert.equal(nativeUserMessageVisible(projection(), run, request), true);
  assert.equal(nativeUserMessageVisible(projection(), run, {...request, nodeId: "child"}), false);
  assert.equal(nativeUserMessageVisible(projection(), {...run, status: "rolled_back"}, request), false);
  assert.equal(nativeUserMessageVisible(projection({nodes: [{...rootNode, parentNodeId: "parent"}]}), run, request), false);
});

test("main run reader returns only nodes in the native root graph", () => {
  const childNode = {id: "child", threadId: thread.id, runId: run.id, parentNodeId: "root", rootNodeId: "root",
    providerThreadId: "provider-main", kind: "subagent", status: "completed"};
  const childOutput = {id: "child-output", threadId: thread.id, runId: run.id, parentNodeId: "child", rootNodeId: "root",
    providerThreadId: "provider-main", kind: "assistant_message", status: "completed"};
  const reader = mainRunNodeReader(projection({nodes: [rootNode, childNode, childOutput]}), run);
  assert.equal(reader("root")?.kind, "root_turn");
  assert.equal(reader("child"), undefined);
  assert.equal(reader("child-output"), undefined);
});

test("runtime request status is tied to the exact request and owning node", () => {
  const active = projection({runtimeRequests: [{id: "question", nodeId: "root", status: "pending"}]});
  assert.equal(freshRuntimeRequestStatus(active, {requestId: "question", nodeId: "root"}), "pending");
  assert.equal(freshRuntimeRequestStatus(active, {requestId: "question", nodeId: "child"}), "unknown");
  const resolved = projection({runtimeRequests: [{id: "question", nodeId: "root", status: "resolved"}]});
  assert.equal(freshRuntimeRequestStatus(resolved, {requestId: "question", nodeId: "root"}), "resolved");
  assert.equal(freshRuntimeRequestStatus(projection(), {requestId: "question", nodeId: "root"}), "unknown");
});

test("native requests and active descendants keep a conversation classified as ongoing", () => {
  assert.equal(projectionHasOngoingWork(projection()), false);
  assert.equal(projectionHasOngoingWork(projection({runtimeRequests: [{id: "question", nodeId: "root", status: "pending"}]})), true);
  assert.equal(projectionHasOngoingWork(projection({subagents: [{status: "running"}]})), true);
  assert.equal(projectionHasOngoingWork(projection({runs: [{...run, status: "running"}]})), true);
});
