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
openclaw config set tools.alsoAllow '["curiosity_v2", "curiosity_web_fetch", "curiosity_note_write"]'
```

The plugin registers three optional tools:

- `curiosity_v2` — developmental memory (snapshot, interests, projects, turn reports, visits, self-modifications).
- `curiosity_web_fetch` — reads public web pages for exploration and evidence. Private/link-local/metadata addresses are blocked; redirects are re-validated.
- `curiosity_note_write` — writes durable artifacts under `<workspace>/creations/<year-month>/`. Path-jailed, extension-whitelisted, refuses silent overwrite.

All three must be allowed in OpenClaw tool policy or heartbeats will have nothing to act with. Set `allowWebFetch`/`allowNotes` to `false` in plugin config to remove them entirely.

## The developmental turn contract

Every heartbeat that receives the developmental prompt must end with a `record_turn` report: a mode plus either a concrete action (`kind`, `target`, `outcome`, `evidence`) or an honest `blockedReason`. `HEARTBEAT_OK` is only legitimate after an acted turn or a recorded block. Interests and projects can carry `nextReturnAt`; overdue ones surface as due hooks in every later snapshot. Visited locations are remembered so repetition requires justification.

Cold start runs a seeding protocol: inventory the environment, gather one or two real observations, propose exactly three candidate interests grounded in evidence, adopt the most alive one, and take its first concrete step immediately.

Budget honesty: only successful (and in-flight) heartbeats consume the daily run ceiling; failed model/auth attempts remain in the ledger for audit but never block future turns; token counts are recorded per run when the runtime reports them.

## Behavioral regression harness

```bash
npm test                       # unit contract tests (no network)
OPENAI_API_KEY=sk-... npm run simulate   # full simulated heartbeat against a real model
```

The simulator exits non-zero unless the model completes the turn contract (at least one acted `record_turn`). Run it after any prompt change.

Use a heartbeat schedule to provide autonomous developmental turns. During ordinary user work the plugin supplies compact continuity context.

## Stored state

State is stored per workspace at:

```text
<workspace>/.openclaw/curiosity-v2/development.db
```

The `curiosity_v2` tool lets the agent recall its snapshot and persist meaningful revisions. It cannot spend money. Self-modifications that describe weakening immutable kernel constraints are rejected, while actual code changes remain governed by OpenClaw's existing filesystem and approval controls.

The accepted product direction and boundaries are documented in [`V2_PRODUCT_DECISIONS.md`](V2_PRODUCT_DECISIONS.md).

## Current scope and next increments

The foundation establishes durable continuity, the autonomous developmental prompt, Stage 0 boundaries, and versioned self-modification records. Subsequent increments should add richer artifact and relationship records, consequence-return scheduling, an observatory, migration experiments, and an isolated self-modification test/deployment workflow.
