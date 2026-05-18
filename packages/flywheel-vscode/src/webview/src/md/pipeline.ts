/**
 * Obsidian-flavoured markdown pipeline (unified).
 *
 * Pipeline:
 *   remark-parse → remark-gfm → remark-math → remark-wiki-link
 *     → mdast walker (image embeds, highlight, internal-link rewrite)
 *     → remark-rehype → rehype-callouts (Obsidian theme) → rehype-katex
 *     → rehype-stringify
 *
 * Why client-side: the webview already needs to highlight/link nodes anyway,
 * and pulling the AST lets us resolve `[[wikilinks]]` against the in-store
 * graph state with no host round-trip.
 *
 * Pre-processing:
 *   - `==text==` → `<mark>text</mark>` (regex on the raw source).
 *   - `![[image.png]]` (resolved by remark-wiki-link to an internal-link)
 *     → `<img>` whose src is looked up in `imageMap` (artifact title → URL).
 *
 * Inputs:
 *   - `md`: raw markdown.
 *   - `imageMap`: artifact `title` (e.g. `loss-curve.png`) → CSP-safe URL.
 *   - `slugResolver`: maps wikilink permalink (slug or title) to a node_id,
 *     or null if unknown. Internal links to known nodes become a VS Code
 *     `command:flywheel.openNodeById` URI (allowed via `enableCommandUris`).
 */

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkRehype from 'remark-rehype';
import rehypeKatex from 'rehype-katex';
import rehypeCallouts from 'rehype-callouts';
import rehypeStringify from 'rehype-stringify';
import remarkWikiLink from 'remark-wiki-link';
import type { Root, RootContent } from 'mdast';

export type SlugResolver = (slug: string) => string | null;

export interface RenderOptions {
  imageMap: Record<string, string>;
  slugResolver: SlugResolver;
  /**
   * Optional sink: each image artifact title (case-insensitive lookup key)
   * resolved against `imageMap` is added here. Callers use this to render a
   * "Figures" gallery for un-referenced image artifacts without duplicating
   * what already appears inline.
   */
  onImageResolved?: (title: string) => void;
}

const HIGHLIGHT_RE = /==(.+?)==/g;

function preprocess(md: string): string {
  // Replace ==highlight== with <mark>…</mark>; this leverages allowDangerousHtml=false-friendly
  // path because we only emit raw HTML when the user wrote highlight markup.
  return md.replace(HIGHLIGHT_RE, (_m, inner: string) => `<mark>${inner}</mark>`);
}

interface WikiLinkNode {
  type: 'wikiLink';
  value: string; // permalink target (slug)
  data?: {
    alias?: string;
    permalink?: string;
    exists?: boolean;
    hName?: string;
    hProperties?: Record<string, unknown>;
    hChildren?: unknown[];
  };
}

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|svg|webp|avif)$/i;

/**
 * Resolve a bare filename or a `./foo.png` / `attachments/foo.png` path
 * against the imageMap. Returns the artifact URL on hit, or null.
 *
 * Matches:
 *   - exact title hit (e.g. `loss-curve.png`)
 *   - case-insensitive fallback (titles in Flywheel can be edited later)
 *   - basename hit for paths like `figs/loss-curve.png`
 *
 * Skips absolute URLs (http:, data:, vscode-webview:) so existing
 * well-formed image links pass through untouched.
 */
function resolveImageUrl(
  rawUrl: string,
  imageMap: Record<string, string>,
): { url: string; matchedTitle: string } | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(rawUrl)) return null; // already absolute
  const stripped = rawUrl.replace(/^\.\//, '');
  const candidates = [stripped, stripped.split('/').pop() ?? stripped];
  for (const cand of candidates) {
    if (imageMap[cand]) return { url: imageMap[cand]!, matchedTitle: cand };
    // Case-insensitive fallback.
    const lcKey = cand.toLowerCase();
    for (const k of Object.keys(imageMap)) {
      if (k.toLowerCase() === lcKey) return { url: imageMap[k]!, matchedTitle: k };
    }
  }
  return null;
}

/** Walk mdast and rewrite (a) wikiLink nodes and (b) plain image nodes. */
function rewriteWikilinks(opts: RenderOptions) {
  return (tree: Root): void => {
    const walk = (nodes: RootContent[]): void => {
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i] as unknown;
        const typed = n as { type?: string };

        // Obsidian-flavoured `![[file.png]]` / `[[slug|alias]]`.
        if (typed.type === 'wikiLink') {
          const link = n as unknown as WikiLinkNode;
          const target = link.value;
          const alias = link.data?.alias ?? target;

          if (IMAGE_EXT_RE.test(target)) {
            const hit = resolveImageUrl(target, opts.imageMap);
            if (hit) {
              opts.onImageResolved?.(hit.matchedTitle);
              nodes[i] = {
                type: 'image',
                url: hit.url,
                alt: alias,
              } as unknown as RootContent;
              continue;
            }
            // Fall through: render as inert text so the user sees the missing-image clue.
            nodes[i] = { type: 'text', value: `![[${target}]]` } as unknown as RootContent;
            continue;
          }

          const nodeId = opts.slugResolver(target);
          const href = nodeId
            ? `command:flywheel.openNodeById?${encodeURIComponent(JSON.stringify([nodeId]))}`
            : '#';
          nodes[i] = {
            type: 'link',
            url: href,
            title: nodeId ? null : 'unresolved wikilink',
            children: [{ type: 'text', value: alias }],
          } as unknown as RootContent;
          continue;
        }

        // Standard markdown `![alt](file.png)`. If the url is a bare artifact
        // title (or a relative path matching one), rewrite to the CSP-safe URL.
        if (typed.type === 'image') {
          const img = n as { url?: string; alt?: string };
          if (img.url) {
            const hit = resolveImageUrl(img.url, opts.imageMap);
            if (hit) {
              opts.onImageResolved?.(hit.matchedTitle);
              img.url = hit.url;
            }
          }
          // No recursion needed — image nodes have no relevant children.
          continue;
        }

        const children = (n as { children?: RootContent[] }).children;
        if (Array.isArray(children)) walk(children);
      }
    };
    walk(tree.children);
  };
}

export function renderObsidianMd(md: string, opts: RenderOptions): string {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath)
    .use(remarkWikiLink, {
      aliasDivider: '|',
      hrefTemplate: (perm: string) => perm,
    })
    .use(rewriteWikilinks, opts)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeCallouts, { theme: 'obsidian' })
    .use(rehypeKatex)
    .use(rehypeStringify, { allowDangerousHtml: true });

  const file = processor.processSync(preprocess(md));
  return String(file.value);
}
