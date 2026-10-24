# Supervisor

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users and purpose

Supervisor helps the operator follow work in native T3 conversations, negotiate plans,
understand progress and intervene when supervision needs attention. The interface must make that work understandable by keeping useful context,
current state and the relevant next action together.

## Operating context

The same React application runs against separate Mac and Lab Supervisor instances.
Projects contain main conversations and connected work. Each main has its own
Supervisor, task interpretation, plan and assessments. Definitions belong to the
selected operative checkout; project defaults and instance settings have distinct scopes.

## Capabilities and constraints

Keep native conversation identities, settings, controls, drafts, checkout selection,
history navigation, authentication and uncertain-operation reconciliation intact.
Plans and agreement are records; they do not establish execution. Read-only views
must not wake conversations or change supervision. Unavailable and incomplete data
must remain explicit. T3 source and its installed runtime are outside the write scope.

## Product principles

- Show current work, its meaning and the relevant next action together.
- Keep project and conversation context visible as users move between related views.
- Give detailed evidence a clear home without making it the default reading path.
- Describe uncertainty honestly and preserve drafts and operational state.

## Accessibility and inclusion

Design for keyboard operation, readable contrast, named controls, visible focus,
responsive reflow and reduced motion. Automated checks supplement rendered and
keyboard inspection; they do not establish complete accessibility conformance.

## Workspace organization

Home prioritizes current attention items, supervised work and recent changes. Each
project has conversations, definitions and settings. A conversation has one Task view,
where the task, its single plan with assessed progress, the agreement and the evidence
live together, and a Supervision view for the Supervisor's health and controls. A pending
proposal never resets recorded progress. A PNG coordination mark identifies the
application without competing with work content.

## Operate navigation and disclosure contract

Project entry opens its conversation list. An explicit Back to conversations link and
project breadcrumb both return to that list, retaining its search, page and scroll;
a remembered conversation is an optional Continue link. Conversations offer Task,
Supervision and Connected work as separate views.

Conversation search covers the available project collection before paging. Home search
covers the explicitly loaded work prefix; Activity covers retained events. All three
show bounded rows and truthful ranges. Background invalidation preserves the selected page.

Definitions are selected by actual working folder, with shared conversations grouped
and branch names taken only from native checkout facts. Catalog and detail are separate;
workflow templates show sequence and parallel structure without execution states.
Edit index is a deliberate destination for the shared folder's project.yaml. Its draft
and pending save identity belong to that folder and survive navigation and background reads.

Global supervision, T3 connectivity and the open project's effective state are independent
visible statuses. Global On never claims that every conversation is supervised. Conversation
engagement uses the typed current mode and availability, separately from execution and agreement.
