# Definition patterns

This is an authoring aid. Check the current product Guide or
`docs/steps-and-workflows.md` when available; do not infer new fields from prose. These
examples illustrate composition, not a catalog every project must adopt.

## Files and references

The operative checkout contains `.t3-supervisor/project.yaml`, `steps/*.md` and
`workflows/*.yaml`. A reusable step's filename matches its lowercase hyphenated ID. Its
Markdown body is empty; put its full contract in YAML frontmatter:

```markdown
---
id: review-correctness
name: Correctness review
description: |
  An independent reviewer assesses the frozen artifact against its actual base
  and authoritative requirements, including affected shared consumers.
  Return concrete findings, reviewer-assigned severity, artifact and base identity,
  coverage limits and a verdict. Later rounds assess fixes and prior objections.
references:
  - AGENTS.md
---
```

Use checkout-relative file strings in `references`. Keep `skills` separate, with
plain strings such as `.claude/skills/project-review/SKILL.md` or
`effect-v4-development`. There is no scope or path/name wrapper. Global names come from the
consuming agent's configured catalog, including namespaces; do not invent host
paths or assume availability. Missing or ambiguous guidance stays an explicit gap.
The product Guide's References and skills section owns the full syntax, bounds and
lookup rules. References grant no access and prove neither reading nor execution.

A workflow has `name`, `description`, optional `references` and `skills` string lists and `fixed`, and one root
`sequence` or `parallel`. Its ID is its YAML filename. Members can be `step` references,
local step objects, named `workflow` references or nested groups. A workflow file has
no `steps`, `inline`, `instructions`, `outcome` or `iterative` field; `steps` is an
index key in `project.yaml` only. Steps have no structural children. Promote genuinely
shared responsibilities to reusable files, and define every referenced ID and its index
entry before claiming a valid catalog.

## Short descriptions with complete contracts

Keep the local work and its evidence in the step. Keep round coordination and completion
in the workflow that owns them. In the review example below, each lens reports its
checks and findings; the main accounts for them; Review decides when the whole process is
finished. Each member need not repeat that full explanation.

Preserve decision-critical conditions inline. Link a shared procedure for mechanics,
with an explicit instruction to read it. Compare every original obligation against its
retained wording or canonical home before declaring a shorter version complete.

## Workflow-owned iteration

When the project requires adversarial review, a useful shape is the following. Define
the three referenced steps separately, including the main-owned accounting contract; do
not hand the accounting step to independent reviewers.

```yaml
name: Review
description: |
  The main owns review coordination and findings accounting. Assign correctness
  and fit assessment to independent reviewers under the project's model policy;
  if that policy requires two models, each covers both lenses independently.
  Freeze one artifact and base per round and wait for all complete reports before
  edits or accounting. Pin every report and accounting record to that artifact.
  After relevant fixes, verify affected behavior and request another round in
  the same reviewer conversations. Keep the workflow and member occurrences
  underway across rounds until the requested outcome's completion rule holds.
  Reporting-only work may finish with unresolved findings clearly returned.
  Acceptance work stays open until important findings have reviewer-confirmed
  resolution on the final artifact, or the requester explicitly decides them.
fixed: true
sequence:
  - parallel:
      - step: review-correctness
      - step: review-fit
  - step: account-for-findings
```

A caller includes `workflow: review` before its governed action. Iteration is an
instruction in the workflow description, not a self-reference, recursive child workflow,
wrapper step or execution-policy keyword. The sequence describes work within each round;
completed reports are evidence, not automatic completion of the persistent occurrences.
Supervisor observes and assesses; it does not run a scheduler or launch those reviewers
from the YAML.

Choose `fixed: true` only when the original members, descriptions, references, order and
parallel relationships must survive adaptation. It permits added support work.
`project.yaml` is the index of every reusable step and workflow, not a whitelist of
task plans. A new project file is `workflows: []` and then `steps: []`:

```yaml
workflows: []
steps: []
```

Each entry has exactly `path` and `summary`, plus an optional `required` (`true` or `false`, default `false`).
`path` is `workflows/<id>.yaml` or `steps/<id>.md`; its file name is the ID. The parser accepts a summary
only when it is nonempty, at most two nonempty lines, and at most 240 characters.
Write what the definition is for and when it applies; a descriptive name can be
a fine summary, and the file description stays the policy. `required: true` is
the only inclusion flag. Optional `default_workflow` names one workflow id already
in `workflows`. Do not add a top-level `required:` key. Read the index first, then
the full definition files that apply. Keep existing flags, summaries and paths
unless the change is intentional. An unlisted file is `definition_unlisted` and
is not read. A missing indexed file is `catalog_entry_missing`; the row and its
flag stay. The referenced step files are indexed in the same edit; the fragment
below shows the workflow flag only.

```yaml
workflows:
  - path: workflows/review.yaml
    summary: Use to independently assess a frozen change or plan, and to account for the findings before the governed action.
    required: true
steps: []
```

Choose required review from the project's risks and requested outcomes; substantive
changes and consequential plans commonly justify it. Do not impose it universally by
copying this example. Where required, record applicability for the current main task. An
explicit request for assessment is applicable even if the artifact is small. Genuine
inapplicability is requirement accounting, not a fabricated reviewer execution or a new
execution status. A selected fixed commitment stays visible with its reason.

## Completion and reviewer identity

State whether the task requests findings or acceptance. "Review this change" can finish
by reporting a bug; "deliver this change" cannot finish merely by handing over the bug
list. Edit permissions do not change that requested outcome. The main owns fixes and
accounting; reviewers independently confirm or contest them. Preserve reviewer-assigned
severity. An author's downgrade is a rebuttal requiring confirmation or an explicit
requester decision, not a way to close the gate. Demonstrated regressions in behavior
promised preserved cannot be dismissed as minor or out of scope. Earlier reports and
pre-fix checks do not certify later changes; a changed base invalidates affected
evidence.

For repeated rounds, strongly prefer the same exact persistent reviewer chats per
main-owned cycle. Record IDs, actual models and reasoning, artifact and base, rounds,
findings and responses privately. Different mains own different reviewer chats. Use
supported conversation or session APIs; copied context in a new task is not conversation
persistence. Respect orchestrator lifecycle rules, including any requirement to create
new delegated tasks instead of resuming completed backing threads. Choose a supported
persistent route when the project requires identity.

Define intentional new-cycle boundaries for substantial intervening work or a material
scope change, carrying forward unresolved findings. Recover temporary interruptions in
the same chats. A permanently unusable chat or unavailable model may justify replacing
only that slot after bounded supported recovery, with a recorded reason, old and new
IDs, full findings handoff, required model diversity and reasoning settings preserved.
Delays or unfavorable findings do not justify replacement. An unavailable compliant
route is an explicit gap, not a waiver.

Keep drafting, adoption and external edits separate. Follow the target-folder boundary
in SKILL.md: keep execution guidance in the definitions and explain rationale in the
response. Existing external files can be read or referenced. Propose external changes to the user and wait for
explicit approval of those specific edits. Conditional wording, catalog adoption or
Supervisor activation does not replace that approval.
