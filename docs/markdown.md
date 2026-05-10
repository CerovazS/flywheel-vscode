# Markdown rendering

The node detail panel renders Obsidian-flavoured markdown. The pipeline is `unified` + `remark-gfm` + `remark-math` + `remark-wiki-link` + `rehype-callouts` + `rehype-katex`.

## Callouts

Use Obsidian-style blockquote callouts:

```markdown
> [!note] Optional title
> Body text. Renders as a tinted box with a coloured left bar.

> [!summary] Bottom line
> Use for top-level takeaways.

> [!tip] Recommendation
> Use for advice that's nice to have.

> [!important] Don't miss
> Use for things the reader must take with them.

> [!warning] Heads-up
> Use for non-fatal pitfalls.

> [!caution] Danger zone
> Use for things that can cause damage / data loss.

> [!example] Worked example
> Use to wrap a concrete walk-through.

> [!quote] — Author
> Use for citations.
```

Supported types: `note`, `info`, `todo`, `summary`, `abstract`, `tldr`, `tip`, `hint`, `important`, `success`, `check`, `done`, `question`, `help`, `faq`, `warning`, `attention`, `caution`, `failure`, `missing`, `fail`, `danger`, `error`, `bug`, `example`, `quote`, `cite`.

> [!note]
> Each type gets its own colour palette tuned for the dark VS Code surface (Obsidian's dark theme values).

## Highlights

```markdown
The result was ==40–50% faster== with no accuracy regression.
```

`==text==` becomes a `<mark>` element styled in amber.

## Math (KaTeX)

Inline math:

```markdown
The Gram matrix is $XX^\top$.
```

Block math:

```markdown
$$
L = \mathbb{E}_{x \sim p_\text{data}} \left[ \log p_\theta(x) \right]
$$
```

## Wikilinks

Bare wikilinks resolve against the loaded subgraph:

```markdown
See [[Muon]] for details.
See [[muon-orthogonalization|the Muon orthogonalization step]].
```

| Resolution | Result |
|---|---|
| Slug matches a node in the loaded subgraph | Internal link; clicking opens that node's detail panel |
| Slug doesn't match | Inert text styled like a link, with a `unresolved wikilink` tooltip |

## Image embeds

```markdown
![[loss-curve.png]]
```

If the node has an artifact with `title === "loss-curve.png"` and `artifact_type === "image"`, the image is rendered inline using its `storage_url`.

## Tables, code, and the rest

GFM tables, fenced code blocks, ordered/unordered lists, blockquotes, hr, and inline code all work as standard.

> [!tip]
> The rendered article uses VS Code theme variables (`--vscode-foreground`, `--vscode-textBlockQuote-background`, etc.) so it adapts to whatever theme you're using.

## Edit mode

Click **Edit** in the detail panel header to drop into a textarea with the raw markdown, then **Save** to publish back through the staged-edit protocol:

1. `flywheel_acquire_stage_lease` (with a generated session id)
2. `flywheel_commit_node` (sends the new `staged_payload`: title, content, summary, repo_context)
3. `flywheel_release_stage_lease` (best-effort cleanup)

> [!warning]
> If the commit fails (concurrent edit, expired lease, validation error), the original content is left untouched and an error message appears in the toolbar. Retry usually works.
