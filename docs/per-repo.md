# Per-repo configuration

Each workspace can pin its own Flywheel graph by dropping a `.flywheel.json` file at the repo root. The extension picks it up the next time the workspace is opened.

## Schema

```jsonc
{
  // REQUIRED for auto-open. Slug (e.g. "lemon-zebra-0042") or UUID.
  "rootNodeId": "muon-overview",

  // OPTIONAL. Default: true.
  // When true, the loaded graph is filtered to nodes whose
  // repo_context.repo_url matches this repo's git remote.
  "repoFilter": true,

  // OPTIONAL. Default: false.
  // Pop the graph panel automatically when the workspace opens.
  "autoOpenGraph": false
}
```

> [!tip]
> The file ships with a JSON Schema (`./resources/flywheel-schema.json`) so VS Code gives you autocomplete + validation while typing.

## Behaviour

| Field | What it does |
|---|---|
| `rootNodeId` | Slug or UUID of the node to load as the graph root. The extension calls `flywheel_resolve_node_slug` and falls back to passing the value through if it looks like a UUID. Required for auto-open and for skipping the prompt on `Flywheel: Open Graph`. |
| `repoFilter` | When `true`, the active workspace's git remote is canonicalized (via VS Code's built-in Git extension) and matched against `node.repo_context.repo_url`. Nodes from other repos are hidden. |
| `autoOpenGraph` | When `true`, the graph panel opens automatically on workspace activation. Off by default to respect your screen state. |

## Resolution priority

When you run `Flywheel: Open Graph`, the extension picks the root node from these sources in order:

1. `rootNodeId` from `.flywheel.json` in the active workspace
2. `flywheel.defaultRootNodeId` from VS Code settings
3. The slug prompt

> [!note]
> Editing `.flywheel.json` while the graph is open shows a notification but doesn't reload — close and reopen the graph to apply changes. This is intentional: auto-reload during a live session is too disruptive.

## Status bar

The status bar item reflects the active config:

| State | Display |
|---|---|
| No graph open, no `.flywheel.json` | `Flywheel: idle` |
| No graph open, valid `.flywheel.json` | `Flywheel: open <root>` (clickable) |
| Graph open | `Flywheel: <count> nodes · <root>` |

Click the item to open or refocus the graph for the active workspace.

## Example

A `.flywheel.json` for a project where you always want the graph filtered and auto-opened:

```json
{
  "rootNodeId": "muon-orthogonalization",
  "repoFilter": true,
  "autoOpenGraph": true
}
```
