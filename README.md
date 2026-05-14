# OpenClaw Curiosity Plugin

`curiosity` is an overlay plugin that lets OpenClaw discover and pursue its own bounded goals during heartbeat-triggered runs.

## What it does

- Builds explicit candidate goals from recent observations
- Scores them with several intrinsic-motivation-inspired heuristics
- Selects one high-value goal on heartbeat runs when the score clears a threshold
- Adds an idle-time boredom drive so prolonged inactivity eventually creates/boosts a bounded workspace goal
- Logs every scored goal, selected goal, external action, and token budget event
- Exposes queue/inspect/compare/pause/resume surfaces through both a tool and CLI

## Scorer families

- `rnd_novelty`: rewards low-frequency topics and surfaces
- `episodic_reachability`: rewards goals far from recent interaction history
- `plan2explore_uncertainty`: rewards goals that likely reduce uncertainty
- `impact_progress`: rewards likely state change and unblock value
- `llm_curriculum_reflection`: rewards reusable patterns and self-improvement opportunities
- `boredom_drive`: rewards action after meaningful activity has been absent long enough

The active policy combines novelty, uncertainty, progress, curriculum, and boredom, then subtracts cost and risk penalties. Shadow scores are logged side-by-side for comparison.

## Storage

For each workspace, the plugin writes:

- SQLite state: `<workspace>/.openclaw/curiosity/curiosity.db`
- Immutable audit logs: `<workspace>/.openclaw/curiosity/events-YYYY-MM-DD.jsonl`

## Installation

```bash
npm install
npm run build
openclaw plugins install /absolute/path/to/openclaw-curiosity
openclaw plugins enable curiosity
openclaw config set tools.allow '["curiosity_inspect"]'
```

If `curiosity` is already installed from a local path, rebuild first and replace the tracked install with `--force` instead of running a plain install:

```bash
npm install
npm run build
openclaw plugins install --force /absolute/path/to/openclaw-curiosity
openclaw gateway restart
```

The plugin expects a Node runtime with `node:sqlite` support, which means Node 22.5+ in practice.

## Example Config

```json
{
  "plugins": {
    "entries": {
      "curiosity": {
        "enabled": true,
        "config": {
          "budgets": {
            "autonomousRunsPerDay": 10,
            "autonomousTokensPerDay": 50000,
            "externalActionsPerDay": 3,
            "externalActionsPerHour": 1
          },
          "thresholds": {
            "act": 0.6,
            "staleGoalHours": 24,
            "recentObservationWindowHours": 72
          },
          "boredom": {
            "enabled": true,
            "idleStartMinutes": 5,
            "saturationMinutes": 60,
            "maxScoreBonus": 0.35
          },
          "actionPolicy": {
            "allowExternalActions": true,
            "externalTargetPolicy": "any-configured-surface",
            "disagreementFallback": "explore-anyway",
            "activeHours": "always-on"
          }
        }
      }
    }
  }
}
```

## CLI

```bash
openclaw curiosity queue
openclaw curiosity inspect <goal-id-or-run-id>
openclaw curiosity compare --window 24h
openclaw curiosity pause
openclaw curiosity resume
```

## Notes

- Heartbeat is the primary self-initiation trigger in v1.
- To limit curiosity selection by time of day, set `actionPolicy.activeHours` to `configured-window` and provide `actionPolicy.activeWindow` with `start`, `end`, and optional `timeZone` values.
- Boredom starts growing after `boredom.idleStartMinutes`, reaches full strength at `boredom.saturationMinutes`, and contributes up to `boredom.maxScoreBonus` to candidate scores. Once active, it also creates a safe workspace goal if no normal candidate exists.
- Candidate goals are derived from user asks, stale goals, failed tools, new entities, low-coverage surfaces, reusable skill patterns, and follow-ups from earlier autonomous runs.
- The plugin only adds guardrails and autonomous-goal context. It does not bypass existing OpenClaw approvals or safety controls.
- The current implementation is heuristic and logging-heavy by design, so model comparisons are visible before any future learned policy is attempted.
