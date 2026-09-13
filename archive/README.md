# Archive

This directory contains material that is not part of the active Curiosity v2 plugin.

- `v1/`: the original Curiosity plugin, including its source, build output, package metadata, tests, and local dependencies.
- `legacy/openclaw-curiosity/`: the superseded heuristic/scoring-based Curiosity plugin (v1-era implementation).
- `legacy/wander/`: the superseded radius-expanding exploration experiment.
- `notes/`: historical project notes not required by the v2 plugin.
- `misc/`: incidental legacy filesystem material.

The active, self-contained plugin is in `../v2/`.

The legacy plugin directories retain their source, documentation, package
metadata, tests, and build output. Local `node_modules`, Python caches, and
macOS `.DS_Store` files were removed during the workspace cleanup; they can be
recreated from each package's lockfile if needed.

The top-level `openclaw` checkout and `Intrinsically-Motivated-Agents` research
project remain outside this archive because they are still useful references.
