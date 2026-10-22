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

The assets must be the compiled `ui/` of `3b8129a`. In this tree `ui/`, `src/`,
`vite.config.ts`, `package.json` and `package-lock.json` are unchanged from `3b8129a`,
so either build them here or copy the deployed `ui-dist/` from the native host:

```sh
npm ci && npm run build          # writes ui-dist/ (and dist/); neither is committed
```

The local build (Node 24.22.1, lockfile dependencies) produced these files. The fixture
prints the same list with sha256 at startup, so it can be compared with the deployed files:

```text
e2b26ff22b851bd982c06e57e852aac2571139edc948c623144e78d65fa4aaf5     50117  app-icon.png
5c81923629f6ca4e9988c0153b7f23cfab36bf48fb6140094349a258fd7272ee     22912  assets/index-CNGMgSGC.css
188e1b821e49ebf1633f8a0bfef51a70d2f16ddb43a41d9902091701eac36b35    618784  assets/index-D4cd0v1Y.js
c772744b0ed2f00528ed65c44eb44c257b476d40c940bd8da85836a698d476d5      5461  favicon.png
840636218bf63313562d548ccfe240d892d9e2a75b66f1b11194de4cce9c1161       498  index.html
a00960958af01d4675a4d255a94f3bfbe842098a6cdbf8b853377f4c8e688fa1   1130323  supervisor-icon.png
```

Compare the files on disk. The baseline server adds a per-response script nonce to
`index.html`, so a served native `index.html` never matches its file hash. The fixture
serves the files as they are, so its CSP allows `script-src 'self'` instead of the nonce.

## Start and stop

```sh
npx tsx test/ui-fixture/run.ts --assets ui-dist [--port N] [--scenario <name>]
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
| `fixture-thread-a3` "Fixture chat A3 (stopped)" | excluded chat with a stop record (StopNotice, Home "Stopped supervision") |
| `fixture-project-b` "Fixture project B (setup)", `fixture-thread-b1` | disabled, folder missing: Enable gives `setup_required` and two checkouts (`/fixture/project-b` on `main`, Git; `/fixture/project-b-worktree`, not Git) |
| `fixture-no-project` "Fixture No Project", `fixture-thread-n1`, `fixture-thread-n2` | No Project mode `on_request`; Start candidates on Home |

Global supervision is on and global definitions are off. Workflow progress is an empty
`ok` page. Synthetic text starts with "Fixture" or "Fixture:".

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
| `session-expiry-next-call` | the next `/api/*` call with a valid session revokes that session and gets 401 "Sign in to Supervisor." (in practice usually the 5 s snapshot poll) |
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
`scenario`, `bodySha256`, `bodyBytes`, `effect` (for example `held`, `dropped`,
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
- `polls` lists `GET /api/*` paths with `count` and the last ten `intervalsMs`. Use it for
  poll cadence. Cadences in source: snapshot 5 s, overview 30 s while visible, and with a
  chat selected, project-supervisor and workflow-progress 30 s while visible.

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
   "Save project configuration" and accept the confirm. Record the message (source: "Your
   draft was not saved. Session refresh failed; reconnect and save again."), the sign-in
   form, the draft after re-sign-in, and whether Save is enabled. Repeat with `save-403`
   (session stays valid; source: "Session refreshed. Your draft was not saved…").
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
2. Navigate as in 01 step 2, plus a chat's Overview/Supervision views (the settings draft
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
   tab's next poll.

**UI-STORY-06 — unmount, one poll per interval, no leaks** (also runnable read-only on
native).
1. Install the counter snippet, read `/__fixture/log` `polls`, then for 2 minutes
   navigate repeatedly between Home, Projects, a chat (Overview, Plan & agreement,
   Supervision), Definitions, Settings and Activity. End on Home.
2. Record `polls[].intervalsMs` (snapshot about 5000 ms with no doubled entries; the others
   about 30000 ms while visible) and `window.__fixtureCounts` (listener add/remove balance
   per type, live intervals). Hide the tab (switch tabs) for 60 s and record the cadence.
3. StrictMode: the baseline `ui/src/main.tsx` does not render `<StrictMode>`, and a
   development build (`npx vite build --mode development`, different hashes) does not
   enable it. A StrictMode check would need a source change, so this part is optional and
   cannot be recorded on the unchanged baseline.

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
   supervision", and Home's "Stopped supervision" "Review and enable". On Settings,
   "Global supervision" Disable and Enable. Optionally arm `mutation-dropped` or
   `editor-uncertain` with `?path=/api/guidance/project-supervisor/chat-supervision` and
   record "The change could not be confirmed. The saved state is shown."

**UI-STORY-08 — keyboard and focus, zoom, reflow** (also runnable read-only on native).
On Home, Projects, a project's Definitions and Project settings, a chat's three views,
Settings and the sign-in form, tab through all controls with the keyboard. Record the focus
order, the focus snippet (visible outline or shadow) and the skip link ("Skip to content").
Repeat at 200 % and 400 % zoom (browser zoom; if unavailable, 640 px and 320 px viewports
at 1280 px equivalence) and at a 320 px wide viewport. Record `reflowOk` and screenshots.

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
