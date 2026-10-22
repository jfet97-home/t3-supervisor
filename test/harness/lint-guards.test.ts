import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// the migration lint guards of eslint.config.js on virtual files: only src/db.ts may import the SQLite driver
// (barrel or any subpath), extension loading stays banned and the suites never import node:test

// every reported message of the file, one per line
const lint = async (filePath: string, code: string): Promise<string> => {
  const [result] = await new ESLint().lintText(code, { filePath });
  return (result?.messages ?? []).map((message) => message.message).join("\n");
};

const sqliteOwner = "only src/db.ts opens SQLite clients (plan 3.2)";

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

  it("rejects extension loading and node:test", { timeout: 30_000 }, async () => {
    expect(await lint("src/lint-guard-probe.ts", `export const load = (db: { loadExtension: (path: string) => void }) => db.loadExtension("x");\n`))
      .toContain("SQLite extension loading stays disabled (plan 3.2)");
    expect(await lint("test/lint-guard-probe.test.ts", `import { test } from "node:test";\nexport const t = test;\n`))
      .toContain("the suites run on vitest");
  });
});
