import tseslint from "typescript-eslint";

// src and ui/src start no raw timer (plan S8): no timer global, also through globalThis or window, and no timers module
const timerMessage = "src and ui/src start no raw timer; wait and repeat with Effect's Clock and Schedule (Effect.sleep, Schedule.spaced)";
const timerNames = ["setTimeout", "setInterval", "setImmediate", "clearTimeout", "clearInterval", "clearImmediate"];
const timerModules = ["timers", "node:timers", "timers/promises", "node:timers/promises"];
const loadExtension = { property: "loadExtension", message: "SQLite extension loading stays disabled (plan 3.2)" };
const timerRules = {
  "no-restricted-globals": ["error", ...timerNames.map((name) => ({ name, message: timerMessage }))],
  "no-restricted-properties": ["error", loadExtension,
    ...["globalThis", "window"].flatMap((object) => timerNames.map((property) => ({ object, property, message: timerMessage })))],
};

// only src/db.ts and its database worker src/db-worker-serve.ts open SQLite clients (plan 3.2); src/db.ts, as the SQL layer
// and private files adapter, is the only module that imports node:sqlite in
// src and ui/src (plan section 11); only src/native-envelope.ts opens native T3 websockets in src (D-08); suites run on
// vitest; the package barrel and every subpath (for example @effect/sql-sqlite-node/SqliteClient)
const restrictedImports = ({ sqlite, ws, nodeSqlite = false, timers = false }) => ["error", {
  paths: [
    { name: "node:test", message: "the suites run on vitest" },
    ...(ws ? [{ name: "ws", message: "native T3 websockets go through src/native-envelope.ts (D-08)" }] : []),
    ...(nodeSqlite ? [{ name: "node:sqlite", message: "node:sqlite stays in the SQL layer and private files adapter src/db.ts (plan 3.2)" }] : []),
    ...(timers ? timerModules.map((name) => ({ name, message: timerMessage })) : []),
  ],
  patterns: sqlite ? [{ group: ["@effect/sql-sqlite-node", "@effect/sql-sqlite-node/*"], message: "only src/db.ts and its database worker open SQLite clients (plan 3.2)" }] : [],
}];

// business code in src and ui/src runs no effect outside its caller's fiber (AGENTS.md "Effect v4 throughout", plan 3.9):
// no Effect.run*, no runtime capture and no ManagedRuntime. The residual adapters keep exactly their own allowance: the
// process entries src/main.ts and src/cli.ts their NodeRuntime.runMain, and the workflow MCP route src/workflow-mcp.ts the
// FiberSet runtimes through which the sdk's promise tool callbacks run their effects (plan 3.7, o-06)
const runMessage = "effects in src run in their caller's fiber; Effect.run* stays in the entries and the workflow MCP adapter (plan 3.9)";
const runSyntax = ({ runMain, fiberRuntimes }) => ["error",
  { selector: "MemberExpression[property.name=/^run(Promise|Sync|Fork|Callback)/]", message: runMessage },
  { selector: "ImportSpecifier[imported.name=/^run(Promise|Sync|Fork|Callback)/]", message: runMessage },
  { selector: "ImportDeclaration[source.value=/ManagedRuntime$/]", message: runMessage },
  { selector: "MemberExpression[object.name='ManagedRuntime']", message: runMessage },
  ...(runMain ? [] : [{ selector: "MemberExpression[property.name='runMain']", message: runMessage }]),
  ...(fiberRuntimes ? [] : [{ selector: "MemberExpression[object.name=/^Fiber(Set|Map|Handle)$/][property.name=/^runtime/]", message: runMessage }]),
];

// the suites run their effects in the test's own fiber (it.effect, it.live; plan S8): no Effect.run*, no runtime capture and no
// ManagedRuntime in test files. The child, worker and fixture-server entries run one program each, and the runner harness
// checks plain vitest behaviour, so they keep their allowance
const testRunMessage = "suites run effects in the test's fiber (it.effect, it.live); Effect.run* stays in the child, worker and fixture-server entries and the runner harness";
const testRunSyntax = ["error",
  { selector: "MemberExpression[property.name=/^run(Promise|Sync|Fork|Callback)/]", message: testRunMessage },
  { selector: "ImportSpecifier[imported.name=/^run(Promise|Sync|Fork|Callback)/]", message: testRunMessage },
  { selector: "ImportDeclaration[source.value=/ManagedRuntime$/]", message: testRunMessage },
  { selector: "MemberExpression[object.name='ManagedRuntime']", message: testRunMessage },
  { selector: "MemberExpression[property.name='runMain']", message: testRunMessage },
];
const testEntries = ["test/support/access-sql-child.ts", "test/support/access-sql-worker.ts", "test/support/db-worker-fault.ts", "test/support/sql-semantics-child.ts", "test/support/g8-auth-child.ts",
  "test/support/g8-auth-worker.ts", "test/support/g8-mcp-inflight-close.ts", "test/ui-fixture/run.ts"];

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "vendor/**"] },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "error",
      "no-restricted-imports": restrictedImports({ sqlite: true, ws: false }),
      "no-restricted-properties": ["error", loadExtension],
    },
  },
  { files: ["src/**/*.ts", "src/**/*.tsx"], rules: { "no-restricted-imports": restrictedImports({ sqlite: true, ws: true, nodeSqlite: true, timers: true }),
    "no-restricted-syntax": runSyntax({ runMain: false, fiberRuntimes: false }), ...timerRules } },
  { files: ["ui/src/**/*.ts", "ui/src/**/*.tsx"], rules: { "no-restricted-imports": restrictedImports({ sqlite: true, ws: false, nodeSqlite: true, timers: true }),
    "no-restricted-syntax": runSyntax({ runMain: false, fiberRuntimes: false }), ...timerRules } },
  { files: ["src/main.ts", "src/cli.ts", "src/db-worker.ts"], rules: { "no-restricted-syntax": runSyntax({ runMain: true, fiberRuntimes: false }) } },
  { files: ["src/workflow-mcp.ts"], rules: { "no-restricted-syntax": runSyntax({ runMain: false, fiberRuntimes: true }) } },
  { files: ["src/db.ts"], rules: { "no-restricted-imports": restrictedImports({ sqlite: false, ws: true, timers: true }) } },
  { files: ["src/db-worker-serve.ts"], rules: { "no-restricted-imports": restrictedImports({ sqlite: false, ws: true, nodeSqlite: true, timers: true }) } },
  { files: ["src/native-envelope.ts"], rules: { "no-restricted-imports": restrictedImports({ sqlite: true, ws: false, nodeSqlite: true, timers: true }) } },
  { files: ["test/**/*.ts", "test/**/*.tsx"], ignores: ["test/harness/**", ...testEntries], rules: { "no-restricted-syntax": testRunSyntax } },
);
