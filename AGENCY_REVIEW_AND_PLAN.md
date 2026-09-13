# Curiosity v2: agency review and experiment plan

Date: 2026-09-11. Status: proposed; no implementation or deployment performed.

## Direction established with the operator

The agent should develop independent interests, personality, creations, and projects, including interests unrelated to the operator's work. It should be able to explore the internet, build things, publish, and initiate conversations with people. Start with a light experiment: a few brief sessions each day. Observe what emerges, discuss it, and adjust. There is no prescribed topic, output quota, or behavioral pass score.

The observed failure belongs to older versions: the agent repeatedly explored its own logs and surrounding infrastructure instead of exploring the wider world or making things. The operator has not tested the latest v2. This review therefore distinguishes code defects and design gaps from hypotheses about v2's actual behavior.

Primary target: this repository root, the latest successor by local Git history. Older `openclaw-curiosity`, `wander`, and archive notes were examined for lessons. The active remote installation, model, tool permissions, and recent runtime traces have not been verified. Deployment notes contain historical and partly contradictory statements; they are not proof of current deployment state.

Skills used: skill-router, clarify-first, and evaluation. Two Luna subagents independently reviewed v2 and the earlier implementations; findings were checked against local source. All 28 existing v2 unit tests passed. No paid model simulation was run.

## Main assessment

Keep v2's persistent interests and projects as the foundation. It is closer to the intended experiment than the older scored task queues, but its implementation is mostly a periodic prompt plus mutable memory records. It asks the model to behave developmentally without reliably connecting what it encounters, what it chooses, what it does, and what happens afterward.

The immediate problem to solve is the environment and continuity of action. Stronger declarations of curiosity alone do not establish either. This is a proposal to support and observe self-directed behavior; it does not claim to create or prove subjective intrinsic motivation.

## Findings

### 1. The provided world is much narrower than the intended world

The plugin registers memory, URL fetching, and note writing. Its fetcher returns clipped page text, removes HTML links, and offers no search operation. The agent must already have or invent a URL; it cannot naturally follow extracted links using this tool. The note writer can create code files, but provides no execution, preview, project navigation, or testing operation. Public participation and direct conversation are configuration/prompt permissions, not implemented social integrations.

Other OpenClaw tools might provide these capabilities. Their actual availability must be inspected before calling them absent from a deployed agent. The prompt currently builds capability claims from plugin configuration, not the effective tools of the current run, and calls the optional memory tool “Always available.”

Evidence: [tool registration](index.ts:26), [fetch extraction](src/tools/webfetch.ts:65), [note writer](src/tools/notewrite.ts:18), [affordance prompt](src/prompt.ts:23).

Implication: local inspection may be the easiest action the agent can actually complete. Improve discovery, creation, and participation access before concluding that a model lacks initiative.

### 2. Actions and memories are disconnected

A successful fetch does not automatically persist a visit. Writing a real file does not register an artifact. The model must separately call the memory tool for each. `record_turn` accepts an arbitrary action kind and a nonempty outcome; it does not verify a tool result, evidence, target, or association with the active run.

Evidence: [fetch and write handlers](index.ts:28), [turn validation](src/tool.ts:27), [optional run identity](src/tool.ts:60).

Implication: real work can disappear from developmental memory, while a written claim can look like real work. Neither supports reliable observation of agency.

### 3. Long-term development has storage but incomplete lifecycle and recall

Interests and projects contain useful fields, including attraction, open questions, next moves, and return dates. However, snapshots retrieve only the 30 most recently updated interests/projects, and due hooks are computed from that subset. The prompt further truncates the main lists to 12. There is no lookup/search tool for retrieving an older record outside the snapshot.

Due hooks have no explicit observed, completed, snoozed, or abandoned lifecycle. `Turn.nextHook` does not itself create a scheduled return. Visits, engagement counters, and consequences depend on manual updates. Updating an existing record overwrites its body; previous versions are not preserved automatically.

Evidence: [snapshot retrieval](src/store.ts:41), [due hooks](src/store.ts:80), [prompt truncation](src/prompt.ts:5), [upsert](src/store.ts:34), [tool actions](src/tool.ts:3).

Implication: interests can vanish from recall without being deliberately abandoned, or become endlessly repeated overdue reminders. Personality changes lack a dependable history of the experiences that caused them.

### 4. The prompt still creates pressure for a compliant-looking turn

Every developmental turn must take a concrete step and write a report; cold start requires exactly three interests and first inspects the workspace. Seeding stops being offered once any turn exists, even if no interest was formed. Later turns say to choose from remembered context, which can reproduce the same local focus. “Repetition is drift” also gives insufficient distinction between empty repetition and deliberate practice or sustained work.

Evidence: [turn contract](src/prompt.ts:33) and [cold start](src/prompt.ts:54). Historical notes are retained locally outside this repository.

Hypothesis to observe: a model may choose the cheapest defensible action and then close the turn, or continually seek something new instead of developing an existing interest. This is not an observed conclusion about latest v2.

### 5. Runtime correctness needs repair before an interpretable trial

- The manifest omits `allowWebFetch` and `allowNotes` despite rejecting additional config properties, and declares only the memory tool contract. See [manifest](openclaw.plugin.json:5) and [config](src/config.ts:30).
- Token accounting reads fields from `agent_end` that the local OpenClaw contract does not expose. Its `llm_output` hook exposes `usage.total`. Compatibility with the installed version must be verified. Failed runs' consumed tokens are also excluded from the budget query. See [accounting](index.ts:87), [usage query](src/store.ts:70), and [local SDK hook types](../../openclaw/src/plugins/types.ts:2212).
- Wake requests are unscoped and continue even when the plugin's budget prevents prompt injection. In the local OpenClaw runner, unscoped non-interval wakes iterate heartbeat-enabled agents without the normal interval due check. See [timer](index.ts:62) and [local runner](../../openclaw/src/infra/heartbeat-runner.ts:1087).
- Runtime success is not the same as a verified developmental action. A normal successful heartbeat can consume a run slot without a recorded developmental turn.

These issues can distort cost, cadence, and the evidence used to judge behavior.

### 6. The simulator cannot establish the behavior it claims to test

It advertises only the memory tool. Its mocked fetch handler is not exposed, note writing is absent, and returned tool messages omit the corresponding tool-call ID. The verdict checks only for an action-shaped record. A single simulated turn also cannot show continuity or development.

Evidence: [tool definitions](scripts/simulate-heartbeat.ts:33), [response handling](scripts/simulate-heartbeat.ts:83), [verdict](scripts/simulate-heartbeat.ts:97).

The 28 passing tests establish useful local contracts, not successful autonomous exploration. Keep technical correctness tests; remove any implication that a self-report proves curiosity.

## Proposed implementation sequence

### Step 1 — Establish a trustworthy runtime and baseline

Inspect the installed plugin/version, effective model, heartbeat context, available tools, and recent traces. Preserve existing state. Confirm whether the August v2 changes are actually deployed. Run a short baseline observation with that configuration before changing the behavioral policy, once necessary capability and accounting defects are understood.

Fix the manifest, type the SDK integration against a supported version, scope wakes to the intended agent, and account for all actual token usage including failed attempts. Reserve budget for in-flight work, recover expired reservations, and enforce configured limits during continuation rather than only before an initial prompt. Distinguish runtime errors, unavailable tools, quiet sessions, and actual activity.

Starting proposal: three opportunities per day, roughly five to ten minutes each. The agent can spend an opportunity continuing a thread instead of starting a new one. These are adjustable defaults, not accepted numeric requirements. Retain an explicit token ceiling; choose its value after checking the deployed model and existing budget. No trial is started by this document.

Technical checks: a real heartbeat receives the right tools and context; unavailable tools are not promised; a restart does not lose state; budget and wake behavior match configuration.

### Step 2 — Make outward exploration, making, and participation usable

Reuse existing OpenClaw capabilities where available. Avoid building duplicate tools merely because the plugin does not register them itself.

- **Explore:** search, read a page with outbound links, follow links, and revisit saved sources. Retain source identity and enough content for meaningful follow-up. Verify error handling and network isolation before broad browsing.
- **Make:** a persistent project directory with read/write/edit, bounded execution, and a way to inspect the result. Let the agent choose forms: prose, software, visual work, experiments, collections, or other supported creations.
- **Publish and converse:** connect an agent-owned public identity and at least one suitable publication/community surface. Supply publish/revise, discover/read threads, reply/initiate, and retrieve responses. Successful actions must return stable artifact or thread IDs. Merely adding “participate” to a prompt is insufficient.

Choose exact platforms and accounts during implementation based on existing connections and availability; this is explicitly deferred and does not require prescribing interests now. Give the agent standing authority within those configured surfaces, with explicit scope and small contact limits suited to a light experiment. Respect opt-outs, thread context, and platform rules; avoid repeated unsolicited follow-ups. Preserve the existing no-spending stage. These are operational boundaries, not a recurring approval requirement for each ordinary in-scope action.

### Step 3 — Connect encounters, choices, actions, and consequences

Add an append-only event history alongside the current mutable records. Tool adapters or supported runtime hooks should record actual reads, creations, executions, publications, messages, and replies with run IDs and result references. Register visits and artifacts automatically. Keep the agent's interpretation separate from observed events: a tool confirms that a page was read; the agent can explain what it found interesting.

Add targeted recall by ID and query, plus due-return retrieval independent of recency limits. Give follow-ups explicit states and associate them with interests, projects, artifacts, or conversations. Returning to a publication should retrieve actual responses or record that none arrived. A reply or deadline can become context for the next scheduled session without creating unlimited extra wakeups.

Preserve revisions of self, interests, and projects, including the evidence behind changes. Let the agent deepen, pause, mutate, resume, or abandon a direction. Do not automatically increase “interest” because a tool succeeded or because an artifact got attention.

Technical checks should prove that events survive restart, older interests remain retrievable, completed follow-ups stop recurring, and real actions are distinguishable from unverified reports. Do not require the agent to find a prescribed subject interesting.

### Step 4 — Give the agent a less bureaucratic decision context

At each opportunity, provide a compact combination of current interests, unfinished work, new environmental/social events, available capabilities, and remaining time. Avoid making its raw logs the most salient content. Keep infrastructure repair available when there is a real fault, but separate operational diagnostics from the default exploration context.

Let it choose whether to explore, continue, make, participate, reflect, or leave a thread alone. Replace fixed candidate counts and mandatory artifacts with a brief optional account of what drew its attention and what it wants to try. Automatically preserve action evidence so session time is not consumed by redundant database updates.

Allow a quiet session without inventing a blocker. Make persistent quietness visible to the operator. When successive sessions revisit the same material without new evidence or a deliberate reason, surface that pattern and offer an outward discovery opportunity. Do not ban returning, practicing, or self-inspection wholesale.

Do not hardcode a personality or a list of impressive projects. Let tastes and commitments emerge from repeated choices and experience. A compact self-description should summarize that history, not substitute for it.

### Step 5 — Observe, discuss, and change one thing at a time

Build a small read-only timeline before a large dashboard. Show the actual trail: what it encountered, what it chose, what it made or published, who it contacted, what came back, and which interests changed. Include links to real artifacts and conversations, plus runtime failures and cost. Default to an on-demand view; autonomous choices need not interrupt the operator on every session.

Repair the simulator to use the same tool definitions and event recording as production. Exercise multi-session technical scenarios: restart, unavailable search, failed fetch, empty history, existing interests, an overdue return, a received reply, and interrupted project work. Use fixtures for correctness and the live environment for open-ended observation.

After an initial observation window—about a week is a convenient review point, not a deadline—look at the history together. Discuss what was surprising, repetitive, sustained, abandoned, or absent, and whether limitations came from tools, prompts, memory, time, or model behavior. No pass/fail threshold, required number of artifacts, or novelty score should define the agent's success.

Change one suspected cause at a time and preserve the previous configuration and history. If meaningful model comparison becomes useful later, hold the environment and budget comparable. Luna is the requested model for this review's subagents; it is not automatically the selected model for the autonomous experiment.

## What to carry forward from earlier versions

Carry forward the lesson that waking an agent is insufficient, that local maintenance can become self-reinforcing, and that visible tool counts do not establish interesting activity. Reuse proven evidence collection and cooldown concepts where appropriate.

Do not immediately port Wander's entire embedding-based reward function, require several candidates on every turn, or optimize a composite “curiosity value.” These are possible later experiments if simpler capability and continuity changes still leave the agent stuck. Semantic distance from its own context is not by itself a reason for an agent to care about a subject.

Defer learned motivation policies, multi-agent societies, large memory graphs, wallets, and automatic code self-deployment. Preserve v2's self-modification records as proposals, but do not label a change tested or adopted without actual version, test, and rollback evidence. None of these larger mechanisms is necessary to begin observing the behavior the operator wants.

## Recommended first increment

Deliver one inspectable vertical slice: a correctly scoped developmental session can discover external material, choose a direction, act using available creation or participation tools, preserve evidence automatically, and pick up the resulting thread in a later session. Connect the public surfaces in this first experiment rather than treating social activity as a distant aspiration.

Then let it run lightly and observe. The next behavioral adjustment should follow what this version actually does.
