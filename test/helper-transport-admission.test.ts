import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Option, Scope } from "effect";
import { FetchHttpClient, HttpClient, type HttpClientResponse } from "effect/http";
import { GuidanceStore } from "../src/guidance-store.js";
import { defaultSupervisorModel, ProjectSupervisorStore } from "../src/project-supervisor-store.js";
import { makeSupervisionGate, SupervisionGate, type GateGuard, type SupervisionGateShape } from "../src/supervision-gate.js";
import { helperDeliveryBody, HelperTransport, type SupervisorHelperMessage } from "../src/supervisor-helper-transport.js";
import { NativeOperateRpc } from "../src/supervisor-native.js";
import { SupervisorTeamStore } from "../src/supervisor-team-store.js";
import { T3Client } from "../src/t3.js";
import type { Projection } from "../src/types.js";
import { operateClient, projectionClient } from "./support/team-units.js";

// CT-LIN-05 on the real helper transport (plan 3.11): the webhook POST is the admitted send. Its final guard, its
// 'posting' receipt and the start of the POST happen in one admission section; the reply is awaited outside it. The
// peer is a loopback HTTP server that holds each reply until the case releases it; fetch is the platform fetch, wrapped
// only to log the synchronous start of each POST and the aborts of its signal

const webhookPath = "/api/hooks/fixture/admission-only-token";
const input: SupervisorHelperMessage = { threadId: "helper", commandId: "admission-command", messageId: "admission-message", text: "Check the assigned branch." };

type Peer = {
  readonly baseUrl: string;
  readonly posts: string[];
  readonly arrived: Deferred.Deferred<void>;
  readonly reply: Deferred.Deferred<void>;
  // a POST's request ended on the peer: its exchange closed, finished or not
  readonly ended: Deferred.Deferred<void>;
  // replies whose connection closed before the peer finished writing them
  readonly cut: number[];
};

// "held": a complete 202 with a delivery id once `reply` completes; a status: that status's headers and the first byte of
// a declared body at once, the rest never sent, so the request stays open until the client ends it

const peer = (mode: "held" | number) => Effect.acquireRelease(Effect.gen(function* () {
  const arrived = yield* Deferred.make<void>();
  const ended = yield* Deferred.make<void>();
  const cut: number[] = [];
  const reply = yield* Deferred.make<void>();
  const posts: string[] = [];
  const waiting = new Set<ServerResponse>();
  const answer = (response: ServerResponse) => {
    if (!waiting.delete(response) || response.destroyed) return;
    response.writeHead(202, { "content-type": "application/json" }).end(JSON.stringify({ deliveryId: `native-delivery-${posts.length}` }));
  };
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      posts.push(Buffer.concat(chunks).toString("utf8"));
      const index = posts.length;
      response.once("close", () => {
        if (!response.writableFinished) cut.push(index);
        Deferred.doneUnsafe(ended, Effect.void);
      });
      Deferred.doneUnsafe(arrived, Effect.void);
      if (mode !== "held") {
        response.writeHead(mode, { "content-type": "application/json", "content-length": "64" });
        response.write("{");
        return;
      }
      waiting.add(response);
      if (Deferred.isDoneUnsafe(reply)) answer(response);
    });
  });
  yield* Effect.callback<void>((resume) => {server.listen(0, "127.0.0.1", () => resume(Effect.void));});
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  yield* Effect.forkScoped(Deferred.await(reply).pipe(Effect.andThen(Effect.sync(() => {for (const response of [...waiting]) answer(response);}))));
  return { server, peer: { baseUrl: `http://127.0.0.1:${address.port}`, posts, arrived, reply, ended, cut } satisfies Peer };
}), ({ server }) => Effect.callback<void>((resume) => {
  server.close(() => resume(Effect.void));
  server.closeAllConnections();
})).pipe(Effect.map(({ peer }) => peer));

const fixtureWith = (mode: "held" | number) => Effect.gen(function* () {
  const directory = yield* Effect.acquireRelease(Effect.promise(() => mkdtemp(join(tmpdir(), "helper-admission-"))),
    (path) => Effect.promise(() => rm(path, { recursive: true, force: true })));
  const guidance = yield* Effect.acquireRelease(Effect.sync(() => new GuidanceStore(directory)), (db) => Effect.sync(() => db.close()));
  const store = new ProjectSupervisorStore(guidance, new Set());
  guidance.db.prepare("INSERT INTO meta VALUES(?,?)").run('supervisor_control:"p"', JSON.stringify({ enabled: true, manual: true, generation: 1 }));
  const binding = { ...store.reserve("p", "main", "main", defaultSupervisorModel, 1, 1), state: "ready" as const };store.setBinding(binding);
  new SupervisorTeamStore(store).registerMember(binding, { threadId: "helper", taskId: "bootstrap", bootstrapRunId: "boot" });
  const helper: Projection = { thread: { id: "helper", projectId: "p", title: "helper", modelSelection: defaultSupervisorModel,
    runtimeMode: "full-access", interactionMode: "default", lineage: { parentThreadId: binding.threadId, relationshipToParent: "subagent" } },
  runs: [], messages: [], runtimeRequests: [] };
  const http = yield* peer(mode);
  const log: string[] = [];
  const rpcs: string[] = [];
  const tasks: Record<string, unknown>[] = [];
  const rpc = async (tag: string, payload: Record<string, unknown>) => {
    rpcs.push(tag);
    if (tag === "scheduledTasks.list") return { tasks };
    if (tag === "scheduledTasks.upsert") {
      const task = { ...payload, createdAt: "2026-10-16T10:00:00Z", webhook: { path: webhookPath, url: null } };
      tasks.splice(0, tasks.length, task);return { task };
    }
    if (tag === "scheduledTasks.listWebhookDeliveries") return { deliveries: [] };
    throw new Error("unexpected_rpc");
  };
  // the policy the guard reads; a Stop is a section that commits it and then its bookkeeping
  // stopped: the per-chat stop the scope predicate includes; revoked: the caller's own authority (a quarantine)
  const policy = { stopped: false, revoked: false };
  let guardReads = 0;
  let onGuard: ((read: number) => void) | null = null;
  const guard: GateGuard = {
    scopeEnabled: () => {log.push("guard");onGuard?.(++guardReads);return !policy.stopped;},
    supervisionStopped: () => policy.stopped,
    workflowEditingEnabled: () => true,
  };
  const inner = yield* makeSupervisionGate(guard);
  // each section logs the end of its body while it still holds the permit
  let sections = 0;
  const gate: SupervisionGateShape = {
    admit: (body) => inner.admit((current) => Effect.ensuring(body(current), Effect.sync(() => {sections += 1;log.push("end");}))),
  };
  const stop = (change: (current: typeof policy) => void, barrier?: { entered: Deferred.Deferred<void>; release: Deferred.Deferred<void> }) =>
    gate.admit(() => Effect.gen(function* () {
      if (barrier) yield* Deferred.succeed(barrier.entered, undefined);
      change(policy);
      log.push("policy-commit");
      if (barrier) yield* Deferred.await(barrier.release);
      log.push("bookkeeping");
    }));
  let aborts = 0;
  const fetch: typeof globalThis.fetch = (url, init) => {
    log.push("initiate");
    init?.signal?.addEventListener("abort", () => {aborts += 1;}, { once: true });
    return globalThis.fetch(url, init);
  };
  let projectionGate: Promise<void> | null = null;
  let projectionReads = 0;
  const projection = async () => {projectionReads += 1;if (projectionGate) await projectionGate;return helper;};
  // a transport in its own scope, as the supervision run builds it; `wrap` stands between it and the fetch client
  const transport = (scope: Scope.Scope, wrap: (client: HttpClient.HttpClient) => HttpClient.HttpClient = (client) => client) => HttpClient.HttpClient.pipe(
    Effect.flatMap((client) => HelperTransport.make({ store, baseUrl: http.baseUrl }).pipe(Effect.provideService(HttpClient.HttpClient, wrap(client)))),
    Effect.provideService(NativeOperateRpc, operateClient(rpc)),
    Effect.provideService(SupervisionGate, gate),
    Effect.provideService(T3Client, projectionClient(projection)),
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, fetch),
    Scope.provide(scope),
  );
  const receipt = () => {
    const row = guidance.db.prepare("SELECT document FROM supervisor_helper_deliveries WHERE owner_thread_id=? AND owner_generation=? AND message_id=?")
      .get(binding.threadId, binding.generation, input.messageId);
    return row ? JSON.parse(String(row.document)) as Record<string, unknown> : null;
  };
  const until = (condition: () => boolean) => Effect.gen(function* () {while (!condition()) yield* Effect.yieldNow;});
  return { binding, http, log, rpcs, policy, gate, stop, transport, receipt, until,
    aborts: () => aborts, sections: () => sections, projectionReads: () => projectionReads,
    onGuard: (action: (read: number) => void) => {onGuard = action;},
    holdProjection: (gateOn: Promise<void>) => {projectionGate = gateOn;} };
});

const fixture = fixtureWith("held");

describe("CT-LIN-05 on the helper webhook transport", () => {
  it.live("a: a send admitted before a Stop starts its POST before the Stop's policy commit, and the Stop completes while the POST awaits its reply", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const transport = yield* f.transport(yield* Effect.scope);
      // the Stop is requested at the send's final guard, before its receipt commit, while the send holds the section;
      // it waits for the permit, so the POST must already have started when the Stop commits
      let stopFiber: Fiber.Fiber<void> | undefined;
      f.onGuard((read) => {if (read === 2) stopFiber = Effect.runFork(f.stop((policy) => {policy.stopped = true;}));});
      const send = yield* Effect.forkChild(transport.send(f.binding, input, { authorized: (guard) => !guard.supervisionStopped("main") }));
      yield* Deferred.await(f.http.arrived);
      yield* f.until(() => stopFiber !== undefined);
      yield* Fiber.join(stopFiber!);
      assert.equal(Deferred.isDoneUnsafe(f.http.reply), false, "the Stop completed while the reply was still held");
      // the POST started inside the send's admission section, before the queued Stop committed
      assert.deepEqual(f.log, ["guard", "end", "guard", "initiate", "end", "policy-commit", "bookkeeping", "end"]);
      assert.equal(f.receipt()?.state, "posting");
      yield* Deferred.succeed(f.http.reply, undefined);
      assert.equal(yield* Fiber.join(send), "waiting");
      assert.equal(f.receipt()?.state, "posted");
      assert.equal(f.receipt()?.nativeDeliveryId, "native-delivery-1");
      assert.deepEqual(f.http.posts, [helperDeliveryBody(input.messageId, input.text)]);
      assert.deepEqual(f.http.cut, [], "the peer finished its reply; the Stop cut nothing");
    }), { timeout: 10_000 });

  for (const [change, label, outcome] of [
    [(policy: { stopped: boolean; revoked: boolean }) => {policy.stopped = true;}, "a per-chat Stop", "busy"],
    [(policy: { stopped: boolean; revoked: boolean }) => {policy.revoked = true;}, "a revocation of the caller's authority", "revoked"],
  ] as const) {
    it.live(`b: a send queued behind ${label} is answered ${outcome} with no receipt and no POST`, () => Effect.gen(function* () {
      const f = yield* fixture;
      const transport = yield* f.transport(yield* Effect.scope);
      const projected = Promise.withResolvers<void>();
      f.holdProjection(projected.promise);
      const send = yield* Effect.forkChild(transport.send(f.binding, input, { authorized: (guard) => !guard.supervisionStopped("main") && !f.policy.revoked }));
      // the send passed its entry guard and is in its helper read when the Stop takes the section
      yield* f.until(() => f.projectionReads() === 1);
      const barrier = { entered: yield* Deferred.make<void>(), release: yield* Deferred.make<void>() };
      const stopping = yield* Effect.forkChild(f.stop(change, barrier));
      yield* Deferred.await(barrier.entered);
      projected.resolve();
      // the send's channel reads finish while the Stop holds the section; its admission waits for the permit
      yield* f.until(() => f.rpcs.includes("scheduledTasks.upsert"));
      yield* Deferred.succeed(barrier.release, undefined);
      yield* Fiber.join(stopping);
      assert.equal(yield* Fiber.join(send), outcome);
      assert.deepEqual(f.log, ["guard", "end", "policy-commit", "bookkeeping", "end", "guard", "end"]);
      assert.equal(f.receipt(), null);
      assert.deepEqual(f.http.posts, []);
    }), { timeout: 10_000 });
  }

  it.live("c: closing the transport scope with a POST in flight releases the request once and keeps the receipt; a later send reconciles without a second POST", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const transportScope = yield* Scope.make();
      const transport = yield* f.transport(transportScope);
      const send = yield* Effect.forkChild(transport.send(f.binding, input));
      yield* Deferred.await(f.http.arrived);
      const posting = f.receipt();
      assert.equal(posting?.state, "posting");
      yield* Scope.close(transportScope, Exit.void);
      // the owner's operation was interrupted: its receipt decides, and without native evidence it stays uncertain
      assert.equal(yield* Fiber.join(send), "uncertain");
      assert.equal(f.aborts(), 1, "the in-flight request was released once");
      assert.deepEqual(f.receipt(), posting);
      const restarted = yield* f.transport(yield* Effect.scope);
      assert.equal(yield* restarted.send(f.binding, input), "uncertain");
      assert.equal(yield* restarted.reconcileDelivery(f.binding, input), "uncertain");
      assert.equal(f.http.posts.length, 1);
      assert.equal(f.aborts(), 1);
      assert.deepEqual(f.receipt(), posting);
    }), { timeout: 10_000 });

  it.live("d: a duplicate send of a live identity joins the original, never posts and reads no receipt", () => Effect.gen(function* () {
    const f = yield* fixture;
    const transport = yield* f.transport(yield* Effect.scope);
    const projected = Promise.withResolvers<void>();
    f.holdProjection(projected.promise);
    const original = yield* Effect.forkChild(transport.send(f.binding, input));
    const duplicate = yield* Effect.forkChild(transport.send(f.binding, input));
    // both sends passed their entry guard and read no receipt before either reaches its admission
    yield* f.until(() => f.projectionReads() === 2);
    projected.resolve();
    yield* Deferred.await(f.http.arrived);
    // each send ran its entry section and its admission section; the duplicate's found the live POST
    yield* f.until(() => f.sections() === 4);
    yield* Deferred.succeed(f.http.reply, undefined);
    assert.equal(yield* Fiber.join(original), "waiting");
    assert.equal(yield* Fiber.join(duplicate), "waiting");
    assert.deepEqual(f.http.posts, [helperDeliveryBody(input.messageId, input.text)]);
    assert.equal(f.log.filter((entry) => entry === "initiate").length, 1);
    assert.equal(f.rpcs.includes("scheduledTasks.listWebhookDeliveries"), false, "the duplicate joined instead of reconciling a receipt");
    assert.equal(f.receipt()?.state, "posted");
  }), { timeout: 10_000 });
});

// the webhook POST's response belongs to the admitted operation: whatever ends it (the caller giving up, the transport
// closing, a settled reply whose body is never read) ends an open request, as NRPC-08 does for the shell read
describe("webhook POST release", () => {
  for (const [label, ending] of [["the caller gives up", "cancel"], ["the transport scope closes", "close"]] as const) {
    it.live(`HTX-REL-01: a 2xx response held at the handoff to its body read is ended when ${label}`, () => Effect.gen(function* () {
      const f = yield* fixtureWith(202);
      // the reviewers' fault: the response is taken and held between its headers and its body read
      const headers = yield* Deferred.make<void>();
      let held: HttpClientResponse.HttpClientResponse | undefined;
      const atHandoff = (client: HttpClient.HttpClient) => HttpClient.transformResponse(client, (effect) => effect.pipe(Effect.tap((response) => {
        held = response;
        return Deferred.succeed(headers, undefined).pipe(Effect.andThen(Effect.never));
      })));
      const transportScope = yield* Scope.make();
      const transport = yield* f.transport(transportScope, atHandoff);
      const cancel = yield* Deferred.make<void>();
      const send = yield* Effect.forkChild(transport.send(f.binding, input, { cancel }));
      yield* Deferred.await(headers);
      if (ending === "cancel") yield* Deferred.succeed(cancel, undefined);
      else yield* Scope.close(transportScope, Exit.void);
      assert.equal(yield* Fiber.join(send), "uncertain");
      assert.ok(held !== undefined, "the response was taken");
      // bounded only so that a request left open fails here by name; the peer closes it at teardown
      const closed = yield* Deferred.await(f.http.ended).pipe(Effect.timeoutOption("2 seconds"));
      assert.ok(Option.isSome(closed), "the POST's request ended with its operation");
      assert.deepEqual(f.http.cut, [1]);
      assert.equal(f.receipt()?.state, "posting");
      assert.deepEqual(f.http.posts, [helperDeliveryBody(input.messageId, input.text)]);
    }), { timeout: 10_000 });
  }

  it.live("HTX-REL-02: an unread 4xx reply's request is ended when its send settles rejected, and a later send only reconciles", () => Effect.gen(function* () {
    const f = yield* fixtureWith(400);
    const transport = yield* f.transport(yield* Effect.scope);
    assert.equal(yield* transport.send(f.binding, input), "rejected");
    // bounded only so that a request left open fails here by name; the peer closes it at teardown
    const closed = yield* Deferred.await(f.http.ended).pipe(Effect.timeoutOption("2 seconds"));
    assert.ok(Option.isSome(closed), "the unread 4xx request ended with its operation");
    assert.deepEqual(f.http.cut, [1]);
    assert.equal(f.receipt()?.state, "rejected");
    assert.equal(yield* transport.send(f.binding, input), "rejected");
    assert.deepEqual(f.http.posts, [helperDeliveryBody(input.messageId, input.text)]);
  }), { timeout: 10_000 });
});
