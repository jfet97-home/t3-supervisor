import { Schema } from "effect";

const StableVersion = Schema.String.check(Schema.isPattern(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u));
const Revision = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u));
export const ReleaseRequest = Schema.Struct({
  channel: Schema.Literals(["stable", "nightly", "alpha", "beta"]),
  revision: Revision,
  commitTime: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u)),
});
export const ReleaseStatus = Schema.Struct({
  releases: Schema.Array(Schema.Struct({ name: Schema.String, newVersion: StableVersion })),
});
export const ReleaseManifest = Schema.Struct({ name: Schema.Literal("@jfet97/t3-supervisor"), version: StableVersion });
export const ReleasePlan = Schema.Struct({
  channel: ReleaseRequest.fields.channel,
  version: Schema.String,
  revision: Revision,
  npmTag: Schema.Literals(["latest", "nightly", "alpha", "beta"]),
  tag: Schema.String,
});

// version identities depend on the checked commit, never a workflow's retry time or run number
export const planRelease = (request: typeof ReleaseRequest.Type, manifest: typeof ReleaseManifest.Type,
  status: typeof ReleaseStatus.Type): typeof ReleasePlan.Type => {
  const date = new Date(request.commitTime);
  if (!Number.isFinite(date.getTime()) || date.toISOString().replace(".000Z", "Z") !== request.commitTime) {
    throw new Error("invalid commit timestamp");
  }
  const planned = status.releases.filter((release) => release.name === manifest.name);
  if (planned.length !== status.releases.length || planned.length > 1) throw new Error("unexpected release plan");
  if (request.channel === "stable" && planned.length !== 0) throw new Error("stable release requires a merged version pull request");
  const base = planned[0]?.newVersion ?? manifest.version.replace(/\d+$/u, (patch) => String(BigInt(patch) + 1n));
  const timestamp = request.commitTime.replace(/[-:TZ]/gu, "");
  const version = request.channel === "stable" ? manifest.version : `${base}-${request.channel}.${timestamp}.g${request.revision.slice(0, 12)}`;
  return { channel: request.channel, version, revision: request.revision,
    npmTag: request.channel === "stable" ? "latest" : request.channel, tag: `v${version}` };
};

// each alias only accepts our stable versions or this channel's timestamped previews
export const assertAliasAdvance = (current: string | undefined, plan: typeof ReleasePlan.Type): void => {
  if (current === undefined || current === plan.version) return;
  const parse = (version: string): bigint[] => {
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(nightly|alpha|beta)\.(\d{14})\.g[a-f0-9]{12})?$/u.exec(version);
    if (!match || (match[4] ?? "stable") !== plan.channel) throw new Error("unexpected existing channel version");
    return [BigInt(match[1]!), BigInt(match[2]!), BigInt(match[3]!), BigInt(match[5] ?? 0)];
  };
  const before = parse(current);
  const after = parse(plan.version);
  for (let index = 0; index < before.length; index += 1) {
    if (after[index]! > before[index]!) return;
    if (after[index]! < before[index]!) throw new Error("refusing to move a channel backwards");
  }
  throw new Error("a different commit already owns this channel timestamp");
};

export const RegistryVersion = Schema.Struct({ version: Schema.String, gitHead: Revision });
export const assertRegistryIdentity = (existing: typeof RegistryVersion.Type, plan: typeof ReleasePlan.Type): void => {
  if (existing.version !== plan.version || existing.gitHead !== plan.revision) throw new Error("published version belongs to a different source revision");
};

export const releaseNotes = (plan: typeof ReleasePlan.Type, changelog: string): string => {
  if (plan.channel !== "stable") return `Preview of checked main commit ${plan.revision}.\n\n` +
    `See [pending release notes](https://github.com/jfet97/t3-supervisor/tree/${plan.revision}/.changeset) and ` +
    `[the changelog](https://github.com/jfet97/t3-supervisor/blob/${plan.revision}/CHANGELOG.md).`;
  const section = changelog.replace(/\r\n/gu, "\n").split(`## ${plan.version}\n`)[1]?.split(/\n## /u)[0]?.trim();
  if (!section) throw new Error("stable release has no changelog entry");
  return section;
};
