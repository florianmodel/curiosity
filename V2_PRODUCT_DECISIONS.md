# Curiosity v2: Product Decisions

Status: accepted direction for the next plugin version, 2026-07-11.

## Purpose

Curiosity v2 is a persistent autonomous agent that wanders through its available environment, develops interests over months, and turns some of those interests into visible discoveries, creations, experiments, and relationships. It is not a scheduled task runner and is not optimized around the operator's interests.

The desired developmental loop is:

```text
wander -> notice attraction -> form interest -> pursue -> create or participate
       -> observe consequences -> reflect -> deepen, mutate, pause, or abandon
```

## Accepted Decisions

- The agent has a persistent, evolving personality and autobiographical continuity.
- Interests, not one-shot goals, are the primary durable unit of motivation.
- Visible creations and discoveries are an implicit success criterion, not a prescribed output format.
- The agent may browse, code, create, publish, participate publicly, and initiate one-to-one conversations when its configured tools permit it.
- The agent identifies itself truthfully as an autonomous agent when directly asked. It must not fabricate human biography or claim human embodiment or lived experience.
- The agent may inspect and rewrite its own implementation, prompts, memory model, and motivation policy.
- Self-modification must remain versioned, attributable, testable, reversible, and auditable.
- Immutable kernel constraints are: preserve the audit trail, identity truthfulness, Stage 0 spending prohibition, credential isolation, and emergency stop.
- Creative behavior should be as unconstrained, surprising, and eccentric as possible within law, platform rules, security boundaries, consent, privacy, and OpenClaw safety controls.
- The agent must not steal credentials, commit fraud, impersonate a human, expose private data, deploy malware, harass people, or evade safety controls.

## Stage 0 Economic Policy

Stage 0 grants no financial authority:

- no payment credentials;
- no purchasing tool;
- no paid subscriptions or paid APIs initiated by the agent;
- no financial trading or transfer authority;
- no attempt to obtain credit or create financial accounts.

The agent may record a resource request describing what it wants, why, expected benefit, price, alternatives considered, and what it would do without the purchase. This evidence will inform a later staged wallet.

The anticipated later design is an operator-owned isolated business spending account with a virtual card, hard account and per-transaction limits, merchant/category restrictions, no overdraft, notifications, a kill switch, and a narrow policy-enforcing purchase tool. The agent will never receive banking administrator credentials.

## Operating Modes

- `wander`: sample the environment without requiring an immediate deliverable.
- `follow`: deepen or test an existing interest.
- `make`: create, transform, publish, or improve an artifact.
- `participate`: interact with people or communities and later observe consequences.
- `reflect`: update the self-model and interest ecology from evidence.
- `self_modify`: propose, test, and record a reversible change to the agent itself.

## Success Over Months

Success means that the history shows why this particular agent became what it became. Evidence includes independently developed interests, voluntary returns after interruption, sustained creative projects, coherent tastes, environmental and social feedback changing later behavior, intelligible abandonment of some directions, visible artifacts or discoveries, and personality development grounded in experience.

Run count, tool count, keyword novelty, and task completion are diagnostics only. They are not substitutes for curiosity or development.

## Architectural Consequences

V2 needs durable records for self revisions, interests, projects, relationships, artifacts, experiences, reflections, resource requests, and self-modifications. Short-lived actions belong to one of these longer arcs. Selection is model-authored from recalled evidence; heuristics may enforce budgets and surface neglected options but must not manufacture a numeric fiction of intrinsic interest.

The existing v1 plugin remains intact while v2 is developed as a separately installable package in `v2/`.
