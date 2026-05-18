/**
 * Full graph panel: WebviewPanel hosting the React+Cosmograph graph view.
 *
 * Lifecycle:
 *   - On `attach` from the webview, fetch get_node_tree, send a snapshot,
 *     start the poller.
 *   - On 2s tick, fetch tree again, diff against last revisions/edges, post a
 *     patch fact (if any ops). Patches are coalesced over a 30ms window before
 *     send to keep the webview render loop calm.
 *   - On view hidden (onDidChangeViewState), pause polling. On visible, resume.
 *   - On panel dispose, stop the poller.
 */

import * as vscode from 'vscode';
import {
  type FlywheelMcpClient,
  type Fact,
  type Intent,
  type PatchOp,
  diffProjection,
  emptyState,
  getNode,
  getNodeTree,
} from 'flywheel-core';
import { getWebviewHtml } from '../webview-bridge.js';
import { Poller } from '../polling/poller.js';

const COALESCE_MS = 30;
const BODY_FETCH_CONCURRENCY = 6;

export class GraphPanel {
  private static current: GraphPanel | undefined;
  private seq = 0;
  private repoFilter: string | null = null;
  private prev: { fingerprints: Map<string, string>; edgeKeys: Set<string> } = emptyState();
  private poller: Poller | null = null;
  private pendingOps: PatchOp[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Tree-projection fingerprint of each node the last time we fetched its body
   * (content + summary). When the live fingerprint changes we refetch.
   * Tree projection drops content/summary, so the webview can't render a
   * TL;DR preview without this eager enrichment. */
  private bodyFingerprints: Map<string, string> = new Map();
  /** Latest enrichment run id; in-flight fetches with a stale id are dropped
   * so a quick reload doesn't race against an older snapshot. */
  private enrichRunId = 0;

  static currentInstance(): GraphPanel | undefined {
    return GraphPanel.current;
  }

  /** Slug → node_id map of the currently-loaded subgraph. */
  getSlugIndex(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [id, node] of this.lastNodes) {
      const slug = node.slug_name;
      if (slug) out[slug] = id;
    }
    return out;
  }

  getNodes(): Map<string, import('flywheel-core').FlywheelNode> {
    return this.lastNodes;
  }

  getEdges(): import('flywheel-core').FlywheelEdge[] {
    return this.lastEdges;
  }

  getSelected(): string | null {
    return this.selectedNodeId;
  }

  onSelectionChange(cb: (nodeId: string | null) => void): vscode.Disposable {
    this.selectionListeners.add(cb);
    return new vscode.Disposable(() => this.selectionListeners.delete(cb));
  }

  /** Most recent loaded node objects keyed by node_id. */
  private lastNodes: Map<string, import('flywheel-core').FlywheelNode> = new Map();
  private lastEdges: import('flywheel-core').FlywheelEdge[] = [];
  private selectedNodeId: string | null = null;
  private readonly selectionListeners = new Set<(id: string | null) => void>();

  toggleRepoFilter(repoUrl: string): void {
    this.repoFilter = this.repoFilter === repoUrl ? null : repoUrl;
    this.send({ kind: 'filter', repoFilter: this.repoFilter });
  }

  setRepoFilter(repoUrl: string | null): void {
    this.repoFilter = repoUrl;
    this.send({ kind: 'filter', repoFilter: this.repoFilter });
  }

  static async show(
    context: vscode.ExtensionContext,
    client: FlywheelMcpClient,
    rootNodeId: string,
  ): Promise<GraphPanel> {
    if (GraphPanel.current) {
      const cur = GraphPanel.current;
      cur.rootNodeId = rootNodeId;
      cur.prev = emptyState();
      cur.bodyFingerprints.clear();
      cur.panel.reveal();
      await cur.loadAndSnapshot();
      cur.startPolling();
      return cur;
    }
    const panel = vscode.window.createWebviewPanel(
      'flywheel.graph',
      'Flywheel Graph',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        enableCommandUris: ['flywheel.openNodeById'],
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview')],
      },
    );
    GraphPanel.current = new GraphPanel(panel, context, client, rootNodeId);
    return GraphPanel.current;
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    private readonly client: FlywheelMcpClient,
    private rootNodeId: string,
  ) {
    this.panel.webview.html = getWebviewHtml(this.panel.webview, context, {
      init: { viewId: 'graph' },
    });

    this.panel.onDidDispose(() => {
      this.disposePolling();
      GraphPanel.current = undefined;
    });

    this.panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.visible) this.poller?.resume();
      else this.poller?.pause();
    });

    this.panel.webview.onDidReceiveMessage((msg: Intent) => {
      void this.handleIntent(msg);
    });
  }

  private send(fact: Fact): void {
    void this.panel.webview.postMessage(fact);
  }

  private async handleIntent(intent: Intent): Promise<void> {
    switch (intent.kind) {
      case 'attach':
        await this.loadAndSnapshot();
        this.startPolling();
        return;
      case 'requestSnapshot':
        await this.loadAndSnapshot();
        return;
      case 'detach':
        this.disposePolling();
        return;
      case 'requestNodeDetail':
        this.selectedNodeId = intent.nodeId;
        for (const cb of this.selectionListeners) cb(this.selectedNodeId);
        await vscode.commands.executeCommand('flywheel.openNodeById', intent.nodeId);
        return;
      case 'requestSemanticSearch':
      case 'setRepoFilter':
        return;
      case 'saveNodeContent':
        // Saving is handled by the per-node detail panel; the graph panel
        // ignores this intent.
        return;
      default: {
        const _exhaustive: never = intent;
        void _exhaustive;
      }
    }
  }

  private async loadAndSnapshot(): Promise<void> {
    try {
      const tree = await getNodeTree(this.client, this.rootNodeId);
      const rootNode = tree.nodes.find((n) => n.node_id === tree.root_id);
      const fingerprints = new Map<string, string>();
      const edgeKeys = new Set<string>();
      for (const n of tree.nodes) {
        fingerprints.set(
          n.node_id,
          `${n.title}|${n.revision ?? ''}|${(n.outgoing_ids ?? []).join(',')}|${(n.incoming_ids ?? []).join(',')}`,
        );
      }
      for (const e of tree.edges) edgeKeys.add(`${e.parent_id}->${e.child_id}`);
      this.prev = { fingerprints, edgeKeys };
      this.lastNodes = new Map(tree.nodes.map((n) => [n.node_id, n]));
      this.lastEdges = tree.edges;

      this.seq += 1;
      this.send({
        kind: 'snapshot',
        viewId: 'graph',
        nodes: tree.nodes,
        edges: tree.edges,
        seq: this.seq,
      });
      this.send({
        kind: 'status',
        connected: true,
        nodeCount: tree.nodes.length,
        rootSlug: rootNode?.slug_name ?? null,
      });
      // Fire-and-forget: pull content + summary for every node so the webview's
      // hover preview can extract the TL;DR callout. The tree projection
      // strips both fields.
      void this.enrichBodies(tree.nodes.map((n) => n.node_id));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.send({ kind: 'error', message: msg });
      this.send({ kind: 'status', connected: false, nodeCount: 0, rootSlug: null });
      void vscode.window.showErrorMessage(`Flywheel: ${msg}`);
    }
  }

  private startPolling(): void {
    if (this.poller) return;
    const cfg = vscode.workspace.getConfiguration('flywheel');
    const intervalMs = cfg.get<number>('pollIntervalMs') ?? 2000;
    this.poller = new Poller(() => this.pollTick(), { intervalMs });
    this.poller.start();
  }

  private disposePolling(): void {
    this.poller?.dispose();
    this.poller = null;
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.pendingOps = [];
  }

  private async pollTick(): Promise<void> {
    const tree = await getNodeTree(this.client, this.rootNodeId);
    const { ops, nextFingerprints, nextEdgeKeys } = diffProjection(
      this.prev.fingerprints,
      this.prev.edgeKeys,
      tree,
    );
    this.prev = { fingerprints: nextFingerprints, edgeKeys: nextEdgeKeys };
    this.lastNodes = new Map(tree.nodes.map((n) => [n.node_id, n]));
    this.lastEdges = tree.edges;
    if (ops.length === 0) return;
    this.queueOps(ops);
    // Refetch bodies only for nodes that the diff touched (add/update). The
    // body cache is keyed by tree fingerprint, so unchanged nodes are skipped
    // inside enrichBodies even if we pass them.
    const touched: string[] = [];
    for (const op of ops) {
      if (op.op === 'addNode') touched.push(op.node.node_id);
      else if (op.op === 'updateNode') touched.push(op.nodeId);
    }
    if (touched.length > 0) void this.enrichBodies(touched);
  }

  /**
   * Fetch full node bodies (content + summary) for the given ids and forward
   * them to the webview as `updateNode` patch ops. Skips ids whose tree
   * fingerprint matches the last successful fetch — repeated polls won't
   * thrash the server.
   *
   * Runs concurrent up to BODY_FETCH_CONCURRENCY. A new call cancels in-flight
   * results from previous calls via `enrichRunId` so a fast reload doesn't
   * push stale bodies onto a newer snapshot.
   */
  private async enrichBodies(nodeIds: string[]): Promise<void> {
    const runId = ++this.enrichRunId;
    const queue: string[] = [];
    for (const id of nodeIds) {
      const fp = this.prev.fingerprints.get(id);
      if (fp === undefined) continue;
      if (this.bodyFingerprints.get(id) === fp) continue;
      queue.push(id);
    }
    if (queue.length === 0) return;

    const workers: Promise<void>[] = [];
    const limit = Math.min(BODY_FETCH_CONCURRENCY, queue.length);
    for (let i = 0; i < limit; i++) {
      workers.push(
        (async () => {
          while (queue.length > 0) {
            const id = queue.shift();
            if (!id) break;
            if (runId !== this.enrichRunId) return;
            try {
              const node = await getNode(this.client, id);
              if (runId !== this.enrichRunId) return;
              const fpNow = this.prev.fingerprints.get(id);
              if (fpNow === undefined) continue;
              this.bodyFingerprints.set(id, fpNow);
              const existing = this.lastNodes.get(id);
              if (existing) {
                existing.content = node.content;
                existing.summary = node.summary;
              }
              this.queueOps([
                {
                  op: 'updateNode',
                  nodeId: id,
                  partial: { content: node.content, summary: node.summary },
                },
              ]);
            } catch {
              // Network/MCP error for a single node is non-fatal — the hover
              // preview will fall back to the slug/title, and the next diff
              // tick will re-queue this id.
            }
          }
        })(),
      );
    }
    await Promise.all(workers);
  }

  /**
   * Coalesce ops over a short window to reduce render churn in the webview.
   * Last-write-wins for same node; cap at 200 ops → fall back to snapshot.
   */
  private queueOps(ops: PatchOp[]): void {
    this.pendingOps.push(...ops);
    if (this.pendingOps.length > 200) {
      this.pendingOps = [];
      void this.loadAndSnapshot();
      return;
    }
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const dedup = collapseLastWriteWins(this.pendingOps);
      this.pendingOps = [];
      this.seq += 1;
      this.send({ kind: 'patch', viewId: 'graph', ops: dedup, seq: this.seq });
    }, COALESCE_MS);
  }
}

function collapseLastWriteWins(ops: PatchOp[]): PatchOp[] {
  // Keep only the latest op per nodeId for node-scoped ops; keep all edge ops.
  const lastNodeOpIdx = new Map<string, number>();
  const out: (PatchOp | null)[] = ops.slice();
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    if (op.op === 'addNode' || op.op === 'updateNode' || op.op === 'removeNode') {
      const id = op.op === 'addNode' ? op.node.node_id : op.nodeId;
      const prev = lastNodeOpIdx.get(id);
      if (prev !== undefined) out[prev] = null;
      lastNodeOpIdx.set(id, i);
    }
  }
  return out.filter((op): op is PatchOp => op !== null);
}
