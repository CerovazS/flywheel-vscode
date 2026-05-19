/**
 * Cosmograph (cosmos.gl) wrapper — STATIC layout.
 *
 * The graph never animates: we run a Fruchterman–Reingold layout in JS once
 * per topology change and feed the result to Cosmograph with
 * `disableSimulation: true`. Positions are stable across patches.
 *
 * Labels are an HTML overlay positioned via cosmos's
 * `spaceToScreenPosition`, refreshed on every zoom event. Each label's
 * horizontal anchor flips based on the node's screen position so long titles
 * never spill off the visible edge: nodes in the left half anchor their
 * label to the *left* of the text (label grows rightwards); nodes in the
 * right half anchor to the *right* (label grows leftwards). Vertical
 * positioning sits below the node.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Graph, type GraphConfigInterface } from '@cosmograph/cosmos';
import type { FlywheelEdge, FlywheelNode } from 'flywheel-core/client';
import { normalizeRepoUrl } from 'flywheel-core/repo';
import { useStore } from './store.js';
import { darkenForLight, nodeColor, rgbaToCss } from './colors.js';
import { computeLayout } from './layout.js';
import { send } from './vscode.js';

interface Buffers {
  ids: string[];
  indexById: Map<string, number>;
  positions: Float32Array;
  colors: Float32Array;
  sizes: Float32Array;
  links: Float32Array;
  /** Degree per node — drives node size so hubs stand out. */
  degrees: number[];
}

function nodeSizeFromDegree(deg: number): number {
  return 6 + Math.min(10, Math.sqrt(deg) * 2.2);
}

function buildBuffers(
  nodes: Map<string, FlywheelNode>,
  edges: FlywheelEdge[],
  prevPositions: Map<string, [number, number]>,
): Buffers {
  const ids = Array.from(nodes.keys());
  const indexById = new Map<string, number>();
  for (let i = 0; i < ids.length; i++) indexById.set(ids[i]!, i);

  const linkPairs: number[] = [];
  const degrees = new Array<number>(ids.length).fill(0);
  for (const e of edges) {
    const s = indexById.get(e.parent_id);
    const t = indexById.get(e.child_id);
    if (s !== undefined && t !== undefined) {
      linkPairs.push(s, t);
      degrees[s]! += 1;
      degrees[t]! += 1;
    }
  }

  const positions = computeLayout({
    ids,
    edges:
      linkPairs.length > 0
        ? Array.from(
            { length: linkPairs.length / 2 },
            (_, i) => [linkPairs[2 * i]!, linkPairs[2 * i + 1]!] as const,
          )
        : [],
    prev: prevPositions,
  });

  const colors = new Float32Array(ids.length * 4);
  const sizes = new Float32Array(ids.length);
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]!;
    const node = nodes.get(id)!;
    const tagColor = node.graph_tags?.[0]?.bg_color ?? null;
    const [r, g, b, a] = nodeColor(tagColor, id);
    colors[4 * i] = r;
    colors[4 * i + 1] = g;
    colors[4 * i + 2] = b;
    colors[4 * i + 3] = a;
    sizes[i] = nodeSizeFromDegree(degrees[i]!);
  }

  return {
    ids,
    indexById,
    positions,
    colors,
    sizes,
    links: new Float32Array(linkPairs),
    degrees,
  };
}

interface HoverState {
  index: number;
  screenX: number;
  screenY: number;
}

const HOVER_DELAY_MS = 280;

// Render a single line of inline markdown into React nodes. Covers the three
// markers used inside a TL;DR callout: **bold**, ==highlight==, `code`. Plain
// text passes through unchanged. We do this by hand instead of pulling in a
// markdown parser because the TL;DR is one short paragraph and the preview
// must stay snappy.
function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*\n]+\*\*|==[^=\n]+==|`[^`\n]+`)/g;
  let cursor = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > cursor) out.push(text.slice(cursor, m.index));
    const tok = m[0];
    if (tok.startsWith('**')) out.push(<strong key={`b${key++}`}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith('==')) out.push(<mark key={`h${key++}`}>{tok.slice(2, -2)}</mark>);
    else out.push(<code key={`c${key++}`}>{tok.slice(1, -1)}</code>);
    cursor = m.index + tok.length;
  }
  if (cursor < text.length) out.push(text.slice(cursor));
  return out;
}

// Extract the `> [!summary] TL;DR` Obsidian callout body from a markdown blob.
// Accepts the `TL;DR` label (any case, with/without the trailing punctuation)
// and the legacy `Bottom Line` label so older nodes still preview cleanly.
// Returns the concatenated body lines or null if no matching callout exists.
function extractTldr(text: string | null | undefined): string | null {
  if (!text) return null;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(/^>\s*\[!summary\](?:\s+(.*))?$/i);
    if (!m) continue;
    const label = (m[1] ?? '').trim();
    // Skip [!summary] callouts with a different label so we don't grab e.g.
    // a stray "Highlights" callout from elsewhere in the body.
    if (label && !/^(tl;?dr|bottom line)$/i.test(label)) continue;
    const body: string[] = [];
    let j = i + 1;
    while (j < lines.length) {
      const cont = lines[j]!.match(/^>\s?(.*)$/);
      if (!cont) break;
      body.push(cont[1] ?? '');
      j += 1;
    }
    const joined = body.join('\n').trim();
    if (joined) return joined;
  }
  return null;
}

interface RenderedLabel {
  id: string;
  title: string;
  x: number;
  y: number;
  color: string;
  /** 'left' | 'right' — which side of the label sits at (x, y) on screen. */
  anchor: 'left' | 'right';
}

interface RenderedRing {
  id: string;
  /** screen-space centre */
  x: number;
  y: number;
  /** ring radius (distance from centre to stroke centreline), in screen pixels */
  radius: number;
  /** stroke thickness, screen pixels */
  strokeWidth: number;
  /** one entry per tag, in tag order; arcs are drawn at 360°/N spans */
  tags: Array<{ color: string }>;
}

/** Convert (centre, radius, angle in degrees) to a cartesian point. 0° points
 *  to the right; we rotate by -90 elsewhere so the first arc starts at the top. */
function polarToCartesian(
  cx: number,
  cy: number,
  r: number,
  angleDeg: number,
): [number, number] {
  const rad = (angleDeg * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

/** Build an SVG arc path between two angles (degrees, clockwise from top). */
function arcPath(
  cx: number,
  cy: number,
  r: number,
  startAngleDeg: number,
  endAngleDeg: number,
): string {
  const [sx, sy] = polarToCartesian(cx, cy, r, startAngleDeg - 90);
  const [ex, ey] = polarToCartesian(cx, cy, r, endAngleDeg - 90);
  const sweep = endAngleDeg - startAngleDeg;
  const largeArc = sweep > 180 ? 1 : 0;
  // sweep-flag=1 for clockwise (we render angles increasing clockwise from top).
  return `M ${sx} ${sy} A ${r} ${r} 0 ${largeArc} 1 ${ex} ${ey}`;
}

type GraphTheme = 'auto' | 'light' | 'dark';

const THEME_STORAGE_KEY = 'flywheel.graphTheme';

function readStoredTheme(): GraphTheme {
  try {
    const raw = globalThis.localStorage?.getItem(THEME_STORAGE_KEY);
    if (raw === 'light' || raw === 'dark' || raw === 'auto') return raw;
  } catch {
    // localStorage may be unavailable in the webview sandbox; fall through.
  }
  return 'auto';
}

function persistTheme(theme: GraphTheme): void {
  try {
    globalThis.localStorage?.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // best-effort; the toggle still works in-session if storage is sandboxed.
  }
}

/** Resolve user-selected theme into the concrete background color. */
function themeBackground(theme: GraphTheme): string {
  if (theme === 'light') return '#f5f5f0';
  if (theme === 'dark') return '#111';
  // 'auto' = follow VS Code editor theme; fall back to dark if the var is missing.
  return 'var(--vscode-editor-background, #111)';
}

/** Resolve VS Code's current editor kind from the body class set by the host. */
function resolveVscodeTheme(): 'light' | 'dark' {
  if (typeof document === 'undefined') return 'dark';
  return document.body.classList.contains('vscode-light') ? 'light' : 'dark';
}

export function FullGraph() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const graphRef = useRef<Graph | null>(null);
  const buffersRef = useRef<Buffers | null>(null);
  const hoverTimerRef = useRef<number | null>(null);
  const [hover, setHover] = useState<HoverState | null>(null);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [labels, setLabels] = useState<RenderedLabel[]>([]);
  const [rings, setRings] = useState<RenderedRing[]>([]);
  const [theme, setTheme] = useState<GraphTheme>(() => readStoredTheme());
  const [vscodeTheme, setVscodeTheme] = useState<'light' | 'dark'>(
    () => resolveVscodeTheme(),
  );

  useEffect(() => {
    persistTheme(theme);
  }, [theme]);

  // Track VS Code theme changes so `auto` updates without a page reload.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const update = (): void => setVscodeTheme(resolveVscodeTheme());
    const mo = new MutationObserver(update);
    mo.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    return () => mo.disconnect();
  }, []);

  const effectiveTheme: 'light' | 'dark' =
    theme === 'auto' ? vscodeTheme : theme;
  const nodes = useStore((s) => s.graph.nodes);
  const edgeList = useStore((s) => s.graph.edgeList);
  const repoFilter = useStore((s) => s.ui.repoFilter);
  const selectedId = useStore((s) => s.ui.selectedNodeId);

  const filteredNodes = useMemo(() => {
    if (!repoFilter) return nodes;
    const out = new Map<string, FlywheelNode>();
    for (const [id, n] of nodes) {
      if (normalizeRepoUrl(n.repo_context?.repo_url ?? null) === repoFilter) {
        out.set(id, n);
      }
    }
    return out;
  }, [nodes, repoFilter]);

  // Imperative label refresh — uses current cosmos transform via
  // spaceToScreenPosition. Called from onZoom, after fitView, and on resize.
  const filteredNodesRef = useRef(filteredNodes);
  filteredNodesRef.current = filteredNodes;
  const zoomLevelRef = useRef(1);
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  const refreshLabels = (): void => {
    const g = graphRef.current;
    const buf = buffersRef.current;
    const container = containerRef.current;
    if (!g || !buf || !container) {
      setLabels([]);
      setRings([]);
      return;
    }
    const nodesMap = filteredNodesRef.current;
    const w = container.clientWidth || 1;
    const k = zoomLevelRef.current;
    const out: RenderedLabel[] = [];
    const outRings: RenderedRing[] = [];
    // Visibility heuristic: at default zoom show only hubs + selected, at high
    // zoom show everyone. Always show the selected node's label.
    const showAll = k >= 1.4 || buf.ids.length <= 40;
    for (let i = 0; i < buf.ids.length; i++) {
      const id = buf.ids[i]!;
      const isSelected = id === selectedIdRef.current;
      const deg = buf.degrees[i] ?? 0;
      const wx = buf.positions[2 * i]!;
      const wy = buf.positions[2 * i + 1]!;
      const [sx, sy] = g.spaceToScreenPosition([wx, wy]);
      // Skip overlays that fell entirely off-screen (a sanity guard for any
      // transient state where the camera hasn't settled yet).
      if (!Number.isFinite(sx) || !Number.isFinite(sy)) continue;
      const node = nodesMap.get(id);
      if (!node) continue;

      // Tag ring overlay — one arc per assigned tag (paint a full coloured
      // border so the tag is visible even when the node fill is light, e.g.
      // the cream `root` tag). Multi-tag nodes split the ring into equal arcs.
      const assignedTags = node.graph_tags ?? [];
      if (assignedTags.length > 0) {
        const dotSize = buf.sizes[i] ?? 6;
        // cosmos draws points at `size * zoom` screen pixels (diameter) with
        // scalePointsOnZoom=true. Approximate the on-screen radius and pad
        // slightly so the ring sits just outside the dot.
        const screenRadius = (dotSize * k) / 2;
        outRings.push({
          id,
          x: sx,
          y: sy,
          // Ring straddles the dot edge: half overlaps the dot, half
          // extends outward. Kept thick enough (5px stroke) to read as a
          // visible colored band even at low zoom, and the half-overlap
          // eliminates any gap between dot fill and ring.
          radius: screenRadius + 2,
          strokeWidth: 5,
          tags: assignedTags.map((t) => ({ color: t.bg_color ?? '#888' })),
        });
      }

      // Label visibility / placement — runs after the ring is logged so that
      // the ring is always drawn even when the label is suppressed.
      if (!isSelected && !showAll) {
        if (deg < 2) continue;
      }
      const r = buf.colors[4 * i]!;
      const gC = buf.colors[4 * i + 1]!;
      const b = buf.colors[4 * i + 2]!;
      // Always render labels to one *side* of the node, never above it.
      // Right-of-node for nodes in the left two-thirds of the canvas,
      // left-of-node for the right third. This guarantees labels never
      // overlap the node dot or its tag ring, and keeps the layout legible
      // when many nodes share a horizontal band.
      const xFrac = sx / w;
      const anchor: 'left' | 'right' = xFrac > 0.66 ? 'right' : 'left';
      out.push({
        id,
        title: node.title ?? node.slug_name ?? id.slice(0, 8),
        x: sx,
        y: sy,
        color: rgbaToCss([r, gC, b, 240]),
        anchor,
      });
    }
    setLabels(out);
    setRings(outRings);
  };

  // Stable refresh fn for callbacks.
  const refreshLabelsRef = useRef(refreshLabels);
  refreshLabelsRef.current = refreshLabels;

  useEffect(() => {
    if (!containerRef.current || graphRef.current) return;
    const config: GraphConfigInterface = {
      backgroundColor: 'transparent',
      pointSize: 7,
      pointSizeScale: 1.0,
      // Bright, opaque-ish links so the graph topology is visible without
      // zooming. The theme effect remaps this to a dark equivalent when
      // light mode is active.
      linkColor: 'rgba(255, 255, 255, 0.7)',
      linkWidth: 1.4,
      linkArrows: false,
      curvedLinks: true,
      // Keep links visible regardless of length. Defaults faded long edges.
      linkVisibilityDistanceRange: [40, 4000],
      linkVisibilityMinTransparency: 0.7,
      renderHoveredPointRing: true,
      hoveredPointRingColor: '#fff3b0',
      // Static positions, no simulation, no auto-fit animation.
      disableSimulation: true,
      enableDrag: false,
      fitViewOnInit: true,
      fitViewDelay: 0,
      fitViewDuration: 0,
      fitViewPadding: 0.18,
      scalePointsOnZoom: true,
      onClick: (index) => {
        if (index === undefined) return;
        const ids = buffersRef.current?.ids;
        if (!ids) return;
        const id = ids[index];
        if (!id) return;
        useStore.getState().setSelected(id);
        send({ kind: 'requestNodeDetail', nodeId: id });
      },
      onPointMouseOver: (index) => {
        const g = graphRef.current;
        const buf = buffersRef.current;
        if (!g || !buf) return;
        const wx = buf.positions[2 * index];
        const wy = buf.positions[2 * index + 1];
        if (wx === undefined || wy === undefined) return;
        const [sx, sy] = g.spaceToScreenPosition([wx, wy]);
        // Defer showing the preview so quick fly-bys don't flash a card.
        if (hoverTimerRef.current !== null) {
          window.clearTimeout(hoverTimerRef.current);
        }
        hoverTimerRef.current = window.setTimeout(() => {
          hoverTimerRef.current = null;
          setHover({ index, screenX: sx, screenY: sy });
        }, HOVER_DELAY_MS);
      },
      onPointMouseOut: () => {
        if (hoverTimerRef.current !== null) {
          window.clearTimeout(hoverTimerRef.current);
          hoverTimerRef.current = null;
        }
        setHover(null);
      },
      onZoom: () => {
        const g = graphRef.current;
        if (g) {
          const z = g.getZoomLevel();
          zoomLevelRef.current = z;
          setZoomLevel(z);
        }
        refreshLabelsRef.current();
      },
      onZoomEnd: () => refreshLabelsRef.current(),
    };
    graphRef.current = new Graph(containerRef.current, config);

    // Track container size changes (panel resize / VS Code layout shifts).
    const ro = new ResizeObserver(() => refreshLabelsRef.current());
    ro.observe(containerRef.current);
    return () => {
      ro.disconnect();
      if (hoverTimerRef.current !== null) {
        window.clearTimeout(hoverTimerRef.current);
        hoverTimerRef.current = null;
      }
      graphRef.current?.destroy();
      graphRef.current = null;
    };
  }, []);

  const topologyKey = useMemo(() => {
    const ids = Array.from(filteredNodes.keys()).sort().join('|');
    const edgeKey = edgeList
      .map((e) => `${e.parent_id}->${e.child_id}`)
      .sort()
      .join('|');
    return `${ids}::${edgeKey}`;
  }, [filteredNodes, edgeList]);

  useEffect(() => {
    const g = graphRef.current;
    if (!g) return;

    const prevPositions = new Map<string, [number, number]>();
    const prevBuffers = buffersRef.current;
    if (prevBuffers) {
      const flat = g.getPointPositions();
      for (let i = 0; i < prevBuffers.ids.length; i++) {
        const x = flat[2 * i];
        const y = flat[2 * i + 1];
        if (x !== undefined && y !== undefined) {
          prevPositions.set(prevBuffers.ids[i]!, [x, y]);
        }
      }
    }

    const next = buildBuffers(filteredNodes, edgeList, prevPositions);
    buffersRef.current = next;
    g.setPointPositions(next.positions);
    // Point colors here are the *base* (bright) buffer. The theme-driven
    // effect below remaps them to a dark display palette when the graph is
    // in light mode.
    g.setPointColors(next.colors);
    g.setPointSizes(next.sizes);
    g.setLinks(next.links);
    g.render(0);

    // fitView triggers an async d3 transition — even with duration=0 the
    // transform applies on the next animation frame. Schedule a few label
    // refreshes to catch the post-fit transform regardless of how onZoom
    // batches.
    const cancels: number[] = [];
    if (next.ids.length > 0) {
      cancels.push(
        requestAnimationFrame(() => {
          g.fitView(0, 0.18);
          requestAnimationFrame(() => {
            zoomLevelRef.current = g.getZoomLevel();
            setZoomLevel(zoomLevelRef.current);
            refreshLabelsRef.current();
          });
        }),
      );
      cancels.push(window.setTimeout(() => refreshLabelsRef.current(), 60) as unknown as number);
      cancels.push(window.setTimeout(() => refreshLabelsRef.current(), 200) as unknown as number);
    } else {
      setLabels([]);
    }
    return () => {
      for (const id of cancels) {
        cancelAnimationFrame(id);
        clearTimeout(id);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topologyKey]);

  // Theme-driven recolor: in light mode, darken node fills + links so they
  // read against the cream background. We re-derive a display buffer from
  // the base (bright) `buf.colors`, leaving the buffer itself untouched so
  // the legend panel keeps showing the true tag color as a visual key.
  useEffect(() => {
    const g = graphRef.current;
    const buf = buffersRef.current;
    if (!g || !buf) return;
    if (effectiveTheme === 'light') {
      const display = new Float32Array(buf.colors.length);
      for (let i = 0; i < buf.colors.length; i += 4) {
        const dark = darkenForLight([
          buf.colors[i]!,
          buf.colors[i + 1]!,
          buf.colors[i + 2]!,
          buf.colors[i + 3]!,
        ]);
        display[i] = dark[0];
        display[i + 1] = dark[1];
        display[i + 2] = dark[2];
        display[i + 3] = dark[3];
      }
      g.setPointColors(display);
      g.setConfig({ linkColor: 'rgba(20, 20, 30, 0.75)' });
    } else {
      g.setPointColors(buf.colors);
      g.setConfig({ linkColor: 'rgba(255, 255, 255, 0.7)' });
    }
    g.render(0);
  }, [effectiveTheme, topologyKey]);

  // Re-anchor labels when filter / selection changes.
  useEffect(() => {
    refreshLabelsRef.current();
  }, [filteredNodes, selectedId, zoomLevel]);

  const hoveredNode = useMemo(() => {
    if (!hover) return null;
    const buf = buffersRef.current;
    if (!buf) return null;
    const id = buf.ids[hover.index];
    if (!id) return null;
    return filteredNodes.get(id) ?? null;
  }, [hover, filteredNodes]);

  // Build the legend entries (right-side panel). Every node in the filtered
  // view is listed, alphabetically — the panel is meant to be a complete
  // index of what's on the canvas, scrollable when the list is long. Each
  // entry carries the node's own colour so the panel reads as a colour
  // legend that maps directly to the canvas dots.
  const legend = useMemo(() => {
    const buf = buffersRef.current;
    if (!buf) return [] as Array<{
      id: string;
      title: string;
      color: string;
      degree: number;
      index: number;
    }>;
    const total = buf.ids.length;
    if (total === 0) return [];
    const entries: Array<{
      id: string;
      title: string;
      color: string;
      degree: number;
      index: number;
    }> = [];
    for (let i = 0; i < total; i++) {
      const id = buf.ids[i]!;
      const node = filteredNodes.get(id);
      if (!node) continue;
      const r = buf.colors[4 * i]!;
      const g = buf.colors[4 * i + 1]!;
      const b = buf.colors[4 * i + 2]!;
      entries.push({
        id,
        title: node.title ?? node.slug_name ?? id.slice(0, 8),
        color: rgbaToCss([r, g, b, 240]),
        degree: buf.degrees[i] ?? 0,
        index: i,
      });
    }
    entries.sort((a, b) => a.title.localeCompare(b.title));
    return entries;
    // `labels` is included in deps as a proxy: it changes after the
    // buffers are rebuilt, ensuring this memo runs against a fresh buf.
  }, [filteredNodes, labels]);

  // Legend → canvas highlighting. When the user hovers a panel entry we
  // focus the corresponding node and dye its ring with the node's own
  // colour, giving a clear visual link between the list and the dot.
  const onLegendEnter = (entry: {
    index: number;
    color: string;
    id: string;
  }): void => {
    const g = graphRef.current;
    if (!g) return;
    g.setConfig({ focusedPointRingColor: entry.color });
    g.setFocusedPointByIndex(entry.index);
  };
  const onLegendLeave = (): void => {
    const g = graphRef.current;
    if (!g) return;
    g.setFocusedPointByIndex(undefined);
  };
  const onLegendClick = (entry: { id: string; index: number }): void => {
    const g = graphRef.current;
    useStore.getState().setSelected(entry.id);
    if (g) {
      // Pan/zoom the canvas to the picked node so the user finds it instantly.
      g.zoomToPointByIndex(entry.index, 350, 2.0, true);
    }
    send({ kind: 'requestNodeDetail', nodeId: entry.id });
  };

  return (
    <>
      <div
        ref={containerRef}
        style={{
          position: 'absolute',
          inset: 0,
          background: themeBackground(theme),
        }}
      />
      <ThemeToggle theme={theme} onChange={setTheme} />
      <div
        data-graph-theme={effectiveTheme}
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          overflow: 'hidden',
        }}
      >
        <svg
          className="flywheel-tag-rings"
          xmlns="http://www.w3.org/2000/svg"
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            pointerEvents: 'none',
            overflow: 'visible',
          }}
        >
          {rings.map((r) =>
            r.tags.length === 1 ? (
              <circle
                key={r.id}
                cx={r.x}
                cy={r.y}
                r={r.radius}
                fill="none"
                stroke={r.tags[0]!.color}
                strokeWidth={r.strokeWidth}
              />
            ) : (
              <g key={r.id}>
                {r.tags.map((tag, i) => {
                  const span = 360 / r.tags.length;
                  const start = i * span;
                  const end = start + span;
                  return (
                    <path
                      key={`${r.id}-${i}`}
                      d={arcPath(r.x, r.y, r.radius, start, end)}
                      fill="none"
                      stroke={tag.color}
                      strokeWidth={r.strokeWidth}
                      strokeLinecap="butt"
                    />
                  );
                })}
              </g>
            ),
          )}
        </svg>
        {labels.map((l) => (
          <div
            key={l.id}
            className="flywheel-node-label"
            data-anchor={l.anchor}
            style={{ left: l.x, top: l.y }}
          >
            {l.title}
          </div>
        ))}
        {hoveredNode && hover ? (
          <NodePreview node={hoveredNode} x={hover.screenX} y={hover.screenY} />
        ) : null}
      </div>
      <LegendPanel
        entries={legend}
        total={filteredNodes.size}
        selectedId={selectedId}
        onEnter={onLegendEnter}
        onLeave={onLegendLeave}
        onPick={onLegendClick}
      />
    </>
  );
}

function ThemeToggle({
  theme,
  onChange,
}: {
  theme: GraphTheme;
  onChange: (next: GraphTheme) => void;
}) {
  // Cycle: auto → light → dark → auto.
  const next: GraphTheme =
    theme === 'auto' ? 'light' : theme === 'light' ? 'dark' : 'auto';
  const glyph = theme === 'light' ? '☀' : theme === 'dark' ? '☾' : '⊙';
  const label =
    theme === 'auto'
      ? 'Theme: follow editor'
      : theme === 'light'
        ? 'Theme: light'
        : 'Theme: dark';
  return (
    <button
      type="button"
      className="flywheel-theme-toggle"
      aria-label={`${label} (click to switch to ${next})`}
      title={`${label} — click to switch to ${next}`}
      onClick={() => onChange(next)}
      style={{
        position: 'absolute',
        top: 12,
        right: 12,
        width: 32,
        height: 32,
        borderRadius: 6,
        border: '1px solid rgba(160, 160, 170, 0.35)',
        background: 'rgba(40, 40, 50, 0.55)',
        color: '#fff3b0',
        cursor: 'pointer',
        fontSize: 16,
        lineHeight: '30px',
        textAlign: 'center',
        padding: 0,
        zIndex: 20,
        pointerEvents: 'auto',
        backdropFilter: 'blur(4px)',
      }}
    >
      {glyph}
    </button>
  );
}

interface LegendEntry {
  id: string;
  title: string;
  color: string;
  degree: number;
  index: number;
}

function LegendPanel({
  entries,
  total,
  selectedId,
  onEnter,
  onLeave,
  onPick,
}: {
  entries: LegendEntry[];
  total: number;
  selectedId: string | null;
  onEnter: (e: LegendEntry) => void;
  onLeave: () => void;
  onPick: (e: LegendEntry) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  if (entries.length === 0) return null;
  return (
    <aside
      className={`flywheel-legend${collapsed ? ' flywheel-legend--collapsed' : ''}`}
      onMouseLeave={onLeave}
    >
      <header className="flywheel-legend__header">
        <span className="flywheel-legend__title">
          {collapsed ? `${entries.length}` : `Nodes · ${entries.length}/${total}`}
        </span>
        <button
          type="button"
          className="flywheel-legend__toggle"
          aria-label={collapsed ? 'Expand legend' : 'Collapse legend'}
          onClick={() => setCollapsed((c) => !c)}
        >
          {collapsed ? '‹' : '›'}
        </button>
      </header>
      {!collapsed ? (
        <ul className="flywheel-legend__list">
          {entries.map((e) => {
            const active = e.id === selectedId;
            return (
              <li
                key={e.id}
                className={`flywheel-legend__item${active ? ' flywheel-legend__item--active' : ''}`}
                onMouseEnter={() => onEnter(e)}
                onClick={() => onPick(e)}
                title={e.title}
              >
                <span
                  className="flywheel-legend__dot"
                  style={{ background: e.color }}
                />
                <span className="flywheel-legend__name" style={{ color: e.color }}>
                  {e.title}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </aside>
  );
}

function NodePreview({ node, x, y }: { node: FlywheelNode; x: number; y: number }) {
  const tags = node.graph_tags ?? [];
  // Prefer the explicit TL;DR callout (mandated by the Flywheel logging style).
  // Fall back to the raw summary field, then to the head of the body, so older
  // nodes without a TL;DR still preview something useful.
  const tldr = extractTldr(node.content) ?? extractTldr(node.summary);
  const body =
    tldr ?? ((node.summary ?? '').trim() || (node.content ?? '').slice(0, 220).trim());
  return (
    <div
      className="flywheel-hover-card"
      style={{ left: x, top: y, transform: 'translate(12px, 12px)' }}
    >
      <div className="flywheel-hover-card__title">{node.title ?? '(untitled)'}</div>
      {node.slug_name ? (
        <div className="flywheel-hover-card__slug">{node.slug_name}</div>
      ) : null}
      {tags.length > 0 ? (
        <div className="flywheel-hover-card__tags">
          {tags.map((t) => (
            <span
              key={t.tag_id ?? t.name}
              className="flywheel-hover-card__tag"
              style={{
                background: t.bg_color ?? '#444',
                color: t.text_color ?? '#fff',
              }}
            >
              {t.name}
            </span>
          ))}
        </div>
      ) : null}
      {body ? (
        <div
          className={
            'flywheel-hover-card__summary' +
            (tldr ? ' flywheel-hover-card__summary--tldr' : '')
          }
        >
          {tldr ? <span className="flywheel-hover-card__tldr-label">TL;DR</span> : null}
          {tldr ? renderInline(body) : body}
        </div>
      ) : null}
    </div>
  );
}
