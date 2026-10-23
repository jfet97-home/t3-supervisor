import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// the migration lint guards of eslint.config.js on virtual files: only src/db.ts may import the SQLite driver
// (barrel or any subpath), only src/native-envelope.ts may import ws in src, src runs no Effect.run* outside the process
// entries and the workflow MCP adapter, extension loading stays banned and the suites never import node:test

// every reported message of the file, one per line
const lint = async (filePath: string, code: string): Promise<string> => {
  const [result] = await new ESLint().lintText(code, { filePath });
  return (result?.messages ?? []).map((message) => message.message).join("\n");
};

const sqliteOwner = "only src/db.ts opens SQLite clients (plan 3.2)";
const wsOwner = "native T3 websockets go through src/native-envelope.ts (D-08)";

describe("lint guards", () => {
  it.for([
    ["barrel import", `import { SqliteClient } from "@effect/sql-sqlite-node";\nexport const opened = SqliteClient.make({ filename: ":memory:" });\n`],
    ["subpath import", `import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";\nexport const opened = SqliteClient.make({ filename: ":memory:" });\n`],
    ["subpath re-export", `export * from "@effect/sql-sqlite-node/SqliteClient";\n`],
  ] as const)("rejects the SQLite driver outside src/db.ts: %s", { timeout: 30_000 }, async ([, code]) => {
    expect(await lint("src/lint-guard-probe.ts", code)).toContain(sqliteOwner);
    expect(await lint("test/lint-guard-probe.test.ts", code)).toContain(sqliteOwner);
    expect(await lint("src/db.ts", code)).not.toContain(sqliteOwner);
  });

  it("rejects ws in src outside the native envelope and the test peers", { timeout: 30_000 }, async () => {
    const code = `import WebSocket from "ws";\nexport const open = (url: string) => new WebSocket(url);\n`;
    expect(await lint("src/lint-guard-probe.ts", code)).toContain(wsOwner);
    expect(await lint("src/db.ts", code)).toContain(wsOwner);
    // every native client is ported onto the envelope (S4), so none keeps an exemption
    for (const client of ["src/t3.ts", "src/supervisor-native.ts", "src/project-files.ts", "src/git-probe.ts"]) expect(await lint(client, code)).toContain(wsOwner);
    expect(await lint("src/native-envelope.ts", code)).not.toContain(wsOwner);
    expect(await lint("test/support/lint-guard-peer.ts", code)).not.toContain(wsOwner);
  });

  it("rejects Effect.run* and runtime capture in src outside the process entries and the workflow MCP adapter", { timeout: 30_000 }, async () => {
    const runOwner = "effects in src run in their caller's fiber; Effect.run* stays in the entries and the workflow MCP adapter (plan 3.9)";
    for (const code of [
      `import { Effect } from "effect";\nexport const value = Effect.runSync(Effect.succeed(1));\n`,
      `import { Effect } from "effect";\nexport const value = () => Effect.runPromise(Effect.succeed(1));\n`,
      `import { Effect } from "effect";\nexport const fork = () => Effect.runFork(Effect.void);\n`,
      `import { Effect } from "effect";\nexport const run = Effect.runPromiseWith;\n`,
      `import { runSyncExit } from "effect/Effect";\nexport const run = runSyncExit;\n`,
      `import { ManagedRuntime } from "effect";\nexport const make = ManagedRuntime.make;\n`,
      `import * as Runtime from "effect/ManagedRuntime";\nexport const make = Runtime.make;\n`,
    ]) {
      expect(await lint("src/lint-guard-probe.ts", code)).toContain(runOwner);
      // the residual adapters keep only their own allowance, and the composition root none
      for (const file of ["src/main.ts", "src/cli.ts", "src/workflow-mcp.ts", "src/guidance-application.ts"]) expect(await lint(file, code)).toContain(runOwner);
      expect(await lint("test/lint-guard-probe.test.ts", code)).not.toContain(runOwner);
    }
    const runMain = `import { NodeRuntime } from "@effect/platform-node";\nimport { Effect } from "effect";\nNodeRuntime.runMain(Effect.void);\n`;
    expect(await lint("src/lint-guard-probe.ts", runMain)).toContain(runOwner);
    expect(await lint("src/workflow-mcp.ts", runMain)).toContain(runOwner);
    for (const entry of ["src/main.ts", "src/cli.ts"]) expect(await lint(entry, runMain)).not.toContain(runOwner);
    const fiberRuntime = `import { Effect, FiberSet } from "effect";\nexport const make = Effect.flatMap(FiberSet.make(), (set) => FiberSet.runtimePromise(set)());\n`;
    expect(await lint("src/lint-guard-probe.ts", fiberRuntime)).toContain(runOwner);
    expect(await lint("src/main.ts", fiberRuntime)).toContain(runOwner);
    expect(await lint("src/workflow-mcp.ts", fiberRuntime)).not.toContain(runOwner);
  });

  it("rejects extension loading and node:test", { timeout: 30_000 }, async () => {
    expect(await lint("src/lint-guard-probe.ts", `export const load = (db: { loadExtension: (path: string) => void }) => db.loadExtension("x");\n`))
      .toContain("SQLite extension loading stays disabled (plan 3.2)");
    expect(await lint("test/lint-guard-probe.test.ts", `import { test } from "node:test";\nexport const t = test;\n`))
      .toContain("the suites run on vitest");
  });
});
