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

The dashboard has **Projects**, **Guide**, **Activity**, and **Settings**. Project file editing needs a separate native T3 filesystem read/write credential configured through deployment setup.

The Settings page lets you exclude chats from Project Supervisor selection. These choices are saved per instance and apply without a restart.

## Local deployment

### Direct installation

Node.js 24 or newer is required. From a source checkout:

```sh
npm ci
npm run build
npm install --global --omit=dev .
```

Configure the T3 endpoint and credential paths in the service environment, then run `t3-supervisor start`. The default state directory is `$XDG_STATE_HOME/t3-supervisor` when set, otherwise `~/.local/state/t3-supervisor`. A custom installation can use `DATA_DIRECTORY`; pass the same directory to `start` and `auth forge`.

### Docker

The portable [Compose template](compose.yaml) requires `SUPERVISOR_SECRETS_DIR` to point to a private directory containing the mounted T3 credentials. Configure the remaining environment values in the deployment file. The persistent `/data` volume retains the native project settings, thread policy, dashboard sessions, workflow MCP token, and the T3 catalog cursor and snapshots.

The Mac deployment uses `~/.config/t3-supervisor/compose.yaml`. The Lima Lab has a separate Dokploy-managed deployment. Health is available at [http://127.0.0.1:9007/health](http://127.0.0.1:9007/health), and the dashboard is published on loopback at port 9008.

The generic T3 catalog is stored in `/data/catalog.sqlite3`; project supervision state and dashboard state remain in their existing private stores.

## Development

The [usage skill](skills/use-t3-supervisor/SKILL.md) describes ordinary dashboard workflows for agent sessions.

```sh
npm ci
npm run autofix
npm run typecheck
npm test
npm run build
```

Read [AGENTS.md](AGENTS.md) and the local knowledge base before changing the project.
