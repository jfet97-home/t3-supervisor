import assert from "node:assert/strict";
import {beforeAll, it} from "@effect/vitest";
import {Context, Effect, Fiber, Layer} from "effect";
import {HttpClient} from "effect/http";
import {json, makeBrowser} from "./support/g7-browser.js";

const browser = makeBrowser();
let api: typeof import("../ui/src/api.js");
let access: typeof import("../ui/src/access.js");
beforeAll(() => Effect.gen(function*() {
  yield* browser.install;
  api = yield* Effect.promise(() => import("../ui/src/api.js"));
  access = yield* Effect.promise(() => import("../ui/src/access.js"));
}));
const clientContext = () => Layer.build(api.sessionHttpClient.pipe(Layer.provideMerge(access.SessionAccess.layerBrowser)));

it.effect("an authenticated GET 401 clears the expected session while POST keeps the mutation classifier's ownership", () => Effect.gen(function*() {
  browser.local.set("supervisor-session", "session-1"); browser.state.reply = () => json({message: "Sign in"}, 401);
  const context = yield* clientContext(); const client = Context.get(context, HttpClient.HttpClient);
  yield* Effect.scoped(HttpClient.withScope(client).get("http://supervisor.test/api/guidance/project-supervisor"));
  assert.equal(browser.local.has("supervisor-session"), false);
  browser.local.set("supervisor-session", "session-2");
  yield* Effect.scoped(HttpClient.withScope(client).post("http://supervisor.test/api/guidance/project-supervisor"));
  assert.equal(browser.local.get("supervisor-session"), "session-2", "POST's definite/unknown outcome remains owned by classifyMutation");
}));

it.effect("a delayed old-session GET 401 cannot clear a newer sign-in", () => Effect.gen(function*() {
  browser.sent.length = 0; browser.local.set("supervisor-session", "old-session");
  let answer: (response: Response) => void = () => {throw new Error("request did not enter the browser boundary");};
  // the controllable foreign fetch reply is released only after the real client request has been observed
  browser.state.reply = request => new Promise<Response>((resolve, reject) => {
    answer = resolve;
    request.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {once: true});
  });
  const context = yield* clientContext(); const client = Context.get(context, HttpClient.HttpClient);
  const request = yield* Effect.forkChild(Effect.scoped(HttpClient.withScope(client).get("http://supervisor.test/api/guidance/project-supervisor")));
  const observed = yield* browser.request(() => true, "old-session request entered fetch");
  assert.equal(observed.session, "old-session");
  yield* Context.get(context, access.SessionAccess).signIn("new-session");
  answer(json({message: "Sign in"}, 401)); yield* Fiber.join(request);
  assert.equal(browser.local.get("supervisor-session"), "new-session");
  assert.equal(observed.signal.aborted, true, "the completed request scope releases its native request");
}));
