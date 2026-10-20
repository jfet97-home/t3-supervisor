---
name: author-supervisor-workflows
description: Create or refine T3 Supervisor step and workflow catalogs from project instructions, development history and human corrections. Use for authoring .t3-supervisor definitions and their rationale, not implementing application workflows or enabling supervision.
---

# Author Supervisor workflows

Turn the project's important recurring obligations into a small, understandable
catalog. Keep humans able to inspect and change each responsibility, its
applicability, owner and completion evidence. Use the current product Guide or
definition documentation as the syntax authority; read
[definition patterns](references/definition-patterns.md) when writing the files.
For dashboard configuration and runtime controls, use
[use-t3-supervisor](../use-t3-supervisor/SKILL.md).

## Establish the authoring boundary

Identify the target checkout, existing catalog, requested outcomes, count limits
and whether the result is a proposal or an adopted policy. A maximum is a ceiling,
not a target. Count distinct step definitions separately from their reused
occurrences; do not hide extra responsibilities in inline steps to evade a budget.
Do not assume fewer definitions are necessarily better.

Read applicable project instructions, skills and maintained knowledge first.
Authoring or committing definitions does not authorize enabling supervision,
applying them to a live project, changing services or adding Git hooks. Keep
deterministic enforcement separate unless the request explicitly includes it.

## Recover the duties and their reasons

Investigate both the project's development history and the orchestration/tooling
history that shaped it, including their human conversations. Search across the
available local, remote and CLI histories within the authorized scope. Inventory
coverage and gaps; titles and search snippets are discovery aids, not conclusions.
Read the relevant conversation context and follow later corrections and decisions.
Current artifacts and explicit later instructions supersede historical commands.

Keep a private evidence ledger: source anchor, requested behavior, failure or
criticism, corrected rule, current authority, and the duty it implies. Distinguish
human instructions from generated summaries, scheduler prompts and mirrored text.
Do not count repetition as independent evidence or publish raw private histories.

Look particularly for incomplete reviews, dismissed findings, missed shared
consumers, evidence that proved the wrong claim, data/rollout assumptions, and
premature completion. Recover why the existing process failed, including cases
where the implementer dismissed a preservation regression as outside the feature.
Retain consequential duties supported by current sources; do not turn every past
incident into a new permanent step.

## Compare independent interpretations

Recommend at least two genuinely different models with high or stronger reasoning
for substantial history research and catalog design. Discover supported models
and settings and verify actual configuration; aliases or a prompt saying "think
hard" are insufficient. Respect the user's budget, delegation and review limits.
This recommendation does not itself require two-model execution in every workflow
the catalog will define; derive that policy from the project and user.

When collaboration is authorized, give independent passes complementary evidence
sets and the same goal. Have them return concise, source-backed duties, omissions
and proposed boundaries. Compare disagreements, exchange concrete objections and
converge on one proposal. Agreement or a majority never replaces evidence. For
iterative discussion, reuse the same model conversations within the main's cycle
through supported transports, respecting their creation and lifecycle rules.
Do not start another review when the user has ruled it out; state the resulting
verification limit rather than claiming another model confirmed later changes.

## Design responsibilities before choosing counts

Map each important duty to a proposed step, its workflow intents and source.
A step represents a coherent responsibility or outcome; a workflow composes steps
and other workflows for an intent with a distinct result, ordering or authority.
Neither should be defined per tool call, model, conversation turn or review round.

Reuse steps and named workflows. Split a combined responsibility when its parts
have different applicability, evidence or independently controlled decisions.
For example, design can be settled while a data/rollout decision remains open.
Explain their dependency and how a later constraint revises the same decision,
rather than creating competing sources of truth. Parallelize independent work;
keep evidence and approval dependencies ordered. Named workflow references must
remain acyclic, and parallel groups do not launch agents automatically.

Explain why each definition exists, which plausible merges or splits were rejected
and what coverage would be lost. If the budget is too small, show the tradeoff;
do not squeeze unrelated responsibilities together silently. If it is generous,
leave unused capacity. Keep proposed counts and unresolved choices visible to the
human who will maintain them.

## Write the semantic contracts

Put applicability, role ownership, required inputs, evidence and completion in
each description. Link the actual authoritative project files in `references`,
especially maintained Markdown instructions and skills; keep private history
anchors in the private ledger. Read supporting files: listing a path proves
neither access nor consultation and grants no permission.

Separate `required` inclusion from `fixed` structure and from a default template.
Account for requirements once per current main task, including nested reuse.
Genuine inapplicability needs a reason; missing resources or inconvenient review
are unresolved gaps. Do not invent unsupported applicability or iteration fields.

For an iterative process, let its workflow description own repetition and the
completion rule. Reference that workflow directly from callers. Add a findings
step only for the main's real accounting responsibility, not as a wrapper whose
sole purpose is invoking Review. Distinguish reviewer assessment from author fixes
and main accounting. The reference describes the review-specific safeguards.

## Check and deliver the catalog

Check coverage against the evidence ledger, ownership, ordering, applicability,
human control and the actual requested outcome. Use concrete scenarios: a factual
question, a consequential change, a reporting-only review, a rejected rebuttal,
a relevant fix, a changed base and an interrupted reviewer conversation.

Validate with the current product's definition reader or parser where available:
supported fields, filenames/IDs, all referenced definitions, acyclic expansion,
counts and complete diagnostics. Separately check that supporting paths exist and
are appropriate; the product does not verify their contents or existence. Report
parser success as format/graph evidence, not proof of actual workflow execution.

Deliver the definitions, a compact intent/step map, source-backed rationale for
the counts and properties, and material open decisions or coverage limits. Follow
the repository's requested commit/push procedure. Keep proposal publication,
policy adoption and Supervisor activation separate; do not activate by implication.
