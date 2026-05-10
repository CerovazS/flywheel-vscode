/**
 * Deterministic static layout for the graph.
 *
 * Cosmograph's GPU simulation is great for live exploration but makes the view
 * "jolt" on first load. We pre-compute a stable layout in JS once per topology
 * change and pass it to Cosmograph with `disableSimulation: true` — so the
 * canvas never animates. Existing positions are reused for nodes that are
 * still alive, so a patch (add/remove a few nodes) doesn't reflow everything.
 *
 * Algorithm: Fruchterman–Reingold (O(n²) repulsion + edge attraction +
 * gravity), with a deterministic PRNG so the same graph always lays out the
 * same way. 250 iterations is enough to settle for a few hundred nodes.
 */

type LayoutEdge = readonly [number, number];

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export interface LayoutOptions {
  ids: string[];
  edges: LayoutEdge[];
  /** Positions to preserve from a prior layout, keyed by id. */
  prev?: Map<string, [number, number]>;
  /** Number of FR iterations. Default 250. */
  iterations?: number;
  /** World extent (controls the spread). Default scales with sqrt(n). */
  spread?: number;
}

/**
 * Compute a static 2D layout. Returns a Float32Array of [x1,y1,x2,y2,...].
 */
export function computeLayout(opts: LayoutOptions): Float32Array {
  const { ids, edges, prev, iterations = 250 } = opts;
  const n = ids.length;
  const out = new Float32Array(n * 2);
  if (n === 0) return out;

  // Seed the PRNG from the (sorted) ids so the layout is stable across runs.
  const seedKey = ids.slice().sort().join('|');
  const rand = mulberry32(hashString(seedKey));

  const spread = opts.spread ?? Math.max(40, Math.sqrt(n) * 18);

  // Initial positions: reuse prev where available, otherwise place on a
  // jittered circle (better than uniform random — fewer crossings to untangle).
  for (let i = 0; i < n; i++) {
    const id = ids[i]!;
    const p = prev?.get(id);
    if (p) {
      out[2 * i] = p[0];
      out[2 * i + 1] = p[1];
    } else {
      const angle = (i / Math.max(1, n)) * Math.PI * 2 + rand() * 0.5;
      const r = spread * (0.4 + rand() * 0.6);
      out[2 * i] = Math.cos(angle) * r;
      out[2 * i + 1] = Math.sin(angle) * r;
    }
  }

  if (n === 1) return out;

  // Ideal edge length
  const k = spread / Math.sqrt(n);
  const k2 = k * k;
  const forces = new Float32Array(n * 2);

  // Cooling schedule: max displacement per iter shrinks from `spread` to ~0.5.
  const tStart = spread * 0.3;
  const tEnd = 0.5;

  // Identify nodes that must NOT move (preserved from prev) only weakly —
  // we still let everyone settle slightly so newly-added nodes integrate.
  for (let iter = 0; iter < iterations; iter++) {
    forces.fill(0);

    // Repulsion (O(n²)) — fine up to ~1k nodes.
    for (let i = 0; i < n; i++) {
      const xi = out[2 * i]!;
      const yi = out[2 * i + 1]!;
      for (let j = i + 1; j < n; j++) {
        let dx = xi - out[2 * j]!;
        let dy = yi - out[2 * j + 1]!;
        let dist2 = dx * dx + dy * dy;
        if (dist2 < 0.0001) {
          // Co-incident — nudge apart deterministically.
          dx = (rand() - 0.5) * 0.1;
          dy = (rand() - 0.5) * 0.1;
          dist2 = dx * dx + dy * dy + 0.0001;
        }
        const f = k2 / dist2;
        const fx = dx * f;
        const fy = dy * f;
        forces[2 * i]! += fx;
        forces[2 * i + 1]! += fy;
        forces[2 * j]! -= fx;
        forces[2 * j + 1]! -= fy;
      }
    }

    // Attraction along edges (Hooke-like).
    for (const [s, t] of edges) {
      const dx = out[2 * s]! - out[2 * t]!;
      const dy = out[2 * s + 1]! - out[2 * t + 1]!;
      const dist = Math.sqrt(dx * dx + dy * dy) + 0.001;
      const f = (dist * dist) / k;
      const fx = (dx / dist) * f;
      const fy = (dy / dist) * f;
      forces[2 * s]! -= fx;
      forces[2 * s + 1]! -= fy;
      forces[2 * t]! += fx;
      forces[2 * t + 1]! += fy;
    }

    // Gentle gravity towards origin so disconnected components stay near.
    const gravity = 0.04;
    for (let i = 0; i < n; i++) {
      forces[2 * i]! -= out[2 * i]! * gravity;
      forces[2 * i + 1]! -= out[2 * i + 1]! * gravity;
    }

    // Apply with cooling.
    const t = tStart + (tEnd - tStart) * (iter / Math.max(1, iterations - 1));
    for (let i = 0; i < n; i++) {
      const fx = forces[2 * i]!;
      const fy = forces[2 * i + 1]!;
      const mag = Math.sqrt(fx * fx + fy * fy) + 0.0001;
      const lim = Math.min(mag, t);
      out[2 * i]! += (fx / mag) * lim;
      out[2 * i + 1]! += (fy / mag) * lim;
    }
  }

  return out;
}

/**
 * Compute a small radial layout for a 1-hop neighborhood: center at origin,
 * neighbors evenly distributed on a circle. Deterministic, instant, no FR
 * needed for these tiny graphs.
 */
export function computeRadialLayout(
  ids: string[],
  centerId: string,
  radius = 60,
): Float32Array {
  const n = ids.length;
  const out = new Float32Array(n * 2);
  const others: number[] = [];
  for (let i = 0; i < n; i++) {
    if (ids[i] === centerId) {
      out[2 * i] = 0;
      out[2 * i + 1] = 0;
    } else {
      others.push(i);
    }
  }
  const m = others.length;
  for (let k = 0; k < m; k++) {
    const idx = others[k]!;
    const angle = (k / Math.max(1, m)) * Math.PI * 2;
    out[2 * idx] = Math.cos(angle) * radius;
    out[2 * idx + 1] = Math.sin(angle) * radius;
  }
  return out;
}
