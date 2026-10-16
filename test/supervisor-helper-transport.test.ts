import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {GuidanceStore} from "../src/guidance-store.js";
import {ProjectSupervisorStore, defaultSupervisorModel} from "../src/project-supervisor-store.js";
import {SupervisorTeamStore} from "../src/supervisor-team-store.js";
import {SupervisorHelperTransport} from "../src/supervisor-helper-transport.js";
import type {Projection} from "../src/types.js";

const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "helper-transport-"));
  const db = new GuidanceStore(directory);
  const store = new ProjectSupervisorStore(db, new Set());
  db.db.prepare("INSERT INTO meta VALUES(?,?)").run('supervisor_control:"p"', JSON.stringify({enabled: true, manual: true, generation: 1}));
  const binding = {...store.reserve("p", "main", "main", defaultSupervisorModel, 1, 1), state: "ready" as const};store.setBinding(binding);
  const team = new SupervisorTeamStore(store);
  team.registerMember(binding, {threadId: "helper", taskId: "bootstrap", bootstrapRunId: "boot"});
  const helper: Projection = {thread: {id: "helper", projectId: "p", title: "helper", modelSelection: defaultSupervisorModel,
    runtimeMode: "full-access", interactionMode: "default", lineage: {parentThreadId: binding.threadId, relationshipToParent: "subagent"}},
  runs: [], messages: [], runtimeRequests: []};
  const tasks: Record<string, unknown>[] = [];
  const calls: string[] = [];
  const state = {posts: 0, loseReply: false, emitMessage: true};
  const rpc = async (tag: string, input: Record<string, unknown>) => {
    calls.push(tag);
    if (tag === "scheduledTasks.list") return {tasks};
    if (tag === "scheduledTasks.upsert") {
      const task = {...input, createdAt: "2026-10-16T10:00:00Z", webhook: {path: "/api/hooks/fixture/fixture-only-token", url: null}};
      tasks.splice(0, tasks.length, task);return {task};
    }
    if (tag === "scheduledTasks.delete") {assert.equal(input.id, tasks[0]!.id);tasks.splice(0);return {id: input.id};}
    throw new Error("unexpected_rpc");
  };
  const mockFetch: typeof fetch = async (_url, options) => {
    state.posts++;
    const body = JSON.parse(String(options?.body)) as {text: string};
    if (state.emitMessage) helper.messages.push({id: "native-scheduler-message", threadId: "helper", scheduledTaskId: tasks[0]!.id,
      runId: "scheduler-run", nodeId: "root", role: "user", text: body.text, creationSource: "server", createdBy: "system",
      streaming: false, createdAt: "2026-10-16T10:00:00Z", updatedAt: "2026-10-16T10:00:00Z"});
    if (state.loseReply) throw new Error("post_reply_lost");
    return Response.json({deliveryId: "native-delivery"}, {status: 202});
  };
  const options = {store, rpc, baseUrl: "http://127.0.0.1:3773", projection: async () => helper, fetch: mockFetch};
  return {directory, db, store, binding, helper, tasks, calls, state, options,
    cleanup: async () => {db.close();await rm(directory, {recursive: true, force: true});}};
};

test("native webhook check-ins have real schedule identity and no root follow-up dispatch", async () => {
  const f = await fixture();
  try {
    const transport = new SupervisorHelperTransport(f.options);
    const input = {threadId: "helper", commandId: "check-in", messageId: "logical-message", text: "Bounded check-in marker-1"};
    assert.equal(await transport.send(f.binding, input, AbortSignal.timeout(1000)), "waiting");
    assert.deepEqual(f.tasks[0]!.schedule, {type: "webhook"});
    assert.equal(f.tasks[0]!.threadId, "helper");
    assert.equal(f.tasks[0]!.prompt, "{{body.text}}");
    assert(!f.calls.includes("orchestration.dispatchCommand"));
    assert.equal(f.state.posts, 1);
    assert(transport.matchesMessage(f.binding, input.messageId, input.text, f.helper.messages[0]!));
    assert(!transport.matchesMessage(f.binding, input.messageId, input.text, {...f.helper.messages[0]!, scheduledTaskId: "foreign"}));
    assert(!transport.matchesMessage(f.binding, input.messageId, input.text, {...f.helper.messages[0]!, text: "Changed body"}));
    assert.equal(await transport.send(f.binding, input, AbortSignal.timeout(1000)), "waiting");
    assert.equal(f.state.posts, 1);
    assert(await transport.retire(f.binding, "helper", AbortSignal.timeout(1000)));
    assert.equal(f.tasks.length, 0);
  } finally {await f.cleanup();}
});

test("uncertain webhook POST never repeats across restart, and native evidence can reconcile it", async () => {
  const f = await fixture();
  try {
    f.state.loseReply = true;f.state.emitMessage = false;
    const input = {threadId: "helper", commandId: "lost", messageId: "lost-message", text: "Unique durable marker-2"};
    assert.equal(await new SupervisorHelperTransport(f.options).send(f.binding, input, AbortSignal.timeout(1000)), "uncertain");
    const restarted = new SupervisorHelperTransport(f.options);
    assert.equal(await restarted.send(f.binding, input, AbortSignal.timeout(1000)), "uncertain");
    assert.equal(f.state.posts, 1);
    assert.equal(await restarted.send(f.binding, {...input, text: "changed"}, AbortSignal.timeout(1000)), "rejected");
    f.helper.messages.push({id: "recovered-native-message", threadId: "helper", scheduledTaskId: f.tasks[0]!.id,
      runId: "run", nodeId: "root", role: "user", text: input.text, creationSource: "server", streaming: false,
      createdAt: "2026-10-16T10:00:00Z", updatedAt: "2026-10-16T10:00:00Z"});
    assert.equal(await restarted.send(f.binding, input, AbortSignal.timeout(1000)), "waiting");
    assert.equal(f.state.posts, 1);
  } finally {await f.cleanup();}
});

test("a manually changed native channel cannot redirect helper work or be silently overwritten", async () => {
  const f = await fixture();
  try {
    const transport = new SupervisorHelperTransport(f.options);
    const input = {threadId: "helper", commandId: "first", messageId: "first-message", text: "First check-in"};
    await transport.send(f.binding, input, AbortSignal.timeout(1000));
    f.tasks[0]!.threadId = "foreign-thread";
    assert.equal(await transport.send(f.binding, {...input, commandId: "second", messageId: "second-message", text: "Second check-in"}, AbortSignal.timeout(1000)), "busy");
    assert.equal(f.state.posts, 1);
    assert.equal(await transport.retire(f.binding, "helper", AbortSignal.timeout(1000)), false);
    assert.equal(f.tasks.length, 1);
  } finally {await f.cleanup();}
});
