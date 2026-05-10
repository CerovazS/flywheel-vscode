/**
 * Per-repo Flywheel configuration.
 *
 * Each workspace folder may contain a `.flywheel.json` at its root that
 * tells the extension which graph to load and how to filter it. Schema:
 *
 *   {
 *     // Required for auto-open. Slug (e.g. "lemon-zebra-0042") or UUID.
 *     "rootNodeId": "muon-overview",
 *
 *     // Optional, default true. When true the graph is filtered to nodes
 *     // whose `repo_context.repo_url` matches the workspace's git remote.
 *     "repoFilter": true,
 *
 *     // Optional, default false. Pop the graph panel automatically when the
 *     // workspace opens. Off by default to respect the user's screen state.
 *     "autoOpenGraph": false
 *   }
 *
 * The first folder in `vscode.workspace.workspaceFolders` wins — we don't
 * try to merge configs from multi-root workspaces.
 */

import * as vscode from 'vscode';

export interface FlywheelWorkspaceConfig {
  rootNodeId?: string;
  /** Default: true. */
  repoFilter?: boolean;
  /** Default: false. */
  autoOpenGraph?: boolean;
}

const CONFIG_FILE = '.flywheel.json';

/** Load `.flywheel.json` from the active workspace folder, if present. */
export async function loadWorkspaceConfig(): Promise<{
  config: FlywheelWorkspaceConfig | null;
  source: vscode.Uri | null;
}> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return { config: null, source: null };
  const folder = folders[0]!;
  const uri = vscode.Uri.joinPath(folder.uri, CONFIG_FILE);
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const text = new TextDecoder('utf-8').decode(bytes);
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${CONFIG_FILE} must be a JSON object`);
    }
    const obj = parsed as Record<string, unknown>;
    const config: FlywheelWorkspaceConfig = {};
    if (typeof obj['rootNodeId'] === 'string') config.rootNodeId = obj['rootNodeId'].trim();
    if (typeof obj['repoFilter'] === 'boolean') config.repoFilter = obj['repoFilter'];
    if (typeof obj['autoOpenGraph'] === 'boolean') config.autoOpenGraph = obj['autoOpenGraph'];
    return { config, source: uri };
  } catch (err: unknown) {
    // FileSystemError code 'FileNotFound' is the common, expected case.
    const code = (err as { code?: string }).code;
    if (code === 'FileNotFound' || code === 'ENOENT') return { config: null, source: null };
    void vscode.window.showWarningMessage(
      `Flywheel: ignoring malformed ${CONFIG_FILE} — ${err instanceof Error ? err.message : String(err)}`,
    );
    return { config: null, source: null };
  }
}

/**
 * Resolve the effective root node ref for the active workspace, in priority:
 *   1. `.flywheel.json` rootNodeId
 *   2. `flywheel.defaultRootNodeId` setting
 *   3. null (caller must prompt)
 */
export async function resolveActiveRootRef(): Promise<string | null> {
  const { config } = await loadWorkspaceConfig();
  if (config?.rootNodeId) return config.rootNodeId;
  const setting = vscode.workspace
    .getConfiguration('flywheel')
    .get<string>('defaultRootNodeId');
  if (setting && setting.trim().length > 0) return setting.trim();
  return null;
}

/** Watch `.flywheel.json` in every workspace folder; fire `onChange` on edits. */
export function watchWorkspaceConfig(
  onChange: () => void,
): vscode.Disposable {
  const watcher = vscode.workspace.createFileSystemWatcher(`**/${CONFIG_FILE}`);
  watcher.onDidChange(onChange);
  watcher.onDidCreate(onChange);
  watcher.onDidDelete(onChange);
  return watcher;
}
