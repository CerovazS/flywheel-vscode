/**
 * SQLite schema for the local semantic search index.
 *
 * Schema is intentionally compatible with the `obsidian-search` Python tool
 * (~/obsidian-search/src/obsidian_search/store.py) so the same Qwen3-0.6B
 * embeddings (1024-dim, cosine) round-trip cleanly. We swap `file_path` →
 * `node_id` because here the unit of indexing is a Flywheel node, not a file.
 *
 * Vector dim: 1024 (Qwen3-Embedding-0.6B output).
 * Distance: cosine.
 */

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS chunks (
  chunk_id    TEXT PRIMARY KEY,
  node_id     TEXT NOT NULL,
  node_slug   TEXT NOT NULL,
  section     TEXT,
  chunk_index INTEGER NOT NULL,
  content     TEXT NOT NULL,
  revision    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS chunks_by_node ON chunks(node_id);

CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0 (
  chunk_id    TEXT PRIMARY KEY,
  embedding   FLOAT[1024] distance_metric=cosine
);
`;

export const VECTOR_DIM = 1024;
export const EMBED_MODEL = 'qwen3-embedding:0.6b';
