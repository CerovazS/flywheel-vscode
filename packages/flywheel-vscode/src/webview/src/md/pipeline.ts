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

/** Walk mdast and rewrite wikiLink nodes for image embeds and node links. */
function rewriteWikilinks(opts: RenderOptions) {
  return (tree: Root): void => {
    const walk = (nodes: RootContent[]): void => {
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i] as unknown;
        if ((n as { type?: string }).type === 'wikiLink') {
          const link = n as unknown as WikiLinkNode;
          const target = link.value;
          const alias = link.data?.alias ?? target;

          if (IMAGE_EXT_RE.test(target)) {
            const url = opts.imageMap[target];
            if (url) {
              nodes[i] = {
                type: 'image',
                url,
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
