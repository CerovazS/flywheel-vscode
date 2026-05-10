# flywheel-vscode

VS Code extension that visualizes [Flywheel](https://flywheel.paradigma.inc) knowledge graphs with Obsidian-grade fluidity, per-GitHub-project filtering, live autoresearch updates, Obsidian-flavoured markdown rendering, and local semantic search.

## Features

- **Full graph view** (Cosmograph / cosmos.gl, GPU force simulation). Click a node → opens its detail panel. Live updates: as a `/flywheel-auto` run mints new nodes, they animate into the graph within a polling tick.
- **Mini graph sidebar** (`Activity Bar → Flywheel`). Shows the 1-hop neighborhood of the currently-selected node.
- **Active sessions tree** (`Activity Bar → Flywheel`). Lists running executions and open approval sessions; click a row to jump to the target node.
- **Repo filter**. The current workspace's GitHub remote is canonicalized via the built-in Git extension and matched against `node.repo_context.repo_url` to hide nodes from other projects.
- **Node detail panel** with Obsidian-fidelity rendering: callouts (`> [!info]`, etc.), KaTeX math, `==highlight==`, `[[wikilinks]]` (resolved against the loaded subgraph), and `![[image.png]]` artifact embeds.
- **Local semantic search** via `sqlite-vec` + Qwen3-Embedding-0.6B (Ollama). Same schema as `obsidian-search` — single 1024-dim cosine index per VS Code globalStorage.
- **Per-repo bootstrap** via `.flywheel.json`. Drop a config file at the repo root and the extension auto-loads the right graph (and optionally pops it open) every time you open the workspace.
- **Inline edit & save**. The detail panel has an Edit/Save toggle that publishes back through the staged-edit protocol (`acquire_stage_lease` → `commit_node` → `release_stage_lease`).

## Architecture

```
~/projects/flywheel-vscode/
  packages/
    flywheel-core/    Pure TS: MCP client, types, graph diff, search schema
    flywheel-vscode/  Extension host (Node) + React webview (Vite)
    flywheel-cli/     Phase-2 placeholder
```

- **Extension host**: Node 20, esbuild → `dist/extension.cjs`. Owns MCP transport, polling, sessions tree, search index, repo identity.
- **Webview**: React 18, Vite → `dist/webview/webview.js`. Three view modes (graph / mini-graph / node-detail) routed by `__FLYWHEEL_INIT__.viewId`.
- **Transport**: typed `Intent` (webview → host) and `Fact` (host → webview) via `postMessage`. Patches are coalesced over 30 ms; if >200 ops are pending, a snapshot is sent instead.
- **Polling-diff**: every 2 s the host re-fetches `flywheel_get_node_tree(rootNodeId)` and emits add/update/remove ops by `revision`. Pauses when the panel is hidden.

## Install (end users)

Pick up the latest `.vsix` from the [Releases page](https://github.com/CerovazS/flywheel-vscode/releases) and run:

```bash
code --install-extension flywheel-0.1.0.vsix
```

The extension is now persistent across all VS Code instances on this machine. To upgrade, drop in a newer `.vsix` and re-run the same command — VS Code replaces the install in place.

### Per-repo configuration

Create a `.flywheel.json` at the root of any repo to skip the slug prompt every time:

```jsonc
{
  // Slug or UUID of the graph root. Required for auto-open.
  "rootNodeId": "muon-overview",

  // Filter the loaded graph to nodes whose repo_context matches this repo's
  // git remote. Default true.
  "repoFilter": true,

  // Pop the graph panel automatically when the workspace opens.
  // Default false to respect the user's screen state.
  "autoOpenGraph": false
}
```

The status bar item then becomes a one-click `Flywheel: open <root>` shortcut whenever the workspace is active. Editing `.flywheel.json` triggers a notification but doesn't auto-reload the open graph.

## Development

### Prerequisites

- Node 20+, pnpm 9+ (via `corepack enable`).
- A Bearer token for `https://flywheel.paradigma.inc/mcp-server`. The extension reads `mcpServers.flywheel.headers.Authorization` from `~/.claude.json`, or you can set `flywheel.token` in VS Code settings.
- Ollama running with `qwen3-embedding:0.6b` for semantic search (optional — graph view works without it).

### Build

```bash
pnpm install
pnpm -r build              # builds flywheel-core then flywheel-vscode
```

If `better-sqlite3` fails to load in the Extension Development Host (ABI mismatch), rebuild it for the matching Node version:

```bash
pnpm --filter flywheel-vscode rebuild better-sqlite3
```

### Run

Press **F5** in VS Code with the workspace open at the monorepo root → Extension Development Host launches.

Then in the host:

1. Run command `Flywheel: Open Graph` → enter a slug (e.g. `lemon-zebra-0042`) or UUID.
2. Click any node → detail panel opens with rendered markdown.
3. `Flywheel: Filter by Current Repo` → restricts the graph to nodes whose `repo_context.repo_url` matches the active workspace's GitHub remote.
4. `Flywheel: Reindex Search Database` → indexes loaded nodes via Ollama.
5. `Flywheel: Semantic Search…` → fuzzy QuickPick over the local index.

### Smoke test (no VS Code needed)

```bash
pnpm smoke   # calls flywheel_list_nodes through the MCP client
```

## Configuration

| Setting | Default | Purpose |
|---|---|---|
| `flywheel.token` | _(empty)_ | Bearer token; falls back to `~/.claude.json`. |
| `flywheel.mcpUrl` | `https://flywheel.paradigma.inc/mcp-server` | Override for testing against a staging server. |
| `flywheel.pollIntervalMs` | `2000` | Live-update tick. |
| `flywheel.embeddingBackend` | `ollama-qwen3` | Only `ollama-qwen3` implemented in MVP. |
| `flywheel.ollamaUrl` | `http://localhost:11434` | Ollama HTTP base. |
| `flywheel.defaultRootNodeId` | _(empty)_ | If set, skips the slug prompt on `Flywheel: Open Graph`. |

## Roadmap

- CLI/TUI (`flywheel-cli`) — placeholder package only.
- Hook-relay self-hosted WebSocket; current live updates are polling-only.
- Marketplace publish + Open VSX.
- Zed: blocked by Zed extension API (no webview yet).
- Multi-graph: one root active at a time.

## License

[MIT](./LICENSE) © 2026 Luca Cerovac.
