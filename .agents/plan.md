# Plan — Flywheel VS Code Graph Viewer (`flywheel-vscode`)

> [!note]
> **Historical document.** This is the original implementation plan written before the repository existed. It is kept under `.agents/` for context — some sections describe state that no longer matches reality (see §10).

## Context

We want a VS Code extension that makes Flywheel graphs (`flywheel.paradigma.inc`, a knowledge-graph system for scientific research) feel like Obsidian Graph View: fluid physics-based rendering, GitHub-project filtering, live control over running autoresearch sessions, Obsidian-faithful markdown rendering inside node bodies (callouts, math, wikilinks, images), and local semantic search.

**Problem solved**: today Flywheel graphs are only usable through MCP (text-only, slow) or the web app (low control, not integrated into the IDE the user lives in). When an autoresearch run mints 50+ nodes for a single project, mixed with nodes from other repos, it becomes impossible to navigate without a per-project filter and a fluid visualization.

**Expected outcome**: a VS Code extension that, the moment a GitHub repo is opened, instantly shows only that repo's Flywheel subgraph, animates new nodes as a live autoresearch run mints them, lets the user read each node with Obsidian-grade rendering, and runs semantic search over node content by reusing the same index already built by `obsidian-search`.

**Locked-in user decisions**:
- **Embedding**: Qwen3-0.6B via Ollama, reusing the same index as `obsidian-search` (`~/.local/share/obsidian-search/index.sqlite`, 1024-dim cosine schema).
- **Live updates**: polling-diff only (no relay hooks). Acceptable latency 2–5s.
- **CLI/TUI**: out of MVP scope. The monorepo is laid out for 3 packages but only `flywheel-core` + `flywheel-vscode` are implemented now.
- **Repo**: local at `~/projects/flywheel-vscode/`. No CI, no publish.

---

## 1. Locked-in architecture

| Layer | Choice | Rationale |
|---|---|---|
| Language | TypeScript (strict) on Node 20 | Webview + extension host share a language, types shared via the core package |
| Repo layout | pnpm workspaces, 3-package monorepo | Scaffolding ready for phase-2 CLI without refactor |
| Graph render (full) | `@cosmograph/cosmos` (cosmos.gl, MIT) | GPU force-sim, ~1M nodes, scales during live autoresearch |
| Graph render (mini sidebar) | `force-graph` (vasturiano, canvas+d3-force) | Trivial API, great for ≤5k local nodes |
| Markdown pipeline | `unified` + remark + rehype-callouts + KaTeX + remark-wiki-link | Obsidian-faithful, AST is walkable so we can lift wikilinks to edges |
| Vector store | `sqlite-vec` + `better-sqlite3` | Reuses the `obsidian-search` schema (1024-dim cosine), SIMD, single `.db` file |
| Embedding | Qwen3-Embedding-0.6B via Ollama HTTP | Identical to `obsidian-search`, already installed |
| Webview state | Zustand | Lightweight, two slices (`graph`, `ui`); host = source of truth |
| Host↔webview transport | `vscode-messenger` (TypeFox) | Typed JSON-RPC over `postMessage`, no manual correlation-id |
| Repo identity | VS Code Git extension API (`vscode.git`) | No manual parsing of `.git/config` |
| Initial boilerplate | `estruyf/vscode-react-webview-template` (Vite + React + TS) | Maintained, message-passing helpers included |

---

## 2. Monorepo layout

```
~/projects/flywheel-vscode/
  package.json                     # root workspace
  pnpm-workspace.yaml
  tsconfig.base.json
  .vscode/                         # launch.json for F5-debugging the extension
  packages/
    flywheel-core/                 # ─── implemented in MVP ───
      src/
        client/                    # MCP/HTTP Flywheel client
          mcp.ts                   # wrappers around MCP tools over JSON-RPC
          contract.ts              # types generated from flywheel_get_contract
          types.ts                 # Node, Edge, Artifact, RepoContext
        graph/
          tree.ts                  # get_node_tree + cache
          diff.ts                  # polling-diff on revision
          subgraph.ts              # export_subgraph for offline snapshot
        search/
          schema.ts                # CREATE TABLE compatible with obsidian-search
          ollama.ts                # Qwen3-0.6B embedding client
          index.ts                 # indexing + KNN query
        repo/
          github.ts                # parse repo URL → {owner, repo, branch}
        protocol.ts                # typed webview ↔ host messages
      package.json
      tsconfig.json
    flywheel-vscode/               # ─── implemented in MVP ───
      src/
        extension.ts               # entrypoint, registers commands+views
        panels/
          GraphPanel.ts             # main WebviewPanel (Cosmograph)
          MiniGraphView.ts          # sidebar WebviewView (force-graph)
          NodeDetailPanel.ts        # per-node markdown WebviewPanel
        views/
          SessionsTreeProvider.ts   # native TreeView for active executions/leases
        commands/
          filterByRepo.ts           # repo QuickPick
          searchSemantic.ts         # QuickPick + sqlite-vec
          openNodeBySlug.ts         # input box → resolve_node_slug → open
        polling/
          poller.ts                 # polling-diff scheduler
        webview/                    # React bundle (Vite)
          src/
            App.tsx
            FullGraph.tsx          # Cosmograph wrapper
            MiniGraph.tsx          # force-graph wrapper
            NodeDetail.tsx         # markdown render
            store.ts               # Zustand
            messenger.ts           # vscode-messenger client
            md/
              pipeline.ts          # unified chain
            search/
              SemanticSearch.tsx
          index.html
          vite.config.ts
      package.json                  # contributes (commands, views, viewsContainers, configuration)
      tsconfig.json
    flywheel-cli/                  # ─── empty stub, phase 2 ───
      package.json                  # placeholder only
      README.md                     # "TODO phase 2"
```

---

## 3. The `flywheel-core` module

### 3.1 MCP client (`packages/flywheel-core/src/client/mcp.ts`)

- HTTP-MCP transport to `https://flywheel.paradigma.inc/mcp-server`. Reuse the config in `~/.claude.json` (`mcpServers.flywheel.headers.Authorization`) by reading the file at extension init (do NOT hardcode the token; read from `vscode.workspace.getConfiguration('flywheel').get('token')` with fallback to `~/.claude.json`).
- Init flow: `flywheel_get_contract` → local cache for the session lifetime → `flywheel_get_contract_section('graph' | 'artifacts' | 'hooks')` lazy.
- Automatic idempotency-key for writes (even if the MVP is read-only).
- Rate-limit awareness: 120 reads/min, 2000/24h — respect them with a client-side token bucket.

### 3.2 Node type (`types.ts`)

Canonical Flywheel schema (from `~/.claude/skills/flywheel/references/`):

```ts
export interface FlywheelNode {
  node_id: string;            // immutable UUID
  slug_name: string;          // adjective-noun-####
  title: string;
  content: string;            // Markdown
  summary: string | null;
  revision: number;           // optimistic-locking key for polling-diff
  visibility: 'private' | 'shared' | 'unlisted' | 'public';
  repo_context: RepoContext | null;
  tags: NodeTag[];
  created_at: string;
  updated_at: string;
}

export interface RepoContext {
  repo_url: string;           // 🔑 key for per-project filtering
  branch_name: string;
  head_commit_sha: string;
  origin_host: string;        // typically 'github.com'
  updated_by: string;
  external_transcript_ref: string | null;
}

export interface NodeTag {
  tag_id: string;
  name: string;
  bg_color: string;
  text_color: string;
  one_only: boolean;
}

export interface FlywheelEdge {
  parent_id: string;
  child_id: string;
  // Multi-parent supported (DAG, no cycles)
}
```

### 3.3 Polling-diff (`graph/diff.ts`)

Algorithm:

1. Local state: `Map<node_id, revision>`.
2. Every 2s (configurable via `flywheel.pollIntervalMs`), call `flywheel_get_node_tree(active_root, depth=infinity)`.
3. Compute the delta:
   - `addedNodes`: present in the response, missing locally.
   - `updatedNodes`: present in both with a changed `revision`.
   - `removedNodes`: missing from the response.
   - `addedEdges` / `removedEdges`: edge diff.
4. Emit `Patch` events to the webview through `vscode-messenger`.
5. Pause polling when the `WebviewPanel` is hidden (`onDidChangeViewState`).
6. Exponential backoff on failure (cap 30s).

### 3.4 Detecting the current GitHub repo (`repo/github.ts`)

```ts
export async function getCurrentRepoUrl(): Promise<string | null> {
  const ext = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (!ext?.isActive) await ext?.activate();
  const api = ext!.exports.getAPI(1);
  const repo = api.repositories[0];                 // first workspace folder
  if (!repo) return null;
  const origin = repo.state.remotes.find(r => r.name === 'origin');
  return origin?.fetchUrl ?? null;                  // e.g. https://github.com/owner/repo.git
}
```

Listen on `api.onDidOpenRepository` and `repo.state.onDidChange` to keep the current filter in sync. A `normalizeRepoUrl(url)` helper canonicalizes `git@github.com:owner/repo.git`, `https://github.com/owner/repo`, `https://github.com/owner/repo.git` to the same form so it can match `node.repo_context.repo_url`.

### 3.5 Search index (`search/`)

**Reuses the `obsidian-search` schema** for full compatibility.

`schema.ts`:

```sql
CREATE TABLE IF NOT EXISTS chunks (
  chunk_id    TEXT PRIMARY KEY,
  node_id     TEXT NOT NULL,        -- (replaces file_path)
  node_slug   TEXT NOT NULL,
  section     TEXT,
  chunk_index INTEGER,
  content     TEXT NOT NULL,
  revision    INTEGER NOT NULL      -- for stale-row detection
);
CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0 (
  chunk_id    TEXT PRIMARY KEY,
  embedding   FLOAT[1024] distance_metric=cosine
);
CREATE INDEX IF NOT EXISTS chunks_by_node ON chunks(node_id);
```

DB path: `${context.globalStorageUri.fsPath}/index.sqlite`.

`ollama.ts`: HTTP POST to `http://localhost:11434/api/embed`, model `qwen3-embedding:0.6b`, batch size 32. Explicit error if Ollama doesn't respond (show a VS Code notification: "Start Ollama or change embedding backend").

`index.ts`:

- **Chunking identical** to `obsidian-search/src/obsidian_search/chunker.py`: heading-aware split (`#`, `##`, …), max 2000 chars, overlap 256 chars at paragraph boundary, prefix `"Node: {slug} | Section: {heading}\n\n"`.
- `chunk_id = sha256(node_id::section::chunk_index)[:16]`.
- Re-index trigger: callback from the poller whenever a node's `revision` changes.
- KNN query: `SELECT chunk_id, distance FROM vec_chunks WHERE embedding MATCH ? AND k = ? ORDER BY distance` + JOIN on `chunks`.

---

## 4. The VS Code extension (`flywheel-vscode`)

### 4.1 `package.json` contributes

```json
{
  "contributes": {
    "commands": [
      { "command": "flywheel.openGraph", "title": "Flywheel: Open Graph" },
      { "command": "flywheel.filterByRepo", "title": "Flywheel: Filter by Current Repo" },
      { "command": "flywheel.searchSemantic", "title": "Flywheel: Semantic Search…" },
      { "command": "flywheel.openNodeBySlug", "title": "Flywheel: Open Node by Slug…" },
      { "command": "flywheel.reindexAll", "title": "Flywheel: Reindex Search Database" }
    ],
    "viewsContainers": {
      "activitybar": [
        { "id": "flywheel", "title": "Flywheel", "icon": "$(graph)" }
      ]
    },
    "views": {
      "flywheel": [
        { "id": "flywheel.miniGraph", "name": "Mini Graph", "type": "webview" },
        { "id": "flywheel.sessions",  "name": "Active Sessions", "type": "tree" }
      ]
    },
    "configuration": {
      "properties": {
        "flywheel.token": { "type": "string", "description": "Bearer token (overrides ~/.claude.json)" },
        "flywheel.pollIntervalMs": { "type": "number", "default": 2000 },
        "flywheel.embeddingBackend": { "type": "string", "enum": ["ollama-qwen3"], "default": "ollama-qwen3" },
        "flywheel.ollamaUrl": { "type": "string", "default": "http://localhost:11434" }
      }
    }
  }
}
```

### 4.2 Primitives → components map

| Component | Primitive | File |
|---|---|---|
| Full-screen graph | `WebviewPanel` with `retainContextWhenHidden: true` | `panels/GraphPanel.ts` |
| Mini-graph of the open node | `WebviewView` in the sidebar | `panels/MiniGraphView.ts` |
| Node detail (markdown) | `WebviewPanel` editor-side, one per node, reusable | `panels/NodeDetailPanel.ts` |
| Active autoresearch sessions | Native `TreeView` | `views/SessionsTreeProvider.ts` |
| Filter by repo | `QuickPick` from command palette | `commands/filterByRepo.ts` |
| Semantic search | `QuickPick` with preview | `commands/searchSemantic.ts` |
| Open by slug | `showInputBox` → `resolve_node_slug` | `commands/openNodeBySlug.ts` |

### 4.3 Autoresearch sessions (TreeView)

Three sources of "active session":

- `flywheel_list_executions(status='running')` → an autoresearch execution.
- `stage_lease` open on nodes (detected via `get_node` returning `lease_holder`).
- `approval_session` open (`flywheel_list_approval_sessions`).

Refresh every 5s. Click on a row → zooms to the target node in the `GraphPanel`. Context menu: "Terminate execution", "Release lease" (require `write` scope).

### 4.4 Message protocol (`flywheel-core/src/protocol.ts`)

```ts
// Webview → Host (intent)
type Intent =
  | { kind: 'attach'; viewId: string; rootNodeId: string; repoFilter?: string }
  | { kind: 'detach'; viewId: string }
  | { kind: 'requestNodeDetail'; nodeId: string }
  | { kind: 'requestSemanticSearch'; query: string; k: number }
  | { kind: 'requestSnapshot'; viewId: string };          // resync

// Host → Webview (fact)
type Fact =
  | { kind: 'snapshot'; viewId: string; nodes: FlywheelNode[]; edges: FlywheelEdge[]; seq: number }
  | { kind: 'patch'; viewId: string; ops: PatchOp[]; seq: number }
  | { kind: 'nodeDetail'; node: FlywheelNode; rendered: string /* HTML */ }
  | { kind: 'searchResults'; results: SearchHit[] }
  | { kind: 'error'; message: string };

type PatchOp =
  | { op: 'addNode'; node: FlywheelNode }
  | { op: 'updateNode'; nodeId: string; partial: Partial<FlywheelNode> }
  | { op: 'removeNode'; nodeId: string }
  | { op: 'addEdge'; edge: FlywheelEdge }
  | { op: 'removeEdge'; parent_id: string; child_id: string };
```

Host-side backpressure: per-viewId `pendingPatches[]` buffer flushed every ~30ms via `setInterval`, last-write-wins per `node_id`. If the buffer exceeds 200 pending ops → send a `snapshot` instead. The webview persists `lastSeq` via `acquireVsCodeApi().setState`; on re-attach it requests a `snapshot` if there's a gap.

### 4.5 Markdown pipeline (`webview/src/md/pipeline.ts`)

```ts
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkWikiLink from 'remark-wiki-link';
import remarkRehype from 'remark-rehype';
import rehypeCallouts from 'rehype-callouts';
import rehypeKatex from 'rehype-katex';
import rehypeStringify from 'rehype-stringify';

export const renderObsidianMd = (md: string, slugResolver: (slug: string) => string | null) =>
  unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath)
    .use(remarkWikiLink, {
      permalinks: [],                   // sentinel; resolve dynamically via hrefTemplate
      hrefTemplate: (perm: string) => {
        const id = slugResolver(perm);
        return id ? `command:flywheel.openNodeById?${encodeURIComponent(JSON.stringify([id]))}` : '#';
      },
    })
    .use(remarkRehype, { allowDangerousHtml: false })
    .use(rehypeCallouts, { theme: 'obsidian' })
    .use(rehypeKatex)
    .use(rehypeStringify)
    .processSync(md).toString();
```

Pre-processing for `==highlight==`: regex transform `==(.+?)==` → `<mark>$1</mark>` (simple; avoids pulling in another plugin).

For `![[image.png]]` (image embed): walk the mdast before `remark-rehype`, detect `wikiLink` nodes whose `value` ends in `.png|.jpg|.svg|.gif`, rewrite to an `image` node with `url = artifact.storage_url`. Requires an `imageName → artifact_id` map obtained from `flywheel_list_artifacts(node_id)`.

CSS: import `katex/dist/katex.min.css` and the Obsidian presets from `rehype-callouts` (shipped with the package). Bundle through Vite, inject as `<style>` in the webview HTML.

Wikilink click: VS Code intercepts `command:` URIs when the webview is created with `enableCommandUris: true` and an explicit allowlist.

### 4.6 Cosmograph integration (`webview/src/FullGraph.tsx`)

- Init: `new Graph(canvas, { simulationGravity: 0.1, simulationRepulsion: 1.0, ... })`.
- Color encoding: the node's primary tag (`node.tags[0].bg_color`), default grey when absent.
- Size encoding: `log(artifact_count + 1)`.
- Hover: callback → emit `requestNodeDetail` intent → show a tooltip with title + summary.
- Click: zoom + pin focus + open `NodeDetailPanel`.
- Filter API: `cosmograph.setData(nodes.filter(...))`. For the repo filter: `nodes.filter(n => normalizeRepoUrl(n.repo_context?.repo_url) === currentRepo)`.
- Streaming: subscribe to the Zustand store; when patches arrive, apply `cosmograph.addPoints(...)` / `cosmograph.removePoints(...)` without resetting the simulation (cosmos.gl's key feature).
- `retainContextWhenHidden: true` is mandatory on the WebviewPanel.

---

## 5. Existing files to reuse / not duplicate

| File | Use | Notes |
|---|---|---|
| `~/.claude.json` (around line 880) | Source of the Flywheel bearer token | Read-only; never write to it. Path: `mcpServers.flywheel.headers.Authorization` |
| `~/.claude/skills/flywheel/references/flywheel-mcp-tool-map.md` | MCP tool catalogue by category | Single source of truth for `flywheel-core/src/client/contract.ts` |
| `~/.claude/skills/flywheel/references/INTERFACES.md` | HTTP↔MCP mapping | Useful if we ever want to bypass MCP |
| `~/.claude/skills/flywheel/references/ARTIFACTS.md` | Artifact upload/finalize contract | Phase-2 (write); MVP is read-only |
| `~/obsidian-search/src/obsidian_search/store.py` | Reference SQLite schema | Replicate 1:1 in `flywheel-core/src/search/schema.ts` |
| `~/obsidian-search/src/obsidian_search/chunker.py` | Heading-aware chunking | Re-implement in TS preserving the exact boundary, overlap, prefix |
| `~/obsidian-search/src/obsidian_search/embedder.py` | Ollama Qwen3-0.6B client | Model: `qwen3-embedding:0.6b`, batch 32, vec dim 1024 |
| `~/.local/share/obsidian-search/index.sqlite` | DO NOT share | A separate DB for Flywheel: `${globalStorageUri}/index.sqlite` with the same schema |

---

## 6. Step-by-step roadmap

### Phase 0 — Bootstrap (~1h)

1. `mkdir -p ~/projects/flywheel-vscode && cd ~/projects/flywheel-vscode`
2. `pnpm init`, configure `pnpm-workspace.yaml` with `packages/*`.
3. Create `tsconfig.base.json` (strict, ES2022, moduleResolution=bundler).
4. Scaffold the 3 packages with minimal `package.json`s.
5. Clone `estruyf/vscode-react-webview-template` locally as a reference (NOT as a dependency), copy the Vite+React setup into `packages/flywheel-vscode/src/webview/`.

### Phase 1 — Minimal `flywheel-core` (~1d)

6. `client/mcp.ts`: stub JSON-RPC client. Reads `~/.claude.json` for the token.
7. `client/types.ts`: types from §3.2.
8. `client/contract.ts`: invokes `flywheel_get_contract` + cache.
9. `repo/github.ts`: `getCurrentRepoUrl()` + `normalizeRepoUrl()`.
10. `protocol.ts`: `Intent` / `Fact` / `PatchOp` types.
11. Smoke test: Node script that calls `flywheel_list_nodes(projection='topology')` and prints N nodes.

### Phase 2 — Extension skeleton (~1d)

12. `extension.ts`: register a `flywheel.openGraph` command that opens a placeholder `WebviewPanel` ("hello world").
13. Configure `.vscode/launch.json` for F5 → Extension Development Host.
14. Vite bundle of the webview, hello-world message passing via `vscode-messenger`.
15. Verify: F5, palette `Flywheel: Open Graph`, see the webview.

### Phase 3 — Static graph (~2d)

16. `flywheel-core/src/graph/tree.ts`: wrapper over `flywheel_get_node_tree`.
17. `panels/GraphPanel.ts`: call `tree`, post a `snapshot` to the webview.
18. `webview/src/FullGraph.tsx`: integrate `@cosmograph/cosmos`, render nodes with tag-color.
19. Click on a node → log in the webview console.
20. Verify: open a real root, see the rendered graph.

### Phase 4 — Repo filter + repo identity (~0.5d)

21. `commands/filterByRepo.ts`: read the current repo via the Git API, apply the filter to the graph (Zustand `ui.repoFilter`).
22. Listener on `onDidOpenRepository` → auto-filter on workspace open.
23. Verify: in repo A you see only nodes from A; switch to repo B → the graph updates.

### Phase 5 — Polling-diff + live updates (~1d)

24. `polling/poller.ts`: 2s scheduler with `onDidChangeViewState` pause.
25. `flywheel-core/src/graph/diff.ts`: algorithm from §3.3.
26. `panels/GraphPanel.ts`: send `patch` events to the webview, coalesced over 30ms.
27. `FullGraph.tsx`: apply patches via `cosmograph.addPoints`/`removePoints` without reset.
28. Verify: start an autoresearch from the terminal, see new nodes animate into the graph within ~2s.

### Phase 6 — Node detail panel + markdown pipeline (~1.5d)

29. `panels/NodeDetailPanel.ts`: new `WebviewPanel` on node click, reusable per node (one panel per node_id).
30. `webview/src/md/pipeline.ts`: full unified pipeline.
31. CSS Obsidian theme + KaTeX.
32. Pre-process `==highlight==`, image embed via artifact lookup.
33. Wikilinks → `command:flywheel.openNodeById`.
34. Verify: open a node with math, callout, wikilink, image — faithful rendering.

### Phase 7 — Mini-graph sidebar + Sessions tree (~1d)

35. `MiniGraphView.ts`: WebviewView with `force-graph` on the 1-hop neighborhood of the selected node.
36. `SessionsTreeProvider.ts`: TreeView with `list_executions` + `list_approval_sessions` + leases.
37. Refresh 5s. Click row → zoom in the GraphPanel.

### Phase 8 — Semantic search (~1.5d)

38. `flywheel-core/src/search/schema.ts`: `CREATE TABLE` schema.
39. `search/ollama.ts`: Qwen3-0.6B client.
40. `search/index.ts`: chunking + indexing, hooked to the poller (revision-driven).
41. `flywheel.reindexAll` command: full rebuild.
42. `commands/searchSemantic.ts`: QuickPick with snippet preview, click → open NodeDetail.
43. Verify: a semantic query returns relevant nodes; re-index after edits.

### Phase 9 — Polish (~0.5d)

44. Settings UI (token override, polling interval, ollama URL).
45. Status bar item "Flywheel: connected to X nodes (root: Y)".
46. Graceful error notifications.
47. README.md with screenshots.

**Total estimated MVP: ~10 person-days.**

---

## 7. End-to-end verification

### 7.1 Pre-test setup

```bash
# Verify Ollama is up with the model
curl http://localhost:11434/api/tags | jq '.models[] | select(.name | startswith("qwen3-embedding"))'
# Verify Flywheel token
jq '.mcpServers.flywheel.headers.Authorization' ~/.claude.json
```

### 7.2 flywheel-core smoke test

```bash
cd ~/projects/flywheel-vscode/packages/flywheel-core
pnpm tsx scripts/smoke-list-nodes.ts   # ad-hoc script that prints N nodes via MCP
```

**Expected**: a list of nodes with no auth errors.

### 7.3 Extension verification

1. F5 → the Extension Development Host opens.
2. Open a workspace that's a GitHub repo indexed in Flywheel.
3. Command `Flywheel: Open Graph` → see the Cosmograph graph of the repo's nodes.
4. Command `Flywheel: Filter by Current Repo` → only nodes whose `repo_context.repo_url` matches remain.
5. Click a node → `NodeDetailPanel` opens with rendered markdown.
6. In another window: launch an autoresearch (e.g. via the Claude slash command `/flywheel-auto`). Within 2-5s, new nodes appear in the graph with physics animation.
7. **Active Sessions** sidebar: see the running execution, click → zoom to its target.
8. Command `Flywheel: Semantic Search…`, query "loss spike during pretraining" → top-5 nodes ordered by similarity.

### 7.4 Edge cases

- **Ollama down at startup**: the extension loads, graph works, search shows an "Ollama unreachable" error without crashing.
- **Node removed during polling**: it disappears from the graph without an abrupt re-layout.
- **Repo URL with auth (`git@github.com:...` vs `https://`)**: `normalizeRepoUrl` matches both forms.
- **MCP token expired**: notification "Flywheel auth failed, check ~/.claude.json".
- **WebviewPanel closed and reopened**: state persisted via `setState`, snapshot resync if there's a seq gap.

---

## 8. Out of scope for MVP (phase 2+)

- **CLI/TUI** (`flywheel-cli`): the package scaffolding is there, the content isn't.
- **Self-hosted hook relay** for near-real-time WebSocket.
- **Write operations** (commit, branch, merge): MVP is read-only.
- **Marketplace publish** + Open VSX.
- **Zed**: blocked by the Zed extension API; revisit when the Visual Extension API ships.
- **Alternative embeddings** (in-process bge-small): code accepts `flywheel.embeddingBackend` as an enum but only `ollama-qwen3` is implemented.
- **Multi-graph**: MVP supports 1 active root at a time (switchable via command), no simultaneous multi-graph view.

---

## 9. Key external references

- **Flywheel MCP server**: `https://flywheel.paradigma.inc/mcp-server`
- **Flywheel docs**: `https://docs.flywheel.paradigma.inc/tutorial`
- **cosmos.gl** (graph engine): `https://github.com/cosmosgl/graph` (MIT)
- **rehype-callouts**: `https://github.com/lin-stephanie/rehype-callouts`
- **Quartz OFM plugin** (reference pipeline): `https://github.com/jackyzha0/quartz/blob/v4/quartz/plugins/transformers/ofm.ts`
- **sqlite-vec**: `https://github.com/asg017/sqlite-vec`
- **better-sqlite3**: `https://github.com/WiseLibs/better-sqlite3`
- **vscode-messenger**: `https://github.com/TypeFox/vscode-messenger`
- **estruyf VS Code template**: `https://github.com/estruyf/vscode-react-webview-template`
- **VS Code Git extension API**: `https://github.com/microsoft/vscode/blob/main/extensions/git/src/api/git.d.ts`
- **VS Code Webview docs**: `https://code.visualstudio.com/api/extension-guides/webview`

---

## 10. Current repo state (at planning time)

`~/projects/flywheel-vscode/` does not exist yet. The first step is physically creating the directory and bootstrapping the monorepo. No files in other repos need editing. Existing tokens and configs are **read-only**.
