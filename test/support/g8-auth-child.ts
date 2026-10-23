import { NodeFileSystem, NodeRuntime, NodeStdio } from "@effect/platform-node";
import { Context, Effect, Layer, Redacted, Scope, Stdio, Stream } from "effect";
import { ServiceAuth } from "../../src/service-auth.js";

// one service auth instance in its own process (spawned by test/service-auth.test.ts): it reads {directory, action, token}
// from stdin, runs one login or session check, prints the session, "rejected", "true" or "false" and exits at once

const program = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;
  const payload = JSON.parse(yield* stdio.stdin.pipe(Stream.decodeText(), Stream.mkString)) as
    { directory: string; action: "login" | "authenticated"; token: string };
  // never released: the process ends right after its answer, the abrupt exit of a running service
  const auth = Context.get(yield* Layer.buildWithScope(ServiceAuth.layer(payload.directory), Scope.makeUnsafe()), ServiceAuth);
  const answer = payload.action === "login"
    ? Effect.map(auth.login(payload.token), (session) => session === null ? "rejected" : Redacted.value(session))
    : Effect.map(auth.authenticated(payload.token), String);
  const text = yield* answer;
  yield* Effect.callback<never>(() => {
    process.stdout.write(text, () => process.exit(0));
  });
});

NodeRuntime.runMain(program.pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodeStdio.layer))));
