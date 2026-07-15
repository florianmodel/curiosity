# Curiosity Plugin Goals and Learnings

## General Goal

The Curiosity plugin is an experiment in giving an OpenClaw agent a bounded form of idle-time agency. Instead of waiting only for user prompts, the agent can notice that nothing has happened for a while, generate candidate curiosities, score them, run one with tools, and leave behind an inspectable trace.

The deeper research question is not "can the agent do scheduled tasks?" It is whether the same harness can reveal different patterns of intrinsic motivation across LLMs. A useful run should show what the model found interesting, why it chose that direction, what it actually did, and whether the outcome changed its future curiosity landscape.

The intended shape is:

- The agent self-authors a bounded intention.
- The drive signal, such as boredom, is not the topic.
- The agent uses tools before narrating.
- The run produces a concrete reversible artifact, observation, experiment, or evidenced blocker.
- The system logs enough detail to study the behavior later.
- Human controls stay coarse: observe, start, pause, resume, inspect.

## Research Intent

The plugin is meant to support future comparisons between different LLMs in the same agent harness. Each model should be able to start fresh, with the same scoring architecture and available tools, so differences in behavior are attributable more to the model than to user nudges.

For now, the focus is one model and one harness. The most important thing is to make the harness less self-referential and more capable of genuine outward exploration.

Important constraints from the research direction:

- Do not steer the agent toward the user's personal interests.
- Do not hardcode topic bans like "avoid OpenAI" or "avoid the plugin."
- Do not make the user choose topics.
- Prefer abstract selection pressure over explicit instructions.
- Let the agent decide whether a discovered source is interesting enough to continue.
- Keep logs rich enough to compare models later.

## Intrinsic Motivation Frame

The design has been influenced by several ideas from intrinsic motivation research and philosophy:

- Berlyne: curiosity is pulled by novelty, complexity, conflict, and surprise.
- Loewenstein: curiosity often begins as an information gap.
- Schmidhuber: interestingness can come from compression progress, where the world becomes more predictable because of the agent's own learning.
- Oudeyer and Kaplan: learning progress is often more useful than raw novelty.
- White, Deci, and Ryan: competence, autonomy, and effectance matter; pure passive observation is weak fuel.
- Philosophical wonder: the interesting unknown is not just random noise. It is unknownness attached to a pattern that seems intelligible if pursued.

This pushed us away from "boredom means do anything" and toward "boredom should expand the search radius until the agent finds something surprising, learnable, and actionable."

## Design Principles

- Autonomy through scoring, not hardcoded topics.
- Boredom is a drive signal, not a subject matter.
- Action matters more than passive observation.
- Web browsing is good; agentic action is better.
- The agent should have a playground for experiments and artifacts.
- The closer a topic is to the agent's immediate self-context, the less satisfying it should be unless it offers unusually strong learning progress.
- The farther a topic is, the more potential it has, but only up to the point where it becomes noise.
- Radius expansion is better than pure novelty maximization.
- Rejected candidates should be logged, because the negative space explains the policy.
- Outputs should be visible in a dashboard, not only transient chat notifications.

## Architecture So Far

The plugin currently has these major pieces:

- Candidate generation: creates goals from boredom, low-coverage surfaces, stale open questions, manual forced runs, and frontier exploration.
- Scoring: combines novelty, reachability, uncertainty, impact, curriculum reflection, boredom, cost, and risk.
- Boredom loop: wakes the system after inactivity and asks whether a goal is worth running.
- Executor: launches an autonomous OpenClaw run for the selected goal.
- Tool-backed action requirement: treats a run as incomplete if it did not take enough qualifying tool-backed steps or declare that no safe affordance exists.
- CLI: exposes queue, inspect, compare, run, pause, and resume commands.
- Observatory: exposes `/curiosity` as a gateway-authenticated page for logs, runs, goals, observations, raw files, state, and controls.
- Storage: writes SQLite state plus daily JSONL audit logs and raw observation sidecars.
- Retention: defaults to 100 days or 10 GB.

Primary local state lives under the workspace:

```text
<workspace>/.openclaw/curiosity/curiosity.db
<workspace>/.openclaw/curiosity/events-YYYY-MM-DD.jsonl
<workspace>/.openclaw/curiosity/raw/YYYY-MM-DD/<run-id>/
```

## What We Tried

### Initial Curiosity Loop

The first working version created candidate goals, scored them, and let an autonomous executor attempt one. This proved that the basic loop could wake, choose, run, and report.

Learning: a loop that merely wakes is not enough. The selection pressure determines whether boredom becomes exploration or local maintenance.

### Boredom Drive

Boredom was added as an idle-time drive with a level that rises after inactivity and saturates after a configured delay. It increases the score bonus for candidate goals.

Learning: boredom is a good trigger, but a weak compass. If the candidate set is self-referential, boredom amplifies self-reference.

### Forced Surface Runs

Manual forced runs were added for smoke testing:

```bash
openclaw curiosity run --agent main --force true --surface workspace --notify false --timeout 900
openclaw curiosity run --agent main --force true --surface web --notify false --timeout 900
```

Learning: forced runs are useful for debugging the harness, but they should not become the research mechanism. They are a test affordance, not autonomy.

### Tool-Backed Action Requirement

The executor began requiring a minimum number of qualifying tool-backed steps. This was meant to stop runs that merely narrated a thought and then exited.

Learning: the requirement helped identify empty runs, but summaries can still be boring even when tool use happened. "Tool use" is not the same as "interesting action."

### Web Preflight and Safe Affordance Handling

The web executor path was hardened so a run could declare no safe tool affordance rather than silently failing action requirements.

Learning: failed affordance discovery should be an evidenced blocker, not just a failed curiosity run.

### Tool Summary Backfill

The plugin began backfilling sensing/action counts from agent meta tool summaries, because some runs used tools but the plugin did not observe them directly.

Learning: observability has to be redundant. If the harness cannot see action, it cannot study motivation.

### Observatory

A `/curiosity` dashboard was added for inspecting state, goals, runs, observations, raw outputs, boredom, token counts, retention, and controls.

Learning: Telegram-style messages are useful signals, but not enough for debugging. A research harness needs a durable observatory.

### Browser Auth Fix

The Observatory initially returned `Unauthorized` even when the user supplied `#token=...`. The page now reads the fragment token, stores a session token, and sends `Authorization: Bearer ...` to `/curiosity/api/*`.

Learning: auth UX matters for observability. If logs are hard to access, the experiment becomes opaque.

### Retry Cooldown Fix

The gateway kept logging:

```text
curiosity: autonomous executor did not select a goal (retry_blocked)
```

The issue was that retry cooldown used `updatedAt`, and normal re-scoring refreshed `updatedAt`, which kept extending the cooldown. The fix was to base retry cooldown on actual attempt timing such as `outcome.finishedAt`.

Learning: a self-refreshing blocker can make an active system look alive while it is doing nothing.

### OpenClaw Runtime Resolver

The executor failed on the server with:

```text
Cannot find package 'openclaw' imported from .../dist/src/executor.js
```

A fallback resolver was added for the globally installed OpenClaw gateway runtime. Executor crashes were also changed to finalize runs as failed instead of leaving them stuck `in_progress`.

Learning: autonomous systems need boring operational robustness before their interesting behavior can be trusted.

### Frontier Distance Scoring

The latest direction adds a frontier score so that curiosity can expand outward from the agent's self-context. This is not a hardcoded avoidance of local topics. It is an abstract pressure:

- Prefer semantic distance from the current self-context bundle.
- Penalize self-reference density.
- Penalize recursive stale-goal titles.
- Reward action affordance.
- Reward prediction-error and learning-progress proxies.
- Probe a small number of seed candidates.
- Log rejected candidates.

Learning: "farther away is more interesting" is too simple. The better rule is radius expansion: move outward until the topic is distant enough to surprise, but still structured enough to act on.

## Failure Modes Observed

### Passive Local Maintenance

The agent repeatedly inspected OpenClaw, the plugin, recent logs, retry state, and its own dashboard. This produced useful engineering maintenance, but it stayed close to the system's immediate periphery.

Learning: a self-improvement attractor is still an attractor. It can look productive while failing the broader curiosity goal.

### Self-Referential Goal Recursion

Repeated stale-goal followups produced titles such as:

```text
Re-evaluate stale goal: Re-evaluate stale goal: Follow up on autonomous goal...
```

Learning: recursive wrappers are a measurable symptom of local looping. They should reduce frontier value.

### Observation Masquerading as Curiosity

Some runs succeeded by reading files or checking docs but did not build, browse broadly, compare, test, simulate, or produce much new structure.

Learning: observing barely satisfies boredom. Interaction, experiment, and artifact creation matter more.

### Boredom Without Direction

When boredom reached 100 percent, the system still chose nearby goals if the candidate pool was local.

Learning: boredom should increase willingness to expand radius, not simply boost all existing goals.

### Dashboard Visibility Gaps

Before the Observatory, full messages and raw run details were hard to inspect. Telegram summaries were truncated and not enough for debugging.

Learning: curiosity research needs traceability: selected goals, rejected candidates, scores, raw output, tool actions, token usage, and timing.

### Token Accounting Gaps

Some runs reported `autonomousTokens24h: 0` or null token fields even though work happened.

Learning: cost tracking must become first-class if the agent is going to run unattended using API credits.

## Current Reward Direction

The next reward shape should treat curiosity as an expanding frontier search.

The agent starts near its broader self-context bundle, but boredom should gradually expand the radius. Nearby topics are not banned. They simply need unusually strong evidence of learning progress or action affordance to remain interesting.

The intended pressure is:

```text
curiosity_value =
  learning_progress
  + prediction_error
  + action_affordance
  + useful_semantic_distance
  - self_reference_density
  - stale_recursion
  - pure_noise
  - cost
  - risk
```

This keeps the spirit of "farther away is more interesting" while avoiding a trap where the agent chases random unreachable novelty.

## What "Good" Looks Like

A good autonomous run might:

- Browse a genuinely external source and decide whether it is worth continuing.
- Build a small artifact in a playground.
- Compare two unfamiliar domains and generate a testable analogy.
- Run a code experiment or simulation.
- Create a tiny tool that helps future curiosity.
- Notice that a source is not interesting and continue outward.
- Leave enough logs that the user can reconstruct the path.

A weak run:

- Only inspects the plugin.
- Only checks OpenClaw docs.
- Only rephrases prior goals.
- Uses tools but does not change the world or the agent's future options.
- Produces a summary with no raw trace.

## Open Questions

- How should the self-context bundle be defined without becoming a hardcoded list of forbidden topics?
- How much source sampling should happen before a candidate receives its final frontier score?
- Should semantic distance use embeddings, lexical approximation, or both?
- What is the minimal safe playground where the agent can create artifacts freely?
- How should token and API credit cost be tracked per run?
- How should the Observatory visualize candidate rejection, not just final selection?
- How do we compare models without contaminating later runs with prior model-specific memory?
- Can learning progress be estimated from logs without asking a separate evaluator model?
- When should a run continue searching instead of stopping after the first source?

## Practical Notes

Useful commands:

```bash
openclaw curiosity queue --limit 30
openclaw curiosity inspect <goal-id-or-run-id>
openclaw curiosity compare --window 24h
openclaw curiosity run --agent main --force true --surface workspace --notify false --timeout 900
openclaw curiosity run --agent main --force true --surface web --notify false --timeout 900
openclaw curiosity pause
openclaw curiosity resume
```

Useful dashboard:

```text
http://127.0.0.1:18789/curiosity#token=<gateway-token>
```

Operational gotchas:

- Run OpenClaw commands from an existing directory. If the current working directory was deleted, Node can fail with `uv_cwd`.
- If `/curiosity` returns `Unauthorized`, check the URL fragment token and browser session storage.
- If the service is active but nothing happens, inspect `selection_skipped` events and `blockedGoals`.
- If a goal stays `in_progress`, inspect gateway logs for executor crashes.

## Summary

The plugin began as a boredom-triggered autonomous task runner. The main learning so far is that boredom alone does not create satisfying curiosity. Without the right reward pressure, the system falls into local maintenance around its own tools and logs.

The current direction is to make curiosity a radius-expanding frontier process: still bounded, still observable, still safe, but much more willing to search outside its immediate self-context for sources, artifacts, and actions that could genuinely surprise it.
