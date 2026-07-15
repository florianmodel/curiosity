# OpenClaw Curiosity Plugin

`curiosity` is an executor-backed plugin that lets OpenClaw discover and pursue its own bounded goals without waiting for a user prompt.

## What it does

- Tracks drive signals from recent observations
- Scores them with several intrinsic-motivation-inspired heuristics
- Selects one high-value goal when the score clears a threshold
- Adds an idle-time boredom drive that can start an executor-backed self-authored run
- Escalates bored runs toward one concrete, tool-backed, reversible outcome instead of a meta announcement or bare inspection
- Sends autonomous result receipts through the configured Telegram notice path, with background boredom runs suppressing the start notice by default
- Serves a gateway-authenticated Curiosity Observatory at `/curiosity` for run traces, raw observation logs, budget state, and pause/resume/start controls
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
- Raw observation sidecars: `<workspace>/.openclaw/curiosity/raw/YYYY-MM-DD/<run-id>/*.txt`

## Installation

```bash
npm install
npm run build
openclaw plugins install /absolute/path/to/openclaw-curiosity
openclaw plugins enable curiosity
openclaw config set tools.alsoAllow '["curiosity_inspect"]'
```

Use `tools.alsoAllow` so the plugin tool is added without narrowing the rest of the agent's tool affordances. Setting `tools.allow` to only `curiosity_inspect` will intentionally leave autonomous web runs with no web tools.

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
            "externalActionsPerDay": 24,
            "externalActionsPerHour": 6
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
          "logging": {
            "retentionDays": 100,
            "maxStorageBytes": 10737418240,
            "verbose": false
          },
          "actionPolicy": {
            "allowExternalActions": true,
            "externalTargetPolicy": "any-configured-surface",
            "disagreementFallback": "explore-anyway",
            "activeHours": "always-on",
            "minimumSensingSteps": 2,
            "maxAttemptsPerGoal": 2,
            "retryCooldownMinutes": 5
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
              "includeEvidence": true,
              "observatoryBaseUrl": "https://your-dashboard.example"
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
openclaw curiosity run --agent main --force true --timeout 900
openclaw curiosity run --agent main --force true --surface web --notify false --timeout 900
openclaw curiosity pause
openclaw curiosity resume
```

## Curiosity Observatory

Open the gateway dashboard and visit `/curiosity` on the same host, for example:

```bash
openclaw dashboard --no-open
# then open http://127.0.0.1:18789/curiosity#token=<gateway-token>,
# or the same remote dashboard origin plus /curiosity#token=<gateway-token>
```

The page shell loads at `/curiosity`, then uses the gateway token from the URL fragment for `/curiosity/api/*` calls. The page is read-heavy by design: it shows recent runs, goals, events, observations, raw sidecar links, boredom state, token counts, and retention settings. It also exposes only coarse controls: start one selection run, pause, and resume.

## Notes

- Heartbeat remains a selection surface, but boredom now starts the curiosity executor directly once the drive crosses `boredom.wakeLevel`.
- To limit curiosity selection by time of day, set `actionPolicy.activeHours` to `configured-window` and provide `actionPolicy.activeWindow` with `start`, `end`, and optional `timeZone` values.
- To get curiosity receipts, enable `notifications.autonomousStart` and set `telegram.botToken` plus `telegram.chatId`. Manual CLI runs can still send a start notice, while background boredom runs send the completion/failure receipt without a start announcement.
- Telegram receipts intentionally stay short; use `/curiosity?run=<run-id>` for the richer trace.
- Set `notifications.autonomousStart.observatoryBaseUrl` to the dashboard origin if you want Telegram receipts to include a clickable run trace link.
- Boredom starts growing after `boredom.idleStartMinutes`, reaches full strength at `boredom.saturationMinutes`, contributes up to `boredom.maxScoreBonus`, and is suppressed for `boredom.satiationMinutes` after an autonomous run.
- Frontier scoring expands the search radius under boredom, rewards semantic distance from recent self-context, penalizes self-reference density and recursive titles, and logs candidate rejection reasons for later model comparison.
- Curiosity executor runs carry drive signals, neutral outcome criteria, and constraints; the agent must author its own bounded intention from inside the run.
- Bored curiosity should pick its own topic by salience, uncertainty, leverage, and reversibility; the drive label is not treated as the topic.
- The first visible background notification should be the outcome receipt. The run should act first, then report the outcome and evidence.
- Web-targeted executor runs preflight `web_search`, `web_fetch`, and `browser` availability. If runtime policy has removed all web affordances, the run records a `NO_SENSING_AFFORDANCE` blocker instead of launching a narrative-only agent turn.
- For smoke tests, `openclaw curiosity run --force true --surface web` creates a manual web goal and bypasses the scorer threshold; normal background autonomy still uses the policy scorer.
- Tool events are correlated back to the active curiosity run id even when the gateway reports an inner run id, so qualifying sensing steps are counted against the selected goal.
- External follow-up goals are created only from successful, completed, non-follow-up prior goals; failed runs do not feed a nested "Follow up on..." loop.
- `curiosity_inspect` is useful for human/debug inspection, but it does not count as a qualifying autonomous sensing step by itself.
- Infrastructure failures and repeated goal fingerprints are damped so curiosity does not orbit its own gateway errors.
- `failedToolAttempts` and `skillOpportunities` default off; enable them only when you want meta-maintenance to compete with boredom-driven exploration.
- The plugin only adds guardrails and autonomous-goal context. It does not bypass existing OpenClaw approvals or safety controls.
- The current implementation is heuristic and logging-heavy by design, so model comparisons are visible before any future learned policy is attempted.
