/**
 * Helpers shared by all WebviewPanels.
 *
 * - `getWebviewHtml`: produce the bootstrap HTML loading the Vite-built
 *   webview.js + assets, with proper CSP and a single nonce.
 * - `wireMessenger`: thin wrapper around vscode-messenger that hides the
 *   correlation-id machinery (we do JSON-RPC over postMessage anyway).
 */

import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';

export interface WebviewBootstrap {
  /** Initial state injected as window.__FLYWHEEL_INIT__ JSON. Must be JSON-serializable. */
  init?: unknown;
}

export function getWebviewHtml(
  webview: vscode.Webview,
  context: vscode.ExtensionContext,
  bootstrap: WebviewBootstrap = {},
): string {
  const nonce = randomBytes(16).toString('hex');
  const distRoot = vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview');
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(distRoot, 'webview.js'));
  // Vite emits the bundled stylesheet at this stable path (see vite.config).
  // Without this <link> the production webview has zero of our custom CSS.
  const styleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(distRoot, 'assets', 'styles.css'),
  );

  // 'unsafe-eval' is required by Cosmograph/regl, which JIT-compiles draw
  // commands via `new Function(...)`. Without it the WebGL pipeline fails
  // to init and the whole React app crashes silently.
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} https: data: blob:`,
    `font-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}' 'unsafe-eval' ${webview.cspSource}`,
    `connect-src ${webview.cspSource} https: http: ws: wss:`,
    `worker-src ${webview.cspSource} blob:`,
  ].join('; ');

  const initJson = JSON.stringify(bootstrap.init ?? {})
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${styleUri}" />
    <title>Flywheel</title>
  </head>
  <body>
    <div id="root"></div>
    <script nonce="${nonce}">window.__FLYWHEEL_INIT__ = ${initJson};</script>
    <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
}
