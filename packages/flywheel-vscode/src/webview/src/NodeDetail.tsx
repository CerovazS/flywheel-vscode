/**
 * Node detail panel: renders the node's markdown body via the Obsidian
 * pipeline, with an inline edit mode (textarea + Save). Saving sends a
 * `saveNodeContent` Intent to the host, which calls the MCP update tool;
 * the result comes back as a `saveResult` Fact.
 */

import { useEffect, useMemo, useState } from 'react';
import type { FlywheelArtifact, FlywheelNode } from 'flywheel-core/client';
import type { Fact } from 'flywheel-core/protocol';
import { onMessage, send } from './vscode.js';
import { renderObsidianMd } from './md/pipeline.js';

interface NodeDetailFact {
  kind: 'nodeDetail';
  node: FlywheelNode;
  artifacts?: FlywheelArtifact[];
  slugIndex?: Record<string, string>;
}

type SaveStatus =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'error'; message: string };

export function NodeDetail({ initNodeId }: { initNodeId: string }) {
  const [node, setNode] = useState<FlywheelNode | null>(null);
  const [artifacts, setArtifacts] = useState<FlywheelArtifact[]>([]);
  const [slugIndex, setSlugIndex] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string>('');
  const [saveStatus, setSaveStatus] = useState<SaveStatus>({ kind: 'idle' });

  useEffect(() => {
    const off = onMessage((fact: Fact) => {
      const f = fact as Fact | NodeDetailFact;
      if ((f as Fact).kind === 'nodeDetail') {
        const nd = f as NodeDetailFact;
        setNode(nd.node);
        setArtifacts(nd.artifacts ?? []);
        setSlugIndex(nd.slugIndex ?? {});
        setError(null);
        // Refresh draft when not actively editing — avoids overwriting the
        // user's in-progress changes when polling refreshes the node.
        setDraft((prev) => (editing ? prev : nd.node.content ?? ''));
      } else if ((f as Fact).kind === 'error') {
        setError((f as { kind: 'error'; message: string }).message);
      } else if ((f as Fact).kind === 'saveResult') {
        const sr = f as { kind: 'saveResult'; ok: boolean; message?: string };
        if (sr.ok) {
          setSaveStatus({ kind: 'saved' });
          setEditing(false);
          // Auto-clear the success indicator after a moment.
          window.setTimeout(() => setSaveStatus({ kind: 'idle' }), 2500);
        } else {
          setSaveStatus({
            kind: 'error',
            message: sr.message ?? 'Save failed',
          });
        }
      }
    });
    send({ kind: 'requestNodeDetail', nodeId: initNodeId });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initNodeId]);

  const { html, unreferencedImages } = useMemo(() => {
    if (!node) return { html: '', unreferencedImages: [] as FlywheelArtifact[] };
    const imageMap: Record<string, string> = {};
    const imageArtifacts: FlywheelArtifact[] = [];
    for (const a of artifacts) {
      if (a.artifact_type === 'image' && a.storage_url) {
        imageMap[a.title] = a.storage_url;
        imageArtifacts.push(a);
      }
    }
    const referenced = new Set<string>();
    let rendered: string;
    try {
      rendered = renderObsidianMd(node.content ?? '', {
        imageMap,
        slugResolver: (slug) => slugIndex[slug] ?? null,
        onImageResolved: (title) => referenced.add(title),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      rendered = `<pre style="color:#ff7b7b">render error: ${msg}</pre>`;
    }
    const leftover = imageArtifacts.filter((a) => !referenced.has(a.title));
    return { html: rendered, unreferencedImages: leftover };
  }, [node, artifacts, slugIndex]);

  if (error) {
    return (
      <div style={{ padding: 24, color: '#ff7b7b' }}>
        <h3>Error</h3>
        <p>{error}</p>
      </div>
    );
  }

  if (!node) {
    return <div style={{ padding: 24, opacity: 0.6 }}>Loading {initNodeId}…</div>;
  }

  const onEdit = (): void => {
    setDraft(node.content ?? '');
    setSaveStatus({ kind: 'idle' });
    setEditing(true);
  };

  const onCancel = (): void => {
    setEditing(false);
    setDraft(node.content ?? '');
    setSaveStatus({ kind: 'idle' });
  };

  const onSave = (): void => {
    setSaveStatus({ kind: 'saving' });
    send({ kind: 'saveNodeContent', nodeId: node.node_id, content: draft });
  };

  const hasChanges = draft !== (node.content ?? '');

  return (
    <div className="flywheel-node-detail">
      <header
        style={{
          padding: '16px 24px',
          borderBottom: '1px solid var(--vscode-panel-border, #2e2e2e)',
        }}
      >
        <h1 style={{ margin: 0, fontSize: 22 }}>{node.title ?? '(untitled)'}</h1>
        <div style={{ marginTop: 6, opacity: 0.65, fontSize: 12 }}>
          {node.slug_name ?? (node.node_id ?? '').slice(0, 8) ?? 'node'}
          {node.revision !== undefined ? ` · rev ${node.revision}` : ''}
          {node.visibility ? ` · ${node.visibility}` : ''}
          {node.repo_context?.repo_url ? ` · ${node.repo_context.repo_url}` : ''}
        </div>
        <div className="flywheel-node-detail__toolbar">
          {!editing ? (
            <button type="button" className="flywheel-btn" onClick={onEdit}>
              Edit
            </button>
          ) : (
            <>
              <button
                type="button"
                className="flywheel-btn"
                onClick={onSave}
                disabled={!hasChanges || saveStatus.kind === 'saving'}
              >
                {saveStatus.kind === 'saving' ? 'Saving…' : 'Save'}
              </button>
              <button
                type="button"
                className="flywheel-btn flywheel-btn--ghost"
                onClick={onCancel}
                disabled={saveStatus.kind === 'saving'}
              >
                Cancel
              </button>
            </>
          )}
          {saveStatus.kind === 'saved' ? (
            <span className="flywheel-edit-status">Saved</span>
          ) : null}
          {saveStatus.kind === 'error' ? (
            <span className="flywheel-edit-status flywheel-edit-status--error">
              {saveStatus.message}
            </span>
          ) : null}
        </div>
      </header>
      {editing ? (
        <div style={{ padding: '20px 28px', maxWidth: 980, margin: '0 auto' }}>
          <textarea
            className="flywheel-edit-textarea"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            autoFocus
          />
        </div>
      ) : (
        <>
          <article
            className="flywheel-md"
            style={{
              padding: '20px 28px',
              maxWidth: 880,
              margin: '0 auto',
              lineHeight: 1.55,
            }}
            dangerouslySetInnerHTML={{ __html: html }}
          />
          {unreferencedImages.length > 0 ? (
            <section
              className="flywheel-figures"
              style={{
                padding: '0 28px 28px',
                maxWidth: 880,
                margin: '0 auto',
              }}
            >
              <h2
                style={{
                  fontSize: 18,
                  marginTop: 8,
                  marginBottom: 12,
                  paddingTop: 16,
                  borderTop: '1px solid var(--vscode-panel-border, #2e2e2e)',
                }}
              >
                Figures
              </h2>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                {unreferencedImages.map((a) => (
                  <figure key={a.artifact_id} style={{ margin: 0 }}>
                    <img
                      src={a.storage_url ?? ''}
                      alt={a.title}
                      style={{
                        maxWidth: '100%',
                        height: 'auto',
                        borderRadius: 4,
                        display: 'block',
                      }}
                    />
                    <figcaption
                      style={{
                        marginTop: 6,
                        fontSize: 12,
                        opacity: 0.7,
                      }}
                    >
                      <strong>{a.title}</strong>
                      {a.note ? ` — ${a.note}` : ''}
                    </figcaption>
                  </figure>
                ))}
              </div>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
