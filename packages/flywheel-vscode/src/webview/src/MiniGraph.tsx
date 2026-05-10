/**
 * Mini-graph view: a compact static render of the 1-hop neighborhood around
 * the currently-selected node. Like FullGraph, simulation is disabled — we
 * compute a deterministic radial layout (center + ring) so the view never
 * jitters. Labels follow the same horizontal-anchor rule (anchor away from
 * the closest screen edge) so they don't get clipped by the sidebar's
 * narrow width.
 */

import { useEffect, useRef, useState } from 'react';
import { Graph, type GraphConfigInterface } from '@cosmograph/cosmos';
import type { FlywheelEdge, FlywheelNode } from 'flywheel-core/client';
import type { Fact } from 'flywheel-core/protocol';
import { onMessage, send } from './vscode.js';
import { nodeColor } from './colors.js';
import { computeRadialLayout } from './layout.js';

interface Buffers {
  ids: string[];
  positions: Float32Array;
  colors: Float32Array;
  sizes: Float32Array;
  links: Float32Array;
  titles: string[];
}

function buildBuffers(
  nodes: FlywheelNode[],
  edges: FlywheelEdge[],
  centerId: string,
): Buffers {
  const ids = nodes.map((n) => n.node_id);
  const titles = nodes.map((n) => n.title ?? n.slug_name ?? n.node_id.slice(0, 8));
  const indexById = new Map<string, number>();
  for (let i = 0; i < ids.length; i++) indexById.set(ids[i]!, i);

  const positions = computeRadialLayout(ids, centerId, 70);
  const colors = new Float32Array(ids.length * 4);
  const sizes = new Float32Array(ids.length);
  for (let i = 0; i < ids.length; i++) {
    const node = nodes[i]!;
    const tag = node.graph_tags?.[0]?.bg_color ?? null;
    const [r, g, b, a] = nodeColor(tag, node.node_id);
    colors[4 * i] = r;
    colors[4 * i + 1] = g;
    colors[4 * i + 2] = b;
    colors[4 * i + 3] = a;
    sizes[i] = node.node_id === centerId ? 14 : 8;
  }
  const linkPairs: number[] = [];
  for (const e of edges) {
    const s = indexById.get(e.parent_id);
    const t = indexById.get(e.child_id);
    if (s !== undefined && t !== undefined) linkPairs.push(s, t);
  }
  return { ids, positions, colors, sizes, links: new Float32Array(linkPairs), titles };
}

interface LabelPos {
  id: string;
  title: string;
  x: number;
  y: number;
  isCenter: boolean;
  anchor: 'left' | 'right' | 'center';
}

export function MiniGraph() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const graphRef = useRef<Graph | null>(null);
  const buffersRef = useRef<Buffers | null>(null);
  const centerRef = useRef<string>('');
  const [empty, setEmpty] = useState(true);
  const [labels, setLabels] = useState<LabelPos[]>([]);

  const recomputeLabels = (): void => {
    const g = graphRef.current;
    const buf = buffersRef.current;
    const container = containerRef.current;
    if (!g || !buf || !container) {
      setLabels([]);
      return;
    }
    const w = container.clientWidth || 1;
    const out: LabelPos[] = [];
    for (let i = 0; i < buf.ids.length; i++) {
      const wx = buf.positions[2 * i]!;
      const wy = buf.positions[2 * i + 1]!;
      const [sx, sy] = g.spaceToScreenPosition([wx, wy]);
      if (!Number.isFinite(sx) || !Number.isFinite(sy)) continue;
      const xFrac = sx / w;
      const anchor: 'left' | 'right' | 'center' =
        xFrac < 0.3 ? 'left' : xFrac > 0.7 ? 'right' : 'center';
      out.push({
        id: buf.ids[i]!,
        title: buf.titles[i] ?? '',
        x: sx,
        y: sy,
        isCenter: buf.ids[i] === centerRef.current,
        anchor,
      });
    }
    setLabels(out);
  };

  useEffect(() => {
    if (!containerRef.current || graphRef.current) return;
    const config: GraphConfigInterface = {
      backgroundColor: 'transparent',
      pointSize: 8,
      linkColor: 'rgba(220, 220, 230, 0.45)',
      linkWidth: 1.4,
      curvedLinks: true,
      linkVisibilityDistanceRange: [20, 4000],
      linkVisibilityMinTransparency: 0.7,
      disableSimulation: true,
      enableDrag: false,
      fitViewOnInit: true,
      fitViewDelay: 0,
      fitViewDuration: 0,
      fitViewPadding: 0.25,
      scalePointsOnZoom: true,
      onClick: (index) => {
        if (index === undefined) return;
        const id = buffersRef.current?.ids[index];
        if (!id) return;
        send({ kind: 'requestNodeDetail', nodeId: id });
      },
      onZoom: () => recomputeLabels(),
      onZoomEnd: () => recomputeLabels(),
    };
    graphRef.current = new Graph(containerRef.current, config);
    send({ kind: 'attach', viewId: 'mini-graph', rootNodeId: '' });
    const ro = new ResizeObserver(() => recomputeLabels());
    ro.observe(containerRef.current);
    return () => {
      ro.disconnect();
      graphRef.current?.destroy();
      graphRef.current = null;
    };
  }, []);

  useEffect(() => {
    const off = onMessage((fact: Fact) => {
      if (fact.kind !== 'snapshot') return;
      const g = graphRef.current;
      if (!g) return;
      if (fact.nodes.length === 0) {
        setEmpty(true);
        setLabels([]);
        buffersRef.current = null;
        g.setPointPositions(new Float32Array(0));
        g.setPointColors(new Float32Array(0));
        g.setPointSizes(new Float32Array(0));
        g.setLinks(new Float32Array(0));
        g.render(0);
        return;
      }
      setEmpty(false);
      const centerId = fact.nodes[0]?.node_id ?? '';
      centerRef.current = centerId;
      const buf = buildBuffers(fact.nodes, fact.edges, centerId);
      buffersRef.current = buf;
      g.setPointPositions(buf.positions);
      g.setPointColors(buf.colors);
      g.setPointSizes(buf.sizes);
      g.setLinks(buf.links);
      g.render(0);
      requestAnimationFrame(() => {
        g.fitView(0, 0.25);
        requestAnimationFrame(() => recomputeLabels());
      });
      window.setTimeout(() => recomputeLabels(), 80);
      window.setTimeout(() => recomputeLabels(), 250);
    });
    return off;
  }, []);

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: 'var(--vscode-sideBar-background, #181818)',
      }}
    >
      <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />
      <div
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          overflow: 'hidden',
        }}
      >
        {labels.map((l) => (
          <div
            key={l.id}
            className={`flywheel-mini-label${l.isCenter ? ' flywheel-mini-label--center' : ''}`}
            data-anchor={l.anchor}
            style={{ left: l.x, top: l.y }}
            title={l.title}
          >
            {l.title}
          </div>
        ))}
      </div>
      {empty ? (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--vscode-descriptionForeground, #888)',
            fontSize: 12,
            padding: 16,
            textAlign: 'center',
            pointerEvents: 'none',
          }}
        >
          Open the graph and click a node to see its 1-hop neighborhood.
        </div>
      ) : null}
    </div>
  );
}
