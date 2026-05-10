/**
 * Ollama embed client (Qwen3-Embedding-0.6B).
 *
 * Endpoint: POST {baseUrl}/api/embed
 *   body: { model: 'qwen3-embedding:0.6b', input: string | string[] }
 *   response: { embeddings: number[][] }
 *
 * Vector dim: 1024.
 */

import { EMBED_MODEL, VECTOR_DIM } from 'flywheel-core';

export interface OllamaClientOptions {
  baseUrl?: string;
  model?: string;
  fetchImpl?: typeof fetch;
}

export class OllamaUnreachableError extends Error {
  constructor(baseUrl: string, cause: unknown) {
    super(
      `Ollama unreachable at ${baseUrl}. Start it with \`ollama serve\` or change flywheel.ollamaUrl.`,
    );
    this.name = 'OllamaUnreachableError';
    this.cause = cause;
  }
}

export class OllamaClient {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OllamaClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? 'http://localhost:11434').replace(/\/$/, '');
    this.model = opts.model ?? EMBED_MODEL;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }

  async embed(inputs: string[]): Promise<Float32Array[]> {
    if (inputs.length === 0) return [];
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, input: inputs }),
      });
    } catch (e) {
      throw new OllamaUnreachableError(this.baseUrl, e);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Ollama HTTP ${res.status}: ${text.slice(0, 500)}`);
    }
    const json = (await res.json()) as { embeddings: number[][] };
    if (!Array.isArray(json.embeddings)) {
      throw new Error('Ollama response missing `embeddings`');
    }
    const out: Float32Array[] = [];
    for (const e of json.embeddings) {
      if (e.length !== VECTOR_DIM) {
        throw new Error(
          `Ollama embedding dim ${e.length} ≠ expected ${VECTOR_DIM}; check model.`,
        );
      }
      out.push(Float32Array.from(e));
    }
    return out;
  }

  async embedBatched(inputs: string[], batchSize = 32): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    for (let i = 0; i < inputs.length; i += batchSize) {
      const chunk = inputs.slice(i, i + batchSize);
      const embeds = await this.embed(chunk);
      out.push(...embeds);
    }
    return out;
  }
}
