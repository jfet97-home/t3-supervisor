# Project definitions

Supervisor can load declarative definitions from the working directory of a T3
project, using T3's native file API. It does not need repository mounts inside its
container, execute definitions, or grant itself permissions.

## Files

```text
.supervisor/
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

The result contains `projectId`, `threadId`, `workspaceRoot`, `rules`, `blocks` and
`issues`. Its status is one of:

- `ready`: the definitions are valid and all required block references resolve.
- `missing`: the `.supervisor` directory does not exist.
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
`.supervisor` requests against the selected workspace, and rejects unexpected
block paths. T3 rejects reads resolving outside that workspace, but this is not
a guarantee against symlinks targeting other files within the same workspace.
These are working-tree reads, not immutable or authoritative policy attestations.

This step supplies the loader and read API. It does not import these definitions
into the existing condition/message reminder rules or interpret applicability.
Project browsing in the dashboard, block creation/review and workflow negotiation
are separate subsequent work.
