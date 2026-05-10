import { useEffect } from 'react';
import { getInit, onMessage, send } from './vscode.js';
import { useStore } from './store.js';
import { FullGraph } from './FullGraph.js';

export function App() {
  const status = useStore((s) => s.ui.status);
  const nodeCount = useStore((s) => s.graph.nodes.size);
  const setStatus = useStore((s) => s.setStatus);
  const setRepoFilter = useStore((s) => s.setRepoFilter);
  const applySnapshot = useStore((s) => s.applySnapshot);
  const applyPatch = useStore((s) => s.applyPatch);

  useEffect(() => {
    const init = getInit();
    const off = onMessage((fact) => {
      switch (fact.kind) {
        case 'status':
          setStatus({ connected: fact.connected, nodeCount: fact.nodeCount, rootSlug: fact.rootSlug });
          break;
        case 'snapshot':
          applySnapshot(fact.viewId, fact.nodes, fact.edges, fact.seq);
          break;
        case 'patch':
          applyPatch(fact.ops, fact.seq);
          break;
        case 'filter':
          setRepoFilter(fact.repoFilter);
          break;
        case 'error':
          console.error('[flywheel] error:', fact.message);
          break;
      }
    });
    send({ kind: 'attach', viewId: init.viewId, rootNodeId: '' });
    return off;
  }, [setStatus, setRepoFilter, applySnapshot, applyPatch]);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        fontFamily: 'var(--vscode-font-family, sans-serif)',
        color: 'var(--vscode-foreground)',
      }}
    >
      <FullGraph />
      <div
        style={{
          position: 'absolute',
          top: 12,
          left: 16,
          padding: '6px 10px',
          borderRadius: 6,
          background: 'rgba(0,0,0,0.45)',
          color: '#fff3b0',
          fontSize: 12,
          pointerEvents: 'none',
        }}
      >
        {status.rootSlug ? `root: ${status.rootSlug}` : status.connected ? 'connected' : 'idle'} · nodes:{' '}
        {nodeCount}
      </div>
    </div>
  );
}
