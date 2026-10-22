import tseslint from "typescript-eslint";

// only src/db.ts opens SQLite clients (plan 3.2); suites run on vitest
const restrictedImports = (sqlite) => ["error", {
  paths: [
    { name: "node:test", message: "the suites run on vitest" },
    ...(sqlite ? [{ name: "@effect/sql-sqlite-node", message: "only src/db.ts opens SQLite clients (plan 3.2)" }] : []),
  ],
}];

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "vendor/**"] },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "error",
      "no-restricted-imports": restrictedImports(true),
      "no-restricted-properties": ["error", { property: "loadExtension", message: "SQLite extension loading stays disabled (plan 3.2)" }],
    },
  },
  { files: ["src/db.ts"], rules: { "no-restricted-imports": restrictedImports(false) } },
);
