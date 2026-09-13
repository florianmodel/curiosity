# Local implementation status — 2026-09-12

Implemented in this repository using Luna subagents for memory, exploration, Mastodon, tests, and review. It has since been deployed to the Hetzner OpenClaw gateway and passed one live behavioral smoke test. It remains an early experiment, not a behaviorally validated product.

## Available behavior

- A few brief developmental opportunities: defaults of eight minutes, every eight hours, at most three runs per rolling day.
- External page exploration with outbound links, a labeled Wikipedia search fallback, and prompts to use native OpenClaw search/browser tools for broader discovery.
- Persistent project files, interests, personality records, relationships, creations, and follow-ups across sessions and restarts.
- Searchable memory and revision history, with successful tool events supporting reported actions instead of treating self-reports as execution evidence.
- Mastodon discovery, publishing, replies, and direct initiation through a configured agent-owned account; daily action limits, contact opt-outs, and durable send recovery.
- Optional quiet sessions and a read-only observer, without a production quota or predefined behavioral success threshold.

## Verification completed

- TypeScript typecheck and production build passed.
- All 83 tests across 11 test files passed, including runtime hook ordering, reservations, evidence binding, project paths, web destinations, and Mastodon send recovery.
- The scripted three-session offline rehearsal passed, including a database restart and continuing an existing project. It uses real local persistence and production tool definitions, with mocked external responses.
- Live read-only network smoke checks fetched Example Domain and returned five Wikipedia results.
- The observer generated a static HTML timeline from the rehearsal database.
- `npm pack --dry-run --json` passed and included the compiled entry point, tools, observer, rehearsal, and plugin manifest.
- `git diff --check` passed.

## Live smoke test — 2026-09-13

- OpenClaw was updated to `2026.9.4` and the managed gateway service was repaired and restarted.
- Curiosity v2 was installed from the local build and enabled; the obsolete v1 `curiosity` plugin was disabled.
- The first live run used `openai/gpt-5.6-luna` and completed successfully with 10 observed actions.
- The agent searched and fetched a Nagoya University report about a bottle cap carrying 307 marine organisms, formed the interest **Accidental habitats**, and created `creations/2026-09/cap-that-carried-a-neighborhood.md`.
- The run reported 116,849 tokens. The configured 50,000-token ceiling is a next-session guard, not a hard in-flight provider cap; keep the cost implication visible when evaluating the experiment.
- Public participation, direct conversations, and self-modification remain disabled for the pilot.

No live Mastodon write was performed. Tests and the smoke test establish mechanics and one coherent behavior trace, not intrinsic motivation or interesting autonomous behavior in general.

## Live setup still needed

Follow `README.md` to install into the selected OpenClaw gateway, set the agent/workspace and heartbeat configuration, and check actual tool exposure. Supply the Mastodon instance and account token through the gateway environment. Native search, browser, execution, and any project hosting remain deployment capabilities that must be configured separately.

The first real heartbeat has now been verified against the installed OpenClaw version. Continue checking actual tool exposure and several subsequent opportunities. The runtime declarations were checked against local OpenClaw source; the live smoke test covered one gateway integration path.

Session deadlines stop subsequent tool work, not an in-flight tool. Token usage is a next-session guard when the host reports it only at completion, not a hard provider-side spending cap. Unknown social sends remain pending rather than being automatically retried. Mastodon publishing currently supports text; media upload and account provisioning are outside this implementation.

Observe several opportunities, then evaluate and adjust with the operator. The original review remains in `AGENCY_REVIEW_AND_PLAN.md`; historical remote deployment notes remain in `DEPLOYMENT_STATUS.md` and do not describe this implementation as installed.
