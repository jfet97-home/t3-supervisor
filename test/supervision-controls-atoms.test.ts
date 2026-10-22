import assert from "node:assert/strict";
import { Result } from "effect";
import { AsyncResult, type Atom, AtomRegistry } from "effect/reactivity";
import { afterAll, beforeAll, it } from "vitest";
import type { SupervisionControlInfo } from "../src/supervisor-control-contract.js";

// target regressions of the supervision switch, setup and shared definitions atoms (WP-S7-PS) over a stubbed browser

const originals = new Map<string, PropertyDescriptor | undefined>();
const install = (key: string, value: unknown) => {
  if (!originals.has(key)) originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, {configurable: true, writable: true, value});
};

interface Sent {readonly method: string; readonly path: string; readonly body: unknown}
const sent: Sent[] = [];
let reply: (request: Sent) => Promise<Response> = async () => new Response("{}", {status: 500});
const storage = new Map<string, string>();

type Control = typeof import("../ui/src/supervisor-control.js");
type Api = typeof import("../ui/src/api.js");
let sc: Control;
let api: Api;

beforeAll(async () => {
  install("location", {origin: "http://supervisor.test", pathname: "/"});
  install("window", new EventTarget());
  install("document", {visibilityState: "visible", hidden: false});
  install("localStorage", {getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => {storage.set(key, value);},
    removeItem: (key: string) => {storage.delete(key);}});
  install("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), "http://supervisor.test");
    const body = init?.body instanceof Uint8Array ? JSON.parse(new TextDecoder().decode(init.body)) as unknown : undefined;
    const request = {method: init?.method ?? "GET", path: url.pathname, body};
    sent.push(request);
    return reply(request);
  });
  storage.set("supervisor-session", "session-1");
  api = await import("../ui/src/api.js");
  sc = await import("../ui/src/supervisor-control.js");
});

afterAll(() => {
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

const until = <A>(registry: AtomRegistry.AtomRegistry, atom: Atom.Atom<A>, predicate: (value: A) => boolean, label: string) =>
  new Promise<A>((resolve, reject) => {
    const timer = setTimeout(() => {stop();reject(new Error(`${label} not reached`));}, 5_000);
    const stop = registry.subscribe(atom, value => {
      if (!predicate(value)) return;
      clearTimeout(timer);
      queueMicrotask(() => stop());
      resolve(value);
    }, {immediate: true});
  });

const pending = () => {
  let release!: (response: Response) => void;
  let reached!: () => void;
  return {
    response: new Promise<Response>(resolve => {release = resolve;}),
    reached: new Promise<void>(resolve => {reached = resolve;}),
    arrive: () => reached(),
    release: (response: Response) => release(response),
  };
};
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {status});
const posts = (path: string) => sent.filter(request => request.method === "POST" && request.path === path);

const control = (generation: number, enabled: boolean, projectId: string | null = "project-a"): SupervisionControlInfo => ({projectId, generation, enabled, manual: true,
  globallyEnabled: true, effectiveEnabled: enabled, detectionStatus: "present", detectionError: null});
const checkout = {origin: "project" as const, threadId: "main-worktree", workspaceRoot: "/worktrees/feature-a", branch: "feature-a", isGitRepository: true,
  folderStatus: "missing" as const};
const options = {projectId: "project-a", generation: 7, available: true, message: "Choose a checkout.", checkouts: [checkout]};

it("a switch change is admitted once against the shown generation and applies its outcome with no panel mounted; a result for another project is unconfirmed", {timeout: 10_000}, async () => {
  const registry = AtomRegistry.make();
  sent.length = 0;
  const stateKey = sc.supervisionControlKey("project-a");
  const stateAtom = sc.supervisionControlState(stateKey);
  registry.set(stateAtom, {...registry.get(stateAtom), control: control(3, true)});
  const post = pending();
  reply = async () => {post.arrive();return post.response;};
  sc.startControlChange(registry, stateKey, "project-a");
  sc.startControlChange(registry, stateKey, "project-a");
  await post.reached;
  assert.ok(registry.get(stateAtom).toggling, "the switch is busy");
  post.release(json({status: "saved", message: "Project supervision disabled.", control: control(4, false)}));
  const saved = await until(registry, stateAtom, state => state.toggling === null, "saved");
  assert.deepEqual(posts("/api/guidance/supervision-control").map(request => request.body), [{projectId: "project-a", expectedGeneration: 3, enabled: false}],
    "one request carrying the generation the shown control was read at");
  assert.deepEqual([saved.control?.generation, saved.message, saved.blocked, saved.uncertain, saved.saved], [4, "Project supervision disabled.", false, false, 1]);

  sent.length = 0;
  reply = async () => json({status: "saved", message: "Saved.", control: control(5, true, "project-b")});
  sc.startControlChange(registry, stateKey, "project-a");
  const foreign = await until(registry, stateAtom, state => state.toggling === null && state.blocked, "foreign");
  assert.deepEqual([foreign.control?.generation, foreign.uncertain, foreign.message], [4, true, "The change could not be confirmed. Reload status before trying again."]);
  sc.startControlChange(registry, stateKey, "project-a");
  assert.equal(posts("/api/guidance/supervision-control").length, 1, "a blocked switch starts nothing until a reload");

  const required = sc.settleControlChange({...foreign, toggling: "x", blocked: false, uncertain: false}, "project-a",
    Result.succeed({status: "setup_required", message: "Choose where to set up definitions.", control: control(5, false)}), 9);
  assert.deepEqual([required.setupRequested, required.blocked, required.uncertain, required.saved], [true, false, false, 1]);
  registry.dispose();
});

it("an unconfirmed setup stays fenced until a setup read that started after the request ended; a verified setup releases the fence and completes setup", {timeout: 10_000}, async () => {
  const registry = AtomRegistry.make();
  sent.length = 0;
  const stateKey = sc.supervisionControlKey("project-a");
  const setupAtom = sc.supervisionSetupState(stateKey);
  const controlAtom = sc.supervisionControlState(stateKey);
  registry.set(controlAtom, {...registry.get(controlAtom), control: control(3, false), setupRequested: true});
  registry.set(sc.supervisionSetupSelection(stateKey), JSON.stringify([checkout.threadId, checkout.workspaceRoot]));
  const post = pending();
  reply = async request => {
    if (request.method === "GET") return json(options);
    post.arrive();
    return post.response;
  };
  const intent = sc.buildSupervisionSetupIntent("project-a", 7, checkout, "create");
  sc.startSetup(registry, stateKey, intent);
  await post.reached;
  assert.deepEqual(registry.get(setupAtom).fence, {active: 1, epoch: 1, fenced: true});
  const during = sc.supervisionSetupRead({projectId: "project-a", revision: 0, epoch: 0});
  const read = await until(registry, during, value => AsyncResult.isSuccess(value) && !value.waiting, "read during the request");
  const staleEpoch = AsyncResult.isSuccess(read) ? read.value.readEpoch : -1;
  post.release(json({message: "unavailable"}, 500));
  const unconfirmed = await until(registry, setupAtom, state => state.operation === null, "unconfirmed");
  assert.deepEqual(unconfirmed.fence, {active: 0, epoch: 3, fenced: true}, "the request ended and the uncertain outcome latched the fence");
  assert.deepEqual([unconfirmed.uncertain, unconfirmed.blocked, unconfirmed.message],
    [true, true, "The setup outcome could not be confirmed. Reload and inspect the selected checkout before trying again."]);
  assert.equal(sc.settleSetupRead(unconfirmed, staleEpoch).fence.fenced, true, "a read that started before the request ended cannot verify it");
  sc.startSetup(registry, stateKey, intent);
  assert.equal(posts("/api/guidance/supervision-setup").length, 1, "nothing is replayed or started while the outcome is unconfirmed");

  const after = sc.supervisionSetupRead({projectId: "project-a", revision: 1, epoch: 0});
  const fresh = await until(registry, after, value => AsyncResult.isSuccess(value) && !value.waiting, "read after the request");
  const verified = sc.settleSetupRead(unconfirmed, AsyncResult.isSuccess(fresh) ? fresh.value.readEpoch : -1);
  assert.deepEqual([verified.fence.fenced, verified.uncertain, verified.blocked, verified.message], [false, false, false, ""]);
  registry.set(setupAtom, verified);

  sent.length = 0;
  reply = async request => request.method === "GET" ? json(options)
    : json({status: "saved", message: "Created definitions.", control: control(4, true), workspaceRoot: checkout.workspaceRoot, branch: checkout.branch});
  sc.startSetup(registry, stateKey, intent);
  const completed = await until(registry, setupAtom, state => state.operation === null, "verified setup");
  assert.deepEqual(completed.fence, {active: 0, epoch: 5, fenced: false}, "a verified result releases the fence");
  const switched = registry.get(controlAtom);
  assert.deepEqual([switched.setupRequested, switched.control?.generation, switched.message, switched.uncertain], [false, 4, "Created definitions.", false]);
  assert.equal(registry.get(sc.supervisionSetupSelection(stateKey)), "", "a verified setup clears the chosen checkout");
  assert.deepEqual(posts("/api/guidance/supervision-setup").map(request => request.body), [intent]);

  const elsewhere = sc.settleSetup({...completed, operation: "x", fence: sc.setupFence.request(completed.fence, true)}, intent,
    Result.succeed({status: "saved", message: "Created.", control: control(5, true), workspaceRoot: checkout.workspaceRoot, branch: "another-branch"}));
  assert.deepEqual([elsewhere.completed, elsewhere.setup.fence.fenced, elsewhere.setup.message],
    [null, true, "The setup outcome could not be confirmed. Reload and inspect the selected checkout before trying again."], "a result for another checkout is unconfirmed");
  registry.dispose();
});

it("a shared definitions change carries the shown generation; anything but a saved result blocks until a reload", {timeout: 10_000}, async () => {
  const registry = AtomRegistry.make();
  sent.length = 0;
  const definitions = {generation: 2, enabled: false, manual: false, effectiveEnabled: false, homePath: "~/.t3-supervisor", detectionStatus: "missing" as const, detectionError: null};
  registry.set(sc.globalDefinitionsState, {...registry.get(sc.globalDefinitionsState), control: definitions});
  reply = async () => json({status: "conflict", message: "Changed in another tab.", control: {...definitions, generation: 3}});
  sc.startGlobalDefinitionsChange(registry);
  const conflict = await until(registry, sc.globalDefinitionsState, state => state.toggling === null, "conflict");
  assert.deepEqual(posts("/api/guidance/global-definitions-control").map(request => request.body), [{expectedGeneration: 2, enabled: true}]);
  assert.deepEqual([conflict.control?.generation, conflict.blocked, conflict.uncertain, conflict.message], [3, true, true, "Changed in another tab."]);
  const failed = sc.settleDefinitionsChange({...conflict, toggling: "x"}, Result.fail(new api.Unconfirmed()), 4);
  assert.deepEqual([failed.blocked, failed.uncertain, failed.message], [true, true, "The global definitions change could not be confirmed. Reload status before trying again."]);
  registry.dispose();
});
