/**
 * Standalone preview entry: mounts FullGraph + NodeDetail + MiniGraph with
 * synthetic data so we can iterate on rendering without launching the
 * Extension Development Host.
 *
 * Run with: pnpm --filter flywheel-vscode preview
 */

import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FullGraph } from './FullGraph.js';
import { NodeDetail } from './NodeDetail.js';
import { MiniGraph } from './MiniGraph.js';
import { useStore } from './store.js';
import type { FlywheelEdge, FlywheelNode } from 'flywheel-core/client';
import type { Fact } from 'flywheel-core/protocol';
import './styles.css';

// Tiny synthetic graph: ~25 nodes in a few clusters with cross-links.
function makeFakeData(): { nodes: FlywheelNode[]; edges: FlywheelEdge[] } {
  const tags = [
    { tag_id: 't-root', name: 'root', bg_color: '#540B0E', text_color: '#FFF3B0', one_only: true },
    { tag_id: 't-insight', name: 'insight', bg_color: '#335C67', text_color: '#FFF3B0', one_only: false },
    { tag_id: 't-experiment', name: 'experiment', bg_color: '#E09F3E', text_color: '#540B0E', one_only: false },
  ];
  const nodes: FlywheelNode[] = [];
  const edges: FlywheelEdge[] = [];
  const id = (i: number): string =>
    `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`;
  // Root.
  nodes.push({
    node_id: id(0),
    slug_name: 'root-research',
    title: 'R01 — Activation Schedule Research',
    revision: 1,
    visibility: 'private',
    graph_tags: [tags[0]!],
    outgoing_ids: [],
    incoming_ids: [],
    content:
      `# Root\n\nThis is the **research root**.\n\n> [!info] Goal\n> Validate the schedule under fixed-budget constraints.\n\nMath: $E = mc^2$ and inline $\\\\alpha\\beta$.\n\n==Highlight== works too. See [[insight-1]].`,
  });
  // Insights (3) + experiments (~6 each).
  const insightCount = 3;
  for (let i = 0; i < insightCount; i++) {
    const ins = id(1 + i);
    nodes.push({
      node_id: ins,
      slug_name: `insight-${i + 1}`,
      title: `I0${i + 1} — Insight on activation family ${i + 1}`,
      revision: 1,
      visibility: 'private',
      graph_tags: [tags[1]!],
      outgoing_ids: [],
      incoming_ids: [],
      content: `# Insight ${i + 1}\n\nKey claim: family ${i + 1} dominates.\n\n- bullet a\n- bullet b\n\n> [!warning]\n> Caveat applies under budget B=10.`,
    });
    edges.push({ parent_id: id(0), child_id: ins });
    nodes[0]!.outgoing_ids!.push(ins);

    const expPerInsight = 5 + i;
    for (let j = 0; j < expPerInsight; j++) {
      const exp = id(100 + i * 10 + j);
      nodes.push({
        node_id: exp,
        slug_name: `exp-${i + 1}-${j + 1}`,
        title: `E${(i + 1).toString().padStart(2, '0')}.${j + 1} — block@${j + 1}`,
        revision: 1,
        visibility: 'private',
        graph_tags: [tags[2]!],
        outgoing_ids: [],
        incoming_ids: [],
        content: `# Experiment\n\nMetric: \`val_loss=${(0.3 + j * 0.01).toFixed(3)}\``,
      });
      edges.push({ parent_id: ins, child_id: exp });
      nodes.find((n) => n.node_id === ins)!.outgoing_ids!.push(exp);
    }
  }
  return { nodes, edges };
}

function PreviewShell() {
  const [view, setView] = useState<'graph' | 'mini' | 'detail'>('graph');
  const applySnapshot = useStore((s) => s.applySnapshot);

  useEffect(() => {
    const { nodes, edges } = makeFakeData();
    applySnapshot('graph', nodes, edges, 1);

    // Fake the host: when NodeDetail / MiniGraph send intents, respond.
    const orig = window.addEventListener;
    window.addEventListener = orig;
  }, [applySnapshot]);

  // Intercept postMessage by faking acquireVsCodeApi at module load (see vscode.ts):
  // in dev mode it's a console.debug shim, so we override to drive replies.
  useEffect(() => {
    const onMsg = (e: MessageEvent): void => {
      const m = e.data as { kind?: string; nodeId?: string };
      if (m?.kind === 'requestNodeDetail' && m.nodeId) {
        const { nodes } = makeFakeData();
        const node = nodes.find((n) => n.node_id === m.nodeId);
        if (!node) return;
        const reply: Fact = {
          kind: 'nodeDetail' as const,
          node,
          rendered: '',
        };
        // Round-trip back through window message channel.
        window.postMessage(reply, '*');
      }
      if (m?.kind === 'attach' && (m as { viewId?: string }).viewId === 'mini-graph') {
        const { nodes } = makeFakeData();
        const root = nodes[0]!;
        const oneHop = nodes.filter((n) =>
          (root.outgoing_ids ?? []).includes(n.node_id) || n.node_id === root.node_id,
        );
        const oneHopEdges = (root.outgoing_ids ?? []).map((cid) => ({
          parent_id: root.node_id,
          child_id: cid,
        }));
        const reply: Fact = {
          kind: 'snapshot' as const,
          viewId: 'mini-graph',
          nodes: oneHop,
          edges: oneHopEdges,
          seq: 1,
        };
        window.postMessage(reply, '*');
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);

  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column' }}>
      <nav
        style={{
          display: 'flex',
          gap: 8,
          padding: '6px 12px',
          borderBottom: '1px solid #333',
          background: '#1a1a1a',
          color: '#ddd',
          fontSize: 12,
        }}
      >
        <strong style={{ color: '#fff3b0' }}>Flywheel preview:</strong>
        {(['graph', 'mini', 'detail'] as const).map((v) => (
          <button
            key={v}
            onClick={() => setView(v)}
            style={{
              background: view === v ? '#fff3b0' : '#222',
              color: view === v ? '#222' : '#ddd',
              border: '1px solid #444',
              padding: '2px 10px',
              borderRadius: 4,
              cursor: 'pointer',
            }}
          >
            {v}
          </button>
        ))}
      </nav>
      <div style={{ position: 'relative', flex: 1 }}>
        {view === 'graph' && <FullGraph />}
        {view === 'mini' && <MiniGraph />}
        {view === 'detail' && <NodeDetail initNodeId={'00000000-0000-0000-0000-000000000000'} />}
      </div>
    </div>
  );
}

const rootEl = document.getElementById('root');
if (rootEl) createRoot(rootEl).render(<PreviewShell />);
