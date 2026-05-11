/**
 * Local semantic search index.
 *
 * Storage: SQLite + sqlite-vec, schema 1:1 compatible with obsidian-search.
 * Embeddings: Qwen3-Embedding-0.6B via Ollama (1024-dim, cosine distance).
 *
 * Lifecycle:
 *   - `indexNodes(nodes)` upserts chunks for changed nodes (revision-driven).
 *   - `removeNode(nodeId)` deletes all chunks for a node.
 *   - `search(query, k)` returns top-k chunks ordered by similarity.
 *
 * Native module note: better-sqlite3 + sqlite-vec require a binary that
 * matches the host Node ABI. They are loaded LAZILY inside the constructor
 * via `require()` so the bundled extension can activate without them — only
 * the semantic-search commands fail (with a clear error) if the natives
 * aren't available. The graph viewer, markdown viewer, and edit-save all
 * keep working.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  type FlywheelNode,
  SCHEMA_SQL,
  VECTOR_DIM,
  type SearchHit,
} from 'flywheel-core';
import { chunkNode, type Chunk } from './chunker.js';
import { OllamaClient } from './ollama.js';

// Minimal ambient types so we don't have to pull better-sqlite3 into the
// build at compile-time. We model only the surface we actually call. Native
// objects from `require('better-sqlite3')` satisfy this structurally.
interface DbStatement<TParams extends unknown[] = unknown[], TRow = unknown> {
  run(...params: TParams): { changes: number; lastInsertRowid: number | bigint };
  all(...params: TParams): TRow[];
  get(...params: TParams): TRow | undefined;
}
interface Db {
  prepare<TParams extends unknown[] = unknown[], TRow = unknown>(
    sql: string,
  ): DbStatement<TParams, TRow>;
  exec(sql: string): void;
  pragma(name: string): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  transaction<T extends (...args: any[]) => any>(fn: T): T;
  close(): void;
}

export interface IndexerOptions {
  dbPath: string;
  ollama: OllamaClient;
}

interface ChunkRow {
  chunk_id: string;
  node_id: string;
  node_slug: string;
  section: string | null;
  chunk_index: number;
  content: string;
  revision: number;
}

interface SearchRow extends ChunkRow {
  distance: number;
}

/**
 * Resolve the two native modules at call time. If either fails to load,
 * surface a single actionable error message to the caller.
 */
function loadNativeDeps(): {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Database: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sqliteVec: any;
} {
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    // Bracket-notation `require` keeps esbuild from trying to bundle these
    // (they're already in the `external` list, but this also defends against
    // any future config drift). They stay as runtime `require()` calls.
    const Database = require('better-sqlite3');
    const sqliteVec = require('sqlite-vec');
    /* eslint-enable @typescript-eslint/no-require-imports */
    return { Database: Database.default ?? Database, sqliteVec };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Flywheel: semantic search needs native modules that aren't installed in the packaged extension. ` +
        `Build from source (see docs/development.md) to use search. Underlying error: ${msg}`,
    );
  }
}

export class SearchIndex {
  private readonly db: Db;
  private readonly ollama: OllamaClient;

  constructor(opts: IndexerOptions) {
    const { Database, sqliteVec } = loadNativeDeps();
    fs.mkdirSync(path.dirname(opts.dbPath), { recursive: true });
    this.db = new Database(opts.dbPath);
    sqliteVec.load(this.db);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA_SQL);
    this.ollama = opts.ollama;
  }

  close(): void {
    this.db.close();
  }

  /** Read currently-indexed revision for each node_id. */
  getIndexedRevisions(): Map<string, number> {
    const rows = this.db
      .prepare<unknown[], { node_id: string; revision: number }>(
        'SELECT node_id, MAX(revision) AS revision FROM chunks GROUP BY node_id',
      )
      .all();
    const out = new Map<string, number>();
    for (const r of rows) out.set(r.node_id, r.revision);
    return out;
  }

  /**
   * Bring the index up-to-date with the given nodes. Only nodes whose
   * stored revision differs from the in-memory revision are re-chunked and
   * re-embedded.
   */
  async indexNodes(nodes: FlywheelNode[]): Promise<{ indexed: number; skipped: number }> {
    const indexedRev = this.getIndexedRevisions();
    const toIndex: FlywheelNode[] = [];
    let skipped = 0;
    for (const n of nodes) {
      const cur = indexedRev.get(n.node_id);
      if (cur === n.revision) {
        skipped += 1;
        continue;
      }
      toIndex.push(n);
    }
    if (toIndex.length === 0) return { indexed: 0, skipped };

    const allChunks: Chunk[] = [];
    for (const n of toIndex) {
      if (!n.node_id) continue;
      const slug = n.slug_name ?? n.node_id.slice(0, 8);
      const text = n.content ?? '';
      if (!text.trim()) continue;
      allChunks.push(...chunkNode({ node_id: n.node_id, node_slug: slug, text }));
    }
    if (allChunks.length === 0) return { indexed: toIndex.length, skipped };

    const embeddings = await this.ollama.embedBatched(
      allChunks.map((c) => c.content),
      32,
    );

    const insertChunk = this.db.prepare<
      [string, string, string, string | null, number, string, number]
    >(
      `INSERT OR REPLACE INTO chunks
       (chunk_id, node_id, node_slug, section, chunk_index, content, revision)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const deleteVec = this.db.prepare<[string]>('DELETE FROM vec_chunks WHERE chunk_id = ?');
    const insertVec = this.db.prepare<[string, Buffer]>(
      'INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)',
    );
    const deleteByNode = this.db.prepare<[string]>('DELETE FROM chunks WHERE node_id = ?');
    const deleteVecByNode = this.db.prepare<[string]>(
      'DELETE FROM vec_chunks WHERE chunk_id IN (SELECT chunk_id FROM chunks WHERE node_id = ?)',
    );

    const tx = this.db.transaction((nodesToIndex: FlywheelNode[], chunks: Chunk[]) => {
      for (const n of nodesToIndex) {
        deleteVecByNode.run(n.node_id);
        deleteByNode.run(n.node_id);
      }
      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i]!;
        const e = embeddings[i]!;
        const node = toIndex.find((n) => n.node_id === c.node_id)!;
        insertChunk.run(
          c.chunk_id,
          c.node_id,
          c.node_slug,
          c.section,
          c.chunk_index,
          c.content,
          node.revision ?? 0,
        );
        deleteVec.run(c.chunk_id);
        insertVec.run(c.chunk_id, Buffer.from(e.buffer));
      }
    });
    tx(toIndex, allChunks);
    return { indexed: toIndex.length, skipped };
  }

  removeNode(nodeId: string): void {
    const deleteVec = this.db.prepare<[string]>(
      'DELETE FROM vec_chunks WHERE chunk_id IN (SELECT chunk_id FROM chunks WHERE node_id = ?)',
    );
    const deleteChunks = this.db.prepare<[string]>('DELETE FROM chunks WHERE node_id = ?');
    const tx = this.db.transaction(() => {
      deleteVec.run(nodeId);
      deleteChunks.run(nodeId);
    });
    tx();
  }

  async search(query: string, k = 8): Promise<SearchHit[]> {
    if (!query.trim()) return [];
    const [embedding] = await this.ollama.embed([query]);
    if (!embedding || embedding.length !== VECTOR_DIM) {
      throw new Error('Failed to embed query');
    }
    const stmt = this.db.prepare<[Buffer, number], SearchRow>(`
      SELECT
        c.chunk_id, c.node_id, c.node_slug, c.section, c.chunk_index,
        c.content, c.revision, v.distance
      FROM vec_chunks v
      JOIN chunks c ON c.chunk_id = v.chunk_id
      WHERE v.embedding MATCH ? AND k = ?
      ORDER BY v.distance
    `);
    const rows = stmt.all(Buffer.from(embedding.buffer), k);
    return rows.map((r) => ({
      chunk_id: r.chunk_id,
      node_id: r.node_id,
      node_slug: r.node_slug,
      section: r.section,
      snippet: r.content.length > 240 ? r.content.slice(0, 240) + '…' : r.content,
      similarity: 1 - r.distance, // cosine distance → cosine similarity
    }));
  }
}
