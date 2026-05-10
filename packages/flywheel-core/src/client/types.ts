/**
 * Canonical Flywheel graph types — aligned to the **observed** server shape
 * from `flywheel_list_nodes` and `flywheel_get_node_tree` (verified via the
 * smoke scripts at packages/flywheel-core/scripts/).
 *
 * The server returns *different fields* depending on the projection:
 *   - `flywheel_get_node_tree` → minimal: {node_id, title, depth, lane,
 *     is_root, outgoing_ids, incoming_ids}.
 *   - `flywheel_list_nodes` (default) → richer: adds revision, visibility,
 *     graph_tags, content, summary, artifacts, timestamps. No repo_context.
 *   - `flywheel_get_node` → full: should add repo_context, full content,
 *     artifacts.
 *
 * We model these as one optional-rich `FlywheelNode` and derive edges from
 * `outgoing_ids` / `incoming_ids`. Server-side `revision` drives diff.
 */

export type Visibility = 'private' | 'shared' | 'unlisted' | 'public';

/**
 * Repo context, included in `flywheel_get_node` payloads. May be null when
 * the node was committed without a repo binding.
 */
export interface RepoContext {
  repo_url: string;
  branch_name?: string | null;
  head_commit_sha?: string | null;
  origin_host?: string | null;
  updated_by?: string | null;
  external_transcript_ref?: string | null;
}

/**
 * A graph tag attached to a node. Returned in the `graph_tags` array.
 */
export interface NodeTag {
  tag_id: string;
  name: string;
  bg_color?: string | null;
  text_color?: string | null;
  one_only?: boolean;
}

/**
 * One node as returned by Flywheel. Most fields are optional because the
 * shape depends on the calling tool's projection. Code paths needing a
 * specific field should null-check.
 */
export interface FlywheelNode {
  node_id: string;
  title: string;
  /** May be null for unpublished/orphan nodes. */
  slug_name?: string | null;
  /** Bumped on every commit; drives polling-diff updates. */
  revision?: number;

  /** Tree-projection only. */
  depth?: number;
  lane?: number;
  is_root?: boolean;

  /** Adjacency: present in tree-projection and richer projections. */
  outgoing_ids?: string[];
  incoming_ids?: string[];

  /** Body & summary (markdown). Present in list/get; absent in tree. */
  content?: string;
  summary?: string | null;

  /** Tagging. */
  graph_tags?: NodeTag[];
  tag_ids?: string[];

  visibility?: Visibility;
  is_owner?: boolean;
  can_write?: boolean;
  can_admin?: boolean;
  owner_email?: string | null;

  /** Repo binding. Present in `flywheel_get_node`; absent in list/tree. */
  repo_context?: RepoContext | null;

  /** Artifacts inline. Present in some projections. */
  artifacts?: FlywheelArtifact[];
  artifacts_total?: number;
  artifacts_truncated?: boolean;

  created_at?: string;
  updated_at?: string;

  /** Server-echoed projection name. */
  graph_projection?: 'topology' | 'core' | 'full';
}

/** Derived edge from outgoing_ids; not a wire format. */
export interface FlywheelEdge {
  parent_id: string;
  child_id: string;
}

export type ArtifactType =
  | 'text'
  | 'table'
  | 'json'
  | 'image'
  | 'banner'
  | 'html'
  | 'plotly_html'
  | 'vega'
  | 'checkpoint'
  | 'binary'
  | 'diff_carousel';

export interface FlywheelArtifact {
  artifact_id: string;
  node_id?: string;
  title: string;
  artifact_type: ArtifactType;
  storage_url?: string | null;
  note?: string | null;
  created_at?: string;
}

export interface NodeTreeProjection {
  root_id: string;
  nodes: FlywheelNode[];
  edges: FlywheelEdge[];
}

export interface SearchHit {
  chunk_id: string;
  node_id: string;
  node_slug: string;
  section: string | null;
  snippet: string;
  similarity: number;
}

export interface ExecutionStatus {
  execution_id: string;
  node_id: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'terminated';
  started_at: string;
  updated_at: string;
}

export interface ApprovalSession {
  session_id: string;
  node_id: string;
  opened_by: string;
  opened_at: string;
}
