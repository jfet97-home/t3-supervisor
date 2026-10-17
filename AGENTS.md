## Skill ownership

Keep `skills/` focused on portable product usage. Personal installation policies,
source maintenance and deployment procedures belong in the global `t3-supervisor`
skill outside this repository. The Git-backed `use-t3-supervisor` skill is exposed
globally through Skillshare; it must not depend on personal maintenance files.

Skill/documentation-only batches use Git and Skillshare propagation; they do not
require rebuilding or restarting the application.

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

## Standing rule: no Supervisor proxy workarounds

Do not add or retain extra HTTP proxies, reverse proxies or relay sidecars to make
Supervisor integrations work. Fix endpoint exposure, authentication, accepted hosts
and client configuration in Supervisor itself. MCPX must connect directly to the
Supervisor MCP endpoint. The existing MCPX gateway remains the client connection;
do not introduce another intermediary. The two legacy workflow HTTP proxy services were
removed by the completed direct-authentication batch. Never modify
T3 source or its installed app/server as a workaround.


## Current phase: rapid development, no backward compatibility

This is an experimental project being iterated quickly on the Mac and Lab VM.
Backward compatibility with previous prototype versions, schemas, file formats,
CLI behavior or configuration is not a requirement unless the user explicitly
requests it for a particular change. Prefer the simplest current implementation.
Do not add compatibility layers, legacy fallbacks, duplicate databases/stores or
migration frameworks solely to keep obsolete experimental versions working.
The former split grant/session databases are the concrete example to avoid.
Obsolete prototype code and tests may be replaced rather than carried forward.

Preserving current credentials, active sessions and non-disposable user data is
operational care, not a reason to retain old product formats. When necessary,
use a bounded one-off operational cut-over rather than permanent compatibility
machinery. This policy does not authorize unrelated data resets.
