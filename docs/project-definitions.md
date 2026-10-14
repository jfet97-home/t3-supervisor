# Project definitions

Supervisor can load declarative definitions from the working directory of a T3
project, using T3's native file API. It does not need repository mounts inside its
container, execute definitions, or grant itself permissions. A separately configured writer can save existing
project rule files through the same native API.

## Files

```text
.t3-supervisor/
  rules.yaml
  blocks/
    adversarial-review.md
```

`rules.yaml` contains a `rules` list. Each rule has exactly these three fields:

```yaml
rules:
  - name: Review implementation changes
    description: >
      Tasks that change application behavior require adversarial review.
      Documentation-only changes are exempt.
    required_blocks:
      - adversarial-review
```

Use `rules: []` to explicitly declare no requirements. Rule names are unique;
required block identifiers are nonempty and unique within a rule. Identifiers
use lowercase ASCII letters, digits, hyphens and underscores, at most 64 characters.

Blocks are direct Markdown files in `blocks/`. Their filename, without `.md`,
supplies the identifier. Frontmatter has exactly `name` and `description`.
Both second-level sections below must be nonempty; headings inside fenced code
examples do not become block sections.

```markdown
---
name: Adversarial review
description: Critically examine an implementation before completion.
---

# Adversarial review

## Instructions

Check correctness, error handling and edge cases.
Compare with analogous code in the base revision.
Inspect tests for weakened assertions or skips.

## Expected result

Findings with file references, resolutions and checks that could not be completed.
```

Unknown fields, duplicate YAML keys, custom tags, YAML aliases and unresolved
block references produce validation issues. Definitions are limited to 100 rules,
100 block directory entries, 64 KiB per file and 512 KiB of read content in total.
An incomplete native listing or truncated file cannot be accepted as ready.

## Read API

The dashboard's existing local API exposes:

```text
GET /api/guidance/project-definitions?projectId=<registered-project-id>
GET /api/guidance/project-definitions?projectId=<id>&threadId=<conversation-id>
```

Without a conversation, the loader uses the registered project's root. With one,
it reads the fresh T3 projection, validates project membership and uses that
conversation's worktree when present. Caller-supplied filesystem paths are not
accepted. Workspace and definition-directory metadata are checked before listing,
so missing folders do not depend on native serialized error details.

The result contains `projectId`, `threadId`, `workspaceRoot`, `revision`, `editingAvailable`, `rules`, `blocks` and
`issues`. Its status is one of:

- `ready`: the definitions are valid and all required block references resolve.
- `missing`: the `.t3-supervisor` directory does not exist.
- `invalid`: definition validation or completeness checks failed.
- `permission_required`: provision `filesystem:read` on the read credential.
- `unavailable`: the project, conversation, workspace or transport cannot be read.

Invalid results may contain valid individual definitions for inspection; consumers
must require `ready` before using the collection as a complete workflow input.
The request has a 30-second deadline and observes its Effect cancellation signal;
each native RPC is bounded to ten seconds.
File contents are returned on demand, not persisted to the guidance databases.
The existing Host/Origin and cross-site API protections also cover this endpoint.

## Permissions and current scope

Trusted deployment setup supplies a native T3 session with `orchestration:read`
and `filesystem:read` at `T3_TOKEN_FILE`. Guidance delivery keeps its separate
read/operate credential. A missing filesystem scope is reported as a setup action;
Supervisor does not issue or upgrade credentials.

T3's filesystem scope is environment-wide. Supervisor only submits relative
`.t3-supervisor` requests against the selected workspace, and rejects unexpected
block paths. T3 rejects reads resolving outside that workspace, but this is not
a guarantee against symlinks targeting other files within the same workspace.
These are working-tree reads, not immutable or authoritative policy attestations.

The dashboard's **Projects** section shows rules, reusable blocks and validation. Select a
project, then optionally a conversation to use its working directory. The
conversation selector includes only available chats belonging to that project.
Required-block buttons open the corresponding reusable block and focus its
summary; missing or invalid references remain clearly marked. Instructions and
expected results are displayed as text, never executed or interpreted as HTML.

Definitions load on selection and **Refresh definitions**, not on the dashboard's
ordinary background snapshot refresh. The load time and actual source directory
are displayed. Refresh after editing files or changing a conversation's workspace.
Switching selection or leaving the section cancels its request; stale responses
cannot replace the new selection's contents.
If a selected conversation becomes unavailable, its contents are hidden and a new
working directory must be selected; the page does not silently fall back to the
project root. Invalid collections never imply that unreadable rules or their
block references are absent.

## Editing project rules

Choose **Edit project rules** to add, rename, change or remove rules. Select required
blocks from the valid Markdown blocks already in this working directory. Saving
an empty collection explicitly writes `rules: []`. Block authoring remains a
repository operation in this step.

The UI writes the same `.t3-supervisor/rules.yaml` that manual repository edits use;
there is no second database of active rules. YAML Document nodes preserve comments
on retained rules/fields where possible; whitespace and YAML formatting may change.
The output is reparsed to verify the intended normalized rules.

The owner confirms the exact working-tree target before each save, including when
it belongs to an active conversation. Drafts survive section navigation and
connection failures. Changing selection, refreshing or cancelling a dirty editor
requires confirmation. Conflicts and uncertain writes keep the draft and block
another save until explicit reload; there are no automatic write retries. A rejected
CSRF session or request-format/size guard means definitely not saved. Session
refresh keeps the draft editable and requires a new explicit Save, rather than
automatically repeating the write. Access is also refreshed after reconnection.

`POST /api/guidance/project-rules` accepts `projectId`, nullable `threadId`,
`expectedRevision` and the complete `rules` list. Host/Origin and CSRF checks apply.
Its result distinguishes saved, conflict, invalid, permission_required, unavailable
and uncertain. The endpoint caps JSON payloads at 256 KiB (413 when exceeded);
the serialized YAML remains limited to 64 KiB.

The revision hashes normalized workspace and conversation binding, raw file reads,
byte lengths and sorted listings/truncation flags. The server rechecks it against
fresh definitions, validates required blocks, serializes saves per workspace and
rechecks the conversation binding immediately before writing. It verifies identical
written text/bytes, regular-file listings and a fresh definition readback.

T3's native writer is a non-atomic truncate/write without compare-and-swap and can
follow symlinks. Consequently this editor only writes an **existing regular
rules.yaml in an existing regular .t3-supervisor directory**, checked through native
listings immediately before and after writing. Missing, malformed or incompletely
read files/blocks must be prepared or repaired in the repository first; the UI never
creates missing paths. A complete collection with missing block references can be
repaired by removing those references or selecting valid existing blocks.

An external filesystem change between native preflight and write is not prevented;
concurrent external editors and deliberate symlink swaps are outside this V1 write
contract. A reader can observe partial contents during the native write. Readback
failure means unknown saved state, not success or a safe retry.

Trusted setup supplies a separate private native session with `filesystem:read`
and `filesystem:write` at `T3_PROJECT_WRITE_TOKEN_FILE` (default mounted file:
`/run/secrets/t3-project-write-token`). The permission covers the T3 environment;
Supervisor restricts its writer to the fixed rules-file path. The service does not
issue credentials or upgrade the read/operate sessions. Missing writer setup
leaves project inspection available and reports editing unavailable.

## Legacy reminder retirement

The separate Guidance rules editor and automatic condition/message evaluations
are retired. Production no longer calls their execution cycle or preview model;
stale clients cannot modify legacy rules/settings, preview, mute, classify or reset
old episodes. SQLite history and uncertain notices are retained, without automatic
reconciliation or retry. The remaining connection poll performs no model calls.

New task interpretation now supplies complete valid definitions to the project
Supervisor to propose ordered workflows and assess rule applicability. Proposals
compose existing blocks and include required blocks for applicable rules. See
[project supervision](project-supervision.md) for validation and availability.
Block authoring/review, agent dialogue and workflow execution monitoring remain later steps.
