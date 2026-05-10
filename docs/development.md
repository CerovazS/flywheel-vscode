# Development

## Layout

```
flywheel-vscode/
├── packages/
│   ├── flywheel-core/    Pure TS — MCP client, types, graph diff, search schema
│   ├── flywheel-vscode/  Extension host (Node) + React webview (Vite)
│   └── flywheel-cli/     Phase-2 placeholder
├── docs/                  This documentation
├── pnpm-workspace.yaml
└── tsconfig.base.json
```

## Prerequisites

| Tool | Version |
|---|---|
| Node | 20+ (22 recommended for `vsce`) |
| pnpm | 9+ (`corepack enable`) |
| VS Code | 1.94+ |
| Ollama | latest (only for semantic search; optional) |

## Build

```bash
pnpm install
pnpm -r build         # builds flywheel-core, then flywheel-vscode
```

What that runs:

- `flywheel-core`: `tsc -b` → `dist/`
- `flywheel-vscode`:
  - `vite build` → `dist/webview/webview.js` + `dist/webview/assets/styles.css`
  - `node esbuild.config.mjs` → `dist/extension.cjs`

> [!note]
> The host bundle marks `vscode`, `better-sqlite3`, and `sqlite-vec` as external. Everything else (including `flywheel-core`) is bundled by esbuild.

## Run in dev (Extension Host)

Press **F5** in VS Code with the workspace open at the monorepo root → an Extension Development Host launches with the extension preloaded.

## Package as `.vsix`

```bash
cd packages/flywheel-vscode
npx @vscode/vsce package --no-dependencies
```

`--no-dependencies` is intentional: the host bundle is self-contained, and skipping `node_modules` keeps the `.vsix` small (~1.2 MB). The trade-off: native modules (`better-sqlite3`, `sqlite-vec`) won't be present in the install, so semantic search needs a from-source install. The graph view, markdown viewer, and edit-save all work fine without them.

## Install locally

```bash
code --install-extension flywheel-0.1.0.vsix --force
```

## Architecture notes

### Host ↔ Webview protocol

Two typed message kinds, defined in `flywheel-core/src/protocol.ts`:

- **Intent** (webview → host): `attach`, `requestNodeDetail`, `saveNodeContent`, `requestSnapshot`, …
- **Fact** (host → webview): `snapshot`, `patch`, `nodeDetail`, `saveResult`, `error`, `status`, …

Patches are coalesced over a 30 ms window; if more than 200 ops accumulate the host falls back to a fresh snapshot to keep the webview render loop calm.

### Polling-diff

Every `flywheel.pollIntervalMs` (default 2000 ms), the host calls `flywheel_get_node_tree(rootNodeId)` and diffs against the previous projection by `revision`. Add/update/remove ops are emitted as a `patch` Fact. Polling pauses when the panel is hidden.

### Static graph layout

The webview disables Cosmograph's GPU simulation (`disableSimulation: true`) and computes a Fruchterman–Reingold layout in JS, seeded by sorted node ids so the layout is deterministic across reloads. Existing nodes keep their coordinates when patches arrive; only new nodes are placed.

### Markdown pipeline

Defined in `webview/src/md/pipeline.ts`. Order:

1. `remark-parse`
2. `remark-gfm`
3. `remark-math`
4. `remark-wiki-link` (with our `slugResolver`)
5. AST walker that rewrites wikilinks to image embeds / internal links / inert text
6. `remark-rehype` (with `allowDangerousHtml`)
7. `rehype-callouts` (theme: `obsidian`)
8. `rehype-katex`
9. `rehype-stringify`

The `==highlight==` regex is applied as a pre-processor on the raw source.

## Smoke tests

```bash
pnpm -F flywheel-core smoke
```

Calls `flywheel_list_nodes` through the MCP client; useful for sanity-checking your token + network without launching VS Code.

## Common gotchas

> [!warning]
> **`better-sqlite3` ABI mismatch in the Extension Development Host.** Rebuild for VS Code's bundled Electron Node:
>
> ```bash
> pnpm --filter flywheel-vscode rebuild better-sqlite3
> ```

> [!warning]
> **CSS not applying in production webview.** The Vite-built CSS is at `dist/webview/assets/styles.css`. If you change the path, also update the `<link rel="stylesheet">` injected by `webview-bridge.ts`.

> [!tip]
> **Faster iteration**: `pnpm -F flywheel-vscode watch` runs esbuild in watch mode for the host. The webview hot-reloads via `vite` if you launch with the dev preview entry instead.
