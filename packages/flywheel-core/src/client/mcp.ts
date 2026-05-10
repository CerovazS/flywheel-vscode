/**
 * HTTP MCP client for Flywheel.
 *
 * Transport: JSON-RPC 2.0 over HTTP POST to `https://flywheel.paradigma.inc/mcp-server`.
 * Each request:
 *   POST /mcp-server
 *   Headers: Authorization: Bearer fwk_<TOKEN>, Content-Type: application/json
 *   Body: { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments } }
 *
 * Token resolution order:
 *   1. constructor `token` argument (e.g. from VS Code setting)
 *   2. ~/.claude.json → mcpServers.flywheel.headers.Authorization (strip "Bearer ")
 *
 * Rate limit: 120 reads/min. We enforce a token bucket client-side as a soft guard.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const FLYWHEEL_MCP_URL = 'https://flywheel.paradigma.inc/mcp-server';

export interface McpClientOptions {
  url?: string;
  token?: string;
  /** Cap requests per minute (default 110, leaves headroom under 120/min). */
  rateLimitPerMinute?: number;
  /** Optional fetch impl (defaults to globalThis.fetch). */
  fetchImpl?: typeof fetch;
}

export class McpError extends Error {
  constructor(
    message: string,
    public readonly code: number | undefined,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = 'McpError';
  }
}

export class FlywheelMcpClient {
  private readonly url: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private requestId = 0;

  // Token bucket: refill `capacity` tokens per 60s window.
  private readonly capacity: number;
  private tokens: number;
  private lastRefill = Date.now();

  constructor(opts: McpClientOptions = {}) {
    this.url = opts.url ?? FLYWHEEL_MCP_URL;
    this.token = opts.token ?? FlywheelMcpClient.resolveToken();
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.capacity = opts.rateLimitPerMinute ?? 110;
    this.tokens = this.capacity;
  }

  static resolveToken(): string {
    const path = join(homedir(), '.claude.json');
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (e) {
      throw new Error(
        `Cannot read ${path}; set 'flywheel.token' in VS Code settings or place a Bearer token in ~/.claude.json under mcpServers.flywheel.headers.Authorization`,
      );
    }
    const parsed = JSON.parse(raw) as {
      mcpServers?: Record<string, { headers?: Record<string, string> }>;
    };
    const auth = parsed.mcpServers?.['flywheel']?.headers?.['Authorization'];
    if (!auth) {
      throw new Error(
        '~/.claude.json has no mcpServers.flywheel.headers.Authorization. Configure flywheel.token in VS Code settings.',
      );
    }
    return auth.replace(/^Bearer\s+/i, '').trim();
  }

  /** Call an MCP tool. Throws McpError on JSON-RPC error or non-2xx HTTP. */
  async callTool<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    await this.acquireToken();

    const body = {
      jsonrpc: '2.0' as const,
      id: ++this.requestId,
      method: 'tools/call',
      params: { name, arguments: args },
    };

    const res = await this.fetchImpl(this.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new McpError(
        `HTTP ${res.status} from Flywheel MCP (${name}): ${text.slice(0, 500)}`,
        res.status,
      );
    }

    const json = (await res.json()) as {
      result?: {
        content?: Array<{ type: string; text?: string }>;
        structuredContent?: T;
        isError?: boolean;
      };
      error?: { code: number; message: string; data?: unknown };
    };

    if (json.error) {
      throw new McpError(json.error.message, json.error.code, json.error.data);
    }

    // MCP `isError: true` carries the failure detail in `content[*].text`.
    if (json.result?.isError) {
      const textPart = json.result.content?.find((c) => c.type === 'text');
      throw new McpError(
        textPart?.text ?? `Tool ${name} returned isError without text`,
        undefined,
      );
    }

    // Prefer structuredContent (typed), then fall back to parsing text content.
    if (json.result?.structuredContent !== undefined) {
      return json.result.structuredContent;
    }
    const textPart = json.result?.content?.find((c) => c.type === 'text');
    if (textPart?.text !== undefined) {
      const txt = textPart.text;
      try {
        return JSON.parse(txt) as T;
      } catch {
        return txt as unknown as T;
      }
    }
    return undefined as unknown as T;
  }

  private async acquireToken(): Promise<void> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    // Wait until a token is available (worst case ~600ms at 110/min).
    const waitMs = Math.ceil((60_000 / this.capacity) * (1 - this.tokens));
    await new Promise((r) => setTimeout(r, waitMs));
    this.refill();
    this.tokens = Math.max(0, this.tokens - 1);
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;
    const refilled = (elapsed / 60_000) * this.capacity;
    this.tokens = Math.min(this.capacity, this.tokens + refilled);
    this.lastRefill = now;
  }
}
