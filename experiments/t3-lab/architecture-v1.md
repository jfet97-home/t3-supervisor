# Agent Supervision and Enforcement

## Architecture V1

**Date:** 12 October 2026.

**Status:** conceptual design completed and approved by adversarial review under the threat model defined in section 9. Implementation feasibility has not yet been established.

**Objective:** build a provider-independent system that supervises development agents and enforces project rules while preserving autonomy, performance, and flexibility.

**Target environment:** T3 Code, with agent runtimes executing inside isolated microVMs.

## 1. Fundamental principles

The architecture combines two complementary mechanisms.

### Semantic supervision

A general-purpose supervisor observes agent behavior, recognizes relevant activities and intentions, provides contextual guidance, coordinates workflows, and supervises other agents, including adversarial reviewers.

It operates primarily asynchronously, avoiding constant interruptions and repetitive instructions that consume the worker's context.

### Deterministic enforcement

Synchronous controls intercept selected protected operations, verify mandatory prerequisites, require trustworthy evidence, and block execution when those prerequisites are not satisfied. Rejections tell the agent what is missing.

Agents remain free to organize and perform their work, but the controlled paths do not let them ignore mandatory prerequisites for protected operations.

V1 aims to reduce errors, omissions, and inappropriate shortcuts. It does not promise absolute correctness or resistance to a deliberately hostile agent.

## 2. General architecture

There are four logical components. They do not necessarily require separate services or processes.

### A. Isolated environment

Agents run inside microVMs with controlled capabilities:

- A restricted set of known tools.
- Controlled network communications.
- Privileged credentials inaccessible to agents.
- Protected operations available through controlled paths.

Wrapping `gh` alone is insufficient if an agent can perform the same operation using `curl` and a GitHub token. Isolation controls the capabilities needed to produce protected effects, rather than recognizing every possible command.

These guarantees are bounded by section 9. Agent-created automation remains an explicitly accepted residual risk in V1.

### B. Semantic supervisor

The supervisor observes sessions through T3 Code. It reacts to relevant behavior and proactively anticipates workflow steps. It can coordinate agents, negotiate workflows, and produce or validate evidence when authorized by policy.

It does not need to inspect every tool call synchronously.

### C. Deterministic enforcement

Protected operations have mandatory prerequisites. Conceptually:

```text
push requires:
  branch is authorized
  and either no associated PR exists or the PR is draft

ready requires:
  E2E evidence is valid
  and adversarial review evidence is valid
```

This is illustrative, not a final API. A gate can validate existing evidence, execute a check, or request a new verification. If a prerequisite is unsatisfied, it blocks the operation and explains the missing requirement.

### D. Evidence system

Requirements are evaluated using trustworthy evidence. Verification can be deterministic, probabilistic, or a combination. Different requirements may accept different forms of evidence and assurance.

## 3. Policies and workflows

### Authoritative policies

Policies define non-negotiable constraints. Their sources can be a protected repository revision, protected initial configuration, or both. The operative agent cannot change them unilaterally during a session.

Policies can specify prerequisites, requirements, mandatory checks, predefined workflows, and evidence acceptance criteria.

The gate independently determines applicable requirements from actual project state. A documentation-only exception, for example, must be verified against the actual diff rather than the agent's description of its task.

### Dynamic workflows

Workflows organize the work using reusable operation blocks, such as consulting project documentation, implementing a feature, writing and running tests, performing adversarial review, checking architecture patterns, and preparing a PR.

At session start, the agent and supervisor can negotiate a workflow suited to the task. The workflow can evolve as the work progresses.

Blocks may be described through skills, MCP, or dedicated configuration. Their representation remains undecided.

### Mandatory workflows

Policies may also require workflows or individual steps. The agent learns them through `AGENTS.md`, skills, or other project instructions. The supervisor monitors progress, while gates enforce verifiable prerequisites at protected operations.

Workflows are adaptable. Authoritative policy requirements cannot be negotiated away.

## 4. Evidence and verifiers

| Concept | Responsibility |
| --- | --- |
| Requirement | Defines the condition that must be satisfied. |
| Evidence | Records support for satisfying the requirement. |
| Verifier | Determines whether the evidence is sufficient. |

Each requirement defines what evidence it accepts.

### Deterministic evidence

A trusted E2E runner executes specified tests and records their results against the verified revision. The attestation establishes execution and results; it does not establish that the code is universally correct.

### Probabilistic evidence

Architecture conformity, error handling, implementation quality, and review completeness may require semantic judgments. Jev or an equivalent tool may supply structured evaluations. No particular semantic evaluator has been selected or validated.

Two forms of assurance remain distinct:

- **Procedural:** the prescribed verification procedure was performed.
- **Substantive:** the conclusion of that verification is correct.

Substantive assurance may be probabilistic. Policy specifies the acceptable assurance.

### Attestation integrity

Only authorized components may produce authoritative evidence. The worker can request verification, but cannot fabricate its result.

Attestation credentials must be inaccessible both to the operative agent and to the code being tested. Reviewer prompts, verification commands, and review acceptance and retry criteria come from protected configuration.

## 5. Adversarial review

The reviewer follows a configurable workflow appropriate to the project. It may check implementation correctness, architecture patterns, errors and edge cases, test quality and completeness, test weakening, and project conventions.

### Consistency with existing implementations

When appropriate, new implementations should follow established project solutions. The reviewer can:

1. Examine code and documentation from before the PR.
2. Identify analogous implementations and established patterns.
3. Compare the proposed changes with those precedents.
4. Explain unjustified divergence or avoidable duplication.

The reference is the PR's base revision, not code or guidance introduced by the operative agent in the PR. New solutions remain possible when their differences are justified.

### Reviewer supervision

The supervisor monitors whether the reviewer follows its workflow, addresses the required checks, produces pertinent evidence, and handles identified problems.

The reviewer examines the actual revision and complete policy-defined scope, rather than an agent-selected diff. Attempts and results are retained. Repeated reviews follow protected policy acceptance criteria.

The supervisor may attest workflow completion when authorized. A supervised review remains fallible; its substantive assurance is explicitly probabilistic.

## 6. Evidence validity and reuse

V1 uses conservative reuse. Evidence remains reusable only when all of the following are identical:

- Code revision and verified inputs.
- Applicable policy and requirement versions.
- Verifier definition and configuration.

Any change requires a new verification.

V1 does not implement incremental attestations. Future versions may reuse evidence for subsets of files while accounting for dependencies.

### Test integrity

A trusted runner can still execute tests weakened by the worker. V1 uses supervised semantic review to identify suspicious test modifications, skips, and configuration changes.

Policy may require both execution evidence and review evidence. This is a deliberate pragmatic choice, with probabilistic detection of weakened tests.

## 7. Example PR lifecycle

For a policy requiring E2E and adversarial review before a PR becomes ready:

1. **Start:** the worker receives its task and negotiates a workflow consistent with mandatory policies.
2. **Implementation:** it works in the microVM while the supervisor observes and guides progress.
3. **Verification:** it requests tests and adversarial review; authorized components produce evidence.
4. **Push:** the gate checks that the branch is authorized and any associated PR is draft. Direct pushes to protected branches, including the default branch, and unauthorized release-tag updates are prohibited.
5. **Ready:** the gate validates required evidence against the actual published commit before authorizing the transition. Creating a PR directly as non-draft requires the same checks.
6. **Further changes:** the worker first returns the PR to draft, pushes changes, and obtains valid evidence for the new revision before making it ready again.

### Concurrency

V1 does not support multiple workers modifying the same branch or PR concurrently.

One agent can still start parallel commands. Protected operations on the same branch must therefore be processed sequentially so push and ready cannot overlap. Verification applies to the actual commit involved in the operation.

Push controls cover every authorized channel that can update the branch, including API operations, rather than only `git push`.

## 8. Failure handling

Supervisor availability is not required for ordinary work. If it becomes unavailable:

- The worker continues using `AGENTS.md`, skills, and existing instructions.
- Deterministic controls remain active.
- Gates continue to verify requirements and evidence.
- Protected operations remain blocked when mandatory evidence is missing or invalid.

If a required attestor is unavailable, its requirement remains unsatisfied. The worker obtains evidence from authorized components; it does not generate authoritative evidence itself.

Supervisor failure must not disable policy enforcement on controlled paths.

## 9. Threat model and guarantee boundary

V1 primarily addresses omissions, inappropriate shortcuts, ignored conventions, judgment errors, and protected operations attempted without their required prerequisites.

It is not designed to resist a deliberately hostile agent.

The guarantee applies to controlled agent operations. V1 does not monitor changes made independently by users, bots, or systems outside its infrastructure.

### Automation and CI

Automation indirectly triggered by an agent can provide an alternative path. V1 adopts limited CI privileges and semantic supervision of anomalous configuration, while explicitly accepting residual risk from agent-created automation.

It does not introduce complete protection against deliberate gate bypass through such automation, a general watchdog, or additional security subsystems without a concrete need.

The implementation must define the actual CI permissions and check unintended bypasses, including ordinary auto-fix workflows. Accepted residual risk must not be described as unconditional prevention.

## 10. T3 Code integration and first feasibility check

T3 Code provides the target orchestration environment for multiple providers, session and event observation, supervisor execution, interventions, and workflow coordination.

Policy and enforcement logic remains provider-independent.

The first technical step is to establish isolation feasibility:

1. Determine where the agent runtime currently executes and whether T3 can run it inside a microVM.
2. Confirm privileged host credentials are inaccessible from that environment.
3. Identify whether orchestration tools provide alternative routes around gates.
4. Confirm trusted components can remain outside worker-controlled execution.

Then verify T3's concrete observation and intervention capabilities for active sessions.

These capabilities have not yet been experimentally validated for this project.

### First observation on 12 October 2026

The current local T3 session runs on the Mac Studio under macOS arm64, using T3 Code Nightly `0.0.46-nightly.20261011.2994`. A read-only process inspection shows the worker CLI is a child of the T3 application process, and commands execute directly on the macOS host. This session is not running inside a microVM.

This establishes the current execution location, not whether T3 can support a different isolated launch arrangement. The next bounded question is how to launch the worker runtime inside a microVM while retaining T3 orchestration. No T3 settings or runtime configuration were changed.

## 11. Open decisions and deferred functionality

| Aspect | Status |
| --- | --- |
| Hybrid supervision and enforcement | Conceptually approved. |
| Asynchronous semantic supervisor | Conceptually approved. |
| Deterministic gates and authoritative policies | Conceptually approved. |
| Negotiated dynamic workflows | Conceptually approved. |
| Deterministic and probabilistic evidence | Conceptually approved. |
| Supervised adversarial review and existing-pattern comparison | Conceptually approved. |
| MicroVM isolation with T3 Code | Requires feasibility validation. |
| Policy and workflow-block formats | To define. |
| Agent-supervisor protocol | To define. |
| Gate implementation | To define. |
| Evidence format and storage | To define. |
| Incremental attestations | Deferred. |
| Multiple workers writing the same branch concurrently | Outside V1. |
| General monitoring of external changes | Outside V1. |
| Formal correctness guarantees | Outside scope. |

## 12. V1 objective and working sequence

V1 must demonstrate autonomy, contextual supervision, mandatory prerequisites on protected operations, trustworthy evidence, and provider-independent project rules.

Configurable review workflows should also help implementations remain consistent with established project conventions.

The guiding principle, within section 9's boundary, is:

> The worker chooses how to work. The supervisor helps it organize and work correctly. Policies define mandatory requirements. Deterministic gates enforce those requirements on controlled protected-operation paths using verifiable evidence.

Dynamic workflows, semantic supervision, and deterministic enforcement share requirements without forcing agents into universally fixed procedures.

Conceptual design is complete under the stated threat model. Implementation should remain intentionally small, adding abstractions or services only when concrete cases require them.

Work proceeds one decision at a time. The immediate task is section 10, item 1: establish the current execution location and microVM feasibility before choosing policy formats, building gates, or starting a general framework.
