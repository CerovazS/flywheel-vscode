/**
 * Polling-diff: compare two NodeTreeProjections and emit PatchOps.
 *
 * The tree projection doesn't include `revision`, so we drive updates off a
 * conservative "fingerprint" of each node (currently: title + outgoing_ids
 * count). This catches additions/removals and topology shifts without
 * over-emitting on cosmetic changes; for richer updates the panel can
 * trigger a focused `flywheel_get_node` fetch.
 */

import type { PatchOp } from '../protocol.js';
import type { FlywheelEdge, FlywheelNode, NodeTreeProjection } from '../client/types.js';

export interface DiffResult {
  ops: PatchOp[];
  nextFingerprints: Map<string, string>;
  nextEdgeKeys: Set<string>;
}

const edgeKey = (e: FlywheelEdge): string => `${e.parent_id}->${e.child_id}`;

/** Cheap, projection-resilient hash of a node. */
function fingerprint(n: FlywheelNode): string {
  const out = (n.outgoing_ids ?? []).join(',');
  const inc = (n.incoming_ids ?? []).join(',');
  return `${n.title}|${n.revision ?? ''}|${out}|${inc}`;
}

export function diffProjection(
  prevFingerprints: Map<string, string>,
  prevEdgeKeys: Set<string>,
  next: NodeTreeProjection,
): DiffResult {
  const ops: PatchOp[] = [];
  const nextFingerprints = new Map<string, string>();

  for (const node of next.nodes) {
    const fp = fingerprint(node);
    nextFingerprints.set(node.node_id, fp);
    const prev = prevFingerprints.get(node.node_id);
    if (prev === undefined) {
      ops.push({ op: 'addNode', node });
    } else if (prev !== fp) {
      ops.push({ op: 'updateNode', nodeId: node.node_id, partial: node });
    }
  }

  for (const [id] of prevFingerprints) {
    if (!nextFingerprints.has(id)) {
      ops.push({ op: 'removeNode', nodeId: id });
    }
  }

  const nextEdgeKeys = new Set<string>();
  for (const edge of next.edges) {
    const k = edgeKey(edge);
    nextEdgeKeys.add(k);
    if (!prevEdgeKeys.has(k)) {
      ops.push({ op: 'addEdge', edge });
    }
  }
  for (const k of prevEdgeKeys) {
    if (!nextEdgeKeys.has(k)) {
      const [parent_id, child_id] = k.split('->') as [string, string];
      ops.push({ op: 'removeEdge', parent_id, child_id });
    }
  }

  return { ops, nextFingerprints, nextEdgeKeys };
}

export function emptyState(): {
  fingerprints: Map<string, string>;
  edgeKeys: Set<string>;
} {
  return { fingerprints: new Map(), edgeKeys: new Set() };
}
