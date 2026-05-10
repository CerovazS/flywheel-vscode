/**
 * Thin wrapper around acquireVsCodeApi() with a typed message protocol.
 *
 * Webview ↔ host messages use the `Intent` / `Fact` types from flywheel-core/protocol.
 * `acquireVsCodeApi()` is provided by VS Code at runtime and may only be called once.
 */

import type { Fact, Intent } from 'flywheel-core/protocol';

interface VSCodeApi {
  postMessage(msg: Intent): void;
  setState<T>(state: T): void;
  getState<T>(): T | undefined;
}

declare global {
  interface Window {
    acquireVsCodeApi?: () => VSCodeApi;
    __FLYWHEEL_INIT__?: { viewId: string; [k: string]: unknown };
  }
}

let cached: VSCodeApi | null = null;

export function vscodeApi(): VSCodeApi {
  if (cached) return cached;
  if (typeof window === 'undefined' || typeof window.acquireVsCodeApi !== 'function') {
    // Dev mode (vite preview): no-op shim.
    cached = {
      postMessage: (msg) => console.debug('[dev] postMessage', msg),
      setState: () => undefined,
      getState: () => undefined,
    };
    return cached;
  }
  cached = window.acquireVsCodeApi();
  return cached;
}

export type FactHandler = (fact: Fact) => void;

export function onMessage(handler: FactHandler): () => void {
  const listener = (e: MessageEvent<Fact>): void => handler(e.data);
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}

export function send(intent: Intent): void {
  vscodeApi().postMessage(intent);
}

export function getInit(): { viewId: string } {
  return (window.__FLYWHEEL_INIT__ as { viewId: string }) ?? { viewId: 'unknown' };
}
