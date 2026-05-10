# flywheel-vscode

A VS Code extension that brings [Flywheel](https://flywheel.paradigma.inc) knowledge graphs into your editor with Obsidian-grade fluidity.

> [!warning]
> **This repository was just created and is rough around the edges.** Several known bugs are listed below. Please file issues for anything you hit — feedback at this stage is especially valuable.

> [!important]
> The extension talks to `https://flywheel.paradigma.inc/mcp-server` and needs a Bearer token. It reads `mcpServers.flywheel.headers.Authorization` from `~/.claude.json` by default, or you can set `flywheel.token` in VS Code settings.

## What it does

- **Static graph view** — GPU-accelerated (Cosmograph). Deterministic layout per topology, no jolt on open.
- **Per-repo bootstrap** — drop a `.flywheel.json` at your repo root and the right graph loads automatically.
- **Obsidian-style markdown** — callouts, KaTeX math, `==highlights==`, `[[wikilinks]]`, and `![[image.png]]` artifact embeds.
- **Inline edit & save** — toggle Edit/Save in the node detail panel; saves go through the staged-edit protocol (`acquire_stage_lease` → `commit_node` → `release_stage_lease`).
- **Zoom-aware legend** — a coloured side panel lists nodes by title; granularity tracks the zoom level so it stays readable at any scale.
- **Mini-graph sidebar** — 1-hop neighbourhood of the currently-selected node.
- **Local semantic search** — `sqlite-vec` + Qwen3-Embedding-0.6B (Ollama).

## Install

> [!tip]
> Grab the latest `.vsix` from the [Releases page](https://github.com/CerovazS/flywheel-vscode/releases) (or build from source — see [docs/development.md](./docs/development.md)).

```bash
code --install-extension flywheel-0.1.0.vsix
```

The extension is now persistent across all VS Code instances on this machine. To upgrade, drop in a newer `.vsix` and re-run the same command — VS Code replaces the install in place.

## Quick start

1. **Open the command palette** (`Cmd/Ctrl+Shift+P`) and run `Flywheel: Open Graph`.
2. **Enter a node slug** (e.g. `lemon-zebra-0042`) or UUID.
3. **Click any node** to open its detail panel with the rendered markdown.

> [!note]
> To skip the prompt every time, drop a `.flywheel.json` at the root of your repo. See [docs/per-repo.md](./docs/per-repo.md).

## Documentation

| Page | What it covers |
|---|---|
| [docs/install.md](./docs/install.md) | Install, upgrade, uninstall |
| [docs/per-repo.md](./docs/per-repo.md) | `.flywheel.json` schema and behaviour |
| [docs/markdown.md](./docs/markdown.md) | Supported markdown features (callouts, math, wikilinks) |
| [docs/development.md](./docs/development.md) | Building, packaging, contributing |

## Known issues

> [!caution]
> The extension is fresh — these are the rough edges I'm aware of:
>
> - **No native modules in the shipped `.vsix`.** `better-sqlite3` and `sqlite-vec` aren't bundled, so semantic search will fail until you build from source. The graph view, markdown viewer, and edit-save all work without them.
> - **Edit-save races.** If the server rejects the staged-edit lease (concurrent edit, expired session), the save fails with a generic error. Retrying usually works.
> - **Patch coalescing edge case.** Very fast bursts (>200 ops in 30 ms) trigger a full snapshot resync; in practice rare but visible as a one-frame layout pop.
> - **Marketplace not published.** Install is `.vsix`-only for now.

## Configuration

| Setting | Default | Purpose |
|---|---|---|
| `flywheel.token` | _(empty)_ | Bearer token; falls back to `~/.claude.json`. |
| `flywheel.mcpUrl` | `https://flywheel.paradigma.inc/mcp-server` | Override for staging. |
| `flywheel.pollIntervalMs` | `2000` | Live-update tick. |
| `flywheel.embeddingBackend` | `ollama-qwen3` | Only `ollama-qwen3` implemented. |
| `flywheel.ollamaUrl` | `http://localhost:11434` | Ollama HTTP base. |
| `flywheel.defaultRootNodeId` | _(empty)_ | If set, skips the slug prompt. Overridden by `.flywheel.json`. |
