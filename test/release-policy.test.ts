import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Schema } from "effect";
import { assertAliasAdvance, assertRegistryIdentity, planRelease, releaseNotes, ReleaseManifest, ReleaseRequest, ReleaseStatus } from "../scripts/release-policy.js";

const manifest = Schema.decodeUnknownSync(ReleaseManifest)({ name: "@jfet97/t3-supervisor", version: "0.0.2" });
const pending = Schema.decodeUnknownSync(ReleaseStatus)({ releases: [{ name: "@jfet97/t3-supervisor", newVersion: "0.0.3" }] });
const empty = { releases: [] };
const revision = "a".repeat(40);
const request = (channel: typeof ReleaseRequest.Type.channel, commitTime = "2026-10-24T14:00:00Z") =>
  Schema.decodeUnknownSync(ReleaseRequest)({ channel, revision, commitTime });

it("stable requires versioned notes and uses the manifest as its only version source", () => {
  assert.throws(() => planRelease(request("stable"), manifest, pending), /merged version/u);
  assert.deepEqual(planRelease(request("stable"), manifest, empty), {
    channel: "stable", version: "0.0.2", revision, npmTag: "latest", tag: "v0.0.2",
  });
});

it.each(["nightly", "alpha", "beta"] as const)("%s retries retain the exact version and advance only their own alias", (channel) => {
  const plan = planRelease(request(channel), manifest, pending);
  assert.equal(plan.version, `0.0.3-${channel}.20261024140000.gaaaaaaaaaaaa`);
  assert.equal(plan.npmTag, channel);
  assert.deepEqual(planRelease(request(channel), manifest, pending), plan);
  assert.doesNotThrow(() => assertAliasAdvance(plan.version, plan));
  assert.doesNotThrow(() => assertAliasAdvance(undefined, plan));
  const newer = planRelease(request(channel, "2026-10-25T14:00:00Z"), manifest, pending);
  assert.doesNotThrow(() => assertAliasAdvance(plan.version, newer));
  assert.throws(() => assertAliasAdvance(newer.version, plan), /backwards/u);
});

it("a preview without pending notes targets the next patch without consuming changesets", () => {
  assert.equal(planRelease(request("beta"), manifest, empty).version, "0.0.3-beta.20261024140000.gaaaaaaaaaaaa");
  assert.equal(pending.releases.length, 1);
});

it("rejects malformed or ambiguous release inputs", () => {
  assert.throws(() => Schema.decodeUnknownSync(ReleaseRequest)({ ...request("alpha"), revision: "main" }));
  assert.throws(() => Schema.decodeUnknownSync(ReleaseManifest)({ ...manifest, version: "0.0.2-beta.1" }));
  assert.throws(() => planRelease(request("beta", "2026-02-30T14:00:00Z"), manifest, empty), /timestamp/u);
  assert.throws(() => planRelease(request("beta"), manifest, { releases: [{ name: "other", newVersion: "1.0.0" }] }), /unexpected/u);
  assert.throws(() => planRelease(request("beta"), manifest, { releases: [...pending.releases, ...pending.releases] }), /unexpected/u);
});

it("immutable versions cannot be reused for another commit and stable cannot move backwards", () => {
  const plan = planRelease(request("stable"), manifest, empty);
  assert.doesNotThrow(() => assertRegistryIdentity({ version: plan.version, gitHead: revision }, plan));
  assert.throws(() => assertRegistryIdentity({ version: plan.version, gitHead: "b".repeat(40) }, plan), /different source/u);
  assert.throws(() => assertRegistryIdentity({ version: "9.0.0", gitHead: revision }, plan), /different source/u);
  assert.throws(() => assertAliasAdvance("0.0.3", plan), /backwards/u);
  assert.throws(() => assertAliasAdvance("not-semver", plan), /unexpected/u);
  assert.throws(() => assertAliasAdvance("0.0.2-beta.20261024140000.gaaaaaaaaaaaa", plan), /unexpected/u);
});

it("requires stable notes before any publication and keeps preview notes source-bound", () => {
  const stable = planRelease(request("stable"), manifest, empty);
  assert.throws(() => releaseNotes(stable, "# Changelog\n"), /no changelog entry/u);
  assert.equal(releaseNotes(stable, "# Changelog\n\n## 0.0.2\n\nNew dashboard.\n\n## 0.0.1\n\nOld entry.\n"), "New dashboard.");
  assert.match(releaseNotes(planRelease(request("alpha"), manifest, pending), ""), new RegExp(revision, "u"));
});
