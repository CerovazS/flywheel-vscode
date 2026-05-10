/**
 * Wrappers around graph navigation MCP tools.
 *
 * `flywheel_get_node_tree` returns a tree projection rooted at a node:
 *   { anchor_node_id, root_node_ids, nodes: [...], lane_count, max_depth }
 *
 * Each node carries `outgoing_ids` / `incoming_ids`. We derive a flat edge
 * list from `outgoing_ids` for the renderer.
 *
 * `flywheel_list_nodes` returns a paginated wrapper:
 *   { nodes, total, page, page_size, has_more }
 *
 * `flywheel_get_node` returns one fully-projected node (with repo_context,
 * artifacts, and content).
 */

import type { FlywheelMcpClient } from '../client/mcp.js';
import type {
  FlywheelArtifact,
  FlywheelEdge,
  FlywheelNode,
  NodeTreeProjection,
} from '../client/types.js';

interface RawTreeResponse {
  anchor_node_id: string;
  root_node_ids: string[];
  nodes: FlywheelNode[];
  lane_count?: number;
  max_depth?: number;
}

export async function getNodeTree(
  client: FlywheelMcpClient,
  nodeId: string,
): Promise<NodeTreeProjection> {
  const raw = await client.callTool<RawTreeResponse>('flywheel_get_node_tree', {
    node_id: nodeId,
  });
  const seen = new Set<string>();
  const edges: FlywheelEdge[] = [];
  for (const n of raw.nodes) {
    for (const child of n.outgoing_ids ?? []) {
      const key = `${n.node_id}->${child}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ parent_id: n.node_id, child_id: child });
    }
  }
  const rootId = raw.root_node_ids[0] ?? raw.anchor_node_id;
  return { root_id: rootId, nodes: raw.nodes, edges };
}

interface RawListResponse {
  nodes: FlywheelNode[];
  total: number;
  page: number;
  page_size: number;
  has_more: boolean;
}

export async function listNodes(
  client: FlywheelMcpClient,
  args: {
    page?: number;
    page_size?: number;
    visibility?: 'private' | 'shared' | 'unlisted' | 'public';
  } = {},
): Promise<RawListResponse> {
  return client.callTool<RawListResponse>('flywheel_list_nodes', args);
}

export interface SlugResolution {
  status: 'unique' | 'context_resolved' | 'ambiguous' | 'not_found';
  node_id: string | null;
  candidates?: Array<{ node_id: string; slug_name: string; title?: string }>;
}

/** Resolve a slug or pass through a UUID-shaped id. */
export async function resolveNodeRef(
  client: FlywheelMcpClient,
  ref: string,
): Promise<string> {
  const trimmed = ref.trim();
  if (!trimmed) throw new Error('Empty node reference');
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) {
    return trimmed;
  }
  const res = await client.callTool<SlugResolution>('flywheel_resolve_node_slug', {
    slug: trimmed,
  });
  if (res.status === 'unique' || res.status === 'context_resolved') {
    if (!res.node_id) throw new Error(`Resolver returned ${res.status} but no node_id`);
    return res.node_id;
  }
  if (res.status === 'ambiguous') {
    throw new Error(`Slug "${trimmed}" is ambiguous (${res.candidates?.length ?? 0} candidates)`);
  }
  throw new Error(`Slug "${trimmed}" not found`);
}

export async function getNode(
  client: FlywheelMcpClient,
  nodeId: string,
): Promise<FlywheelNode> {
  // Server wraps the payload as `{ node: {...} }`. Some older builds may
  // have returned the node directly — handle both shapes.
  const res = await client.callTool<FlywheelNode | { node: FlywheelNode }>(
    'flywheel_get_node',
    { node_id: nodeId },
  );
  if (res && typeof res === 'object' && 'node' in res && (res as { node: FlywheelNode }).node) {
    return (res as { node: FlywheelNode }).node;
  }
  return res as FlywheelNode;
}

export async function listArtifacts(
  client: FlywheelMcpClient,
  nodeId: string,
): Promise<FlywheelArtifact[]> {
  const res = await client.callTool<
    { artifacts?: FlywheelArtifact[] } | FlywheelArtifact[]
  >('flywheel_list_artifacts', { node_id: nodeId });
  if (Array.isArray(res)) return res;
  return res?.artifacts ?? [];
}

export interface ExecutionsResponse {
  executions: Array<{
    execution_id: string;
    node_id: string;
    status: 'queued' | 'running' | 'completed' | 'failed' | 'terminated';
    started_at: string;
    updated_at: string;
    title?: string;
  }>;
  next_cursor?: string;
}

export async function listExecutions(
  client: FlywheelMcpClient,
  status?: 'queued' | 'running' | 'completed' | 'failed' | 'terminated',
): Promise<ExecutionsResponse> {
  const args: Record<string, unknown> = {};
  if (status) args['status'] = status;
  return client.callTool<ExecutionsResponse>('flywheel_list_executions', args);
}

export interface ApprovalSessionsResponse {
  sessions: Array<{
    session_id: string;
    node_id: string;
    opened_by: string;
    opened_at: string;
  }>;
}

export async function listApprovalSessions(
  client: FlywheelMcpClient,
): Promise<ApprovalSessionsResponse> {
  return client.callTool<ApprovalSessionsResponse>('flywheel_list_approval_sessions', {});
}

/**
 * Update a node's markdown content via the staged-edit protocol:
 *
 *   1. acquire_stage_lease({node, session_id, base_revision})
 *   2. commit_node({node, session_id, base_revision, staged_payload})
 *   3. release_stage_lease({node, session_id})
 *
 * The lease is best-effort released even on error — leases are short-lived
 * server-side and a missed release is harmless, but releasing eagerly avoids
 * the "stale lease" path on the user's next edit.
 *
 * `staged_payload` requires `title` + `summary` + `repo_context` alongside
 * `content`, so we fetch the current node first and reuse its fields. The
 * caller can override any of them via `overrides`.
 */
export async function updateNodeContent(
  client: FlywheelMcpClient,
  nodeId: string,
  content: string,
  overrides?: { title?: string; summary?: string },
): Promise<{ revision: number | undefined }> {
  const current = await getNode(client, nodeId);
  const baseRevision = typeof current.revision === 'number' ? current.revision : 0;
  const sessionId = generateSessionId();

  // The stage payload mirrors the server's `McpCommitNodeStagedPayload`:
  // every field non-null even when unchanged. We fall back to empty strings
  // / null where the read projection didn't carry the value.
  const repo = current.repo_context ?? null;
  const stagedPayload = {
    title: overrides?.title ?? current.title ?? '',
    content,
    summary: overrides?.summary ?? current.summary ?? '',
    repo_context: {
      repo_url: repo?.repo_url ?? null,
      branch_name: repo?.branch_name ?? null,
      head_commit_sha: repo?.head_commit_sha ?? null,
      origin_host: repo?.origin_host ?? null,
      updated_by: repo?.updated_by ?? null,
      external_transcript_ref: repo?.external_transcript_ref ?? null,
    },
  };

  await client.callTool<unknown>('flywheel_acquire_stage_lease', {
    node_id: nodeId,
    stage_session_id: sessionId,
    base_committed_revision: baseRevision,
  });

  try {
    const result = await client.callTool<{ revision?: number }>(
      'flywheel_commit_node',
      {
        node_id: nodeId,
        stage_session_id: sessionId,
        base_committed_revision: baseRevision,
        staged_payload: stagedPayload,
      },
    );
    return { revision: result?.revision };
  } finally {
    // Best-effort cleanup. Don't surface lease-release failures to the user;
    // the commit either landed or didn't, and that's the only thing that
    // matters from a UX standpoint.
    try {
      await client.callTool<unknown>('flywheel_release_stage_lease', {
        node_id: nodeId,
        stage_session_id: sessionId,
      });
    } catch {
      // ignore
    }
  }
}

/**
 * RFC 4122 v4 UUID without depending on `crypto.randomUUID` (Node 18 / older
 * browsers). Uses `crypto.getRandomValues` if available, else `Math.random`.
 */
function generateSessionId(): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = (globalThis as any).crypto;
  const buf = new Uint8Array(16);
  if (g && typeof g.getRandomValues === 'function') {
    g.getRandomValues(buf);
  } else {
    for (let i = 0; i < 16; i++) buf[i] = Math.floor(Math.random() * 256);
  }
  buf[6] = (buf[6]! & 0x0f) | 0x40; // version 4
  buf[8] = (buf[8]! & 0x3f) | 0x80; // variant 1
  const hex: string[] = [];
  for (const b of buf) hex.push(b.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
}
