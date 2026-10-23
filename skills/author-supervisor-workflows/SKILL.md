---
name: author-supervisor-workflows
description: Create or refine T3 Supervisor step and workflow catalogs from project instructions, development history and human corrections. Use for authoring .t3-supervisor definitions and their rationale, not implementing application workflows or enabling supervision.
---

# Author Supervisor workflows

Turn important recurring duties into a catalog humans can read and maintain. Use the
current product Guide or definition docs as the syntax authority; [definition
patterns](references/definition-patterns.md) explains the file format and review
pattern. Dashboard work belongs to [use-t3-supervisor](../use-t3-supervisor/SKILL.md).

## Target project boundary

Write only the needed `project.yaml`, `steps/*.md` and `workflows/*.yaml` inside the
target project's `.t3-supervisor/` folder by default. Keep execution rules in their
descriptions and explain rationale in the response. Additional documentation needs
an explicit request or approval.

Investigate existing instructions, skills and routers to identify a suitable place for
a useful tactical reference. When one would help, propose the concrete link or edit in
AGENTS.md, CLAUDE.md or the most appropriate existing file, and ask the user whether to
apply it. Explain its purpose and effects on other users when Supervisor is absent or
disabled. Reading or referencing a file does not authorize changing it.

Apply outside-folder changes only after the user explicitly approves those specific
edits, including shared skills, routers, documentation and hooks. Authoring, commit/push,
catalog adoption or enabling Supervisor does not itself approve them. Conditional
wording is not a substitute for permission.

## Definition index

`project.yaml` indexes reusable definitions. It is not a whitelist of task plans.
Its only keys are `workflows`, `steps` (both lists, `[]` allowed) and optional
`default_workflow`. A new folder starts with `workflows: []`, then `steps: []`,
plus `steps/.gitkeep` and `workflows/.gitkeep`. Add, rename or remove a reusable
file and its index entry in the same edit. Every entry has exactly `path` and
`summary`, plus an optional `required` (`true` or `false`, default `false`).
`path` is `workflows/<id>.yaml` or `steps/<id>.md`; its file name is the ID
(lowercase letters, digits, `-` or `_`, at most 64 characters). Each path
appears once. At most 100 entries. The parser
requires a summary to be nonempty, at most two nonempty lines, and at most 240
characters. When writing one, say what the definition is for and when it
applies; a descriptive name can be enough. The file description stays the
policy. `required: true` is the only authored inclusion flag. `default_workflow`,
when present, names a workflow id in that index and is only a starting
suggestion. Do not add a top-level `required:` list. Keep every existing entry's
flag, summary and path unless the change is intentional. An unlisted file is
`definition_unlisted` and is not read. A missing indexed file is
`catalog_entry_missing`; the row and its flag stay, and a required one stays
unresolved. Either issue makes the collection invalid. Read `project.yaml`
first, then the full definitions that apply. Negotiated plans may add local
steps that are not index entries. Do not automatically edit files outside
`.t3-supervisor`.

## Scope and evidence

Establish the checkout, existing catalog, requested outcomes, count limits and proposal
and adoption boundary. Count definitions separately from reused occurrences. A maximum
is a ceiling, not a target; neither fewer definitions nor filling every slot is a goal.
Do not hide extra responsibilities in inline steps to evade limits.

Read versioned project instructions and matched skills. Research project and
orchestration and tooling histories, including human conversations across authorized local,
remote and CLI sources. Record coverage gaps. Search snippets identify leads; read their
context and later corrections. Current artifacts and later explicit instructions
supersede historical commands.

Keep a private ledger: source anchor, requested behavior, criticism or failure,
correction, current authority and implied duty. Separate human decisions from generated
summaries, scheduler prompts and mirrors; repetition is not independent evidence. Do not
publish raw private histories.

Study incomplete reviews, dismissed preservation regressions, missed shared consumers,
proof of the wrong claim, data and rollout assumptions and premature completion.
Identify why the process failed; retain consequential duties supported by current
sources, rather than one permanent step per incident.

## Compare interpretations

Recommend at least two genuinely different models using high or stronger reasoning for
substantial research and catalog design. Discover supported settings and verify actual
models/options; aliases or a prompt to think hard are insufficient. This authoring
recommendation does not impose the same execution policy on every generated workflow.
Respect the project's policy and the user's budget, delegation and review limits.

When collaboration is authorized, assign independent passes a common goal and
complementary evidence. Compare concise source-backed duties, omissions and proposed
boundaries, exchange objections and agree on one proposal. Agreement or a majority is
not evidence. Reuse conversations within the main's cycle through supported, authorized
APIs: retain ordinary reviewer chats for later rounds of the same work; delegated
backing threads are not resumable ordinary conversations. Send the delta and prior
findings/responses instead of restarting discovery. If the user prohibits another
review, honor that and report the verification limit; do not claim another model confirmed unreviewed changes.

## Choose responsibilities and structure

Map each important duty to its source, step and workflow intents. A step owns a coherent
responsibility or outcome; a workflow composes work for an intent with a distinct
result, ordering or authority. Do not define either per tool call, model, turn or review
round.

Reuse steps and named workflows. Split responsibilities when applicability, evidence or
independently controlled decisions differ. Explain dependencies: later data constraints
revise the same design decision, not a competing record. Parallelize independent work
and order evidence and approval dependencies. Workflow references stay acyclic; parallel
groups do not launch agents.

For external assignments, allow the main to pass the workflow, selected steps or an
adapted plan, preserving applicable commitments and explicit roles.

Justify each definition and plausible merges and splits. Show lost coverage if the
budget is too small; leave spare capacity when appropriate. Keep counts, properties and
unresolved choices visible to the human maintainer.

## Write for humans

A description should show what the work is, when it applies, who does it and what
evidence or completion it requires. Use ordinary direct sentences and short parallel
lists. Remove repeated rationale, reminders and defensive boilerplate. Keep prohibitions
that prevent a known failure. Avoid cryptic compressed prose.

State a rule where its decision belongs. Keep essential conditions and exceptions
visible; put shared rules in the owning step or workflow description and refer to it. Do not duplicate a workflow's completion contract in every member, hide
important conditions behind vague links, or move the same wall of text unchanged
elsewhere.

When shortening, map every original obligation to retained wording or its actual
canonical source. Check actors, triggers, authority, named cases, evidence limits and
exceptions. Compare readability and word counts, without imposing a quota that would
discard relevant detail.

## Encode and deliver

Descriptions carry applicability, roles, inputs, evidence and completion. Link real
authoritative project files, especially maintained Markdown docs and skills. Read them:
references prove neither consultation nor access and grant no permission. Use
checkout-relative files and explicit local skill paths; name global skills through
the consuming agent's configured catalog. Keep decision-critical obligations in the
definition, and detailed procedures in the canonical referenced source. Missing or
ambiguous skills remain gaps; never guess personal paths or claim consultation. See
the product Guide for the reference contract.

Separate `required: true`, fixed structure and `default_workflow`. Account for
requirements once per main task, including nested reuse. Genuine inapplicability needs a
reason; unavailable resources are gaps. Do not invent schema fields or a second
required list.

Let an iterative workflow's description own repetition and completion; callers reference
it directly. A findings step owns the main's accounting, not a wrapper whose only
purpose is invoking Review. Distinguish reviewer assessment from author fixes. The
reference explains reporting versus acceptance and persistent review.

Check the ledger and concrete cases: factual answers, consequential changes, report-only
review, contested rebuttals, fixes, changed bases and interrupted chats. Use the current
definition reader or parser for fields, filenames and IDs, references, acyclic
expansion, counts and complete diagnostics. Separately check supporting files. Parser
success proves format and graph validity, not execution.

Deliver definitions, a compact intent and step map, rationale and material gaps. Follow
the requested Git procedure. Drafting, publication, policy adoption and Supervisor
activation remain separate; authoring does not authorize live changes, services or
Git-hook enforcement.
