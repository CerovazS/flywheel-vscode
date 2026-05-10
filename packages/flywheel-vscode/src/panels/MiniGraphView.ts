/**
 * Sidebar mini-graph WebviewView.
 *
 * Reuses the same Vite bundle (viewId='mini-graph') and Cosmograph engine.
 * The host pushes 1-hop neighborhood snapshots based on the GraphPanel's
 * current selection; if no GraphPanel is open the view is empty.
 *
 * NB: the plan called for force-graph here but we already ship Cosmograph
 * in the same bundle, so reusing it costs zero bundle weight and keeps
 * behavior consistent (same color palette, same physics feel).
 */

import * as vscode from 'vscode';
import type {
  FlywheelMcpClient,
  FlywheelEdge,
  FlywheelNode,
} from 'flywheel-core';
import { getWebviewHtml } from '../webview-bridge.js';

export interface MiniGraphContext {
  /** Read currently-known node by id from the active GraphPanel state. */
  getNode(nodeId: string): FlywheelNode | undefined;
  /** Read all edges from the active GraphPanel state. */
  getEdges(): FlywheelEdge[];
  /** Read all nodes (used to lookup neighbors by id). */
  getNodes(): Map<string, FlywheelNode>;
  /** Currently-selected node_id, or null. */
  getSelected(): string | null;
}

export class MiniGraphViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'flywheel.miniGraph';

  private view: vscode.WebviewView | null = null;
  private seq = 0;

  constructor(
    private readonly extensionContext: vscode.ExtensionContext,
    private readonly _client: FlywheelMcpClient,
    private readonly ctx: MiniGraphContext,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionContext.extensionUri, 'dist', 'webview'),
      ],
    };
    view.webview.html = getWebviewHtml(view.webview, this.extensionContext, {
      init: { viewId: 'mini-graph' },
    });
    view.onDidDispose(() => {
      this.view = null;
    });
    view.webview.onDidReceiveMessage((msg: { kind?: string }) => {
      // React mount sends { kind: 'attach' }. Any other intent (a click)
      // also triggers a refresh, which is cheap.
      if (msg.kind === 'attach' || msg.kind === 'requestSnapshot' || msg.kind === 'requestNodeDetail') {
        this.refresh();
      }
    });
  }

  /** Recompute the 1-hop neighborhood and push as a snapshot to the webview. */
  refresh(): void {
    const view = this.view;
    if (!view) return;
    const selected = this.ctx.getSelected();
    if (!selected) {
      this.seq += 1;
      void view.webview.postMessage({
        kind: 'snapshot',
        viewId: 'mini-graph',
        nodes: [],
        edges: [],
        seq: this.seq,
      });
      return;
    }
    const all = this.ctx.getNodes();
    const allEdges = this.ctx.getEdges();
    const center = all.get(selected);
    const keep = new Set<string>([selected]);
    const localEdges: FlywheelEdge[] = [];
    for (const e of allEdges) {
      if (e.parent_id === selected || e.child_id === selected) {
        keep.add(e.parent_id);
        keep.add(e.child_id);
        localEdges.push(e);
      }
    }
    const nodes: FlywheelNode[] = [];
    for (const id of keep) {
      const n = all.get(id);
      if (n) nodes.push(n);
    }
    if (center) {
      // Surface center first so it's index 0; useful for color emphasis.
      nodes.sort((a, b) => (a.node_id === selected ? -1 : b.node_id === selected ? 1 : 0));
    }
    this.seq += 1;
    void view.webview.postMessage({
      kind: 'snapshot',
      viewId: 'mini-graph',
      nodes,
      edges: localEdges,
      seq: this.seq,
    });
  }
}
