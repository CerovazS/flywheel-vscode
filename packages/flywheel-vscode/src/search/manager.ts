/**
 * Lazy SearchIndex singleton, scoped to the extension's globalStorageUri.
 *
 * The index file lives at `${globalStorageUri}/index.sqlite`. We initialise
 * lazily because better-sqlite3 + sqlite-vec involve native module loads we
 * don't want to pay at activation time.
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import { SearchIndex } from './index.js';
import { OllamaClient } from './ollama.js';

let instance: SearchIndex | null = null;

export function getSearchIndex(context: vscode.ExtensionContext): SearchIndex {
  if (instance) return instance;
  const cfg = vscode.workspace.getConfiguration('flywheel');
  const ollamaUrl = cfg.get<string>('ollamaUrl') ?? 'http://localhost:11434';
  const dbPath = path.join(context.globalStorageUri.fsPath, 'index.sqlite');
  instance = new SearchIndex({
    dbPath,
    ollama: new OllamaClient({ baseUrl: ollamaUrl }),
  });
  context.subscriptions.push(
    new vscode.Disposable(() => {
      instance?.close();
      instance = null;
    }),
  );
  return instance;
}
