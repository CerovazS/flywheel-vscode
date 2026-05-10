/**
 * `flywheel.filterByRepo` command.
 *
 * Reads the current repo's canonical URL via the VS Code Git extension and
 * tells the active GraphPanel to apply it as a filter. Toggle off if already
 * matching the current repo.
 */

import * as vscode from 'vscode';
import { getCurrentRepoCanonicalUrl } from '../git.js';
import { GraphPanel } from '../panels/GraphPanel.js';

export async function filterByRepoCommand(): Promise<void> {
  const url = await getCurrentRepoCanonicalUrl(
    vscode.window.activeTextEditor?.document.uri,
  );
  if (!url) {
    void vscode.window.showWarningMessage(
      'Flywheel: no GitHub remote detected in the current workspace.',
    );
    return;
  }
  const panel = GraphPanel.currentInstance();
  if (!panel) {
    void vscode.window.showInformationMessage(
      'Flywheel: open the graph first (Flywheel: Open Graph), then filter.',
    );
    return;
  }
  panel.toggleRepoFilter(url);
}
