# UI baseline fixture (test only)

A localhost test fixture for recording the mounted UI stories UI-STORY-01..08
(`docs/effect-v4-migration.md`, section 7). It serves the **real compiled baseline UI**
unchanged and answers its API calls with **synthetic API data**. Label every recording
made against it `fixture`; recordings against a real deployment are labelled `native`.

It is test infrastructure: it is not a service and not a proxy. It never forwards a
request, never opens a non-loopback connection, binds `127.0.0.1` only, and keeps every
session, setting and mutation in memory. It writes no files. Every response carries
`x-supervisor-fixture: <scenario>`.

## Assets

Build the current checkout with its lockfile dependencies and pass that `ui-dist/`
directory to the fixture. The fixture serves those files unchanged and prints their
SHA256 hashes at startup. Compare that manifest with the revision being reviewed;
do not reuse hashes from a previous UI build.

```sh
pnpm install --frozen-lockfile && pnpm build
```

Compare the files on disk. The baseline server adds a per-response script nonce to
`index.html`, so a served native `index.html` never matches its file hash. The fixture
serves the files as they are, so its CSP allows `script-src 'self'` instead of the nonce.

## Start and stop

```sh
pnpm exec tsx test/ui-fixture/run.ts --assets ui-dist [--port N] [--scenario <name>]
```

The default port is an ephemeral port, printed as `url:`. Open exactly
`http://127.0.0.1:<port>/`. Like the baseline, any other Host (for example `localhost`)
gets 403. Stop with Ctrl-C or SIGTERM. Open connections are closed, held requests are
dropped, the in-memory log is released, and the process exits with 0.

Sign in with the token **`fixture-token`**. It is reusable; real tokens are single-use.
`POST /__fixture/grant` returns a single-use token (`fixture-grant-…`) if you want the
baseline single-use behaviour. The session is a random 43-character value kept in memory.

## Synthetic data

| Item | Purpose |
| --- | --- |
| `fixture-project-a` "Fixture project A" | supervised and enabled, `.t3-supervisor` present, editable `project.yaml` (1 workflow, 2 steps, unindexed `steps/fixture-unindexed.md`), model/monitoring/team settings |
| `fixture-thread-a1` "Fixture chat A1 (supervised)" | ready binding, inferred task, Stop/Enable supervision |
| `fixture-thread-a2` "Fixture chat A2 (access rejected)" | rejected binding: attention item and "Retry native access" |
| `fixture-thread-a3` "Fixture chat A3 (stopped)" | excluded chat with a stop record (StopNotice in Supervision; its Home row opens Supervision) |
| `fixture-project-b` "Fixture project B (setup)", `fixture-thread-b1` | disabled, folder missing: Enable gives `setup_required` and two checkouts (`/fixture/project-b` on `main`, Git; `/fixture/project-b-worktree`, not Git) |
| `fixture-no-project` "Fixture No Project", `fixture-thread-n1`, `fixture-thread-n2` | No Project mode `on_request`; Start candidates on Home |

Global supervision is on and global definitions are off. The baseline has an empty
`ok` workflow page. The `journey-*` scenarios replace chat A1's task with a synthetic
reconstructed packing example (a GTIN scan selects an article; quantity-label scans add pieces) using the
production proposal, agreement and progress schemas; Home, Conversations and the Task view show the same title,
objective and status for it.
They cover request, proposal, acceptance, work, attention, a revised proposal awaiting acceptance,
the accepted refinement, verification, parallel review, completion, stale acceptance and an unlinked
earlier workflow, with more than eight steps. Synthetic text starts with "Fixture", "Fixture:" or
"Reconstructed example:". These scenes record no actual work or native messages.

### Environments

The fixture answers for one of two synthetic T3 environments. Each keeps its own in-memory
state, and the project ids are the same in both. The snapshot's `environmentId` names the
current one.

| Name | `environmentId` | Start candidates (No Project chats) | Explicit exclusion | `fixture-project-a` definitions |
| --- | --- | --- | --- | --- |
| `a` (default) | `fixture-environment` | `fixture-thread-n1`, `fixture-thread-n2` | `fixture-thread-a3` | `/fixture/project-a`: 1 workflow, 2 steps (as above) |
| `b` | `fixture-environment-b` | `fixture-thread-bn1` "Fixture B No Project chat 1", `fixture-thread-bn2` | `fixture-thread-a1` | `/fixture-b/project-a`: no workflow, 1 step "Fixture B step: run the environment b tests." (another revision) |

Switching changes only which data set answers. It calls nothing native and changes no
session.

## Controls (`/__fixture/`)

Controls go through the same Host/Origin check. Call them with curl, or from the page with
`fetch("/__fixture/…", {method: "POST"})`.

| Control | Effect |
| --- | --- |
| `POST /__fixture/reset` | restores the data set, scenario `baseline`, no arms, no sessions; drops held requests; clears the log (keeps the reset entry) |
| `POST /__fixture/scenario/<name>[?path=&apply=1&ms=]` | sets the label and arms the scenario; earlier arms are replaced; data and held requests stay |
| `GET /__fixture/state` | scenario, armed effects, session count, held requests, scenario catalogue |
| `GET /__fixture/log[?since=<seq>]` | request log (below) |
| `POST /__fixture/held/answer[?seq=]`, `POST /__fixture/held/drop[?seq=]` | answer (run the handler now, or send the stored result with `apply=1`) or destroy held connections |
| `POST /__fixture/grant` | single-use sign-in token |
| `POST /__fixture/environment/<a\|b>` | answers for that synthetic T3 environment from the next request on; each keeps its data; reset returns to `a` |

## Scenarios

"Mutation" means a `POST /api/guidance/*` that passed the session, CSRF, content-type and
body checks. `?path=` restricts an arm to one exact pathname, for example
`/api/guidance/project-configuration`, `/api/guidance/project-supervisor`,
`…/project-supervisor/retry`, `…/project-supervisor/chat-supervision`,
`/api/guidance/supervision-control`, `/api/guidance/supervision-setup`,
`/api/guidance/supervision-start`, `/api/guidance/no-project-control`,
`/api/guidance/global-definitions-control` or `/api/guidance/thread-policy`. An arm fires
once, except `slow-reads`.

| Name | Behaviour |
| --- | --- |
| `baseline` | normal synthetic behaviour |
| `session-expiry-next-call` | the next `/api/*` call with a valid session revokes that session and gets 401 "Sign in to Supervisor." (on the next explicit read or SSE connection) |
| `signout-other-tab` | revokes every session now, which is the server side of a sign-out in another tab |
| `mutation-never-answered` | the next mutation is received and held unanswered; `apply=1` applies it first |
| `mutation-dropped` | the next mutation is received and its connection destroyed with no response; `apply=1` applies it first |
| `save-401` | the next mutation gets 401 and its session is revoked, as only an invalid session gives 401 at baseline; not applied |
| `save-403` | the next mutation gets the baseline CSRF 403; the session stays valid; not applied |
| `save-409` | the next mutation gets HTTP 409. The baseline server never sends 409 (conflicts are 200 with `status: "conflict"`), so this exercises the generic non-OK branch; not applied |
| `save-413` | the next mutation gets the baseline 413 message; not applied |
| `editor-conflict` | the next project-configuration save (or `?path=`) gets a schema-valid `conflict` result; not applied |
| `editor-uncertain` | as above with `uncertain` (`unavailable` where an endpoint has no `uncertain`; thread-policy answers 400); `apply=1` applies it first |
| `slow-reads` | every `GET /api/guidance/*` waits `ms` (default 2000, at most 30000) until the scenario changes |
| `setup-race` | the next setup POST (or `?path=`) is applied at receipt and answered after `ms` (default 5000) |
| `reload` | label only (baseline behaviour) for recording reloads; state persists across reloads |

## Request log

`GET /__fixture/log` returns `entries` in receipt order, up to 2000 (older ones are
counted in `evicted`). Each entry has `seq`, `at` and `completedAt` (monotonic ms since
start), `method`, `path` (with query), `kind` (`api|auth|fixture|static`), `mutation`,
`scenario`, `environment` (the `environmentId` that answered), `bodySha256`, `bodyBytes`, `effect` (for example `held`, `dropped`,
`status-401`, `outcome-conflict`, `session-expired`, `delayed-2000ms`), `result`
(`answered|held|dropped|interrupted|pending`) and `status`. Raw bodies, tokens, sessions
and CSRF values are never logged. GETs of `/__fixture/log` and `/__fixture/state` are not
logged.

- `mutations` groups mutation entries by method, path and `bodySha256`. A Start's
  `operationId` and a Save's draft are in the body, so a replay shows as `count` 2 or a
  second entry with the same hash. **Received once, never replayed** means one entry for
  that path and hash, and no later entry for it after reload or re-sign-in (check with
  `?since=<seq>`). A Save the user clicks again with the same draft also has the same hash;
  record it as an explicit action.
- `polls` is the historical log field name for authenticated GETs, with `count` and the last ten `intervalsMs`. It does not imply periodic polling. The current UI uses one authenticated SSE stream per visible registry, and typed reads refresh on hints or an explicit action. The synthetic listener sends the initial reset and holds the stream; it does not model the production commit bus or revocation watcher. Real stream commit/revocation proof belongs to the listener tests, not this fixture.

## Plain DOM snippets (preview evaluate)

```js
// scenario control from the page
await fetch("/__fixture/scenario/save-401?path=/api/guidance/project-configuration", {method: "POST"}).then(r => r.json())
// log summary
await fetch("/__fixture/log").then(r => r.json()).then(l => ({mutations: l.mutations, polls: l.polls, last: l.entries.slice(-10)}))
// route, title, session presence, retained Start fence
({hash: location.hash, title: document.title, session: Boolean(localStorage.getItem("supervisor-session")), start: sessionStorage.getItem("supervisor-pending-start")})
// visible status and alert text
[...document.querySelectorAll('[role="status"],[role="alert"]')].filter(e => !e.closest("[hidden]") && e.textContent.trim()).map(e => e.textContent.trim())
// draft values of the editor or settings form
[...document.querySelectorAll("textarea, input, select")].filter(e => !e.closest("[hidden]")).map(e => [e.id || e.name, e.type === "checkbox" ? e.checked : e.value])
// listener and interval counters (install after load, navigate, then read window.__fixtureCounts)
(() => {const c = window.__fixtureCounts = {listeners: {}, intervals: 0}; const add = window.addEventListener, remove = window.removeEventListener, set = window.setInterval, clear = window.clearInterval; const live = new Set();
  window.addEventListener = function (t, ...a) {c.listeners[t] = (c.listeners[t] || 0) + 1; return add.call(this, t, ...a);};
  window.removeEventListener = function (t, ...a) {c.listeners[t] = (c.listeners[t] || 0) - 1; return remove.call(this, t, ...a);};
  window.setInterval = function (...a) {const id = set.apply(this, a); live.add(id); c.intervals = live.size; return id;};
  window.clearInterval = function (id) {live.delete(id); c.intervals = live.size; return clear.call(this, id);}; return "installed";})()
// focus and reflow
(() => {const e = document.activeElement, s = getComputedStyle(e); return {tag: e.tagName, label: (e.getAttribute("aria-label") || e.textContent || "").trim().slice(0, 60), outline: `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor}`, shadow: s.boxShadow, reflowOk: document.documentElement.scrollWidth <= innerWidth};})()
```

```js
// switch the synthetic T3 environment (a or b); the page sees it at its next snapshot read (within 5 s)
await fetch("/__fixture/environment/b", {method: "POST"}).then(r => r.json())
// which environment the fixture answers for
await fetch("/__fixture/state").then(r => r.json()).then(s => s.environment)
```

`confirm()` dialogs (Save, Discard, Refresh) need the preview dialog tool. Record the
dialog text and which button you chose.

## Stories

Start each story with `POST /__fixture/reset`, reload `http://127.0.0.1:<port>/`, sign in
with `fixture-token`, and record the log `seq` reached. For each story record what the UI
actually does per panel: whether navigation was blocked by a confirm guard, whether you
discarded a draft explicitly, whether the draft was still present, and the visible
messages. Never assume a draft survived; read it back with the draft snippet. The quoted
texts below are from the source; where the outcome depends on runtime behaviour, observe
and record it.

**UI-STORY-01 — configuration editor drafts, 401, conflict, uncertain.**
1. Projects, then "Fixture project A", then "Definitions", then "Inspect project root
   checkout" (`#/projects/fixture-project-a/definitions?main=`), then "Edit project
   configuration". Change step 1's summary, tick a Required box, click "Index
   steps/fixture-unindexed.md" and give the new row a summary (an empty summary fails
   client validation before any POST).
2. Navigate to the section "Project settings" and back, Home and back, the Projects
   directory and "Fixture project A" again, project "Fixture project B (setup)", and a chat
   (Conversation select, "Fixture chat A1"). For each, record whether a confirm appeared
   ("Discard unsaved project-configuration changes and reload definitions?" or "Discard
   unsaved project configuration and Supervisor settings?"), your choice, the URL and the
   draft values.
3. Session expiry: `POST /__fixture/scenario/session-expiry-next-call`. Within about 5 s
   the sign-in form should appear ("Sign in again", "Your open draft is kept in this tab").
   Sign in and read the draft back.
4. Save after 401: `scenario/save-401?path=/api/guidance/project-configuration`, then
   "Save project configuration" and accept the confirm. A 401 for a sent session does not
   exclude a first attempt the browser resent after it applied, so record the unknown message
   (source: "The save outcome could not be confirmed. Refresh and inspect project.yaml before
   retrying."), the sign-in form, the draft after re-sign-in, and that Save stays blocked until
   a refresh. Repeat with `save-403`: the session stays valid and the fixture still issues the
   token that was sent, so the refusal is definite (source: "Session refreshed. Your draft was
   not saved…") and Save stays enabled.
5. Conflict: `scenario/editor-conflict`, then Save. Record the message, whether Save is
   disabled, and "Your draft is kept. Refresh project definitions…". Then "Refresh
   definitions" and record the discard confirm. Repeat with `editor-uncertain` and
   `editor-uncertain?apply=1`.
6. Log proof: each Save POST to `/api/guidance/project-configuration` appears once, with
   effect `status-401`, `status-403`, `outcome-conflict` or `outcome-uncertain…`, and no
   POST follows the re-sign-in until you click Save.

**UI-STORY-02 — project panel drafts (model, monitoring, team).**
1. "Fixture project A", then "Project settings". Change Model to "Fixture quick model",
   Reasoning, "Maximum pending activity age", "Finalized activities per operative chat" and
   "Maximum helpers per root".
2. Navigate as in 01 step 2, plus a chat's Task/Supervision views (the settings draft
   is per project). Record guards, discards and draft values.
3. `scenario/session-expiry-next-call`, then re-sign-in. Read the draft back.
4. `scenario/save-401?path=/api/guidance/project-supervisor`, then "Save Supervisor
   settings". Record the message (source: "Your Supervisor change was not performed…") and
   the draft. Then save again explicitly with `baseline`.
5. Retry: open "Fixture chat A2 (access rejected)", then "Supervision". Record the
   "Retry native access" state with and without a dirty draft (source: "Save or discard
   your settings draft before retrying native access."). Click it once.
6. Log proof: one POST per click to `/api/guidance/project-supervisor` or `…/retry`, and
   none after re-sign-in without a click.

**UI-STORY-03 — session expiry during a pending Save or Start.**
1. Save: `scenario/mutation-never-answered?path=/api/guidance/project-supervisor`, edit a
   setting, then Save ("Saving…"). Then `scenario/signout-other-tab` and wait for the
   sign-in form. Then `POST /__fixture/held/drop`. Sign in. Record the message (source:
   "The save outcome could not be confirmed…"), whether Save is blocked, and the draft.
   Variant: answer instead of drop (`held/answer`) after re-sign-in and record the result.
2. Start: on Home open "Start supervision for a No Project chat". Run
   `scenario/mutation-never-answered?path=/api/guidance/supervision-start`, then "Start
   supervision" for "Fixture No Project chat 1". Then `signout-other-tab`, `held/drop`,
   sign in. Record "Retained Start for fixture-thread-n1" and the fence snippet
   (`supervisor-pending-start`). Click "Check Start status". Not applied means `denied`
   ("No matching Start operation is recorded. Nothing was replayed."), which source says
   keeps the fence. Repeat with `&apply=1`, where `active` should clear it.
3. Log proof: one POST `/api/guidance/supervision-start` with result `dropped`. After
   re-sign-in, only `GET /api/guidance/supervision-start?threadId=…&operationId=…` appears,
   with the same `operationId`.

**UI-STORY-04 — Back/Forward and manual hash edits with a dirty draft** (also runnable
read-only on native, without saving).
1. Make an editor draft (01 step 1), then visit Project settings, Home, Projects directory,
   and back to Definitions.
2. Browser Back and Forward several times (preview navigation, or `history.back()` and
   `history.forward()`). Then set `location.hash` by hand to
   `#/projects/fixture-project-b/progress`, `#/projects/fixture-project-a/progress?main=fixture-thread-a1`,
   `#/settings` and an invalid `#/nowhere`.
3. For each step record the confirm (if any) and choice, `location.hash` after any
   restore, the visible page and the draft values. `beforeunload` should prompt on reload
   while dirty: record it.

**UI-STORY-05 — two tabs.**
1. Open two tabs at the fixture URL; both share the session in `localStorage`. Make a
   settings draft in tab 2 only.
2. In tab 1 click "Sign out" (disabled while tab 1 has a draft). Record tab 2 (storage
   event: sign-in form expected), the server state (`GET /__fixture/state` sessions) and the
   log (`POST /auth/logout` once).
3. Sign in in tab 1. Record tab 2 (signed in again or not) and whether tab 2's earlier
   draft is still present. Record exactly what you see; the source does not establish that
   no draft crosses sessions.
4. Optional: `signout-other-tab` (server-only revocation, no storage event) and record each
   tab's next authenticated read. The fixture does not model the production access-file revocation watcher.

**UI-STORY-06 — visible stream ownership, no periodic reads.**
1. Start the current built fixture, sign in, inspect `/__fixture/log`, and navigate Home, Projects, Task, Supervision, Connected work, Definitions, Settings and Activity.
2. Leave a visible page idle. There should be one held `/api/events` connection and no scheduled snapshot/overview/chat/progress reads. Hiding the tab interrupts the stream; returning reconnects and reconciles mounted reads once. Navigation and background reconciliation preserve focus, draft values and admitted operation identities.
3. Listener tests exercise real commit, rollback, coalescing, expiry and active revocation. This synthetic fixture supplies only reset/lifetime behavior and records request traffic; it is not that native proof.

**UI-STORY-07 — concurrent setup and reload; cut Start; Stop/Enable.**
1. Setup: "Fixture project B (setup)", then "Project settings", then "Enable supervision"
   (expected: "First-time setup"). Run `scenario/setup-race?ms=8000`. Choose
   `/fixture/project-b — main`, click "Create", then reload the page within 8 s. Record the
   panel after reload (setup state is applied server-side; the source holds the setup fence
   in memory only).
2. Concurrent setup: reset, open two tabs on project B setup, choose the same checkout in
   both, `setup-race?ms=5000`, click Create in tab 1 and then tab 2. Record both messages
   (the second should be a conflict) and the log (two distinct POSTs, one each).
3. Cut Start: `scenario/mutation-dropped?path=/api/guidance/supervision-start`, then Start
   "Fixture No Project chat 1" (source: "Start outcome is unknown… no new Start will be
   sent."). Reload. Record the retained fence and "Check Start status" (`denied` keeps it).
   Repeat with `&apply=1` (`active` clears it). The log has one dropped POST and no POST
   after the reload.
4. Stop/Enable: "Fixture chat A1", then "Supervision", then "Stop supervision", then
   "Enable supervision". Open "Fixture chat A3 (stopped)" and use the StopNotice "Enable
   supervision" (Home's row for that chat opens the same Supervision view). On Settings,
   "Global supervision" Disable and Enable. Optionally arm `mutation-dropped` or
   `editor-uncertain` with `?path=/api/guidance/project-supervisor/chat-supervision` and
   record "The change could not be confirmed. The saved state is shown."

**UI-STORY-08 — keyboard and focus, zoom, reflow** (also runnable read-only on native).
On Home, Projects, a project's Definitions and Project settings, a chat's Task and Supervision views,
Settings and the sign-in form, tab through all controls with the keyboard. Record the focus
order, the focus snippet (visible outline or shadow) and the skip link ("Skip to content").
Repeat at 200 % and 400 % zoom (browser zoom; if unavailable, 640 px and 320 px viewports
at 1280 px equivalence) and at a 320 px wide viewport. Record `reflowOk` and screenshots.

**Environment switch (A-R18-03, mounted).** Start each check with `POST /__fixture/reset`,
reload and sign in; the fixture answers for `a`. Switch with `POST /__fixture/environment/b`
and refresh the current view or reconnect/reload to reconcile its snapshot (read back `environmentId` from the log or the state
control). For each panel record what is shown and enabled before and after the switch, and
again after switching back to `a`:
1. Home, "Start supervision for a No Project chat": a shows the two "Fixture No Project chat"
   rows; after the switch no a row may stay actionable while b's search is unread or failed
   (combine with `scenario/slow-reads` to see the unread state); b shows the "Fixture B" rows.
2. Settings, "Chat settings": in a, remove the exclusion of "Fixture chat A3" without saving
   (a draft). After the switch the form shows b's saved exclusion ("Fixture chat A1") and no
   a draft; back in a, the a draft is present. Variant: start the a save with
   `scenario/mutation-never-answered?path=/api/guidance/thread-policy`, switch to b,
   `held/answer`, and record that b shows no a outcome while a does.
3. Projects, "Fixture project A", "Definitions", "Project folder", "Edit index", then "Edit
   project configuration": change step 1's summary (a dirty a draft), then switch. Record
   that b shows its own definitions (`/fixture-b/project-a`, one step) and no a draft, that
   no Save of a can reach b, and that back in a the a draft is present. Variant: start the a
   save with `scenario/mutation-never-answered?path=/api/guidance/project-configuration`,
   switch, `held/answer`, and record where its outcome message appears.
4. Log proof: entries carry `environment`; no mutation entry of a's draft is answered by
   `fixture-environment-b`.

## Known gaps and differences from the baseline server

- Static files are byte-identical, with no nonce injection. The CSP therefore uses
  `script-src 'self'` instead of the nonce and `'strict-dynamic'`. Paths, content types,
  cache headers and "no SPA fallback" (only `/` maps to `index.html`) mirror
  `src/guidance-ui.ts`.
- Sign-in uses the reusable `fixture-token` (and optional single-use grants), not real
  forged tokens.
- Bodies are bounded at 64 000 bytes (API) and 2048 bytes (login). A chunked body without
  `Content-Length` over the limit closes the connection instead of answering 413. Browsers
  send `Content-Length`.
- The synthetic semantics (generations, conflicts, setup, Start) are plausible stand-ins,
  not the real supervisor's logic. Only the schemas, the auth/CSRF/Host/Origin gate and the
  static handling follow the baseline. HTTP 409 does not occur at baseline.
- The UI's behaviour in each story is to be observed and recorded. This fixture does not
  assert it.

`journey-nested-attention` retains a planned parent while revealing its attention-needing child, without changing the parent assessment.

## Bounded Operate UI fixture

Run `pnpm exec tsx test/ui-fixture/run.ts --assets ui-dist --port 18127 --scenario large-interface` after `pnpm build`. This is synthetic data: 149 project conversations, 48 catalog entries, a shared project folder, a separate working copy and a Git folder with no branch name reported. Search precedes paging; Home queries the complete available supervised collection at the typed server boundary. Activity pages the retained events.

For the long Task and Connected work views, POST `/__fixture/scenario/journey-nested-attention` and reload. With `large-interface` already initialized it includes a separately recorded child contribution. Other `journey-*` scenarios cover Following, catching up, paused discussion, proposal, agreement, refinement, completion and stale acceptance. These are rendered examples, not evidence of real operative execution.

Definitions first selects an actual folder. Catalog and per-definition detail show template sequence/parallel topology with no execution state; Edit index names the shared project.yaml target and pages compact editable entries ten at a time. Uncertain/conflict stories retain their original operation and draft fences.

`partial-inventory` renders the independently readable project folder while listing an unavailable conversation binding. Selecting a folder is explicit; the missing conversation is never assumed to use the root. The actual ProjectDefinitions regression separately verifies that browsing can be partial while setup target validation remains strict.

Regression: keep a non-matching Home search in the hash, then open Project A Conversations pages 1 and 2. Each page reads its own visible IDs; Home filters must not hide row state or project attention.
