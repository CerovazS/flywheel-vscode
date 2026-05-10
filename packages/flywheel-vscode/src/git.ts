/**
 * VS Code Git extension API binding.
 *
 * We treat the built-in `vscode.git` extension as our source of truth for the
 * "current repo URL" — never parse `.git/config` ourselves. The relevant API:
 *
 *   const ext = vscode.extensions.getExtension<GitExtension>('vscode.git');
 *   await ext.activate();
 *   const api = ext.exports.getAPI(1);
 *   api.repositories[i].state.remotes[]   // {name, fetchUrl, pushUrl}
 *   api.onDidOpenRepository(...)
 *   repo.state.onDidChange(...)
 */

import * as vscode from 'vscode';
import { normalizeRepoUrl } from 'flywheel-core';

interface Remote {
  name: string;
  fetchUrl?: string;
  pushUrl?: string;
}

interface RepositoryState {
  remotes: Remote[];
  onDidChange: vscode.Event<void>;
}

interface Repository {
  rootUri: vscode.Uri;
  state: RepositoryState;
}

interface GitApi {
  repositories: Repository[];
  onDidOpenRepository: vscode.Event<Repository>;
  onDidCloseRepository: vscode.Event<Repository>;
}

interface GitExtension {
  getAPI(version: 1): GitApi;
}

let cachedApi: GitApi | undefined;

async function getApi(): Promise<GitApi | undefined> {
  if (cachedApi) return cachedApi;
  const ext = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (!ext) return undefined;
  if (!ext.isActive) await ext.activate();
  cachedApi = ext.exports.getAPI(1);
  return cachedApi;
}

/** Pick the repo whose rootUri is the longest prefix of `forUri`, else first. */
function pickRepo(api: GitApi, forUri?: vscode.Uri): Repository | undefined {
  if (!api.repositories.length) return undefined;
  if (!forUri) return api.repositories[0];
  const target = forUri.fsPath;
  let best: { repo: Repository; len: number } | null = null;
  for (const r of api.repositories) {
    const root = r.rootUri.fsPath;
    if (target.startsWith(root) && (best === null || root.length > best.len)) {
      best = { repo: r, len: root.length };
    }
  }
  return best?.repo ?? api.repositories[0];
}

/**
 * Return the canonical https URL for the repo currently active in `forUri`
 * (or the first workspace repo). Tries `origin` first, then any remote.
 */
export async function getCurrentRepoCanonicalUrl(
  forUri?: vscode.Uri,
): Promise<string | null> {
  const api = await getApi();
  if (!api) return null;
  const repo = pickRepo(api, forUri);
  if (!repo) return null;
  const origin =
    repo.state.remotes.find((r) => r.name === 'origin') ?? repo.state.remotes[0];
  const url = origin?.fetchUrl ?? origin?.pushUrl ?? null;
  return normalizeRepoUrl(url);
}

/**
 * Subscribe to anything that may change the current repo URL: workspace repo
 * open/close and remote-list mutations on existing repos. Fires `cb` on each
 * change and once at subscription time so callers can sync state.
 */
export async function onCurrentRepoChange(cb: () => void): Promise<vscode.Disposable> {
  const api = await getApi();
  const subs: vscode.Disposable[] = [];
  if (!api) {
    return new vscode.Disposable(() => undefined);
  }

  const watchRepo = (r: Repository): void => {
    subs.push(r.state.onDidChange(cb));
  };

  for (const r of api.repositories) watchRepo(r);
  subs.push(
    api.onDidOpenRepository((r) => {
      watchRepo(r);
      cb();
    }),
  );
  subs.push(api.onDidCloseRepository(() => cb()));

  queueMicrotask(cb);
  return new vscode.Disposable(() => {
    for (const s of subs) s.dispose();
  });
}
