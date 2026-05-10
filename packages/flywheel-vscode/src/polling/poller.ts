/**
 * Generic polling scheduler with pause/resume + exponential backoff on error.
 *
 * Used by GraphPanel to call getNodeTree(rootNodeId) every 2s, run a diff,
 * and forward patch ops to the webview.
 *
 * Interface is callback-based: callers provide an async tick function. The
 * poller never overlaps ticks (waits for the previous one to settle).
 */

export interface PollerOptions {
  intervalMs: number;
  /** Max backoff on consecutive failures (default 30s). */
  maxBackoffMs?: number;
}

export class Poller {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private inFlight = false;
  private failures = 0;
  private readonly maxBackoffMs: number;

  constructor(
    private readonly tick: () => Promise<void>,
    private readonly opts: PollerOptions,
  ) {
    this.maxBackoffMs = opts.maxBackoffMs ?? 30_000;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  pause(): void {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  resume(): void {
    if (this.running) return;
    this.start();
  }

  dispose(): void {
    this.pause();
  }

  private schedule(delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => void this.runOnce(), delayMs);
  }

  private async runOnce(): Promise<void> {
    if (!this.running) return;
    if (this.inFlight) {
      // Should not happen — we only schedule after the prior tick resolves —
      // but guard anyway.
      this.schedule(this.opts.intervalMs);
      return;
    }
    this.inFlight = true;
    try {
      await this.tick();
      this.failures = 0;
      this.schedule(this.opts.intervalMs);
    } catch (err) {
      this.failures += 1;
      const backoff = Math.min(
        this.opts.intervalMs * 2 ** Math.min(this.failures, 6),
        this.maxBackoffMs,
      );
      console.warn(`[flywheel poller] tick failed (${this.failures}x), backing off ${backoff}ms:`, err);
      this.schedule(backoff);
    } finally {
      this.inFlight = false;
    }
  }
}
