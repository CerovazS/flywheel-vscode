/**
 * Heading-aware markdown chunker, port of obsidian-search/chunker.py.
 *
 * Behaviour preserved 1:1 so embeddings produced here are interchangeable
 * with those produced by the Python tool (same Qwen3-0.6B, same chunks).
 *
 * Differences:
 *   - The unit of indexing is a Flywheel node, not a vault file. The "file"
 *     concept maps to (node_id, slug). The prefix uses the slug, not a path.
 *   - We strip frontmatter parsing — Flywheel nodes don't carry YAML.
 */

import { createHash } from 'node:crypto';

export interface Chunk {
  chunk_id: string;
  node_id: string;
  node_slug: string;
  section: string | null;
  chunk_index: number;
  content: string;
}

const HEADING_RE = /^(#{1,6})\s+(.+)$/gm;
const WIKILINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
const IMAGE_EMBED_RE = /!\[\[.*?\]\]/g;
const HR_RE = /^---+\s*$/gm;

function hashChunkId(nodeId: string, section: string, ord: number, idx: number): string {
  const key = `${nodeId}::${section}::${ord}::${idx}`;
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

function cleanText(text: string): string {
  return text
    .replace(IMAGE_EMBED_RE, '')
    .replace(HR_RE, '')
    .replace(WIKILINK_RE, (_m, target: string, alias: string | undefined) => alias ?? target)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitByHeadings(body: string): Array<{ heading: string; content: string }> {
  const out: Array<{ heading: string; content: string }> = [];
  HEADING_RE.lastIndex = 0;
  const positions: Array<{ start: number; line: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = HEADING_RE.exec(body)) !== null) {
    positions.push({ start: m.index, line: m[0] });
  }
  if (positions.length === 0) {
    const cleaned = cleanText(body);
    if (cleaned) out.push({ heading: 'Introduction', content: cleaned });
    return out;
  }
  const pre = body.slice(0, positions[0]!.start);
  const preClean = cleanText(pre);
  if (preClean) out.push({ heading: 'Introduction', content: preClean });
  for (let i = 0; i < positions.length; i++) {
    const { start, line } = positions[i]!;
    const end = i + 1 < positions.length ? positions[i + 1]!.start : body.length;
    const heading = line.replace(/^#+\s+/, '').trim();
    const content = body.slice(start + line.length, end);
    const cleaned = cleanText(content);
    if (cleaned) out.push({ heading, content: cleaned });
  }
  return out;
}

function splitLongSection(text: string, maxChars: number, overlapChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const paragraphs = text.split('\n\n');
  const chunks: string[] = [];
  let current: string[] = [];
  let currentLen = 0;
  for (const para of paragraphs) {
    const paraLen = para.length + 2;
    if (current.length > 0 && currentLen + paraLen > maxChars) {
      chunks.push(current.join('\n\n'));
      const overlap: string[] = [];
      let olen = 0;
      for (let i = current.length - 1; i >= 0; i--) {
        if (olen + current[i]!.length > overlapChars) break;
        overlap.unshift(current[i]!);
        olen += current[i]!.length;
      }
      current = overlap;
      currentLen = olen;
    }
    current.push(para);
    currentLen += paraLen;
  }
  if (current.length > 0) chunks.push(current.join('\n\n'));
  return chunks;
}

export interface ChunkInput {
  node_id: string;
  node_slug: string;
  /** Markdown body (e.g. node.content). */
  text: string;
}

export function chunkNode(
  input: ChunkInput,
  maxChars = 2000,
  overlapChars = 256,
): Chunk[] {
  const sections = splitByHeadings(input.text);
  const out: Chunk[] = [];
  for (let secOrd = 0; secOrd < sections.length; secOrd++) {
    const { heading, content } = sections[secOrd]!;
    const prefix = `Node: ${input.node_slug} | Section: ${heading}\n\n`;
    const subs = splitLongSection(content, maxChars, overlapChars);
    for (let idx = 0; idx < subs.length; idx++) {
      out.push({
        chunk_id: hashChunkId(input.node_id, heading, secOrd, idx),
        node_id: input.node_id,
        node_slug: input.node_slug,
        section: heading,
        chunk_index: idx,
        content: prefix + subs[idx]!,
      });
    }
  }
  return out;
}
