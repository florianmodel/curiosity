# Wander

A radius-expanding autonomous curiosity plugin for OpenClaw. It is a ground-up
rewrite of the `curiosity` plugin, built around the central learning from that
experiment: **boredom is a good trigger but a weak compass**, and template-based
candidates with lexical scoring inevitably collapse into local self-maintenance.

## What it does

When the agent has been idle long enough, Wander runs one bounded cycle:

1. **Generate.** The agent's *own model* is asked to author N concrete candidate
   curiosities — real subjects in the world, each with a first action and an
   expected artifact. What a model finds interesting is the research subject, so
   generation goes through the same gateway agent rather than a fixed side model.
   Grounded heuristic candidates (open user asks, failed tool attempts) are added
   to the same pool.
2. **Score.** Each candidate is embedded (OpenAI `text-embedding-3-small`) and
   compared against a *self-context bundle* (recent activity + recently visited
   territory). The reward shape is an expanding frontier search:

   ```
   curiosity_value =
       learning_progress_prior
     + prediction_error
     + action_affordance
     + frontier_fit            (distance near the boredom-scaled target radius)
     + territory_novelty
     - self_similarity         (scaled by boredom)
     - recursion_penalty       (self-wrapping titles)
     - noise_penalty           (structureless, unactionable)
     - saturation_penalty      (near an exhausted region)
     - cost - risk
   ```
3. **Select & run.** The top eligible candidate runs as one bounded OpenClaw turn
   with a visible playground directory it may create artifacts in. It must take a
   minimum number of tool-backed steps and end with a structured `wander-report`.
4. **Remember.** The report folds into a **persistent exploration map**: visited
   topics, their learning-progress estimates, and saturation. Revisiting a region
   that stopped teaching raises its saturation, which pushes future curiosity
   outward. The map is the long-term memory radius expansion is measured against.

Every candidate (selected *and* rejected) is logged with its full score vector,
so the negative space — *why* the agent did not chase something — is inspectable.

## How it differs from v1 (`curiosity`)

| v1 failure mode | Wander's response |
| --- | --- |
| Self-referential attractor; runs inspected the plugin/logs | LLM-authored candidates name real external subjects; self-context similarity is penalized with real embedding distance, not keyword overlap |
| Template candidates with no topic content to score | Candidates carry concrete topic, first action, and expected artifact |
| Lexical "frontier distance" too weak to separate topics | Cosine distance from `text-embedding-3-small`, normalized to a usable band |
| No memory of where it had been | Persistent territory map with learning-progress + saturation |
| "Tool use" ≠ "interesting action" | Structured self-report (surprise, learning progress, artifacts) drives the map; observation-only runs leave a weak report |
| Self-refreshing retry cooldown kept the system looking alive | Retry cooldown keyed to `outcome.finishedAt`, never to `updatedAt` |
| Recursive stale-goal title wrappers | Explicit recursion-shape penalty in scoring |

When no embedding API key is present, scoring degrades to a lexical fallback and
every score is flagged `degraded_distance: true` so logs stay honest.

## Cross-model comparison

The territory map and all goal/run state live under
`<workspace>/.openclaw/wander/`. To compare two models cleanly, run each against a
fresh workspace (or archive the `wander.db`) so neither inherits the other's
exploration history. Scoring inputs (embeddings, weights, radius) are identical
across models; only the generation step — what the model chooses to be curious
about — varies, which is exactly the behavior under study.

## Setup

```bash
export OPENAI_API_KEY=sk-...   # for embeddings; configurable via embeddings.apiKeyEnv
npm install
npm run build
```

Point OpenClaw at `./dist/index.js` (see `package.json` → `openclaw.extensions`).

## CLI

```bash
openclaw wander status          # boredom, budgets, embedding availability, recent territory
openclaw wander queue           # recent candidate goals + curiosity scores
openclaw wander map             # the persistent exploration map
openclaw wander inspect <id>    # full trace for a goal or run
openclaw wander generate        # dry run: generate + score, execute nothing
openclaw wander run             # force one full cycle now
openclaw wander pause / resume
```

## State layout

```
<workspace>/.openclaw/wander/wander.db          # goals, territory, observations, events, embedding cache
<workspace>/.openclaw/wander/events-YYYY-MM-DD.jsonl
<workspace>/.openclaw/wander/raw/YYYY-MM-DD/<run-id>/
<workspace>/wander-playground/<date>-<topic>/   # agent-created artifacts
```

## Open questions deliberately left to iterate on

- Learning-progress is currently the agent's self-estimate plus map-based EMA; a
  log-derived estimator could replace the self-report.
- The territory merge threshold and saturation dynamics are heuristic and worth
  tuning against real runs.
- The Observatory web dashboard from v1 is not yet ported; CLI + JSONL is the
  current inspection surface.
