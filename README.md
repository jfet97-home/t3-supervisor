# T3 Supervisor

A local dashboard and background service for **continuously monitoring T3 agents**,
configuring guidance, and handling Telegram notifications and input.

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

Open **[http://127.0.0.1:9008](http://127.0.0.1:9008)**. Generate a one-use login code:

```sh
docker --context desktop-linux compose -f ~/.config/mcpx/t3-supervisor.compose.yaml exec t3-supervisor npm run ui:login-code
```

The UI includes **Rules**, **Activity**, **Recaps and Telegram**, and **Settings**.
Start rules in **Observe** mode. Sending guidance requires its dedicated credential
and the owner opt-in in Settings. Detection is advisory: a target finishing during
message delivery can cause a follow-up turn. See [dashboard and guidance setup](docs/guidance.md).

## Local deployment

The Mac installation uses `~/.config/mcpx/t3-supervisor.compose.yaml`:

```sh
docker --context desktop-linux compose -f ~/.config/mcpx/t3-supervisor.compose.yaml up -d
```

The repository's [Compose template](compose.yaml) is portable; configure private
credential mounts and instance settings using [.env.example](.env.example).
Before a fresh image build, run `node scripts/fetch-runtime.mjs` to fetch the pinned
runtime. The service connects to T3's orchestration API and to Telegram through MCPX.
Its private `t3-supervisor_state` volume retains settings and delivery evidence.
Health: [http://127.0.0.1:9007/health](http://127.0.0.1:9007/health).

## Development

```sh
npm ci
npm run autofix
npm run typecheck
npm test
npm run build
```

Read [AGENTS.md](AGENTS.md) and the local knowledge base, when present, before changes.
