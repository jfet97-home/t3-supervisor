# T3 Supervisor

A local dashboard and background service for supervising T3 projects, native conversations, and reusable workflow plans.

## Features

- Inspect and edit repository-defined steps, workflows, and required references in `.t3-supervisor/project.yaml`. See [project definitions](docs/project-definitions.md).
- Configure a native Project Supervisor for each project. It reads the project's definitions, discusses task plans in T3, and tracks main and child workflow progress. See [project supervision](docs/project-supervision.md).
- Coordinate optional native Supervisor teams with scoped helper assignments and retained history. See [Supervisor teams](docs/supervisor-team.md).
- View project and conversation activity in the dashboard. Project and chat catalogs sync from T3.

Workflow proposals, agreements, and status notes are records of supervision. They do not prove that work was executed.

## Dashboard

Open [http://127.0.0.1:9008](http://127.0.0.1:9008). Create a one-use sign-in token on the machine running Supervisor:

```sh
t3-supervisor auth forge
```

For Docker or a VM, run the command inside that environment. Tokens expire after five minutes and can be used once. The browser keeps a 30-day browser session scoped to that address and port. Sessions survive restarts and deployments until their original expiry; signing out revokes the session.

The dashboard opens on **Home**, showing current attention and supervised work. **Projects**, **Activity**, and **Settings** remain directly accessible, with **Guide** as a utility link. Each conversation has a **Task** view (its task, one plan with assessed progress, the agreement and the evidence) and a **Supervision** view (the Supervisor's health and controls). Project file editing needs a separate native T3 filesystem read/write credential configured through deployment setup.

The Settings page lets you exclude chats from Project Supervisor selection. These choices are saved per instance and apply without a restart.

## Local deployment

### Direct installation

Node.js 24.22.1 or newer and pnpm 12.14.0 are required. From a source checkout:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm add --global .
```

Configure the T3 endpoint and credential paths in the service environment, then run `t3-supervisor start`. The default state directory is `$XDG_STATE_HOME/t3-supervisor` when set, otherwise `~/.local/state/t3-supervisor`. A custom installation can use `DATA_DIRECTORY`; pass the same directory to `start` and `auth forge`.

### Docker

The portable [Compose template](compose.yaml) requires `SUPERVISOR_SECRETS_DIR` to point to a private directory containing the mounted T3 credentials. Configure the remaining environment values in the deployment file. The persistent `/data` volume retains the native project settings, thread policy, dashboard sessions, workflow MCP token, and the T3 catalog cursor and snapshots.

The Mac deployment uses `~/.config/t3-supervisor/compose.yaml`. The Lima Lab has a separate Dokploy-managed deployment. Health is available at [http://127.0.0.1:9007/health](http://127.0.0.1:9007/health), and the dashboard is published on loopback at port 9008.

The generic T3 catalog is stored in `/data/catalog.sqlite3`; project supervision state and dashboard state remain in their existing private stores.

## Development

The Nix development shell pins Node 24.22.1 (the October 2026 security release)
and pnpm 12.14.0, using the same release archives and Nix input revisions as
Scanner. It supports Apple Silicon macOS and x86_64/aarch64 Linux.
Run `nix develop` in the checkout to enter it, or prefix a command with
`nix develop --command`. The project's `packageManager` field pins pnpm 12.14.0;
dependency installation uses the committed `pnpm-lock.yaml` with
`pnpm install --frozen-lockfile`.

New worktrees reuse pnpm's shared package store with `--prefer-offline` and
hardlinks, fetching packages that are missing while keeping each worktree's
installed `node_modules` separate. Build-script approval is explicit in
`pnpm-workspace.yaml`; script commands never install dependencies implicitly.

T3's **Setup Worktree** action runs `sh scripts/setup-worktree.sh`. The launcher
approves this checkout's `.envrc` when direnv is installed, then installs dependencies
inside the pinned Nix shell. It works without an interactive shell hook.
An existing T3 project may need its saved action set to the same command because
saved actions override `t3.json`.

For automatic loading in interactive terminals, enable direnv's shell hook once.
The tracked `.envrc` loads the flake when entering the checkout and unloads it
when leaving. T3's setup launcher handles approval for worktrees it creates;
for a checkout created manually, run `direnv allow` from its root after reviewing
`.envrc`. Run it again if `.envrc` changes. Nix alone does not need this approval.

The [usage skill](skills/use-t3-supervisor/SKILL.md) describes ordinary dashboard workflows for agent sessions.
The [workflow-authoring skill](skills/author-supervisor-workflows/SKILL.md) derives
reusable steps and workflows from project guidance, development history and human
corrections, with a recommendation for two distinct models using high reasoning.

```sh
pnpm install --frozen-lockfile
pnpm autofix
pnpm typecheck
pnpm test
pnpm build
```

`pnpm test` runs the [Vitest](https://vitest.dev) suites; Effect code is tested with `@effect/vitest`.

GitHub CI runs lint, type checking and build once, the runner harness once, and
the complete main suite across four native Vitest shards on separate runners.
Each shard uses one test worker so database worker startup does not compete with
another suite in the same runner. Isolation, the leak gate, per-test bounds and
the 20-minute watchdog stay the same. The `check` status requires every job
to pass, including every shard; failed, cancelled or skipped jobs fail the gate.
One shared setup action caches the pnpm package store by OS, architecture, Node
major and lockfile. A changed lockfile can reuse an older store and fetch only
missing packages. Every job still validates a frozen install and executes its
checks; installed trees, build outputs and test results are never cached.
New runs cancel older runs of this workflow for the same branch or pull request,
including `main`; unrelated branches and pull requests run independently.

While editing, run focused files through the watchdog, for example
`pnpm test test/config.test.ts`. Leave the final complete main and harness
suites to GitHub CI. To reproduce one CI shard locally, use
`pnpm test --shard=1/4 --maxWorkers=1`. Native sharding assigns complete files
deterministically, so all four shard indices are required for full coverage.

Read [AGENTS.md](AGENTS.md) and the local knowledge base before changing the project.

## Node security runtime

The Dockerfile pins official Node 24.22.1 images by immutable digest in both
build and runtime stages, applying the October 2026 Node security release.
That October rebuild was a runtime rebuild of the existing application with the
same dependency lock, not an application or protocol migration. The Effect v4
migration is a separate application change with its own dependency lock change:
`effect` and every `@effect/*` package move to an exact 4.0.6 pin and the suites
move to Vitest, on the same Node image digests. Preserve the existing private
state, credentials, mounts and lifecycle settings when replacing the container.
Verify the actual runtime and a bounded service read after deployment; updating
host Node or running nix-darwin activation does not update this container.
