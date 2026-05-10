/**
 * `flywheel.searchSemantic` command.
 *
 * Opens a QuickPick that runs a semantic search against the local sqlite-vec
 * index whenever the user pauses typing. Selecting a result fires
 * `flywheel.openNodeById` for the hit's node.
 */

import * as vscode from 'vscode';
import type { SearchHit } from 'flywheel-core';
import type { SearchIndex } from '../search/index.js';

interface HitItem extends vscode.QuickPickItem {
  hit: SearchHit;
}

const SEARCH_DEBOUNCE_MS = 200;

export async function searchSemanticCommand(index: SearchIndex): Promise<void> {
  const qp = vscode.window.createQuickPick<HitItem>();
  qp.placeholder = 'Type to search the Flywheel knowledge graph…';
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const runQuery = async (q: string): Promise<void> => {
    if (!q.trim()) {
      qp.items = [];
      return;
    }
    qp.busy = true;
    try {
      const hits = await index.search(q, 12);
      qp.items = hits.map((h) => ({
        label: h.node_slug + (h.section ? ` · ${h.section}` : ''),
        description: `${(h.similarity * 100).toFixed(1)}%`,
        detail: h.snippet.replace(/\s+/g, ' '),
        hit: h,
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      qp.items = [];
      void vscode.window.showErrorMessage(`Flywheel: ${msg}`);
    } finally {
      qp.busy = false;
    }
  };

  qp.onDidChangeValue((v) => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => void runQuery(v), SEARCH_DEBOUNCE_MS);
  });

  qp.onDidAccept(async () => {
    const sel = qp.selectedItems[0];
    qp.hide();
    if (sel) {
      await vscode.commands.executeCommand('flywheel.openNodeById', sel.hit.node_id);
    }
  });

  qp.onDidHide(() => {
    if (timer !== null) clearTimeout(timer);
    qp.dispose();
  });

  qp.show();
}
