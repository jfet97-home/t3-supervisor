import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Crypto, Effect, Layer } from "effect";
import { SupervisorIds } from "../src/ids.js";

const v4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

// SupervisorIds over a Crypto whose bytes the test chooses; every draw is recorded with its size
const withBytes = (bytes: (draw: number, size: number) => Uint8Array) => {
  const draws: number[] = [];
  const crypto = Crypto.make({
    randomBytes: (size) => {
      draws.push(size);
      return bytes(draws.length, size);
    },
    digest: () => Effect.die(new Error("no digest is expected")),
  });
  return { draws, layer: SupervisorIds.layer.pipe(Layer.provide(Layer.succeed(Crypto.Crypto, crypto))) };
};

const uuid = SupervisorIds.use((ids) => ids.uuid);

it.effect("uuid formats the Crypto bytes as a lowercase hyphenated v4 uuid with the version and variant bits set", () => Effect.gen(function* () {
  const zeros = withBytes((_draw, size) => new Uint8Array(size));
  assert.equal(yield* uuid.pipe(Effect.provide(zeros.layer)), "00000000-0000-4000-8000-000000000000");
  const ones = withBytes((_draw, size) => new Uint8Array(size).fill(0xff));
  assert.equal(yield* uuid.pipe(Effect.provide(ones.layer)), "ffffffff-ffff-4fff-bfff-ffffffffffff");
  const mixed = withBytes(() => Uint8Array.from([0xde, 0xad, 0xbe, 0xef, 0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0x10, 0x32, 0x54, 0x76]));
  const value = yield* uuid.pipe(Effect.provide(mixed.layer));
  assert.equal(value, "deadbeef-0123-4567-89ab-cdef10325476");
  assert.match(value, v4);
}), { timeout: 10_000 });

it.effect("the Crypto service is the only source: equal bytes give equal ids, one 16-byte draw per id", () => Effect.gen(function* () {
  const fixed = withBytes((_draw, size) => new Uint8Array(size).fill(0x5a));
  const [first, second] = yield* Effect.all([uuid, uuid]).pipe(Effect.provide(fixed.layer));
  assert.equal(first, second);
  assert.equal(first, "5a5a5a5a-5a5a-4a5a-9a5a-5a5a5a5a5a5a");
  assert.deepEqual(fixed.draws, [16, 16]);
}), { timeout: 10_000 });

it.effect("distinct Crypto bytes give distinct ids", () => Effect.gen(function* () {
  // the draw number in the leading bytes, so every draw differs
  const counting = withBytes((draw, size) => {
    const bytes = new Uint8Array(size);
    new DataView(bytes.buffer).setUint32(0, draw);
    return bytes;
  });
  const ids = yield* Effect.all(Array.from({ length: 100 }, () => uuid)).pipe(Effect.provide(counting.layer));
  assert.equal(new Set(ids).size, 100);
  for (const id of ids) assert.match(id, v4);
  assert.equal(ids[0], "00000001-0000-4000-8000-000000000000");
  assert.equal(counting.draws.length, 100);
}), { timeout: 10_000 });
