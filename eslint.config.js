import tseslint from "typescript-eslint";

// only src/db.ts opens SQLite clients (plan 3.2); only src/native-envelope.ts opens native T3 websockets in src (D-08);
// suites run on vitest; the package barrel and every subpath (for example @effect/sql-sqlite-node/SqliteClient)
const restrictedImports = ({ sqlite, ws }) => ["error", {
  paths: [
    { name: "node:test", message: "the suites run on vitest" },
    ...(ws ? [{ name: "ws", message: "native T3 websockets go through src/native-envelope.ts (D-08)" }] : []),
  ],
  patterns: sqlite ? [{ group: ["@effect/sql-sqlite-node", "@effect/sql-sqlite-node/*"], message: "only src/db.ts opens SQLite clients (plan 3.2)" }] : [],
}];

// the native clients not yet ported onto the envelope; each S4 port removes its file from this list
const unportedNativeClients = ["src/project-files.ts", "src/git-probe.ts"];

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "vendor/**"] },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "error",
      "no-restricted-imports": restrictedImports({ sqlite: true, ws: false }),
      "no-restricted-properties": ["error", { property: "loadExtension", message: "SQLite extension loading stays disabled (plan 3.2)" }],
    },
  },
  { files: ["src/**/*.ts", "src/**/*.tsx"], rules: { "no-restricted-imports": restrictedImports({ sqlite: true, ws: true }) } },
  { files: ["src/db.ts"], rules: { "no-restricted-imports": restrictedImports({ sqlite: false, ws: true }) } },
  { files: ["src/native-envelope.ts", ...unportedNativeClients], rules: { "no-restricted-imports": restrictedImports({ sqlite: true, ws: false }) } },
);
