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
 * Alternatively, the workspace may declare the root via environment
 * variables in a `.env` file at its root:
 *
 *   FLYWHEEL_ROOT_NODE_ID=d1f2f974-2cf3-5f0e-8782-1bfca8bba5ec
 *   FLYWHEEL_ROOT_NODE_SLUG=wild-boat-4023
 *   FLYWHEEL_ROOT_NODE_TITLE="R01 DiffMechint — Semantic Geometry of Diffusability"
 *
 * `FLYWHEEL_ROOT_NODE_ID` (UUID) is preferred when present; otherwise
 * `FLYWHEEL_ROOT_NODE_SLUG` is used. The title is optional and surfaces in
 * the status-bar tooltip.
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

export interface FlywheelEnvConfig {
  /** UUID from FLYWHEEL_ROOT_NODE_ID, preferred when present. */
  rootNodeId?: string;
  /** Slug from FLYWHEEL_ROOT_NODE_SLUG, fallback when no UUID. */
  rootNodeSlug?: string;
  /** Human title from FLYWHEEL_ROOT_NODE_TITLE, surfaced in tooltips. */
  rootNodeTitle?: string;
}

const CONFIG_FILE = '.flywheel.json';
const ENV_FILE = '.env';

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
 * Parse a `.env` file's contents into a flat key→value map.
 *
 * Minimal POSIX-ish parser — no shell interpolation, no command substitution.
 * Just enough to support the FLYWHEEL_ROOT_NODE_* keys declared at a repo's
 * root. Lines that don't match `KEY=value` (comments, blanks, `export KEY=…`
 * with whitespace quirks, multiline values) are skipped silently.
 */
function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    // Allow an optional leading `export ` to mirror real `.env` files.
    const stripped = line.startsWith('export ') ? line.slice(7).trimStart() : line;
    const eq = stripped.indexOf('=');
    if (eq <= 0) continue;
    const key = stripped.slice(0, eq).trim();
    let value = stripped.slice(eq + 1).trim();
    // Strip wrapping single or double quotes if symmetric.
    if (value.length >= 2) {
      const first = value.charAt(0);
      const last = value.charAt(value.length - 1);
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1);
      }
    }
    // Drop trailing inline comment for unquoted values (`KEY=foo # note`).
    if (!value.startsWith('"') && !value.startsWith("'")) {
      const hashAt = value.indexOf(' #');
      if (hashAt >= 0) value = value.slice(0, hashAt).trimEnd();
    }
    if (key.length > 0) out[key] = value;
  }
  return out;
}

/** Load `.env` from the active workspace folder, if present. */
export async function loadWorkspaceEnv(): Promise<{
  env: FlywheelEnvConfig | null;
  source: vscode.Uri | null;
}> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return { env: null, source: null };
  const folder = folders[0]!;
  const uri = vscode.Uri.joinPath(folder.uri, ENV_FILE);
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const text = new TextDecoder('utf-8').decode(bytes);
    const map = parseDotEnv(text);
    const env: FlywheelEnvConfig = {};
    if (map['FLYWHEEL_ROOT_NODE_ID']) env.rootNodeId = map['FLYWHEEL_ROOT_NODE_ID'];
    if (map['FLYWHEEL_ROOT_NODE_SLUG']) env.rootNodeSlug = map['FLYWHEEL_ROOT_NODE_SLUG'];
    if (map['FLYWHEEL_ROOT_NODE_TITLE']) env.rootNodeTitle = map['FLYWHEEL_ROOT_NODE_TITLE'];
    if (!env.rootNodeId && !env.rootNodeSlug && !env.rootNodeTitle) {
      return { env: null, source: uri };
    }
    return { env, source: uri };
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code === 'FileNotFound' || code === 'ENOENT') return { env: null, source: null };
    // A malformed .env is not the extension's problem — log and move on.
    console.warn('[flywheel] ignoring unreadable .env:', err);
    return { env: null, source: null };
  }
}

/**
 * Resolve the effective root node ref for the active workspace, in priority:
 *   1. `.flywheel.json` rootNodeId
 *   2. `.env` FLYWHEEL_ROOT_NODE_ID (UUID preferred) or FLYWHEEL_ROOT_NODE_SLUG
 *   3. `flywheel.defaultRootNodeId` setting
 *   4. null (caller must prompt)
 */
export async function resolveActiveRootRef(): Promise<string | null> {
  const { config } = await loadWorkspaceConfig();
  if (config?.rootNodeId) return config.rootNodeId;
  const { env } = await loadWorkspaceEnv();
  if (env?.rootNodeId) return env.rootNodeId;
  if (env?.rootNodeSlug) return env.rootNodeSlug;
  const setting = vscode.workspace
    .getConfiguration('flywheel')
    .get<string>('defaultRootNodeId');
  if (setting && setting.trim().length > 0) return setting.trim();
  return null;
}

/** Watch `.flywheel.json` AND `.env` in every workspace folder; fire `onChange` on edits. */
export function watchWorkspaceConfig(
  onChange: () => void,
): vscode.Disposable {
  const jsonWatcher = vscode.workspace.createFileSystemWatcher(`**/${CONFIG_FILE}`);
  const envWatcher = vscode.workspace.createFileSystemWatcher(`**/${ENV_FILE}`);
  for (const w of [jsonWatcher, envWatcher]) {
    w.onDidChange(onChange);
    w.onDidCreate(onChange);
    w.onDidDelete(onChange);
  }
  return vscode.Disposable.from(jsonWatcher, envWatcher);
}
