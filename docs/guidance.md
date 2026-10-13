> Historical implementation: the condition/message reminder editor and execution
> are retired. Use Projects to edit repository rules; see [project definitions](project-definitions.md).
> The configuration instructions below describe the earlier implementation.

# Intent guidance and activity UI

Open http://127.0.0.1:9008. The supervisor, rather than T3, serves this interface.
It uses Effect v4 HttpApi and React with Effect Atom, built by Vite.

The dashboard opens directly without a login code or expiring owner login.
The Docker port is published only on the Mac's `127.0.0.1`. Local processes are
trusted; other devices cannot access this listener. Exact Host/Origin checks
and a CSRF token still protect API writes from other websites. The browser loads
that token automatically; there is no authentication command to run.

User-initiated top-level links from other sites may open the dashboard. Cross-site
API requests, embedded pages and wrong Host/Origin requests remain rejected.
Keep the port bound to loopback; this access model is for the local Mac only.

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
`~/.config/t3-supervisor/secrets/t3-guidance-token`. An MCP OAuth token cannot be
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

## Chat settings

Settings also selects excluded chats and the interactive Telegram chat by stable ID.
The policy is saved in `/data/thread-settings.sqlite3`, separate from guidance settings
in `/data/guidance.sqlite3` and delivery ledgers. Changes apply live and independently
on each deployment. Excluded chats generate no new recaps, guidance or plain input
notices; the selected interactive chat may still handle questionnaires. Saved IDs
remain visible even when a chat is unavailable. Concurrent tab changes require reload.
