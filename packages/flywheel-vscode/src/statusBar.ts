/**
 * Status bar item: "Flywheel: <state>".
 *
 * Reflects the live state of the active GraphPanel (root + node count),
 * plus a hint about the per-workspace `.flywheel.json` configuration when
 * present. Click → opens (or focuses) the graph for the active workspace.
 */

import * as vscode from 'vscode';
import { GraphPanel } from './panels/GraphPanel.js';
import { loadWorkspaceConfig, loadWorkspaceEnv } from './workspaceConfig.js';

let item: vscode.StatusBarItem | undefined;
let timer: ReturnType<typeof setInterval> | null = null;
type ConfigSource = 'flywheel.json' | '.env';
let configCache: {
  hasFile: boolean;
  rootNodeId?: string;
  rootNodeTitle?: string;
  source?: ConfigSource;
} = { hasFile: false };

export function installStatusBar(context: vscode.ExtensionContext): void {
  item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.command = 'flywheel.openGraph';
  item.name = 'Flywheel';
  refresh();
  item.show();
  context.subscriptions.push(item);

  // Cheap pull — graph state can change at any time without an explicit
  // signal, so we sample once a second. Cost is a Map.size read.
  timer = setInterval(refresh, 1000);
  context.subscriptions.push(
    new vscode.Disposable(() => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    }),
  );

  // Refresh the cached `.flywheel.json` info on workspace + config changes
  // so the bar reflects the current bootstrap target without a full reload.
  void refreshConfigCache();
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => void refreshConfigCache()),
  );
}

async function refreshConfigCache(): Promise<void> {
  const { config } = await loadWorkspaceConfig();
  if (config?.rootNodeId) {
    configCache = { hasFile: true, rootNodeId: config.rootNodeId, source: 'flywheel.json' };
    refresh();
    return;
  }
  // Fall back to .env — the same priority order as resolveActiveRootRef().
  const { env } = await loadWorkspaceEnv();
  const envRef = env?.rootNodeId ?? env?.rootNodeSlug;
  if (envRef) {
    configCache = {
      hasFile: true,
      rootNodeId: envRef,
      ...(env?.rootNodeTitle ? { rootNodeTitle: env.rootNodeTitle } : {}),
      source: '.env',
    };
  } else {
    configCache = { hasFile: false };
  }
  refresh();
}

function refresh(): void {
  if (!item) return;
  const panel = GraphPanel.currentInstance();
  if (!panel) {
    if (configCache.hasFile && configCache.rootNodeId) {
      // We have a configured target but the graph isn't open yet — invite
      // the user to open it with one click.
      const label = configCache.rootNodeTitle ?? configCache.rootNodeId;
      const src = configCache.source ?? 'config';
      item.text = `$(graph) Flywheel: open ${label}`;
      item.tooltip = `Click to open the graph rooted at "${configCache.rootNodeId}"${
        configCache.rootNodeTitle ? ` — ${configCache.rootNodeTitle}` : ''
      } (from ${src}).`;
    } else {
      item.text = '$(graph) Flywheel: idle';
      item.tooltip =
        'Flywheel — click to open graph (set rootNodeId in .flywheel.json or FLYWHEEL_ROOT_NODE_ID in .env to skip the prompt).';
    }
    item.backgroundColor = undefined;
    return;
  }
  const nodes = panel.getNodes();
  const slug = panel.getSlugIndex();
  const count = nodes.size;
  const rootSlug = configCache.rootNodeId ?? Object.keys(slug)[0] ?? null;
  const tag = rootSlug ? ` · ${rootSlug}` : '';
  item.text = `$(graph) Flywheel: ${count} nodes${tag}`;
  item.tooltip = `Flywheel graph open · ${count} nodes${
    rootSlug ? ` · root ${rootSlug}` : ''
  } — click to refocus.`;
}
