import { NodeFileSystem, NodeRuntime } from "@effect/platform-node";
import { createHash } from "node:crypto";
import { Config, Effect, FileSystem, Schema } from "effect";
import { assertAliasAdvance, assertRegistryIdentity, planRelease, RegistryVersion, releaseNotes, ReleaseManifest, ReleasePlan,
  ReleaseRequest, ReleaseStatus } from "./release-policy.js";

// the process edge prepares a disposable CI workspace; it never commits or talks to a registry
const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const read = <S extends Schema.Top>(path: string, schema: S) =>
    fs.readFileString(path).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(schema))));
  const command = process.argv[2];
  if (command === "prepare") {
    const request = yield* read("release-input.json", ReleaseRequest);
    const manifest = yield* read("package.json", ReleaseManifest);
    const status = yield* read("release-status.json", ReleaseStatus);
    const plan = yield* Effect.try(() => planRelease(request, manifest, status));
    const changelog = yield* fs.readFileString("CHANGELOG.md");
    const notes = yield* Effect.try(() => releaseNotes(plan, changelog));
    const original = yield* read("package.json", Schema.Record(Schema.String, Schema.Unknown));
    yield* fs.makeDirectory("release", { recursive: true });
    yield* fs.writeFileString("release/plan.json", JSON.stringify(plan, null, 2) + "\n");
    yield* fs.writeFileString("release/notes.md", notes + "\n");
    yield* fs.writeFileString("package.json", JSON.stringify({ ...original, version: plan.version, gitHead: plan.revision }, null, 2) + "\n");
    const output = yield* Config.String("GITHUB_OUTPUT");
    yield* fs.writeFileString(output, Object.entries(plan).map(([key, value]) => `${key}=${value}\n`).join(""), { flag: "a" });
  } else if (command === "verify-registry") {
    const plan = yield* read("release/plan.json", ReleasePlan);
    const existing = yield* read("release/registry-version.json", RegistryVersion);
    yield* Effect.try(() => assertRegistryIdentity(existing, plan));
  } else if (command === "verify-alias") {
    const plan = yield* read("release/plan.json", ReleasePlan);
    const existing = yield* read("release/registry-alias.json", Schema.Struct({ version: Schema.String }));
    yield* Effect.try(() => assertAliasAdvance(existing.version, plan));
  } else if (command === "verify-archive") {
    const plan = yield* read("release/plan.json", ReleasePlan);
    const registry = yield* read("release/registry-version.json", Schema.Struct({ dist: Schema.Struct({ integrity: Schema.String }) }));
    const bytes = yield* fs.readFile(`release/t3-supervisor-${plan.version}.tgz`);
    const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    if (integrity !== registry.dist.integrity) return yield* Effect.fail(new Error("registry archive integrity mismatch"));
  } else {
    return yield* Effect.fail(new Error("expected prepare, verify-registry, verify-alias or verify-archive"));
  }
});

NodeRuntime.runMain(program.pipe(Effect.provide(NodeFileSystem.layer)));
