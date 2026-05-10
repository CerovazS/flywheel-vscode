/**
 * Message protocol between extension host and webview.
 *
 * Webview → Host: Intent (the user wants something).
 * Host → Webview: Fact (here is the truth).
 *
 * Snapshot+Patch streaming:
 *   - Snapshot delivers the entire graph state for a viewId on attach/resync.
 *   - Patch delivers a sequence of graph mutations (ops) since last snapshot.
 *   - `seq` monotonically increases per viewId. Webview persists `lastSeq` via
 *     acquireVsCodeApi().setState; on reload, requests Snapshot if it sees a gap.
 */

import type {
  FlywheelEdge,
  FlywheelNode,
  SearchHit,
} from './client/types.js';

export type Intent =
  | { kind: 'attach'; viewId: string; rootNodeId: string; repoFilter?: string }
  | { kind: 'detach'; viewId: string }
  | { kind: 'requestNodeDetail'; nodeId: string }
  | { kind: 'requestSemanticSearch'; query: string; k: number }
  | { kind: 'requestSnapshot'; viewId: string }
  | { kind: 'setRepoFilter'; viewId: string; repoFilter: string | null }
  | { kind: 'saveNodeContent'; nodeId: string; content: string };

export type PatchOp =
  | { op: 'addNode'; node: FlywheelNode }
  | { op: 'updateNode'; nodeId: string; partial: Partial<FlywheelNode> }
  | { op: 'removeNode'; nodeId: string }
  | { op: 'addEdge'; edge: FlywheelEdge }
  | { op: 'removeEdge'; parent_id: string; child_id: string };

export type Fact =
  | {
      kind: 'snapshot';
      viewId: string;
      nodes: FlywheelNode[];
      edges: FlywheelEdge[];
      seq: number;
    }
  | { kind: 'patch'; viewId: string; ops: PatchOp[]; seq: number }
  | { kind: 'nodeDetail'; node: FlywheelNode; rendered: string }
  | { kind: 'searchResults'; results: SearchHit[] }
  | { kind: 'error'; message: string }
  | { kind: 'status'; connected: boolean; nodeCount: number; rootSlug: string | null }
  | { kind: 'filter'; repoFilter: string | null }
  | { kind: 'saveResult'; nodeId: string; ok: boolean; message?: string };
