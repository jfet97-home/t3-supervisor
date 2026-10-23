import { Context, Crypto, Effect, Layer } from "effect";

// identity allocation (CC-IDS): uuid yields a v4 uuid in today's lowercase hyphenated randomUUID format
export class SupervisorIds extends Context.Service<SupervisorIds, {
  readonly uuid: Effect.Effect<string>;
}>()("t3-supervisor/SupervisorIds") {
  // backed by the platform Crypto: NodeCrypto in the process, Crypto.make over chosen bytes in tests
  static readonly layer: Layer.Layer<SupervisorIds, never, Crypto.Crypto> = Layer.effect(SupervisorIds, Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    // v4 generation never fails; its signature only shares the platform error of randomBytes
    return SupervisorIds.of({ uuid: Effect.orDie(crypto.randomUUIDv4()) });
  }));
}
