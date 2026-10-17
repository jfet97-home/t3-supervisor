# T3 Supervisor

A local dashboard and background service for inspecting T3 projects, editing
repository-defined steps and workflows, and optionally handling Telegram notifications and input.

## Main features

- **Steps and workflows:** inspect reusable steps and nested sequence/parallel
  workflows in the operative checkout. Edit required references and the optional
  default in `.t3-supervisor/project.yaml`. See [project definitions](docs/project-definitions.md).
- **Guide:** in-app definitions, syntax examples and FAQ explain fixed workflows,
  project requirements, child contributions, whole-workflow delegation and errors.
- **Project Supervisor:** choose a T3 model and reasoning per project. A reusable
  conversation is created automatically to interpret new tasks and propose draft
  workflows from their workspace steps, workflows and project configuration, introduce them through active
  steering and discuss them through T3 messages. Configure live check-in timing
  and activity thresholds per project. See
  [project supervision](docs/project-supervision.md).
- **T3 observation and history:** project and chat inventories sync automatically;
  existing supervision and notification history remain inspectable.
- **Telegram completion notifications:** optional concise recaps for substantial
  work, with full answers for Telegram-originated tasks.
- **Telegram input:** optional native T3 questionnaires and answers through Telegram.

Supervising conversations can discuss workflows and read completed activity on
demand. Matching native proposal and acceptance records save an agreement; connected live
plans remain editable. Neither agreement nor plan status alone proves execution. The earlier condition/message reminders are retired; their stored history
and uncertain outcomes remain available without automatic retries.

## Dashboard

Open **[http://127.0.0.1:9008](http://127.0.0.1:9008)**. The login page shows the
same command for every deployment:

```sh
t3-supervisor auth forge
```

For a direct installation, run it in your terminal as the account running
Supervisor, from any directory. For Docker or a VM, run it inside that environment.
It creates a fresh
sign-in token valid for five minutes and one use. Paste the result into the page;
do not put it in chat or a URL. This issues a local grant against private service
state, following T3's pairing-token pattern; it does not read out a permanent
password or contact T3.

The browser keeps only an eight-hour session in storage scoped to that exact
address and port. Sessions survive Supervisor restarts and deployments until their
original expiry; Sign out revokes the session durably. Grant hashes and session
hashes/timestamps share one private login.sqlite3 database; grant consumption and
session creation commit together. The service and CLI use the current schema. An expired session keeps
an open draft in the tab and never automatically
repeats a rejected write. The Docker dashboard port remains published only on
the Mac's loopback address.

The UI includes **Projects**, **Guide**, **Activity**, **Recaps and Telegram**, and **Settings**.
Open Projects, select a workspace, then edit project configuration. Saving requires a
separate native T3 filesystem read/write credential supplied through trusted setup.
No credential can be entered or upgraded through the dashboard.

## Local deployment

### Direct installation

Node.js 24 or newer is required. From a source checkout, install dependencies,
build, and install the named command:

```sh
npm ci
npm run build
npm install --global --omit=dev .
```

Configure the service's T3 credential paths and other instance settings in its
environment, then run `t3-supervisor start`. The dashboard and token command share
the same state directory: `$XDG_STATE_HOME/t3-supervisor` when set, otherwise
`~/.local/state/t3-supervisor`. Neither command depends on the current directory.
For a custom state location, use the same `DATA_DIRECTORY` for both commands, or
pass `--data-dir /absolute/path` to `start` and `auth forge`.
The command only mints a token after that instance has initialized its auth state.
The default T3 endpoint is `http://127.0.0.1:3773`; the built UI is located relative
to the installed package. Docker explicitly sets its state directory to `/data`.

### Existing Mac and Lab installations

The Mac installation uses `~/.config/t3-supervisor/compose.yaml`.

This is a private deployment-file convention shared with the Mac's MCP services;
Supervisor remains its own Compose project and state volume. The source checkout's
Compose files are portable templates. The Lima lab uses a separate Dokploy-managed
Compose deployment, not this Mac configuration directory.

Manage **excluded chats** and the **interactive Telegram chat** in the dashboard's
Settings page. Each instance saves them in `/data/thread-settings.sqlite3` inside its
persistent Docker volume. Changes apply live and survive restarts. The Mac and VM
have independent settings; new instances start with no exclusions or interactive chat.

Exclusions suppress new completion notifications, guidance and native input-needed
notices. The selected interactive chat is an input-only exception: it can answer
Telegram questionnaires while remaining excluded from recaps and guidance. Existing
forms for other newly excluded chats are retired without answering native questions.
Catalog/history and uncertain delivery evidence remain intact. Legacy
`EXCLUDED_THREAD_IDS` and `INPUT_INTERACTIVE_THREAD_ID` values are imported only when
the settings database is first created; they never override saved UI choices.

An obsolete questionnaire deletion with no confirmed receipt is retained as
`expired` with reason `deletion_unconfirmed_expired` after its 24-hour cleanup TTL. This does not claim deletion or replay it. It no longer blocks readiness;
uncertain sends and native submissions remain frozen and visible. Expired deletion
audit entries contain metadata only and are retained for 30 days, up to 1,000 entries.

```sh
docker --context desktop-linux compose -f ~/.config/t3-supervisor/compose.yaml up -d
```

The repository's [Compose template](compose.yaml) is portable; configure private
credential mounts and instance settings using [.env.example](.env.example).
Before a fresh image build, run `node scripts/fetch-runtime.mjs` to fetch the pinned
runtime. The service connects to T3's orchestration API; Telegram uses MCPX only when enabled.
Its private `t3-supervisor_state` volume retains settings and delivery evidence.
Health: [http://127.0.0.1:9007/health](http://127.0.0.1:9007/health).
With Telegram enabled, readiness requires the independent bot identity check and
healthy dependencies/workers. Unresolved delivery ledger entries remain visible and
are not replayed without proof, but do not by themselves make the service unready.
A successful ledger lookup does not replace the bot identity check.

### Optional Telegram integration

Telegram is disabled by default. Set `TELEGRAM_ENABLED=true` to enable completion
recaps and Telegram-originated answers. Set `INPUT_ENABLED=true` as well to enable
Telegram input relay. The Telegram master setting overrides the input setting.
Apply configuration changes by restarting the service.

A bridge `telegram_not_sent` response permits a retry only with explicit proof
that the connection failed before an HTTP request was sent: rejected delivery,
confirmed non-delivery, no possible completion and failure stage `connect`.
Completion messages and questionnaire operations retain the original key and
payload for the retry. Timeouts without that proof, lost responses and journal
failures remain uncertain and are reconciled rather than automatically replayed.

The base Compose template does not require MCPX or its Docker network. To enable
Telegram with the bundled MCPX network settings, use the Telegram override:

```sh
docker compose -f compose.yaml -f compose.telegram.yaml up -d
```

The override connects to the existing `lunar-mcpx_default` network. A custom
deployment can instead configure its own reachable MCPX URL. Existing installations
that use Telegram must explicitly set the master flag before upgrading.

With Telegram disabled, the service does not initialize the Telegram client, poll
the bot, process deliveries, generate completion recaps or relay input. T3
observation and the project dashboard remain available. Telegram credentials,
its MCP connection and the input responder credential are unnecessary, and disabled
Telegram workers do not affect readiness. Native workflow Supervisor conversations execute through T3; the optional recap CLI/auth cache is separate.

Existing delivery records and uncertain outcomes are retained; disabling Telegram
does not mark them sent or clear them. Re-enabling resumes existing queued work,
without collecting completions from the disabled period. Pending recap context does
not expire while disabled and gets a fresh seven-day retention window on re-enable.
Completions not queued before disabling are not collected retrospectively.
Historical delivery evidence remains visible in the dashboard.

## Development

The [usage skill](skills/use-t3-supervisor/SKILL.md) packages dashboard workflows for
installation in an agent's skills directory. It includes its own references and
does not require this source checkout for ordinary use.

```sh
npm ci
npm run autofix
npm run typecheck
npm test
npm run build
```

Read [AGENTS.md](AGENTS.md) and the local knowledge base, when present, before changes.
