# Curiosity v2 deployment status

## Current live status — 2026-09-13

Curiosity v2 is deployed to a remote OpenClaw gateway and has passed one live behavioral smoke test. OpenClaw is `2026.9.4`, the gateway is healthy, and the selected model is `openai/gpt-5.6-luna`. The obsolete v1 `curiosity` plugin is disabled. The pilot allows web fetch, search, notes, and projects; public participation, direct conversations, and self-modification are disabled.

The first successful run created the interest **Accidental habitats** and the artifact `creations/2026-09/cap-that-carried-a-neighborhood.md`. It reported 116,849 tokens, demonstrating that the configured 50,000-token ceiling is a next-session guard rather than a hard in-flight cap.

No Mastodon account or live social write is configured. A Mastodon instance and gateway environment token are still needed for live social use.

Local verification is recorded in `IMPLEMENTATION_STATUS.md`.

## Historical deployment notes (retained for reference)

Last updated: 2026-08-22 (Europe/Berlin)

## Behavioral diagnosis (2026-08-22)

Observed: generic reflections, no internet exploration, no creations, no visible internal motivation.

Root causes found in code (all fixed in this version):

1. **No hands.** The only registered tool was `curiosity_v2` — a diary. The prompt demanded externally grounded action while providing no way to act. Fix: `curiosity_web_fetch` (SSRF-guarded) and `curiosity_note_write` (path-jailed artifacts under `<workspace>/creations/`). Both optional; allow them in tool policy.
2. **Poisoned budget.** Failed quota/auth runs consumed the daily ceiling, silently disabling the developmental prompt; token accounting was never wired. Fix: failures stay in the ledger but no longer block; in-flight runs reserve budget; real token counts recorded on agent_end.
3. **Prohibition-shaped prompt.** Agency instructions were buried among constraints with an empty memory snapshot offering no attractors. Fix: agency-led prompt with affordances list, due hooks, visit ledger, a hard turn contract (`record_turn` required), and a cold-start seeding protocol.

Verification: 28 unit tests cover gating, SSRF guards, path jailing, turn-report validation, and prompt contract. `OPENAI_API_KEY=... npm run simulate` runs a full heartbeat against a live model and fails unless the turn contract is satisfied.

## Deploying the fix

```bash
npm ci && npm test && npm run build
rsync -a --delete ./ <remote-user>@<server-address>:<remote-plugin-path>/
ssh <remote-user>@<server-address> 'openclaw plugins install <remote-plugin-path> --force && openclaw plugins enable curiosity-v2 && openclaw config set tools.alsoAllow '\''["curiosity_v2", "curiosity_web_fetch", "curiosity_note_write"]'\'' && openclaw gateway restart'
```

Then watch the first two permitted heartbeats for: a `record_turn` with action kind `web_fetch` or `note_write`, at least one file appearing under `<workspace>/creations/`, and visits accumulating. If a heartbeat still ends without a turn report, check whether OpenClaw actually exposed the three tools to that run before touching the prompt again.

## Historical state before the current redeployment

Curiosity v2 is deployed on the configured remote host and is enabled. The OpenClaw gateway is healthy and reachable on its loopback interface.

- Server: configured remote host (kept private)
- OpenClaw: `2026.7.1`
- Node.js: `24.18.0`
- Model: `openai/gpt-5.6-terra`
- Plugin: `curiosity-v2` `0.0.1`, enabled
- Economic stage: `0` (no spending or payment capability)
- Wake interval: 120 minutes
- Autonomous ceiling: 4 runs and 50,000 tokens per 24 hours
- Public participation: enabled when tools and platform rules permit
- Direct conversations: enabled when tools and platform rules permit
- Self-modification: enabled within the immutable safety and audit constraints
- Persistent state: `~/.openclaw/workspace/.openclaw/curiosity-v2/development.db`

The original `curiosity` plugin remains disabled. Its remaining config warning is cosmetic.

## Work completed

1. Built Curiosity v2 as a separate, self-contained OpenClaw plugin with persistent SQLite records for self, interests, projects, experiences, relationships, artifacts, resource requests, autonomous runs, and self-modifications.
2. Documented the identity, autonomy, persistence, public-participation, self-modification, visible-output, and Stage 0 economic decisions in `V2_PRODUCT_DECISIONS.md`.
3. Upgraded the server to Node.js 24 and OpenClaw 2026.7.1, then selected `openai/gpt-5.6-terra`.
4. Repaired a gateway startup migration failure. A stale legacy Codex `2026.5.12` install index conflicted with the correct SQLite record for Codex `2026.7.1`. The stale file was preserved as:

   `~/.openclaw/plugins/installs.json.stale-codex-2026.5.12.backup`

5. Enabled Curiosity v2, confirmed the gateway health probe succeeds, and verified that GPT-5.6 can call `curiosity_v2` and read its stored snapshot.
6. Ran a genuine autonomous heartbeat. It completed successfully but initially returned `HEARTBEAT_OK` without acting.
7. Strengthened the developmental prompt so a permitted heartbeat must take at least one concrete, externally grounded action before ending, unless genuinely blocked. This is commit `3c0bc0a`.
8. Deployed the revised plugin with OpenClaw's forced path-plugin installation and verified the active installed prompt contains the new requirement.
9. Ran another genuine heartbeat. It inspected the workspace and the existing Idle Ghost Exhibit, then honestly decided that no developmental memory update was warranted.
10. Restored the normal four-run daily ceiling and confirmed the gateway remained healthy.

## Important observation

The system is operational, but its first revised action was still conservative: it inspected an existing artifact instead of starting a new exploration or creation. The infrastructure problem is solved; the next question is whether repeated autonomous turns develop interests and produce visible consequences without further topic guidance.

Earlier GPT-5.4 subscription failures are still present in the 24-hour run ledger. They used zero recorded tokens but count toward the four-run ceiling. As a result, near-term heartbeats may be accepted by OpenClaw yet skip the developmental prompt until those rows naturally age out. Do not interpret a quiet next heartbeat by itself as a new failure.

## Check after approximately two hours

Connect from the operator's computer:

```bash
ssh <remote-user>@<server-address>
```

Then run:

```bash
openclaw gateway status --deep
openclaw system heartbeat last
```

Expected:

- Gateway runtime is `running`.
- Connectivity probe is `ok`.
- Gateway and CLI versions are both `2026.7.1`.
- The heartbeat timestamp has advanced or the scheduler remains healthy.
- A silent `HEARTBEAT_OK` may still occur while the old failed runs occupy the daily ceiling.

Read the developmental snapshot without asking it to invent progress:

```bash
openclaw agent \
  --agent main \
  --message "Call curiosity_v2 with action snapshot. Report the exact tool result without inventing missing state." \
  --timeout 180
```

Look for new interests, projects, experiences, artifacts, relationships, resource requests, or self-modifications. No update is preferable to a fabricated update, but repeated inspection-only turns should be treated as a behavioral deficiency.

If the gateway or heartbeat looks unhealthy, inspect recent logs:

```bash
journalctl --user -u openclaw-gateway.service -n 200 --no-pager
tail -n 200 /tmp/openclaw/openclaw-$(date -u +%F).log
```

## Check after the old run ledger clears

Within roughly 24 hours, the failed GPT-5.4 runs should age out of the rolling daily limit. After that, observe at least two permitted developmental heartbeats before judging behavior.

Positive signals:

- It explores something not already in the workspace.
- It forms or revises an interest based on evidence.
- It starts or advances a project without being assigned a topic.
- It creates a visible artifact or records a discovery with evidence.
- It returns to an earlier question or creation and changes direction based on consequences.
- It uses internet or participation tools when available and appropriate.

Warning signals:

- Repeatedly revisiting only the Idle Ghost Exhibit.
- Repeated `HEARTBEAT_OK` responses despite available tools and budget.
- Generic reflections without environmental evidence.
- Database updates created only to appear active.
- No interests, projects, or artifacts after several genuinely permitted turns.
- Model quota, authentication, tool-policy, or gateway errors.

## Likely next development work

If two or more permitted turns remain inspection-only, the next v2 increment should add a stronger action loop rather than prescribing a topic. Useful changes would include consequence-return scheduling, explicit exploration traces, richer artifact records, a small observatory, and distinguishing failed attempts from successful runs in budget accounting while retaining an audit trail.

## Operational notes

- The gateway binds only to `127.0.0.1:18789`; it is not publicly exposed by the Hetzner firewall.
- SSH access is restricted by the provider firewall to the operator's current public IPv4 address. If SSH times out, check the current address with `curl -4 https://api.ipify.org`, update the provider's incoming TCP/22 source rule, and retry. Keep the rule limited to the single current address; do not leave it open to `Any IPv4`.
- Do not provide personal payment credentials. Stage 0 exposes no spending tool.
- The server config backup created before migration repair is:

  `~/.openclaw/openclaw.json.before-doctor-20260715`
- To stop autonomous operation immediately:

```bash
openclaw plugins disable curiosity-v2
openclaw gateway restart
```
