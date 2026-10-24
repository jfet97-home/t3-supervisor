# Installation and configuration

Choose the local package or the container in the [README](../README.md). Both run
the same service, dashboard and CLI. The npm package requires Node 24.22.1 or
newer; the container supplies its own runtime. Neither requires Nix. Nix is for
[source development](../CONTRIBUTING.md).

## Connect to T3

Start your T3 server first. Obtain a native read credential through that server's
supported access controls and save it in a private file owned by the account
running Supervisor. Do not use a provider API key or a dashboard login token.
Supervisor cannot issue T3 credentials or grant itself access.

The credential must permit the environment descriptor, project/thread catalogs,
native orchestration reads and event subscriptions. A T3 build without those
native capabilities cannot be made compatible by installing Supervisor alone.
Use T3's own documentation for credential issuance for your installed version.

Set `T3_URL` to the server's base URL and `T3_TOKEN_FILE` to the credential file.
For example, protect an existing file with `chmod 600 /path/to/t3-read-token`.
Supervisor reads the file; keep the token itself out of shell commands and Git.

Additional credentials enable capabilities separately:

| Variable | Purpose |
| --- | --- |
| `T3_GUIDANCE_TOKEN_FILE` | Native Project Supervisor conversations and guidance |
| `T3_PROJECT_WRITE_TOKEN_FILE` | Project definition file reads and writes |
| `T3_PROJECT_COMMIT_TOKEN_FILE` | Explicit project setup commits |
| `T3_GIT_PROBE_TOKEN_FILE` | Git preflight checks for project setup |

Each credential must be issued by T3 with the corresponding permissions. Missing
optional access remains unavailable in the dashboard; it does not grant broader
authority. See [project definitions](project-definitions.md) and
[project supervision](project-supervision.md) for the feature contracts.

## State, ports and sign-in

Local state defaults to `$XDG_STATE_HOME/t3-supervisor`, or
`~/.local/state/t3-supervisor` when `XDG_STATE_HOME` is unset. Override it with
`DATA_DIRECTORY` or `--data-dir /absolute/path`. Use the same account and directory
for `t3-supervisor start` and `t3-supervisor auth forge`.

The dashboard defaults to `127.0.0.1:9008` (`UI_HOST`, `UI_PORT`), and health to
port 9007 (`HEALTH_PORT`). `/health` reports readiness; `/live` reports liveness.
Both include `version` and `revision`. A source build without a recorded Git
revision reports `revision: null`.

Forge a fresh dashboard token after the instance has initialized. It is single-use
and valid for five minutes. Browser sessions survive restarts until their original
30-day expiry or sign-out. Dashboard tokens, T3 credentials and the workflow MCP
bearer are separate credentials. See [workflow MCP](workflow-mcp.md) before enabling
remote clients; keep the default loopback exposure for ordinary local use.

## Docker

The template runs as `LOCAL_UID:LOCAL_GID`, so set them with `id -u` and `id -g`.
Create `SUPERVISOR_DATA_DIR` first, owned by that account, with mode 0700. The
directory is mounted at `/data`; the credential directory is mounted read-only at
`/run/secrets`. Its `t3-read-token` must be readable by the same account. Optional
credential files use the names shown in [compose.yaml](../compose.yaml).

The default T3 address is `http://host.docker.internal:3773`. Docker Desktop
provides this hostname; the template also maps it to the host gateway on Linux.
On Linux, a T3 server listening only on host loopback may not accept gateway
connections. Configure T3's supported listener/access settings or use a reachable
T3 server URL; Supervisor does not start a proxy. Host and container loopback are
different network namespaces.

Container ports are published only on host loopback. Set `T3_URL` to change the
upstream server and `SUPERVISOR_VERSION` to select an exact image version or a
channel. The registry is `ghcr.io/jfet97-home/t3-supervisor`; published images
support Linux amd64 and arm64. For immutable image selection, use the digest from
the GitHub release in your deployment configuration.

This template uses a host directory for portable ownership. Existing deployments
using a named volume should retain that volume and its mount; do not replace it
with an empty directory during an upgrade.

## Upgrade and rollback

Stop Supervisor and back up its complete state directory or volume before
upgrading. Preserve private credential files, sessions, instance settings and the
workflow MCP bearer. Copying live SQLite files without their WAL is not a reliable
backup; take the backup while the service is stopped.

For local installation, install the desired version with
`npm install --global t3-supervisor@VERSION` (or `pnpm add --global ...`), then
restart the service. For Compose, set `SUPERVISOR_VERSION=VERSION`, run
`docker compose pull`, then `docker compose up -d`. Confirm `--version` and
`/health` after restarting. Updating an alias in the registry never changes a
running process or container by itself.

Alpha, beta and nightly are opt-in test releases. Use separate state for testing
them. An older binary may not understand state written by a newer one; rollback
can require restoring the matching pre-upgrade backup. Do not promise downgrade
compatibility from a version number alone.
