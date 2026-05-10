/**
 * Per-node detail panel. One WebviewPanel per nodeId, deduplicated.
 *
 * On `requestNodeDetail`, the host fetches `flywheel_get_node` and
 * `flywheel_list_artifacts`, builds a slug index from the active graph state,
 * and posts a `nodeDetail` Fact with `{ node, artifacts, slugIndex }` so the
 * webview pipeline can resolve `[[wikilinks]]` and `![[image.png]]` embeds.
 *
 * The panel reuses the same Vite bundle as the graph view; routing happens
 * via `__FLYWHEEL_INIT__.viewId === 'node-detail'`.
 */

import * as vscode from 'vscode';
import {
  type FlywheelArtifact,
  type FlywheelMcpClient,
  type FlywheelNode,
  type Intent,
  getNode,
  listArtifacts,
  updateNodeContent,
} from 'flywheel-core';
import { getWebviewHtml } from '../webview-bridge.js';

export interface NodeDetailContext {
  /** Active slug → node_id map; the GraphPanel keeps this fresh. */
  getSlugIndex(): Record<string, string>;
}

export class NodeDetailPanel {
  private static panels = new Map<string, NodeDetailPanel>();

  static async open(
    extensionContext: vscode.ExtensionContext,
    client: FlywheelMcpClient,
    nodeCtx: NodeDetailContext,
    nodeId: string,
  ): Promise<NodeDetailPanel> {
    const existing = NodeDetailPanel.panels.get(nodeId);
    if (existing) {
      existing.panel.reveal();
      await existing.refresh();
      return existing;
    }
    const panel = vscode.window.createWebviewPanel(
      'flywheel.node',
      'Flywheel: …',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        enableCommandUris: ['flywheel.openNodeById'],
        localResourceRoots: [
          vscode.Uri.joinPath(extensionContext.extensionUri, 'dist', 'webview'),
        ],
      },
    );
    const inst = new NodeDetailPanel(panel, extensionContext, client, nodeCtx, nodeId);
    NodeDetailPanel.panels.set(nodeId, inst);
    return inst;
  }

  private node: FlywheelNode | null = null;
  private artifacts: FlywheelArtifact[] = [];

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    extensionContext: vscode.ExtensionContext,
    private readonly client: FlywheelMcpClient,
    private readonly nodeCtx: NodeDetailContext,
    private readonly nodeId: string,
  ) {
    this.panel.webview.html = getWebviewHtml(this.panel.webview, extensionContext, {
      init: { viewId: 'node-detail', nodeId },
    });
    this.panel.onDidDispose(() => {
      NodeDetailPanel.panels.delete(this.nodeId);
    });
    this.panel.webview.onDidReceiveMessage((msg: Intent | { kind: string }) => {
      if (msg.kind === 'requestNodeDetail') {
        void this.refresh();
      } else if (msg.kind === 'saveNodeContent') {
        const m = msg as Extract<Intent, { kind: 'saveNodeContent' }>;
        void this.handleSave(m.nodeId, m.content);
      }
    });
  }

  private async handleSave(nodeId: string, content: string): Promise<void> {
    try {
      await updateNodeContent(this.client, nodeId, content);
      // Refresh from source-of-truth so the rendered view is consistent with
      // what the server stored (it may normalize / strip whitespace).
      await this.refresh();
      void this.panel.webview.postMessage({
        kind: 'saveResult',
        nodeId,
        ok: true,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      void this.panel.webview.postMessage({
        kind: 'saveResult',
        nodeId,
        ok: false,
        message,
      });
      void vscode.window.showErrorMessage(`Flywheel save failed: ${message}`);
    }
  }

  private async refresh(): Promise<void> {
    try {
      const [node, artifacts] = await Promise.all([
        getNode(this.client, this.nodeId),
        listArtifacts(this.client, this.nodeId).catch(() => []),
      ]);
      this.node = node;
      this.artifacts = artifacts;
      const idShort = (node.node_id ?? '').slice(0, 8) || 'node';
      const label = node.slug_name ?? node.title ?? idShort;
      this.panel.title = `Flywheel: ${label}`;
      void this.panel.webview.postMessage({
        kind: 'nodeDetail',
        node,
        artifacts,
        slugIndex: this.nodeCtx.getSlugIndex(),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      void this.panel.webview.postMessage({ kind: 'error', message: msg });
    }
  }
}
