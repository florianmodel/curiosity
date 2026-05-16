# OpenClaw Curiosity Plugin

`curiosity` is an overlay plugin that lets OpenClaw discover and pursue its own bounded goals during heartbeat-triggered runs.

## What it does

- Tracks drive signals from recent observations
- Scores them with several intrinsic-motivation-inspired heuristics
- Selects one high-value goal on heartbeat runs when the score clears a threshold
- Adds an idle-time boredom drive that can wake a self-authored run
- Optionally sends a Telegram notice when an autonomous curiosity run starts
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
            "autonomousRunsPerDay": 48,
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
            "idleStartMinutes": 2,
            "saturationMinutes": 15,
            "maxScoreBonus": 0.35,
            "wakeLevel": 0.25,
            "wakeCheckMinutes": 0.5,
            "wakeMinIntervalMinutes": 5,
            "satiationMinutes": 5
          },
          "actionPolicy": {
            "allowExternalActions": true,
            "externalTargetPolicy": "any-configured-surface",
            "disagreementFallback": "explore-anyway",
            "activeHours": "always-on",
            "minimumSensingSteps": 2,
            "maxAttemptsPerGoal": 2,
            "retryCooldownMinutes": 120
          },
          "notifications": {
            "autonomousStart": {
              "enabled": true,
              "provider": "telegram",
              "telegram": {
                "botToken": "123456:telegram-bot-token",
                "chatId": "123456789"
              },
              "minIntervalMinutes": 0,
              "includeEvidence": true
            }
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

- Heartbeat remains a selection surface, and boredom can proactively request a heartbeat once the drive crosses `boredom.wakeLevel`.
- To limit curiosity selection by time of day, set `actionPolicy.activeHours` to `configured-window` and provide `actionPolicy.activeWindow` with `start`, `end`, and optional `timeZone` values.
- To get a heads-up when curiosity starts acting on its own, enable `notifications.autonomousStart` and set `telegram.botToken` plus `telegram.chatId`. The notice is sent only when a heartbeat selects an autonomous goal.
- Boredom starts growing after `boredom.idleStartMinutes`, reaches full strength at `boredom.saturationMinutes`, contributes up to `boredom.maxScoreBonus`, and is suppressed for `boredom.satiationMinutes` after an autonomous run.
- Curiosity prompts carry drive signals and constraints; the agent must author its own bounded intention from inside the run.
- Infrastructure failures and repeated goal fingerprints are damped so curiosity does not orbit its own gateway errors.
- `failedToolAttempts` and `skillOpportunities` default off; enable them only when you want meta-maintenance to compete with boredom-driven exploration.
- The plugin only adds guardrails and autonomous-goal context. It does not bypass existing OpenClaw approvals or safety controls.
- The current implementation is heuristic and logging-heavy by design, so model comparisons are visible before any future learned policy is attempted.
