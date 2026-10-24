# Development


The Nix development shell pins Node 24.22.1 (the October 2026 security release)
and pnpm 12.14.0, and supports Apple Silicon macOS and x86_64/aarch64 Linux.
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

## Releases

Add a changeset for user-visible changes. See [RELEASING.md](RELEASING.md).

## Run from source

After entering the development shell:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

Set `T3_URL` and `T3_TOKEN_FILE` as described in
[installation](docs/installation.md). To register the CLI globally, use
`pnpm add --global .`. `pnpm pack` builds a complete archive, including the dashboard.

To build a development container, set the Compose variables from the README and
run `docker compose -f compose.yaml -f compose.build.yaml up --build -d`.
Production installation uses the published image without the build override.
