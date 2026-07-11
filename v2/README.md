# Curiosity v2

Curiosity v2 is the separately installable successor experiment to the original Curiosity plugin. It replaces one-shot scored goals with persistent self, interest, project, experience, resource-request, and self-modification records.

This is the first foundation release. It deliberately keeps the original plugin untouched while the new developmental loop is tested.

## Stage 0

Stage 0 has no purchasing or payment capability. The agent may record why it wants a paid resource and what free alternatives it considered, but the plugin exposes no spending tool and never accepts financial credentials.

## Installation

```bash
npm install
npm run build
openclaw plugins install /absolute/path/to/curiosity/v2
openclaw plugins enable curiosity-v2
openclaw config set tools.alsoAllow '["curiosity_v2"]'
```

Use a heartbeat schedule to provide autonomous developmental turns. The plugin adds the current developmental memory and operating contract on heartbeat prompts. During ordinary user work it supplies compact continuity context.

## Stored state

State is stored per workspace at:

```text
<workspace>/.openclaw/curiosity-v2/development.db
```

The `curiosity_v2` tool lets the agent recall its snapshot and persist meaningful revisions. It cannot spend money. Self-modifications that describe weakening immutable kernel constraints are rejected, while actual code changes remain governed by OpenClaw's existing filesystem and approval controls.

The accepted product direction and boundaries are documented in [`../V2_PRODUCT_DECISIONS.md`](../V2_PRODUCT_DECISIONS.md).

## Current scope and next increments

The foundation establishes durable continuity, the autonomous developmental prompt, Stage 0 boundaries, and versioned self-modification records. Subsequent increments should add richer artifact and relationship records, consequence-return scheduling, an observatory, migration experiments, and an isolated self-modification test/deployment workflow.
