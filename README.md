# T3 Supervisor

A local dashboard and background service for inspecting T3 projects, editing
repository-defined rules, and optionally handling Telegram notifications and input.

## Main features

- **Project rules:** edit names, descriptions and required blocks in the selected
  project's existing `.supervisor/rules.yaml`. The UI and repository use one rule
  model; there is no separate reminder-rule editor.
- **Reusable blocks:** inspect Markdown instructions, expected results and rule
  references. Select a project root or a conversation's worktree and see validation
  problems and the actual source path. See [project definitions](docs/project-definitions.md).
- **Project Supervisor:** choose a T3 model and reasoning per project. A reusable
  conversation is created automatically to interpret new tasks and propose draft
  workflows from their workspace rules and blocks, introduce them through active
  steering and discuss them through T3 messages. Configure live check-in timing
  and activity thresholds per project. See
  [project supervision](docs/project-supervision.md).
- **T3 observation and history:** project and chat inventories sync automatically;
  existing supervision and notification history remain inspectable.
- **Telegram completion notifications:** optional concise recaps for substantial
  work, with full answers for Telegram-originated tasks.
- **Telegram input:** optional native T3 questionnaires and answers through Telegram.

Supervising conversations can discuss workflows and read completed activity on
demand. The service still records a draft, not a confirmed workflow or proof of
block execution. The earlier condition/message reminders are retired; their stored history
and uncertain outcomes remain available without automatic retries.

## Dashboard

Open **[http://127.0.0.1:9008](http://127.0.0.1:9008)**. The dashboard opens directly,
without a login code. Its Docker port is published only on the Mac's loopback address.

The UI includes **Projects**, **Activity**, **Recaps and Telegram**, and **Settings**.
Open Projects, select a workspace, then Edit project rules. Saving requires a
separate native T3 filesystem read/write credential supplied through trusted setup.
No credential can be entered or upgraded through the dashboard.

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
observation and the project dashboard remain available. Telegram credentials,
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
