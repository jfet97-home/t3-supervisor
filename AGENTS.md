## Knowledge Base

This project has an LLM-maintained knowledge base in `knowledge/` (git-ignored). Invoke `$knowledge` or `/knowledge` with the same subcommands and arguments.

- When a local knowledge base exists, consult `knowledge/INDEX.md` and relevant pages before reading code. Use `rg` for exact lookup and `qmd query` when available for semantic lookup.
- After meaningful development or pulling commits, use `$knowledge update`.
- Library lookup order: `knowledge/dependencies/`, installed `node_modules/`, then official upstream documentation. Dependency reference sources are read-only and must never be imported.

## Batch completion and deployment

After completing an implementation batch, deploy the completed Supervisor to both
the Mac and T3 Lab VM and activate any associated MCP/MCPX connection changes.
Source checks alone do not complete a batch. Carry out the normal commit/source
synchronization and deployment steps without asking for confirmation again, unless
the current user explicitly limits deployment or a concrete blocker prevents it.
Verify the running revision, relevant health and a bounded real MCP call; preserve
state volumes, credentials, existing thread identities and instance settings.
Update the Lab's current-state, next-steps and progress documents with the outcome.
Choose checks proportionate to the change; do not replay the entire historical
foundation test campaign. Never modify T3 source or its installed app/server.
