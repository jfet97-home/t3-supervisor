# T3 Supervisor

A local dashboard and background service for **continuously monitoring T3 agents**,
configuring guidance, and optionally handling Telegram notifications and input.

## Main features

- **Agent monitoring and guidance:** watch active main-agent work against conditions
  written in ordinary language. Configure global, project-specific or no-project
  rules; preview them, observe matches, pause monitoring, or enable delivery of an
  exact guidance message to the relevant T3 conversation.
- **Control dashboard:** manage rules, scopes, monitoring budget and delivery settings;
  inspect decisions, holds, uncertain deliveries and activity history.
- **Telegram completion notifications:** send concise recaps for substantial work.
  Routine exchanges stay silent. Telegram-originated work returns its full answer,
  and replies to recaps can be routed back to the original conversation.
- **Telegram input:** mirror native T3 questionnaires into the configured Telegram
  conversation and submit answers back to T3. Other eligible chats receive plain
  input-needed notices.

## Dashboard

Open **[http://127.0.0.1:9008](http://127.0.0.1:9008)**. The dashboard opens directly,
without a login code. Its Docker port is published only on the Mac's loopback address.

The UI includes **Rules**, **Activity**, **Recaps and Telegram**, and **Settings**.
Start rules in **Observe** mode. Sending guidance requires its dedicated credential
and the owner opt-in in Settings. Detection is advisory: a target finishing during
message delivery can cause a follow-up turn. See [dashboard and guidance setup](docs/guidance.md).

## Local deployment

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
uncertain sends and native submissions remain frozen and visible.

```sh
docker --context desktop-linux compose -f ~/.config/t3-supervisor/compose.yaml up -d
```

The repository's [Compose template](compose.yaml) is portable; configure private
credential mounts and instance settings using [.env.example](.env.example).
Before a fresh image build, run `node scripts/fetch-runtime.mjs` to fetch the pinned
runtime. The service connects to T3's orchestration API; Telegram uses MCPX only when enabled.
Its private `t3-supervisor_state` volume retains settings and delivery evidence.
Health: [http://127.0.0.1:9007/health](http://127.0.0.1:9007/health).

### Optional Telegram integration

Telegram is disabled by default. Set `TELEGRAM_ENABLED=true` to enable completion
recaps and Telegram-originated answers. Set `INPUT_ENABLED=true` as well to enable
Telegram input relay. The Telegram master setting overrides the input setting.
Apply configuration changes by restarting the service.

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
observation, the dashboard and guidance remain available. Telegram credentials,
its MCP connection and the input responder credential are unnecessary, and disabled
Telegram workers do not affect readiness. Guidance model authentication remains
independent of Telegram.

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
