# T3 Supervisor

A dashboard and background service for supervising [T3 Code](https://github.com/pingdotgg/t3code)
projects and conversations. Define reusable workflows, agree on plans in T3, and
follow their progress from one place.

Supervisor runs alongside T3. It needs a running T3 server with native access
credentials; installing Supervisor does not install T3 or configure its providers.

> **First release pending:** the registry package and container image below are
> the intended installation paths. Until the first release is published, use the
> [source installation](CONTRIBUTING.md#run-from-source).

## Install locally

Requires Node.js **24.22.1 or newer**. Install with either package manager:

```sh
npm install --global t3-supervisor@latest
# or: pnpm add --global t3-supervisor@latest
```

Put the T3 read credential in a private file, then start Supervisor:

```sh
export T3_URL=http://127.0.0.1:3773
export T3_TOKEN_FILE="$HOME/.config/t3-supervisor/t3-read-token"
t3-supervisor start
```

The file must already contain a credential issued by your T3 server. See
[configuration](docs/installation.md) for native access, optional capabilities,
custom ports and state directories. The command runs in the foreground; use your
usual service manager if you want it to start at login or boot.

## Run with Docker

Docker includes the Node runtime and the built dashboard. Download
[compose.yaml](compose.yaml) into a directory of your choice. Put your T3
credential in a private directory as `t3-read-token`, then run:

```sh
export SUPERVISOR_SECRETS_DIR="$HOME/.config/t3-supervisor/secrets"
export SUPERVISOR_DATA_DIR="$HOME/.local/state/t3-supervisor"
export LOCAL_UID=$(id -u) LOCAL_GID=$(id -g)
mkdir -p "$SUPERVISOR_DATA_DIR"
chmod 700 "$SUPERVISOR_DATA_DIR"
docker compose pull
docker compose up -d
```

The template reaches T3 on the host at `host.docker.internal:3773` and publishes
Supervisor's ports on loopback. For a T3 server elsewhere, set `T3_URL` before
starting Compose. State lives in `SUPERVISOR_DATA_DIR`; keep it when upgrading.
See [container setup](docs/installation.md#docker) for permissions and networking.

## Open the dashboard

Open **[http://127.0.0.1:9008](http://127.0.0.1:9008)**. In another terminal, create
a one-use sign-in token for the running instance:

```sh
t3-supervisor auth forge
# with Docker: docker compose exec t3-supervisor t3-supervisor auth forge
```

Paste it into the dashboard. Tokens expire after five minutes; browser sessions
last up to 30 days. If you use a custom state directory, pass the same
`--data-dir /absolute/path` to `start` and `auth forge`.

Start on **Home** to see work that needs attention. **Projects** lets you configure
project supervision and workflow definitions; **Activity** shows recent events.
Project supervision is opt-in. Recorded plans and progress do not prove that
the underlying work was executed.

## Versions and updates

Use `t3-supervisor --version` to check the installed version. Releases provide the
same version as an npm package and a container image for Linux amd64 and arm64.

| Channel | npm/pnpm selector | Container tag | Intended use |
| --- | --- | --- | --- |
| Stable | `t3-supervisor@latest` | `:latest` | Normal use |
| Beta | `t3-supervisor@beta` | `:beta` | Testing a release candidate |
| Alpha | `t3-supervisor@alpha` | `:alpha` | Earlier testing |
| Nightly | `t3-supervisor@nightly` | `:nightly` | Latest successful main build |

Previews are optional and may not exist until one has been published. For example,
`npm install --global t3-supervisor@beta` selects beta; with Compose, set
`SUPERVISOR_VERSION=beta`. You can pin an exact release instead of a channel.
Installing a new version does not restart your running service automatically.

Back up the state directory or volume before upgrading. See
[upgrade and rollback](docs/installation.md#upgrade-and-rollback),
[release notes](CHANGELOG.md) and [GitHub releases](https://github.com/jfet97-home/t3-supervisor/releases).

## Learn more

- [Installation and configuration](docs/installation.md)
- [Project supervision](docs/project-supervision.md), [workflow definitions](docs/project-definitions.md) and [Supervisor teams](docs/supervisor-team.md)
- [Workflow MCP](docs/workflow-mcp.md) and [usage skill](skills/use-t3-supervisor/SKILL.md)
- [Development](CONTRIBUTING.md) and [maintaining releases](RELEASING.md)
