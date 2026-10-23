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

// only src/db.ts opens SQLite clients (plan 3.2) and, as the SQL layer and private files adapter, imports node:sqlite in
// src and ui/src (plan section 11); only src/native-envelope.ts opens native T3 websockets in src (D-08); suites run on
// vitest; the package barrel and every subpath (for example @effect/sql-sqlite-node/SqliteClient)
const restrictedImports = ({ sqlite, ws, nodeSqlite = false, timers = false }) => ["error", {
  paths: [
    { name: "node:test", message: "the suites run on vitest" },
    ...(ws ? [{ name: "ws", message: "native T3 websockets go through src/native-envelope.ts (D-08)" }] : []),
    ...(nodeSqlite ? [{ name: "node:sqlite", message: "node:sqlite stays in the SQL layer and private files adapter src/db.ts (plan 3.2)" }] : []),
    ...(timers ? timerModules.map((name) => ({ name, message: timerMessage })) : []),
  ],
  patterns: sqlite ? [{ group: ["@effect/sql-sqlite-node", "@effect/sql-sqlite-node/*"], message: "only src/db.ts opens SQLite clients (plan 3.2)" }] : [],
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
  { files: ["src/main.ts", "src/cli.ts"], rules: { "no-restricted-syntax": runSyntax({ runMain: true, fiberRuntimes: false }) } },
  { files: ["src/workflow-mcp.ts"], rules: { "no-restricted-syntax": runSyntax({ runMain: false, fiberRuntimes: true }) } },
  { files: ["src/db.ts"], rules: { "no-restricted-imports": restrictedImports({ sqlite: false, ws: true, timers: true }) } },
  { files: ["src/native-envelope.ts"], rules: { "no-restricted-imports": restrictedImports({ sqlite: true, ws: false, nodeSqlite: true, timers: true }) } },
);
