import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { NodeFileSystem, NodeRuntime } from "@effect/platform-node";
import { Config, Effect, Schema } from "effect";
import { buildInfo } from "../src/version.js";
import { supervisorHarness } from "../test/support/g8-cli.js";
import { runProcess, startProcess } from "../test/support/g8-process.js";
import { verifyReleaseDashboard } from "../test/support/release-smoke.js";

// release-only real I/O, sharing the bounded native-peer fixture; Docker is a scoped external process adapter
const program = Effect.gen(function* () {
  const kind = process.argv[2];
  const target = process.argv[3];
  if (!target || (kind !== "package" && kind !== "image")) return yield* Effect.fail(new Error("expected package BIN or image IMAGE"));
  const harness = yield* supervisorHarness();
  const platform = yield* Config.String("SMOKE_PLATFORM").pipe(Config.withDefault("linux/amd64"),
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Literals(["linux/amd64", "linux/arm64"]))));
  const name = `supervisor-release-${randomUUID()}`;
  const dockerOptions = { env: process.env, cwd: harness.home, timeoutMs: 15_000 };
  if (kind === "image") {
    yield* Effect.acquireRelease(Effect.void, () => runProcess("docker", ["rm", "--force", name], dockerOptions).pipe(Effect.ignore));
  }
  const container = ["run", "--rm", "--name", name, "--platform", platform, "--network", "host", "--init", "--read-only", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges:true", "--user", `${process.getuid!()}:${process.getgid!()}`,
    "--mount", `type=bind,src=${harness.home},dst=${harness.home}`,
    ...Object.entries(harness.env).filter(([key]) => key !== "PATH").flatMap(([key, value]) => ["--env", `${key}=${value}`]),
    "--entrypoint", "t3-supervisor", target];
  const child = kind === "image"
    ? yield* startProcess("docker", [...container, "start"], dockerOptions)
    : yield* harness.start(target, ["start"]);
  yield* verifyReleaseDashboard(harness, child);
  const version = kind === "image"
    ? yield* runProcess("docker", ["exec", name, "t3-supervisor", "--version"], dockerOptions)
    : yield* runProcess(target, ["--version"], { env: harness.env, cwd: harness.home, timeoutMs: 10_000 });
  assert.equal(version.code, 0);
  assert.equal(version.stdout, `t3-supervisor v${buildInfo.version}\n`);
  process.kill(child.pid, "SIGTERM");
  const closed = yield* child.closed(30_000);
  assert.equal(closed.code, 130);
  assert.equal(closed.stderr, "");
});

NodeRuntime.runMain(program.pipe(Effect.scoped, Effect.timeout("90 seconds"), Effect.provide(NodeFileSystem.layer)));
