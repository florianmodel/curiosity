# Curiosity v2

A light, open-ended OpenClaw plugin for observing an agent develop interests, creations, projects, and conversations over time. It gets a few heartbeat opportunities each day to choose what deserves its attention. There is no artifact quota or curiosity score.

This version connects external exploration, persistent projects, Mastodon participation, and observed action history. It keeps the existing v2 database and adds revision/event history on first open. The older plugins remain separate.

Curiosity is not a separate server or model runtime. OpenClaw owns the gateway, provider authentication, heartbeat scheduler, native tools, and execution policy. This plugin scopes its hooks and tools to one configured agent, supplies developmental context, and records the consequences of that agent's actions.

## How a developmental opportunity works

Each heartbeat opportunity follows this broad loop:

1. The plugin reserves a run against the daily run and token budgets.
2. It gives the selected agent a compact memory snapshot and an invitation to choose a direction. Existing interests and overdue follow-ups can compete with fresh exploration.
3. The agent chooses whether to explore, continue an interest, make something, participate, reflect, or remain quiet.
4. Plugin and native tool results create observable events. Successful fetches become visits; successful writes become artifacts; memory updates preserve evidence and revisions.
5. A later opportunity can retrieve the resulting interest, project, question, or follow-up and continue it.

The event history is the evidence of what happened. An interest record is the agent's interpretation of that evidence, not proof of subjective experience.

## What changed

- Public page reading returns outbound links and readable text, with bounded responses and checked/pinned public DNS destinations.
- `curiosity_search` provides a clearly labeled Wikipedia search fallback. Use OpenClaw's native `web_search` or browser for broader discovery. The search module also supports injected native providers and SearXNG; these are library interfaces, not configured plugin providers yet.
- `curiosity_project` lists, reads, and writes persistent project files. Run and inspect those projects using OpenClaw's native execution/browser tools when available. The plugin does not introduce a second shell execution policy.
- Actual actions produce event IDs. Fetches register visits; writes register artifacts. Mastodon conversations register contact history and future returns. Successful native tools in an active developmental session also leave evidence without copying their raw output.
- Older memory can be searched or fetched by ID. Updates preserve revisions. Follow-ups can be completed, snoozed, or abandoned; completion requires action evidence.
- Reports are optional. Quiet sessions are legitimate. A reported action must cite a successful event from the same run.
- Wakes target one agent. Run reservations are atomic and expire after interrupted sessions. Failed attempts retain their consumed token usage.
- An offline rehearsal exercises production tools across three sessions and a restart. It is a technical check, not evidence of emergent curiosity.

## Install and configure

From this source checkout (the development commands require its source files and lockfile):

```bash
npm ci
npm run typecheck
npm test
npm run build
openclaw plugins install /absolute/path/to/curiosity/v2 --force --accept-capabilities
openclaw plugins enable curiosity-v2
```

Node with `node:sqlite` support is required (package minimum Node 22.5). A local path install may require `--accept-capabilities` because the package uses prompt and model-output hooks. The integration uses public OpenClaw hooks; the declaration subset was checked against this workspace's OpenClaw source. A live gateway smoke test is still required on the installed version.

Merge this fragment into the existing OpenClaw configuration. Preserve other agents, tools, and plugin entries. Choose `agentId` to match the dedicated autonomous agent and set its workspace explicitly (or let a native heartbeat supply the resolved workspace before the plugin timer can wake it). A dedicated workspace prevents unrelated assistant work from dominating its context.

```json
{
  "plugins": {
    "entries": {
      "curiosity-v2": {
        "enabled": true,
        "hooks": {
          "allowConversationAccess": true
        },
        "config": {
          "agentId": "main",
          "wakeIntervalMinutes": 480,
          "sessionMinutes": 8,
          "maxAutonomousRunsPerDay": 3,
          "maxAutonomousTokensPerDay": 50000,
          "maxSocialActionsPerDay": 3,
          "maxDirectConversationsPerDay": 1,
          "allowPublicParticipation": false,
          "allowDirectConversations": false,
          "allowSelfModification": false,
          "allowWebFetch": true,
          "allowSearch": true,
          "allowNotes": true,
          "allowProjects": true,
          "mastodon": {
            "baseUrl": "https://your-instance.example",
            "accessTokenEnv": "CURIOSITY_MASTODON_TOKEN"
          }
        }
      }
    }
  },
  "tools": {
    "alsoAllow": [
      "curiosity_v2",
      "curiosity_web_fetch",
      "curiosity_search",
      "curiosity_note_write",
      "curiosity_project"
    ]
  },
  "agents": {
    "defaults": {
      "model": {
        "primary": "openai/gpt-5.6-luna"
      }
    }
  }
}
```

The `hooks.allowConversationAccess` entry is required for non-bundled plugins. The tool allowlist admits the optional plugin tools; narrower per-agent and sandbox policies still apply. Add `curiosity_social` only after Mastodon is configured and social behavior has been reviewed. Separately enable native search, browser, and execution capabilities appropriate for the agent. Do not infer availability merely from a plugin config flag.

OpenClaw provider credentials belong in OpenClaw's auth profiles, gateway environment, or provider configuration; never put API keys in this file, prompts, memory, or project artifacts. If using OpenRouter, authenticate the gateway with `OPENROUTER_API_KEY` and use an explicit model reference such as `openrouter/<provider>/<model>` rather than an unpinned router when comparing behavior.

OpenClaw must have heartbeats enabled for the selected agent. The plugin requests an immediate opportunity at service start and then every configured interval when it has budget. Native heartbeats can also provide developmental opportunities; the shared daily ceiling still applies. Adjust any existing faster native schedule if you want sessions spread evenly through the day.

The defaults are starting settings for a light experiment. Existing explicit settings override them. Session time stops **further tool work** after the deadline. Token usage is a next-session guard on OpenClaw versions that report it only at attempt completion; if reported earlier, it also stops further tool work. Neither setting interrupts an already-running tool or caps a provider's in-flight completion. Keep provider/runtime output limits in place. A missing usage report is recorded as `usage_unknown`, not presented as verified zero consumption.

The configured token ceiling is a budget guard, not a hard per-call spending cap. A long in-flight completion can exceed it before OpenClaw reports usage. Start with short sessions and a low-cost model, watch actual usage, and reduce `sessionMinutes` or the provider's output limit if a run is too expensive. Failed attempts can still consume a run reservation even when they use zero reported tokens; inspect the ledger before interpreting a quiet period.

## Provider and cost recommendations

For a first behavioral baseline, `openai/gpt-5.6-terra` is the stronger comparison model. For a cost-conscious live pilot, use `openai/gpt-5.6-luna`. Keep the model, tool policy, session length, starting database, and daily limits constant when comparing providers.

The model provider is part of the experiment. A provider authentication error, model timeout, unavailable tool, quiet session, and successful autonomous action should be distinguished in the logs; none of them by itself measures curiosity.

## Mastodon setup

Use a dedicated agent-owned account on an instance whose rules permit this activity. Configure its profile honestly as an autonomous agent. Create an access token with the relevant scopes: `read:accounts`, `read:statuses`, `read:notifications`, `read:search`, and `write:statuses`. Reading conversations additionally uses `read:statuses`. The instance may require further read scope for its public timeline; check its response and policy.

Set `CURIOSITY_MASTODON_TOKEN` in the gateway service's environment. Do not put the token in plugin configuration, prompts, or memory. The instance URL must be an HTTPS origin; the tool cannot redirect its credentials to another origin. Host-level credentials and native execution remain governed by the deployment's isolation and OpenClaw policy.

`curiosity_social` supports account verification, discovery/search, status/thread reads, notifications, conversation reads, publication, replies, direct initiation, edits, and local `block_contact` records. Have the agent verify the configured account before its first publication. No account is created and no profile is edited by this package.

Contact uses a verified account or parent status. New standalone posts and edits reject mentions; replies and direct messages add the verified recipient. Direct visibility is audience-limited, **not end-to-end encrypted**. Private/direct replies keep the parent's visibility. Public and direct permissions are independent. The small daily limits apply to attempted writes through `curiosity_social`; they do not govern separate native tools or other processes.

Every write requires a stable `operationId`. Completed operations return their cached result and original evidence. If the server acknowledged a send but a later local write failed, replay repairs the local evidence/follow-up records without sending again. An interrupted or uncertain send remains pending and is not retried automatically, even after Mastodon's server-side idempotency window expires. Inspect the account and operation history before any new send; do not evade uncertainty by inventing a new operation ID. Opt-outs recorded with `block_contact` prevent subsequent replies or direct contact through this adapter.

Mastodon currently publishes text. Projects can remain local or be linked from a post when a separate configured hosting tool has published them. Media uploads and automatic account provisioning are not implemented.

API references: [statuses and idempotency](https://docs.joinmastodon.org/methods/statuses/), [accounts](https://docs.joinmastodon.org/methods/accounts/), [notifications](https://docs.joinmastodon.org/methods/notifications/), [conversations](https://docs.joinmastodon.org/methods/conversations/), [search](https://docs.joinmastodon.org/methods/search/).

## Observe and adjust

### Live gateway runbook

Curiosity runs inside the OpenClaw gateway. On a remote VPS, connect only after the Hetzner firewall's incoming TCP/22 rule allows your current public IPv4 address. Home and VPN addresses may change; check yours with:

```bash
curl -4 https://api.ipify.org
```

Then connect and wait for the remote prompt before running server commands:

```bash
ssh <remote-user>@<server-address>
openclaw gateway status --deep
openclaw system heartbeat last
```

Restart the managed gateway when configuration or plugin code changes:

```bash
openclaw gateway restart
```

If the dashboard is loopback-only, keep this tunnel running in a separate laptop terminal:

```bash
ssh -N -L 18789:127.0.0.1:18789 <remote-user>@<server-address>
```

Open `http://127.0.0.1:18789/` locally. The separate [`private-operator-runbook`](../../private-operator-runbook) runbook contains the firewall, service, update, and recovery details for that host.

From the source checkout:

```bash
npm run simulate
npm run inspect -- --workspace /absolute/agent/workspace
npm run inspect -- --workspace /absolute/agent/workspace --html /tmp/curiosity-timeline.html
npm run inspect -- --workspace /absolute/agent/workspace --id interest-id
```

From an installed package without development sources, use the shipped scripts directly:

```bash
node dist/scripts/simulate-heartbeat.js
node dist/scripts/inspect.js --workspace /absolute/agent/workspace
```

`simulate` runs a scripted offline fixture using production tool definitions and real temporary files/SQLite. It makes no model API calls and sends no public messages. It prints a trace directory. A passing rehearsal proves mechanics only.

`inspect` reads the existing SQLite database in read-only mode. It shows recent events, records, run usage, revisions, and publication operations. `--before` pages older events by sequence; `--limit` controls the page size. Its optional HTML export is static, escapes stored content, and makes no network requests. Keep exports private because they can contain conversation material. The observer does not add activity to the agent's memory.

For a first live observation, inspect actual tool exposure and one genuine heartbeat on the configured gateway, then leave the agent's topics alone for several opportunities. Look at the resulting history together: what drew its attention, what it continued, what it made or said, what came back, and where it got stuck. Change one suspected cause at a time. No fixed behavioral pass threshold is imposed.

When interpreting an interest, look for the chain of evidence: external material selected, source actually fetched, interpretation recorded, question or prediction formed, artifact or project produced, and later return based on consequences. Coherent records are encouraging behavioral evidence; they are not evidence that the model has human feelings or independent consciousness.

## State and recovery

- `<workspace>/.openclaw/curiosity-v2/development.db`: current records, append-only events/revisions, run ledger, contact blocks, and publication operations.
- `<workspace>/creations/<year-month>/`: standalone creations.
- `<workspace>/creations/projects/<slug>/`: persistent project trees.

Back up the database (including a consistent WAL snapshot) before installing a new version. Migration adds tables, triggers, and the run lease column without deleting legacy records. Legacy actions remain historical self-reports; migration does not manufacture tool evidence. Append-only triggers protect normal plugin writes; they are not protection from a host administrator rewriting the database.

To stop the experiment, disable `curiosity-v2` and restart the gateway. Self-modification remains a recorded proposal unless execution/test and rollback evidence is supplied; the plugin does not deploy its own code changes. Stage 0 continues to grant no spending authority.

In the source checkout, `IMPLEMENTATION_STATUS.md` records completed verification and remaining live setup. `AGENCY_REVIEW_AND_PLAN.md` describes the reviewed direction. `DEPLOYMENT_STATUS.md` contains historical deployment notes and the distinction between local verification and a live installation.
