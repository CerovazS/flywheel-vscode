# Plan — Flywheel VS Code Graph Viewer (`flywheel-vscode`)

## Context

L'utente vuole un'estensione VS Code che renda i grafi di Flywheel (`flywheel.paradigma.inc`, sistema di knowledge-graph per ricerca scientifica) usabili come Obsidian Graph View: rendering fluido con physics, filtro per progetto GitHub, controllo live delle sessioni autoresearch attive, rendering Obsidian-fedele del markdown nei nodi (callout, math, wikilink, immagini), e ricerca semantica locale.

**Problema risolto**: oggi i grafi Flywheel sono usabili solo via MCP (testuale, lento) o web app (poco controllo, non integrato nell'IDE dove l'utente passa la giornata). Quando un autoresearch genera 50+ nodi su un singolo progetto, mescolati a quelli di altri repo, diventa impossibile orientarsi senza filtro per progetto e senza visualizzazione fluida.

**Outcome atteso**: estensione VS Code che, aperto un repo GitHub, mostra istantaneamente solo il sotto-grafo Flywheel di quel repo, anima i nodi nuovi durante un autoresearch live, permette di leggere ogni nodo con rendering identico ad Obsidian, e cerca semanticamente sui contenuti riusando lo stesso indice già costruito da `obsidian-search`.

**Decisioni utente (locked-in)**:
- **Embedding**: Qwen3-0.6B via Ollama, riusa lo stesso indice di `obsidian-search` (`~/.local/share/obsidian-search/index.sqlite`, schema 1024-dim cosine).
- **Live updates**: solo polling-diff (no relay hooks). Latenza accettabile 2–5s.
- **CLI/TUI**: fuori scope MVP. Monorepo predisposto a 3 package ma solo `flywheel-core` + `flywheel-vscode` implementati ora.
- **Repo**: locale `~/projects/flywheel-vscode/`. Niente CI, niente publish.

---

## 1. Architettura locked-in

| Layer | Scelta | Motivazione |
|---|---|---|
| Linguaggio | TypeScript (strict) su Node 20 | Webview + extension host stesso linguaggio, type-share via core package |
| Repo layout | pnpm workspaces monorepo a 3 package | Scaffolding già pronto per CLI fase 2 senza refactor |
| Render del grafo (full) | `@cosmograph/cosmos` (cosmos.gl, MIT) | GPU force-sim, ~1M nodi, scala live durante autoresearch |
| Render del grafo (mini sidebar) | `force-graph` (vasturiano, canvas+d3-force) | API banale, ottimo ≤5k nodi locali |
| Markdown pipeline | `unified` + remark + rehype-callouts + KaTeX + remark-wiki-link | Obsidian-fedele, AST walkable per estrarre wikilink come edge |
| Vector store | `sqlite-vec` + `better-sqlite3` | Riusa schema `obsidian-search` (1024-dim cosine), SIMD, single .db file |
| Embedding | Qwen3-Embedding-0.6B via Ollama HTTP | Identico a `obsidian-search`, già installato |
| Stato webview | Zustand | Lightweight, due slice (`graph`, `ui`); host = source of truth |
| Transport host↔webview | `vscode-messenger` (TypeFox) | JSON-RPC tipato sopra postMessage, niente correlation-id manuale |
| Repo identity | VS Code Git extension API (`vscode.git`) | Niente parsing manuale di `.git/config` |
| Boilerplate iniziale | `estruyf/vscode-react-webview-template` (Vite + React + TS) | Mantenuto, message-passing helper incluso |

---

## 2. Layout del monorepo

```
~/projects/flywheel-vscode/
  package.json                     # root workspace
  pnpm-workspace.yaml
  tsconfig.base.json
  .vscode/                         # launch.json per F5-debug dell'estensione
  packages/
    flywheel-core/                 # ─── implementato in MVP ───
      src/
        client/                    # MCP/HTTP client a Flywheel
          mcp.ts                   # wrapper sui tool MCP via JSON-RPC
          contract.ts              # type generati da flywheel_get_contract
          types.ts                 # Node, Edge, Artifact, RepoContext
        graph/
          tree.ts                  # get_node_tree + cache
          diff.ts                  # polling-diff su revision
          subgraph.ts              # export_subgraph per snapshot offline
        search/
          schema.ts                # CREATE TABLE compatibile obsidian-search
          ollama.ts                # client embedding Qwen3-0.6B
          index.ts                 # indicizzazione + KNN query
        repo/
          github.ts                # parse repo URL → {owner, repo, branch}
        protocol.ts                # message types webview ↔ host (tipati)
      package.json
      tsconfig.json
    flywheel-vscode/               # ─── implementato in MVP ───
      src/
        extension.ts               # entrypoint, registra commands+views
        panels/
          GraphPanel.ts             # WebviewPanel principale (Cosmograph)
          MiniGraphView.ts          # WebviewView sidebar (force-graph)
          NodeDetailPanel.ts        # WebviewPanel per dettaglio nodo (markdown)
        views/
          SessionsTreeProvider.ts   # TreeView nativo per executions/leases attivi
        commands/
          filterByRepo.ts           # QuickPick repo
          searchSemantic.ts         # QuickPick + sqlite-vec
          openNodeBySlug.ts         # input box → resolve_node_slug → apri
        polling/
          poller.ts                 # polling-diff scheduler
        webview/                    # bundle React (Vite)
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
    flywheel-cli/                  # ─── stub vuoto, fase 2 ───
      package.json                  # solo placeholder
      README.md                     # "TODO phase 2"
```

---

## 3. Modulo `flywheel-core`

### 3.1 Client MCP (`packages/flywheel-core/src/client/mcp.ts`)

- Trasporto HTTP-MCP verso `https://flywheel.paradigma.inc/mcp-server`. Reuse della config in `~/.claude.json` (`mcpServers.flywheel.headers.Authorization`) tramite lettura del file all'init dell'estensione (NON hardcodare il token; leggi da `vscode.workspace.getConfiguration('flywheel').get('token')` con fallback a `~/.claude.json`).
- Init flow: `flywheel_get_contract` → cache locale per la durata della sessione → `flywheel_get_contract_section('graph' | 'artifacts' | 'hooks')` lazy.
- Idempotency-key automatica per i write (anche se MVP è read-only).
- Rate limit awareness: 120 reads/min, 2000/24h — rispettali con un token bucket lato client.

### 3.2 Type del nodo (`types.ts`)

Schema canonico Flywheel (da `~/.claude/skills/flywheel/references/`):
```ts
export interface FlywheelNode {
  node_id: string;            // UUID immutabile
  slug_name: string;          // adjective-noun-####
  title: string;
  content: string;            // Markdown
  summary: string | null;
  revision: number;           // optimistic locking key per polling-diff
  visibility: 'private' | 'shared' | 'unlisted' | 'public';
  repo_context: RepoContext | null;
  tags: NodeTag[];
  created_at: string;
  updated_at: string;
}

export interface RepoContext {
  repo_url: string;           // 🔑 chiave del filtro per progetto
  branch_name: string;
  head_commit_sha: string;
  origin_host: string;        // 'github.com' tipicamente
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
  // Multi-parent supportato (DAG, no cicli)
}
```

### 3.3 Polling-diff (`graph/diff.ts`)

Algoritmo:
1. Stato locale: `Map<node_id, revision>`.
2. Ogni 2s (configurabile via setting `flywheel.pollIntervalMs`), chiamare `flywheel_get_node_tree(active_root, depth=infinity)`.
3. Calcolare delta:
   - `addedNodes`: presenti nella response, assenti localmente.
   - `updatedNodes`: presenti in entrambi con `revision` cambiata.
   - `removedNodes`: assenti dalla response.
   - `addedEdges` / `removedEdges`: diff degli edge.
4. Emettere `Patch` events tramite `vscode-messenger` al webview.
5. Pausare il polling quando il `WebviewPanel` non è visibile (`onDidChangeViewState`).
6. Backoff exponential se la chiamata fallisce (max 30s).

### 3.4 Riconoscimento del repo GitHub corrente (`repo/github.ts`)

```ts
export async function getCurrentRepoUrl(): Promise<string | null> {
  const ext = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (!ext?.isActive) await ext?.activate();
  const api = ext!.exports.getAPI(1);
  const repo = api.repositories[0];                 // primo workspace folder
  if (!repo) return null;
  const origin = repo.state.remotes.find(r => r.name === 'origin');
  return origin?.fetchUrl ?? null;                  // es. https://github.com/owner/repo.git
}
```
Listener su `api.onDidOpenRepository` e `repo.state.onDidChange` per tenere sincronizzato il filtro corrente. Funzione `normalizeRepoUrl(url)` che canonicalizza `git@github.com:owner/repo.git`, `https://github.com/owner/repo`, `https://github.com/owner/repo.git` alla stessa forma per match contro `node.repo_context.repo_url`.

### 3.5 Search index (`search/`)

**Riusa `obsidian-search` schema** per compatibilità totale.

`schema.ts`:
```sql
CREATE TABLE IF NOT EXISTS chunks (
  chunk_id    TEXT PRIMARY KEY,
  node_id     TEXT NOT NULL,        -- (cambia da file_path)
  node_slug   TEXT NOT NULL,
  section     TEXT,
  chunk_index INTEGER,
  content     TEXT NOT NULL,
  revision    INTEGER NOT NULL      -- per detection stale
);
CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0 (
  chunk_id    TEXT PRIMARY KEY,
  embedding   FLOAT[1024] distance_metric=cosine
);
CREATE INDEX IF NOT EXISTS chunks_by_node ON chunks(node_id);
```
DB path: `${context.globalStorageUri.fsPath}/index.sqlite`.

`ollama.ts`: HTTP POST a `http://localhost:11434/api/embed`, model `qwen3-embedding:0.6b`, batch size 32. Errore esplicito se Ollama non risponde (mostrare notification VS Code "Start Ollama or change embedding backend").

`index.ts`:
- **Chunking identico** a `obsidian-search/src/obsidian_search/chunker.py`: heading-aware split (`#`, `##`, ...), max 2000 char, overlap 256 char a paragraph boundary, prefix `"Node: {slug} | Section: {heading}\n\n"`.
- `chunk_id = sha256(node_id::section::chunk_index)[:16]`.
- Re-index trigger: callback dal poller quando un nodo ha `revision` cambiata.
- KNN query: `SELECT chunk_id, distance FROM vec_chunks WHERE embedding MATCH ? AND k = ? ORDER BY distance` + JOIN su `chunks`.

---

## 4. Estensione VS Code (`flywheel-vscode`)

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

### 4.2 Mappa primitives → componenti

| Componente | Primitive | File |
|---|---|---|
| Graph fullscreen | `WebviewPanel` con `retainContextWhenHidden: true` | `panels/GraphPanel.ts` |
| Mini-graph del nodo aperto | `WebviewView` in sidebar | `panels/MiniGraphView.ts` |
| Dettaglio nodo (markdown) | `WebviewPanel` editor-side, una per nodo, riusabile | `panels/NodeDetailPanel.ts` |
| Sessioni autoresearch attive | `TreeView` nativo | `views/SessionsTreeProvider.ts` |
| Filtro per repo | `QuickPick` da command palette | `commands/filterByRepo.ts` |
| Ricerca semantica | `QuickPick` con preview | `commands/searchSemantic.ts` |
| Apri per slug | `showInputBox` → `resolve_node_slug` | `commands/openNodeBySlug.ts` |

### 4.3 Sessioni autoresearch (TreeView)

Tre fonti di "sessione attiva":
- `flywheel_list_executions(status='running')` → execution di un autoresearch.
- `stage_lease` aperti su nodi (rilevati via `get_node` che torna `lease_holder`).
- `approval_session` aperti (`flywheel_list_approval_sessions`).

Refresh ogni 5s. Click su una row → fa zoom sul nodo target nel `GraphPanel`. Context-menu: "Terminate execution", "Release lease" (richiedono scope `write`).

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

Backpressure host-side: buffer `pendingPatches[]` per viewId, flush ogni ~30ms via `setInterval`, last-write-wins su `node_id`. Se buffer > 200 op pendenti → invia `snapshot` invece. Webview persiste `lastSeq` via `acquireVsCodeApi().setState`; al re-attach chiede `requestSnapshot` se gap.

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
      permalinks: [],                   // sentinella; resolve dinamico via hrefTemplate
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

Pre-processo per `==highlight==`: regex transform `==(.+?)==` → `<mark>$1</mark>` (semplice, evita un plugin in più).

Per `![[image.png]]` (image embed): walk dell'mdast prima di `remark-rehype`, detect `wikiLink` con `value` che termina in `.png|.jpg|.svg|.gif`, rewrite a `image` node con `url = artifact.storage_url`. Richiede mappa `imageName → artifact_id` ottenuta da `flywheel_list_artifacts(node_id)`.

CSS: import `katex/dist/katex.min.css` e i preset Obsidian di `rehype-callouts` (forniti dal pacchetto). Bundle con Vite, inietta come `<style>` nel webview HTML.

Wiki link click: VS Code intercetta `command:` URI quando webview è creato con `enableCommandUris: true` e una allowlist esplicita.

### 4.6 Cosmograph integration (`webview/src/FullGraph.tsx`)

- Init: `new Graph(canvas, { simulationGravity: 0.1, simulationRepulsion: 1.0, ... })`.
- Color encoding: tag primario del nodo (`node.tags[0].bg_color`), default grigio se assente.
- Size encoding: `log(artifact_count + 1)`.
- Hover: callback → emette intent `requestNodeDetail` → mostra tooltip con titolo + summary.
- Click: zoom + pin focus + apri `NodeDetailPanel`.
- Filter API: `cosmograph.setData(nodes.filter(...))`. Per repo filter: `nodes.filter(n => normalizeRepoUrl(n.repo_context?.repo_url) === currentRepo)`.
- Streaming: subscribe allo store Zustand; quando arrivano patch, applica `cosmograph.addPoints(...)` / `cosmograph.removePoints(...)` senza reset della simulazione (key feature di cosmos.gl).
- `retainContextWhenHidden: true` mandatory sul WebviewPanel.

---

## 5. File esistenti da riusare / non duplicare

| File | Uso | Note |
|---|---|---|
| `~/.claude.json` (riga ~880) | Sorgente del bearer token Flywheel | Leggere read-only; mai scriverci. Path: `mcpServers.flywheel.headers.Authorization` |
| `~/.claude/skills/flywheel/references/flywheel-mcp-tool-map.md` | Catalogo tool MCP per categoria | Single source-of-truth per `flywheel-core/src/client/contract.ts` |
| `~/.claude/skills/flywheel/references/INTERFACES.md` | Mappatura HTTP↔MCP | Utile se in futuro si vuole bypassare MCP |
| `~/.claude/skills/flywheel/references/ARTIFACTS.md` | Contratto upload/finalize artifact | Per fase 2 (write); MVP solo lettura |
| `~/obsidian-search/src/obsidian_search/store.py` | Schema SQLite di riferimento | Replicare 1:1 in `flywheel-core/src/search/schema.ts` |
| `~/obsidian-search/src/obsidian_search/chunker.py` | Chunking heading-aware | Re-implementare in TS preservando esattamente boundary, overlap, prefix |
| `~/obsidian-search/src/obsidian_search/embedder.py` | Client Ollama Qwen3-0.6B | Modello: `qwen3-embedding:0.6b`, batch 32, vec dim 1024 |
| `~/.local/share/obsidian-search/index.sqlite` | NON condividere | DB indipendente per Flywheel: `${globalStorageUri}/index.sqlite` con stesso schema |

---

## 6. Roadmap step-by-step

### Fase 0 — Bootstrap (~1h)
1. `mkdir -p ~/projects/flywheel-vscode && cd ~/projects/flywheel-vscode`
2. `pnpm init`, configura `pnpm-workspace.yaml` con `packages/*`.
3. Crea `tsconfig.base.json` (strict, ES2022, moduleResolution=bundler).
4. Scaffold dei 3 package con `package.json` minimi.
5. Clona localmente `estruyf/vscode-react-webview-template` come riferimento (NON come dipendenza), copia il setup Vite+React in `packages/flywheel-vscode/src/webview/`.

### Fase 1 — `flywheel-core` minimale (~1d)
6. `client/mcp.ts`: client JSON-RPC stub. Reading `~/.claude.json` per il token.
7. `client/types.ts`: type da §3.2.
8. `client/contract.ts`: invocazione `flywheel_get_contract` + cache.
9. `repo/github.ts`: `getCurrentRepoUrl()` + `normalizeRepoUrl()`.
10. `protocol.ts`: type `Intent` / `Fact` / `PatchOp`.
11. Test smoke: script Node che chiama `flywheel_list_nodes(projection='topology')` e stampa N nodi.

### Fase 2 — Estensione skeleton (~1d)
12. `extension.ts`: registra command `flywheel.openGraph` che apre un `WebviewPanel` placeholder ("hello world").
13. Configura launch config `.vscode/launch.json` per F5 → Extension Development Host.
14. Bundle Vite del webview, message-passing helloworld via `vscode-messenger`.
15. Verifica: F5, palette `Flywheel: Open Graph`, vedi il webview.

### Fase 3 — Graph statico (~2d)
16. `flywheel-core/src/graph/tree.ts`: wrapper su `flywheel_get_node_tree`.
17. `panels/GraphPanel.ts`: chiama `tree`, posta `snapshot` al webview.
18. `webview/src/FullGraph.tsx`: integra `@cosmograph/cosmos`, render dei nodi con tag-color.
19. Click nodo → log nella console del webview.
20. Verifica: aprire un root reale, vedere il grafo renderizzato.

### Fase 4 — Filtro per repo + repo identity (~0.5d)
21. `commands/filterByRepo.ts`: legge repo corrente via Git API, applica filter al grafo (Zustand `ui.repoFilter`).
22. Listener su `onDidOpenRepository` → auto-filter all'apertura.
23. Verifica: in repo A vedi solo nodi di A; switch a repo B → grafo si aggiorna.

### Fase 5 — Polling-diff e live updates (~1d)
24. `polling/poller.ts`: scheduler 2s con `onDidChangeViewState` pause.
25. `flywheel-core/src/graph/diff.ts`: algoritmo da §3.3.
26. `panels/GraphPanel.ts`: invia `patch` events al webview con coalescing 30ms.
27. `FullGraph.tsx`: applica patch via `cosmograph.addPoints`/`removePoints` senza reset.
28. Verifica: lancia un autoresearch da terminale, vedi i nodi nuovi animarsi nel grafo entro ~2s.

### Fase 6 — Node detail panel + markdown pipeline (~1.5d)
29. `panels/NodeDetailPanel.ts`: nuovo `WebviewPanel` su click nodo, riusabile per nodo (un panel per node_id).
30. `webview/src/md/pipeline.ts`: catena unified completa.
31. CSS Obsidian theme + KaTeX.
32. Pre-process `==highlight==`, image embed via artifact lookup.
33. Wikilinks → `command:flywheel.openNodeById`.
34. Verifica: apri un nodo con math, callout, wikilink, immagine — render fedele.

### Fase 7 — Mini-graph sidebar + Sessions tree (~1d)
35. `MiniGraphView.ts`: WebviewView con `force-graph` su 1-hop neighborhood del nodo selezionato.
36. `SessionsTreeProvider.ts`: TreeView con `list_executions` + `list_approval_sessions` + lease.
37. Refresh 5s. Click row → zoom nel GraphPanel.

### Fase 8 — Ricerca semantica (~1.5d)
38. `flywheel-core/src/search/schema.ts`: `CREATE TABLE` schema.
39. `search/ollama.ts`: client Qwen3-0.6B.
40. `search/index.ts`: chunking + indicizzazione, hookato al poller (revision-driven).
41. Comando `flywheel.reindexAll`: full rebuild.
42. `commands/searchSemantic.ts`: QuickPick con preview snippet, click → apri NodeDetail.
43. Verifica: query semantica torna nodi rilevanti; reindicizza dopo modifica.

### Fase 9 — Polish (~0.5d)
44. Settings UI (token override, polling interval, ollama URL).
45. Status bar item "Flywheel: connected to X nodes (root: Y)".
46. Error notifications gracefully.
47. README.md con screenshots.

**Totale stimato MVP: ~10 giornate uomo.**

---

## 7. Verifica end-to-end

### 7.1 Setup pre-test
```bash
# Verifica Ollama up con modello
curl http://localhost:11434/api/tags | jq '.models[] | select(.name | startswith("qwen3-embedding"))'
# Verifica token Flywheel
jq '.mcpServers.flywheel.headers.Authorization' ~/.claude.json
```

### 7.2 Smoke test flywheel-core
```bash
cd ~/projects/flywheel-vscode/packages/flywheel-core
pnpm tsx scripts/smoke-list-nodes.ts   # script ad-hoc che stampa N nodi via MCP
```
**Atteso**: lista di nodi senza errori auth.

### 7.3 Verifica estensione
1. F5 → Extension Development Host si apre.
2. Apri un workspace che è un repo GitHub indicizzato in Flywheel.
3. Comando `Flywheel: Open Graph` → vedi grafo Cosmograph dei nodi del repo.
4. Comando `Flywheel: Filter by Current Repo` → restano solo nodi con `repo_context.repo_url` matching.
5. Click su un nodo → si apre `NodeDetailPanel` con markdown renderizzato.
6. In altra finestra: lancia un autoresearch (es. via slash command Claude `/flywheel-auto`). Entro 2-5s vedi nodi nuovi apparire nel grafo con animazione physics.
7. Sidebar **Active Sessions**: vedi l'execution running, click → zoom sul target.
8. Comando `Flywheel: Semantic Search…`, query "loss spike during pretraining" → top-5 nodi ordinati per similarity.

### 7.4 Edge case
- **Ollama down all'avvio**: l'estensione carica, grafo funziona, search mostra errore "Ollama unreachable" senza crash.
- **Nodo eliminato durante polling**: scompare dal grafo senza re-layout brusco.
- **Repo URL con auth (`git@github.com:...` vs `https://`)**: `normalizeRepoUrl` matcha entrambe le forme.
- **Token MCP scaduto**: notification "Flywheel auth failed, check ~/.claude.json".
- **WebviewPanel chiuso e riaperto**: state persisted via `setState`, snapshot resync se gap di seq.

---

## 8. Out of scope MVP (fase 2+)

- **CLI/TUI** (`flywheel-cli`): scaffolding del package c'è, contenuto vuoto.
- **Hook relay self-hosted** per WebSocket near-real-time.
- **Write operations** (commit, branch, merge): MVP è read-only.
- **Marketplace publish** + Open VSX.
- **Zed**: bloccato dall'API Zed; quando arriva la Visual Extension API si valuta porting.
- **Embedding alternativi** (bge-small in-process): codice predisposto via `flywheel.embeddingBackend` enum, ma solo `ollama-qwen3` implementato.
- **Multi-graph**: MVP supporta 1 root attivo per volta (cambia via comando), no view multi-grafo simultanea.

---

## 9. Riferimenti esterni chiave

- **Flywheel MCP server**: `https://flywheel.paradigma.inc/mcp-server`
- **Flywheel docs**: `https://docs.flywheel.paradigma.inc/tutorial`
- **cosmos.gl** (graph engine): `https://github.com/cosmosgl/graph` (MIT)
- **rehype-callouts**: `https://github.com/lin-stephanie/rehype-callouts`
- **Quartz OFM plugin** (catena di riferimento): `https://github.com/jackyzha0/quartz/blob/v4/quartz/plugins/transformers/ofm.ts`
- **sqlite-vec**: `https://github.com/asg017/sqlite-vec`
- **better-sqlite3**: `https://github.com/WiseLibs/better-sqlite3`
- **vscode-messenger**: `https://github.com/TypeFox/vscode-messenger`
- **estruyf VS Code template**: `https://github.com/estruyf/vscode-react-webview-template`
- **VS Code Git extension API**: `https://github.com/microsoft/vscode/blob/main/extensions/git/src/api/git.d.ts`
- **VS Code Webview docs**: `https://code.visualstudio.com/api/extension-guides/webview`

---

## 10. Stato corrente del repo

`~/projects/flywheel-vscode/` non esiste ancora. Il primo step è la creazione fisica della directory e bootstrap del monorepo. Nessun file da modificare in altri repo. Token e config esistenti sono **letti** (read-only).
