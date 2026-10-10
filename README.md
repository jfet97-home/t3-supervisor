# T3 Supervisor

An extensible Effect TypeScript v4 service that observes T3 Code and runs background
integrations. Its first integration sends Telegram notifications for completed main-agent turns.

Luna reserves notifications for substantial deliverables, investigations, developed
analysis, major completed workflow milestones, or meaningful results from sustained
work. Ordinary back-and-forth, tool inventories, sign-in-link refreshes, minor
clarifications, cosmetic changes and repeated outcomes stay silent. One message can
contain substantial work; message length, turn count or elapsed waiting time alone
does not qualify it. A thank-you accompanied by substantial new work can still notify.
Skipped turns retain their durable identity, preventing notifications after a restart.

The listener reads T3's authenticated orchestration API, persists event cursors and
completion hints, and evaluates each successful completed run independently of later
queued or running turns. That run's own tools, approvals and child delivery must settle.
Bounded context contains only that turn's request, assistant updates and final answer;
earlier accomplishments cannot leak into a recap of a trivial follow-up. A separate ephemeral `cx` call uses `gpt-6-luna` with max reasoning to
produce at most 30 English words. Telegram messages include chat title, real project title
when present, and the full thread ID. Bot communication uses MCPX's lazy wrapper and the
existing `raspfet-telegram-t3` server; no provider hooks or new T3 summary chats are used.

The Telegram-bound conversation and the existing No-project TEAMS conversation are
excluded by exact IDs in Compose. Internal subagent chats are excluded; ordinary forks
remain eligible. Only post-activation completions are considered, and activation survives
restarts. A completed turn does not independently establish that an entire objective is done.

Telegram-originated follow-ups use a separate delivery path: recognize the originating
run's durable `message:mcp:UUID:thread-send:telegram-route-UPDATE_ID` user message,
then send the exact final main-agent answer without Luna classification or a word cap.
Keep the same identity header so another Telegram reply can return to the right chat.
Long answers are split into Unicode-safe parts of at most 4,000 UTF-16 units; their
bodies reconstruct the original answer exactly. Ordinary T3 exchanges keep the selective
recap policy. The two excluded chats and internal subagents remain excluded.

## Intent guidance

The supervisor also provides an authenticated local UI for scoped natural-language
rules, detector activity, completion recaps and Telegram handling. See
[Intent guidance and activity UI](docs/guidance.md) for login, delivery setup and limits.
T3 source is unchanged.

## Development

```sh
npm ci
npm run autofix
npm run typecheck
npm test
npm run build
```

Read `AGENTS.md` and `knowledge/INDEX.md` before code changes. Installed Effect v4 source
is the API reference. The T3 source, completion policy, durable store, recap runtime,
Telegram adapter and coordinator have separate module boundaries for future integrations.

## Docker

```sh
node scripts/fetch-runtime.mjs
docker --context desktop-linux compose -f ~/.config/mcpx/t3-supervisor.compose.yaml build
docker --context desktop-linux compose -f ~/.config/mcpx/t3-supervisor.compose.yaml up -d
curl -fsS http://127.0.0.1:9007/health
```

The repository is [jfet97-home/t3-supervisor](https://github.com/jfet97-home/t3-supervisor).
`compose.yaml` is a portable template: set `SUPERVISOR_SECRETS_DIR`, optional exact
`EXCLUDED_THREAD_IDS`, and `T3_MANAGED_SCRATCH_ROOT` for your installation. On this Mac,
the installed instance configuration is the private file
`~/.config/mcpx/t3-supervisor.compose.yaml`, with its build context pointing here.
The image pins
its ARM64 Node base and official runtime artifact integrity. Private session/login files
are mounted from `~/.config/mcpx/t3-supervisor-secrets/`; they never enter the image or
source. The read-only T3 session and isolated runtime login cache are separate from the
bot's credentials, which remain on the Pi.

`restart: unless-stopped` starts the container with Docker and recovers crashes. A manual
stop stays stopped until explicitly started. The Mac must be awake, Docker running and
T3 available to observe new completions. `/live` reports process liveness; `/health`
reports readiness, dependency state, worker progress and outbox statistics.

The private named volume contains SQLite state and the runtime login cache. Preserve it
during normal upgrades. Stable delivery keys and saved message bytes prevent duplicate
notifications. An uncertain send is reconciled using the original key, never blindly
retried. Raw context expires after seven days, sent metadata after thirty days, and
payload-free deduplication identities remain. Docker logs rotate at three files of 5 MiB
and contain metadata rather than conversation text.

## Operations guidance

The global skill is `~/.agents/skills/t3-supervisor/SKILL.md`. Its adjacent architecture,
operations, development and troubleshooting guides document this installation. Use the
live service configuration and evidence rather than assuming that older notes remain current.

## Replies to completion recaps

Telegram replies are routed by the existing Telegram-bound T3 conversation, using
the `Telegram main` webhook prompt and T3's `t3_thread_read` / `t3_thread_send`
tools. Ordinary recap reply routing does not depend
on its container, database, or credentials.

The router accepts the identity header only from the actual bot's private-chat
message, validates the destination in T3, and queues the original follow-up with
the stable request ID `telegram-route-UPDATE_ID`. Quoted recap text is context,
not instructions. Forwarded messages, internal subagent chats, the Telegram router
and the TEAMS monitor are not routing targets. Archived or settled destinations
are reported instead of automatically reopened. Bridge configuration requests
stay in the Telegram-bound conversation. The destination receives only Andrea's
original text. A successful forward is acknowledged only by a 🕊 reaction on that
incoming Telegram reply, through `raspfet-telegram-t3__set_message_reaction` and the
stable key `telegram-UPDATE_ID-reaction-1`, passing `emoji="🕊"`; no acknowledgement text is sent.
The reaction means T3 accepted the message, not that work finished. The target's
eventual successful completion returns its full answer, even for a trivial turn. Reaction failures are
reported in T3 and never cause the request to be forwarded again.

## Native input questionnaires

An independent worker watches user-input requests in ordinary active local T3 chats.
Only the configured Telegram conversation gets interactive questionnaires. Other main
and fork chats receive a plain input-needed notification naming the chat, in addition
to their existing completion recaps. Replies to those plain notifications stay in the
Telegram conversation and cannot answer the other chat's native request. Delegated,
archived and deleted chats and permission approvals remain excluded.

The Pi bridge registers each card before sending it and captures authenticated replies
and button callbacks into a private durable inbox. The supervisor pulls that inbox through
the existing `raspfet-telegram-t3` MCPX transport. Responses bypass the waiting agent and
ordinary chat-message dispatch. No new public endpoint, bot, or T3 modification is needed.

Each question preserves its choices and descriptions and supports permitted custom text.
Predefined multi-choice answers are arrays; custom answers are strings, matching the
installed native UI. Complete all questions and use the versioned Submit control.
Submitting an old draft cannot silently submit a newer one. Answers in T3 retire the
Telegram cards; answers in Telegram use the exact native request. Live requests resume
the waiting tool, while message-mode requests use T3's normal structured async answer.

Set `INPUT_ENABLED=true`, `T3_INPUT_TOKEN_FILE` to the private responder credential file,
and optionally `INPUT_POLL_MS` (default 1000). The responder uses the installed session
CLI with explicit orchestration scopes; provider credentials are not reused. The separate
`telegram-input.sqlite3` persists definitions, drafts, submission intents and cleanup in
the existing state volume. Preserve both it and the completion database during upgrades.

Before activation, call the bounded `configure_input_updates` MCP tool with a stable key
to enable callback and edit updates on the existing webhook. It verifies and preserves
the webhook URL, delivery secret and pending updates. After uncertainty, reconcile the
original delivery key before further action. Native text replies retain receipt reactions
through MCPX; reaction failure does not consume or block their answers.

Native acceptance is not provider completion. An uncertain submission stays frozen and
visible with a status card until authoritative reconciliation; it is never blindly resent.
The current T3 API cannot atomically check a question revision or attribute every lost
acknowledgement. Telegram cards refresh before the deletion deadline, but prolonged
downtime can prevent deletion after 48 hours. Input state is bounded and private; health
reports question-worker failure and uncertain operations separately from liveness.

Capacity maintenance preserves identities rather than silently dropping old work.
Inspect supervisor `inputCapacity` and the Pi inbox capacity returned by its read tools.
Terminal payload compaction and free SQLite pages provide reusable space; the default
physical bound is 64 MiB per input store. If retained identities approach that bound,
stop the affected workers, take a consistent private SQLite backup and reclaim free pages
with an offline checkpoint/VACUUM before restarting. If live identities still require more
space, increase the corresponding reviewed source page/byte bound and rebuild, preserving
the database. Do not replace the database or delete unknown deliveries, event identities,
native intents or tombstones merely to regain capacity. This maintenance is separate from
routine upgrades and has not been executed as part of feature setup.


`INPUT_INTERACTIVE_THREAD_ID` selects the sole interactive Telegram conversation
(default `af0e5160-07d2-46c9-b60b-a329d6951d83`). Update this explicit binding if the
Telegram webhook is intentionally moved to another T3 thread. The external descriptor
need not expose a current thread. Other-chat notifications use generic MCPX send/edit
and original-key delivery reconciliation, without questionnaire suffixes or buttons.

Reply directly to a displayed question; How to type my answer? is optional and last.
Review has no implicit reply target. Invalid/media replies show a bounded notice on
that same card. After accepted Submit or an exact matching native resolved request,
owner reply messages and the card are cleaned up. Cancelled, expired, archived or
changed questions alone do not authorize deleting unsubmitted text.

Preserve `telegram-input-replies.sqlite3` alongside both existing supervisor databases.
It stores only request/message identities, readiness proof and deletion state, with
private permissions and finite capacity. Unknown deletions retain their original key
and are never replayed. Confirmed missing messages are already absent; impossible or
expired deletions increment `inputReplyCleanupExpired`, without permanently masking
worker health. Telegram's deletion deadline still limits cleanup after long downtime.
