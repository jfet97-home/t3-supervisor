import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { it } from "@effect/vitest";
import { Cause, Effect, Exit } from "effect";
import { startProcess } from "./support/g8-process.js";

// the process helper's maxBuffer against node's execFile: each of stdout and stderr counts the raw bytes it received,
// before decoding, against its own limit; a stream beyond it terminates the child and its result dies (real child processes)

const limit = 4096;
const euro = "€"; // three utf-8 bytes, one character

// a child that writes its chunks (base64) to the named streams in order, a pause between them so each arrives as its own
// chunk, then exits, or keeps running so only the helper's termination ends it
interface Plan {readonly writes: ReadonlyArray<readonly ["stdout" | "stderr", string]>; readonly keepAlive?: boolean}
const childScript = `const plan = JSON.parse(process.env.OUTPUT_PLAN);
const next = (index) => {
  if (index === plan.writes.length) { if (plan.keepAlive) setInterval(() => {}, 1000); else process.exitCode = 0; return; }
  const [name, chunk] = plan.writes[index];
  process[name].write(Buffer.from(chunk, "base64"), () => setTimeout(() => next(index + 1), 20));
};
next(0);`;
const write = (name: "stdout" | "stderr", bytes: Buffer) => [name, bytes.toString("base64")] as const;
const env = (plan: Plan) => ({...process.env, OUTPUT_PLAN: JSON.stringify(plan)});

// the helper's verdict: the decoded streams, or the limit failure with the child's termination signal
const helper = (plan: Plan) => Effect.scoped(Effect.gen(function* () {
  const running = yield* startProcess(process.execPath, ["-e", childScript], {env: env(plan), cwd: tmpdir(), maxBuffer: limit});
  const exit = yield* Effect.exit(running.closed(10_000));
  if (Exit.isSuccess(exit)) return {exceeded: false as const, stdout: exit.value.stdout, stderr: exit.value.stderr};
  return {exceeded: true as const, message: String(Cause.squash(exit.cause)), signal: running.child.signalCode};
}));

// node's execFile with the same limit and its default utf8 decoding: rejected or resolved
const oracle = (plan: Plan) => Effect.callback<boolean>((resume) => {
  execFile(process.execPath, ["-e", childScript], {env: env(plan), cwd: tmpdir(), maxBuffer: limit, timeout: 10_000},
    (error) => resume(Effect.succeed(error !== null && (error as {code?: unknown}).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")));
});

const multibyte = (bytes: number) => {
  const text = euro.repeat(Math.floor(bytes / 3)) + "a".repeat(bytes % 3);
  assert.equal(Buffer.byteLength(text), bytes);
  return text;
};

it.live("exactly 4,096 utf-8 bytes of multibyte characters on stdout pass, decoded intact, as execFile accepts them", () => Effect.gen(function* () {
  const text = multibyte(4096);
  const plan = {writes: [write("stdout", Buffer.from(text))]};
  assert.deepEqual(yield* helper(plan), {exceeded: false, stdout: text, stderr: ""});
  assert.equal(yield* oracle(plan), false);
}));

for (const name of ["stdout", "stderr"] as const) {
  it.live(`4,098 utf-8 bytes (1,366 characters) on ${name} exceed the 4,096-byte limit, terminate the child and fail, as execFile rejects them`, () => Effect.gen(function* () {
    const text = euro.repeat(1366);
    assert.equal(text.length, 1366);
    assert.equal(Buffer.byteLength(text), 4098);
    const plan = {writes: [write(name, Buffer.from(text))], keepAlive: true};
    const verdict = yield* helper(plan);
    assert.equal(verdict.exceeded, true);
    if (verdict.exceeded) {
      assert.match(verdict.message, new RegExp(`exceeded its 4096 byte ${name} limit`, "u"));
      assert.equal(verdict.signal, "SIGTERM", "the overflow itself ends the otherwise endless child");
    }
    assert.equal(yield* oracle({writes: plan.writes}), true);
  }));
}

it.live("stdout and stderr have separate limits: 4,000 bytes on each pass, as execFile accepts them", () => Effect.gen(function* () {
  const out = multibyte(4000);
  const err = multibyte(4000);
  const plan = {writes: [write("stdout", Buffer.from(out)), write("stderr", Buffer.from(err))]};
  assert.deepEqual(yield* helper(plan), {exceeded: false, stdout: out, stderr: err});
  assert.equal(yield* oracle(plan), false);
}));

it.live("a multibyte character split across two chunks counts its raw bytes once and decodes intact at the boundary", () => Effect.gen(function* () {
  const bytes = Buffer.from(euro);
  const padding = (count: number) => Buffer.from("a".repeat(count));
  // 4,093 + 2 + 1 = 4,096 bytes: at the limit
  const atLimit = {writes: [write("stdout", Buffer.concat([padding(4093), bytes.subarray(0, 2)])), write("stdout", bytes.subarray(2))]};
  assert.deepEqual(yield* helper(atLimit), {exceeded: false, stdout: "a".repeat(4093) + euro, stderr: ""});
  assert.equal(yield* oracle(atLimit), false);
  // 4,094 + 2 + 1 = 4,097 bytes: one beyond
  const beyond = {writes: [write("stdout", Buffer.concat([padding(4094), bytes.subarray(0, 2)])), write("stdout", bytes.subarray(2))]};
  assert.equal((yield* helper(beyond)).exceeded, true);
  assert.equal(yield* oracle(beyond), true);
}));

it.live("invalid utf-8 counts its raw bytes, not the replacement characters it decodes to", () => Effect.gen(function* () {
  // 4,096 raw bytes decode to 4,096 replacement characters, which would re-encode to 12,288 bytes
  const atLimit = yield* helper({writes: [write("stdout", Buffer.alloc(4096, 0xff))]});
  assert.equal(atLimit.exceeded, false);
  if (!atLimit.exceeded) assert.equal(atLimit.stdout, "�".repeat(4096));
  assert.equal((yield* helper({writes: [write("stdout", Buffer.alloc(4097, 0xff))], keepAlive: true})).exceeded, true);
}));
