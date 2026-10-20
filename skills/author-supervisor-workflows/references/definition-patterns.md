# Definition patterns

This is an authoring aid. Check the current product Guide or
`docs/steps-and-workflows.md` when available; do not infer new fields from prose.
These examples illustrate composition, not a catalog every project must adopt.

## Files and references

The operative checkout contains `.t3-supervisor/project.yaml`, `steps/*.md` and
`workflows/*.yaml`. A reusable step's filename matches its lowercase hyphenated ID.
Its Markdown body is empty; put its full contract in YAML frontmatter:

```markdown
---
id: review-correctness
name: Correctness review
description: |
  An independent reviewer assesses the frozen artifact against its actual base
  and authoritative requirements, including affected shared consumers.
  Return concrete findings, reviewer-assigned severity, artifact/base identity,
  coverage limits and a verdict. Later rounds assess fixes and prior objections.
references:
  - AGENTS.md
---
```

Use real project paths, replacing the example reference if necessary. Optional
`references` are checkout-root-relative paths, including for globally sourced
definitions. They can name documentation, skills or code, not URLs, home aliases,
absolute paths or line-number suffixes. They are supporting context, not reusable
definition IDs, access grants or proof that their targets were read.

A workflow has `name`, `description`, optional `references` and `fixed`, and one
root `sequence` or `parallel`. Its ID is its YAML filename. Members can be `step`
references, local step objects, named `workflow` references or nested groups.
There is no `steps`, `inline`, `instructions`, `outcome` or `iterative` field.
Steps have no structural children. Promote genuinely shared responsibilities to
reusable files, and define every referenced ID before claiming a valid catalog.

## Workflow-owned iteration

When the project requires adversarial review, a useful shape is the following.
Define the three referenced steps separately, including the main-owned accounting
contract; do not hand the accounting step to independent reviewers.

```yaml
name: Review
description: |
  The main owns review coordination and findings accounting. Assign correctness
  and fit assessment to independent reviewers under the project's model policy;
  if that policy requires two models, each covers both lenses independently.
  Freeze one artifact/base per round and wait for all complete reports before
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
instruction in the workflow description, not a self-reference, recursive child
workflow, wrapper step or execution-policy keyword. The sequence describes work
within each round; completed reports are evidence, not automatic completion of
the persistent occurrences. Supervisor observes and assesses; it does not run a
scheduler or launch those reviewers from the YAML.

Choose `fixed: true` only when the original members, descriptions, references,
order and parallel relationships must survive adaptation. It permits added support
work. Project-wide required inclusion is a separate choice in `project.yaml`:

```yaml
required:
  - workflow: review
```

Choose required review from the project's risks and requested outcomes; substantive
changes and consequential plans commonly justify it. Do not impose it universally
by copying this example. Where required, record applicability for the current main task. An explicit request
for assessment is applicable even if the artifact is small. Genuine inapplicability
is requirement accounting, not a fabricated reviewer execution or a new execution
status. A selected fixed commitment stays visible with its reason.

## Completion and reviewer identity

State whether the task requests findings or acceptance. "Review this change" can
finish by reporting a bug; "deliver this change" cannot finish merely by handing
over the bug list. Edit permissions do not change that requested outcome. The
main owns fixes and accounting; reviewers independently confirm or contest them.
Preserve reviewer-assigned severity. An author's downgrade is a rebuttal requiring
confirmation or an explicit requester decision, not a way to close the gate.
Demonstrated regressions in behavior promised preserved cannot be dismissed as
minor or out of scope. Earlier reports and pre-fix checks do not certify later
changes; a changed base invalidates affected evidence.

For repeated rounds, strongly prefer the same exact persistent reviewer chats
per main-owned cycle. Record IDs, actual models/reasoning, artifact/base, rounds,
findings and responses privately. Different mains own different reviewer chats.
Use supported conversation/session APIs; copied context in a new task is not
conversation persistence. Respect orchestrator lifecycle rules, including any
requirement to create new delegated tasks instead of resuming completed backing
threads. Choose a supported persistent route when the project requires identity.

Define intentional new-cycle boundaries for substantial intervening work or a
material scope change, carrying forward unresolved findings. Recover temporary
interruptions in the same chats. A permanently unusable chat or unavailable model
may justify replacing only that slot after bounded supported recovery, with a
recorded reason, old/new IDs, full findings handoff, required model diversity and
reasoning settings preserved. Delays or unfavorable findings do not justify replacement.
An unavailable compliant route is an explicit gap, not a waiver.

Keep adoption separate from drafting. Changes to generally loaded instructions or
skills can impose a policy even without enabling Supervisor. Until adoption is
authorized, make such additions conditional on an explicit request or adoption;
do not advertise a proposal while silently changing the project's active rules.
