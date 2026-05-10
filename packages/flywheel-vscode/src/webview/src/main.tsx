import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { NodeDetail } from './NodeDetail.js';
import { MiniGraph } from './MiniGraph.js';
import { getInit } from './vscode.js';
import './styles.css';

const rootEl = document.getElementById('root');
if (rootEl) {
  const init = getInit() as { viewId: string; nodeId?: string };
  if (init.viewId === 'node-detail' && init.nodeId) {
    createRoot(rootEl).render(<NodeDetail initNodeId={init.nodeId} />);
  } else if (init.viewId === 'mini-graph') {
    createRoot(rootEl).render(<MiniGraph />);
  } else {
    createRoot(rootEl).render(<App />);
  }
}
