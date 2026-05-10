import * as vscode from 'vscode';
import { FlywheelMcpClient, resolveNodeRef } from 'flywheel-core';
import { GraphPanel } from './panels/GraphPanel.js';
import { NodeDetailPanel } from './panels/NodeDetailPanel.js';
import { MiniGraphViewProvider } from './panels/MiniGraphView.js';
import { SessionsTreeProvider } from './views/SessionsTreeProvider.js';
import { filterByRepoCommand } from './commands/filterByRepo.js';
import { searchSemanticCommand } from './commands/searchSemantic.js';
import { getCurrentRepoCanonicalUrl, onCurrentRepoChange } from './git.js';
import { getSearchIndex } from './search/manager.js';
import { installStatusBar } from './statusBar.js';
import {
  loadWorkspaceConfig,
  resolveActiveRootRef,
  watchWorkspaceConfig,
} from './workspaceConfig.js';

let client: FlywheelMcpClient | undefined;

function makeClient(): FlywheelMcpClient {
  const cfg = vscode.workspace.getConfiguration('flywheel');
  const tokenSetting = cfg.get<string>('token') ?? '';
  const url = cfg.get<string>('mcpUrl') ?? undefined;
  const opts: ConstructorParameters<typeof FlywheelMcpClient>[0] = {};
  if (tokenSetting.trim().length > 0) opts.token = tokenSetting.trim();
  if (url) opts.url = url;
  return new FlywheelMcpClient(opts);
}

function getClient(): FlywheelMcpClient {
  if (!client) client = makeClient();
  return client;
}

async function pickRootNodeRef(): Promise<string | undefined> {
  // Priority: .flywheel.json (per-repo) → user setting → input prompt.
  const fromWorkspace = await resolveActiveRootRef();
  if (fromWorkspace) return fromWorkspace;
  return vscode.window.showInputBox({
    title: 'Flywheel: Open Graph',
    prompt: 'Enter a root node slug (e.g. `lemon-zebra-0042`) or UUID',
    placeHolder: 'lemon-zebra-0042',
    ignoreFocusOut: true,
  });
}

/**
 * Open the graph for the workspace's configured root, then apply repo filter.
 * Used both by the auto-open flow and by the manual command.
 */
async function openGraphForWorkspace(
  context: vscode.ExtensionContext,
  miniGraph: MiniGraphViewProvider,
  ref: string,
  repoFilter: boolean,
): Promise<void> {
  const c = getClient();
  const rootId = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Flywheel: resolving…' },
    () => resolveNodeRef(c, ref),
  );
  const panel = await GraphPanel.show(context, c, rootId);
  context.subscriptions.push(panel.onSelectionChange(() => miniGraph.refresh()));
  miniGraph.refresh();
  if (repoFilter) {
    const url = await getCurrentRepoCanonicalUrl();
    if (url) panel.setRepoFilter(url);
  }
}

async function reindexLoaded(context: vscode.ExtensionContext): Promise<void> {
  const panel = GraphPanel.currentInstance();
  if (!panel) {
    void vscode.window.showInformationMessage(
      'Flywheel: open a graph first; reindex covers the loaded subgraph.',
    );
    return;
  }
  const idx = getSearchIndex(context);
  const nodes = Array.from(panel.getNodes().values());
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Flywheel: indexing…' },
    async (progress) => {
      progress.report({ message: `${nodes.length} nodes` });
      const res = await idx.indexNodes(nodes);
      void vscode.window.showInformationMessage(
        `Flywheel: indexed ${res.indexed} nodes (${res.skipped} unchanged).`,
      );
    },
  );
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('flywheel.token') || e.affectsConfiguration('flywheel.mcpUrl')) {
        client = undefined;
      }
    }),
  );

  const miniGraph = new MiniGraphViewProvider(context, getClient(), {
    getNode: (id) => GraphPanel.currentInstance()?.getNodes().get(id),
    getEdges: () => GraphPanel.currentInstance()?.getEdges() ?? [],
    getNodes: () => GraphPanel.currentInstance()?.getNodes() ?? new Map(),
    getSelected: () => GraphPanel.currentInstance()?.getSelected() ?? null,
  });
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(MiniGraphViewProvider.viewType, miniGraph, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  const sessions = new SessionsTreeProvider(getClient);
  const sessionsView = vscode.window.createTreeView('flywheel.sessions', {
    treeDataProvider: sessions,
    showCollapseAll: false,
  });
  context.subscriptions.push(sessionsView, sessions.bind(sessionsView));

  context.subscriptions.push(
    vscode.commands.registerCommand('flywheel.openGraph', async () => {
      try {
        const ref = await pickRootNodeRef();
        if (!ref) return;
        const { config } = await loadWorkspaceConfig();
        const repoFilter = config?.repoFilter ?? true;
        await openGraphForWorkspace(context, miniGraph, ref, repoFilter);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`Flywheel: ${msg}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('flywheel.filterByRepo', () => filterByRepoCommand()),
    vscode.commands.registerCommand('flywheel.searchSemantic', async () => {
      try {
        const idx = getSearchIndex(context);
        await searchSemanticCommand(idx);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`Flywheel: ${msg}`);
      }
    }),
    vscode.commands.registerCommand('flywheel.openNodeBySlug', async () => {
      const slug = await vscode.window.showInputBox({
        title: 'Flywheel: Open Node by Slug',
        prompt: 'Enter a slug (e.g. `lemon-zebra-0042`) or UUID',
        ignoreFocusOut: true,
      });
      if (!slug) return;
      try {
        const id = await resolveNodeRef(getClient(), slug);
        await vscode.commands.executeCommand('flywheel.openNodeById', id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`Flywheel: ${msg}`);
      }
    }),
    vscode.commands.registerCommand('flywheel.openNodeById', async (nodeId: string) => {
      try {
        if (!nodeId) return;
        const c = getClient();
        const panel = GraphPanel.currentInstance();
        const slugCtx = {
          getSlugIndex: () => panel?.getSlugIndex() ?? {},
        };
        await NodeDetailPanel.open(context, c, slugCtx, nodeId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`Flywheel: ${msg}`);
      }
    }),
    vscode.commands.registerCommand('flywheel.reindexAll', async () => {
      try {
        await reindexLoaded(context);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`Flywheel: ${msg}`);
      }
    }),
  );

  void onCurrentRepoChange(async () => {
    const url = await getCurrentRepoCanonicalUrl();
    GraphPanel.currentInstance()?.setRepoFilter(url);
  }).then((d) => context.subscriptions.push(d));

  installStatusBar(context);

  // Per-repo bootstrap. If the workspace has a `.flywheel.json` with
  // `autoOpenGraph: true`, open the graph in the background — silently if
  // anything fails so we don't nag on every startup.
  void (async () => {
    try {
      const { config } = await loadWorkspaceConfig();
      if (!config?.rootNodeId || !config.autoOpenGraph) return;
      await openGraphForWorkspace(
        context,
        miniGraph,
        config.rootNodeId,
        config.repoFilter ?? true,
      );
    } catch (err) {
      console.warn('[flywheel] auto-open failed:', err);
    }
  })();

  context.subscriptions.push(
    watchWorkspaceConfig(() => {
      // Surface that the config changed; don't auto-reload — too disruptive.
      void vscode.window.showInformationMessage(
        'Flywheel: .flywheel.json changed — reload the graph to apply.',
      );
    }),
  );
}

export function deactivate(): void {
  // no-op
}
