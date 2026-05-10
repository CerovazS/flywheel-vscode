/**
 * Color helpers for the Cosmograph buffer encoding + label CSS.
 *
 * Cosmograph wants colors as Float32Array in flat RGBA, each 0-255.
 * We map node tag.bg_color (hex) to that format. Nodes without a tag get a
 * deterministic palette color hashed off their id, so the graph reads as
 * "many distinct categories" rather than a sea of grey.
 */

export type Rgba = [number, number, number, number];

const FALLBACK_PALETTE: Rgba[] = [
  [88, 166, 255, 230],   // azure
  [255, 169, 77, 230],   // amber
  [126, 211, 33, 230],   // green
  [228, 85, 153, 230],   // pink
  [180, 130, 255, 230],  // violet
  [83, 223, 221, 230],   // teal
  [255, 110, 110, 230],  // coral
  [255, 211, 70, 230],   // yellow
  [120, 200, 255, 230],  // sky
  [200, 145, 92, 230],   // copper
];

const DEFAULT: Rgba = [127, 127, 140, 220];

function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function hexToRgba(hex: string, alpha = 230): Rgba {
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length !== 6) return DEFAULT;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  if ([r, g, b].some(Number.isNaN)) return DEFAULT;
  return [r, g, b, alpha];
}

export function nodeColor(tagBg?: string | null, fallbackKey?: string | null): Rgba {
  if (tagBg) return hexToRgba(tagBg);
  if (fallbackKey) {
    const idx = hashString(fallbackKey) % FALLBACK_PALETTE.length;
    return FALLBACK_PALETTE[idx]!;
  }
  return DEFAULT;
}

/** CSS rgb() string from an Rgba; used for HTML overlay accents. */
export function rgbaToCss(c: Rgba, alpha?: number): string {
  const a = alpha ?? c[3] / 255;
  return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`;
}
