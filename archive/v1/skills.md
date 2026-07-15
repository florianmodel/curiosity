# Project Skills

Use these repo-local skills when working on the curiosity plugin.

## Curiosity Proactivity Tuning

Use when changing boredom, autonomous prompt wording, goal selection, retry behavior, or minimum-action enforcement.

- Keep the drive label separate from the chosen topic.
- Increase agency through neutral criteria: salience, uncertainty, leverage, reversibility, and available tools.
- Require tool-backed progress for autonomous success. `curiosity_inspect` may help debugging, but it should not satisfy autonomous progress by itself.
- Add or update tests in `src/prompt.test.ts`, `src/manager.test.ts`, or `src/scoring.test.ts`.

## Plugin Build And Runtime Sync

Use when TypeScript source changes affect plugin behavior.

- Run `npm test`.
- Run `npm run typecheck`.
- Run `npm run build`.
- Commit both `src/` changes and rebuilt `dist/` files so installed plugin runtime code matches source.

## Configuration And Schema Changes

Use when adding or changing plugin config.

- Update `src/types.ts`, `src/config.ts`, `openclaw.plugin.json`, and README examples together.
- Validate defaults with `src/config.test.ts`.
- Keep defaults safe but useful for autonomous runs.

## GitHub Direct Publish

Use at the end of completed work.

- Always push completed changes directly to GitHub unless the user explicitly says not to.
- Check `git status -sb` before staging.
- Stage only files that belong to the requested change.
- Commit with a short message that describes the behavior or docs changed.
- Push the branch to `origin` immediately after the commit.
