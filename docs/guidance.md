# Intent guidance and activity UI

Open http://127.0.0.1:9008. The supervisor, rather than T3, serves this interface.
It uses Effect v4 HttpApi and React with Effect Atom, built by Vite.

Generate an owner login code locally:

```sh
docker --context desktop-linux compose -f ~/.config/mcpx/t3-supervisor.compose.yaml exec t3-supervisor npm run ui:login-code
```

Enter that code in the login form. It expires after 15 minutes and can be used once.
The owner session lasts eight hours. Codes and credentials never enter service logs.
Access is limited to the exact loopback origin; write requests also require a session
CSRF token. Serve the UI through this address, rather than exposing it publicly.

## Rules

Write a condition in ordinary language and the exact message to deliver when it matches.
Rules can apply globally, to one synchronized T3 project, or to managed no-project chats.
T3 inventory supplies the project IDs; titles do not determine scope. The configured
managed scratch root identifies no-project chats. Other ambiguous projects require an
explicit classification. Global rules can be muted for individual scopes.

Start in Observe mode. Preview evaluates supplied examples without sending messages.
Editing a rule's condition or message returns a sending rule to Observe mode. Pausing,
editing and resuming establish a fresh activation watermark, avoiding historical replay.
Stale tabs cannot overwrite newer saves.

The live monitor evaluates a bounded window from the active main run: its originating
request, recent public conversation, and owned command inputs. Child-agent output and
private reasoning are excluded. The detector is isolated, has no tools, and cannot send
messages itself. Missing prior history, quoted examples and ambiguous intent can produce
Needs context rather than guidance. Semantic detection is advisory and can miss events.

Accepted guidance is deduplicated for the thread/rule episode. A clearly cited new object
or resolved situation can rearm an episode; ordinary continued discussion cannot. The UI
also allows an owner to reset a resolved episode. Uncertain delivery is frozen, never
blindly resent, and requires reconciliation or explicit acceptance of duplicate risk.

## Enable delivery

Reading uses the existing read credential. Sending requires a **separate native T3
session credential** with orchestration operation permission, mounted privately as
`~/.config/mcpx/t3-supervisor-secrets/t3-guidance-token`. An MCP OAuth token cannot be
used on the native WebSocket surface. Do not reuse the questionnaire responder token.
The local coordinator can provision this credential through the installed T3 CLI; the
owner does not need to find or paste a token. Use `t3 auth session issue` with an explicit
T3 base directory and only `orchestration:read` and `orchestration:operate` scopes. Capture
its output directly into a private file, never into chat or logs. The installed credential
was provisioned on 9 October 2026 and expires on 9 October 2027. Renew it through the same
native command, then restart only the supervisor service. T3 source stays unchanged.

Enable Allow documented delivery race in Settings, then select Send for the desired rule.
The opt-in is tied to the observed T3 server version and clears on version changes.
The installed native dispatcher can start a follow-up if the targeted turn completes
between the supervisor's final check and dispatch. This is why sending is disabled by
default and requires explicit owner opt-in. It is guidance, not a publication lock.

Each notice has a persisted ID, exact message bytes and a dispatch marker before its
single native attempt. Native event acceptance and message visibility are displayed
separately; neither proves that the agent followed the instruction. The guidance path
cannot answer native questionnaires or permission requests.

## History and limits

Activity shows decisions, holds, delivery state and owner actions. Recaps and Telegram
shows the existing completion/input/reply-cleanup ledgers read-only. It does not resend
messages. Older silent recap decisions predating the audit table are unavailable.

The token budget is a conservative reservation estimate, not billed usage or a hard cap
on provider reasoning tokens. Only one detector invocation runs at a time. Coverage,
connection and missing write capability are visible. Detailed evidence expires after the
configured 24-hour or seven-day period; ordinary metadata expires after thirty days.
Uncertain notice bytes survive expiry for reconciliation. Databases remain in the existing
private Docker volume. Preserve that volume and all existing Telegram ledgers on upgrade.
