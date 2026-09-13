# OpenClaw Curiosity Plugin

`curiosity` is an overlay plugin that lets OpenClaw discover and pursue its own bounded goals during heartbeat-triggered runs.

## What it does

- Tracks drive signals from recent observations and idle state
- Scores them with several intrinsic-motivation-inspired heuristics
- Selects one high-value goal on heartbeat runs when the score clears a threshold
- Adds an idle-time boredom drive that can wake the agent into a self-authored intention
- Escalates bored runs toward one concrete, tool-backed, reversible outcome instead of a meta announcement or bare inspection
- Separates external meaningful activity from autonomous self-noise, with satiation after a curiosity run
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

## Config Shape

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
            "maxScoreBonus": 0.35,
            "wakeLevel": 0.65,
            "wakeCheckMinutes": 1,
            "wakeMinIntervalMinutes": 5,
            "satiationMinutes": 20
          },
          "actionPolicy": {
            "allowExternalActions": true,
            "externalTargetPolicy": "any-configured-surface",
            "disagreementFallback": "explore-anyway",
            "activeHours": "always-on"
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

- Heartbeat is the primary self-initiation trigger in v1.
- To limit curiosity selection by time of day, set `actionPolicy.activeHours` to `configured-window` and provide `actionPolicy.activeWindow` with `start`, `end`, and optional `timeZone` values.
- To get a heads-up when curiosity starts acting on its own, enable `notifications.autonomousStart` and set `telegram.botToken` plus `telegram.chatId`. The notice is sent only when a heartbeat selects an autonomous goal.
- Boredom starts growing after `boredom.idleStartMinutes`, reaches full strength at `boredom.saturationMinutes`, and can request a heartbeat once it reaches `boredom.wakeLevel`.
- Curiosity runs are self-authored: the plugin supplies drive state and neutral outcome criteria, not concrete task examples.
- Bored curiosity should pick its own topic by salience, uncertainty, leverage, and reversibility; the drive label is not treated as the topic.
- The first visible response should not be a run announcement when tools are available. The run should act first, then report the outcome and evidence.
- Observation-derived signals can still raise or lower priority, but selected curiosity runs are framed as self-authored intentions.
- The plugin only adds guardrails and autonomous-goal context. It does not bypass existing OpenClaw approvals or safety controls.
- The current implementation is heuristic and logging-heavy by design, so model comparisons are visible before any future learned policy is attempted.
