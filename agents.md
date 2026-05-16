# Agent Instructions

This repository contains the OpenClaw curiosity plugin. Treat it as a production plugin: source changes should be small, tested, built, and pushed.

## Default Workflow

- Read the relevant source before editing. The main behavior lives in `src/manager.ts`, `src/prompt.ts`, `src/scoring.ts`, and `src/config.ts`.
- Keep autonomous behavior self-authored and non-prescriptive. Boredom may increase urgency, but it must not hard-code a project type, activity, or user-visible suggestion.
- Prefer concrete, tool-backed outcomes over meta narration. A curiosity run should act first when safe tools are available, then report the outcome and evidence.
- Preserve OpenClaw safety, approval, budget, and active-hours policies. Do not bypass existing gates to make curiosity feel more active.
- Update tests alongside behavior changes. Add regression tests when changing prompt contracts, scoring, retry logic, or minimum-action rules.
- Run `npm test`, `npm run typecheck`, and `npm run build` before publishing unless the change is documentation-only.
- Commit generated `dist/` output when source changes affect runtime code.

## GitHub Publishing

- Always push completed changes directly to GitHub unless the user explicitly says not to.
- Use concise commits on the current branch when appropriate; if the work starts on a protected or shared branch and direct push is blocked, create a short feature branch and push it.
- Do not leave finished local changes unpushed. If push fails because authentication or branch protection blocks it, report the exact blocker and the commit/branch that needs pushing.

## Server Update Snippet

Use this on the server to fetch and activate the latest plugin build. Set `PLUGIN_DIR` to the checkout path you want to use on that machine.

```bash
export PLUGIN_DIR="${PLUGIN_DIR:-$HOME/curiosity}"

if [ ! -d "$PLUGIN_DIR/.git" ]; then
  git clone https://github.com/florianmodel/curiosity.git "$PLUGIN_DIR"
fi

cd "$PLUGIN_DIR"
git pull --ff-only origin main
npm ci
npm run build
openclaw plugins install --force "$PLUGIN_DIR"
openclaw plugins enable curiosity
openclaw gateway restart
```

## Guardrails

- Never commit secrets, local OpenClaw config, tokens, database files, or workspace `.openclaw/` state.
- Avoid broad rewrites of scoring or manager flow unless the request is specifically about policy behavior.
- Keep docs and prompts neutral: describe affordances and outcome criteria, not canned things the agent should build.
