import { Schema } from "effect";

export const DashboardKeys = Schema.Array(Schema.String.check(Schema.isMaxLength(1024), Schema.isPattern(/^(snapshot|overview|project:.+|progress:.+)$/u)))
  .check(Schema.isMaxLength(64));
export const DashboardHint = Schema.Struct({keys: DashboardKeys});
export type DashboardKey = "snapshot" | "overview" | `project:${string}` | `progress:${string}:${string}`;
export const projectKeys = (projectId: string, mainThreadId?: string): ReadonlyArray<DashboardKey> =>
  ["snapshot", "overview", `project:${projectId}`, ...(mainThreadId ? [`progress:${projectId}:${mainThreadId}` as const] : [])];
