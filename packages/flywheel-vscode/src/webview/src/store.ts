/**
 * Zustand store for the webview. Two slices:
 *   - graph: nodes/edges (rebuilt from snapshots + patches; not persisted)
 *   - ui:    selection, repo filter, search query (persisted via vscode setState)
 *
 * Host is the source of truth for `graph`; webview only holds a projection.
 */

import { create } from 'zustand';
import type { FlywheelEdge, FlywheelNode } from 'flywheel-core/client';
import type { PatchOp } from 'flywheel-core/protocol';

export interface UiState {
  selectedNodeId: string | null;
  repoFilter: string | null;
  search: string;
  status: { connected: boolean; nodeCount: number; rootSlug: string | null };
  lastSeq: number;
}

export interface GraphState {
  nodes: Map<string, FlywheelNode>;
  edges: Set<string>; // key: parent_id->child_id
  edgeList: FlywheelEdge[];
}

export interface Store {
  ui: UiState;
  graph: GraphState;
  setStatus(status: UiState['status']): void;
  applySnapshot(viewId: string, nodes: FlywheelNode[], edges: FlywheelEdge[], seq: number): void;
  applyPatch(ops: PatchOp[], seq: number): void;
  setSelected(id: string | null): void;
  setRepoFilter(filter: string | null): void;
  setSearch(s: string): void;
}

const edgeKey = (e: FlywheelEdge) => `${e.parent_id}->${e.child_id}`;

export const useStore = create<Store>((set) => ({
  ui: {
    selectedNodeId: null,
    repoFilter: null,
    search: '',
    status: { connected: false, nodeCount: 0, rootSlug: null },
    lastSeq: 0,
  },
  graph: {
    nodes: new Map(),
    edges: new Set(),
    edgeList: [],
  },
  setStatus: (status) => set((s) => ({ ui: { ...s.ui, status } })),
  applySnapshot: (_viewId, nodes, edges, seq) =>
    set(() => {
      const nodeMap = new Map<string, FlywheelNode>();
      for (const n of nodes) nodeMap.set(n.node_id, n);
      const edgeKeys = new Set<string>();
      const edgeList: FlywheelEdge[] = [];
      for (const e of edges) {
        const k = edgeKey(e);
        if (!edgeKeys.has(k)) {
          edgeKeys.add(k);
          edgeList.push(e);
        }
      }
      return {
        graph: { nodes: nodeMap, edges: edgeKeys, edgeList },
        ui: {
          selectedNodeId: null,
          repoFilter: null,
          search: '',
          status: { connected: true, nodeCount: nodes.length, rootSlug: null },
          lastSeq: seq,
        },
      };
    }),
  applyPatch: (ops, seq) =>
    set((s) => {
      const nodes = new Map(s.graph.nodes);
      const edges = new Set(s.graph.edges);
      let edgeList = s.graph.edgeList;
      for (const op of ops) {
        switch (op.op) {
          case 'addNode':
            if (op.node) nodes.set(op.node.node_id, op.node);
            break;
          case 'updateNode': {
            const cur = nodes.get(op.nodeId);
            if (cur) nodes.set(op.nodeId, { ...cur, ...op.partial });
            break;
          }
          case 'removeNode':
            nodes.delete(op.nodeId);
            break;
          case 'addEdge': {
            const k = edgeKey(op.edge);
            if (!edges.has(k)) {
              edges.add(k);
              edgeList = [...edgeList, op.edge];
            }
            break;
          }
          case 'removeEdge': {
            const k = `${op.parent_id}->${op.child_id}`;
            if (edges.has(k)) {
              edges.delete(k);
              edgeList = edgeList.filter(
                (e) => !(e.parent_id === op.parent_id && e.child_id === op.child_id),
              );
            }
            break;
          }
        }
      }
      return {
        graph: { nodes, edges, edgeList },
        ui: { ...s.ui, lastSeq: seq, status: { ...s.ui.status, nodeCount: nodes.size } },
      };
    }),
  setSelected: (id) => set((s) => ({ ui: { ...s.ui, selectedNodeId: id } })),
  setRepoFilter: (filter) => set((s) => ({ ui: { ...s.ui, repoFilter: filter } })),
  setSearch: (search) => set((s) => ({ ui: { ...s.ui, search } })),
}));
