import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Icon } from "./Icon";
import { renderMarkdown } from "../lib/markdown";

// How long after the last keystroke the panel saves. Long enough that a fast
// typist is not firing a request per word, short enough that a glance away and
// back finds the work already kept.
const SAVE_DEBOUNCE = 700;

// The kinds that have something to preview. A code canvas is only ever the
// editor -- there is nothing to render it into -- so it never shows the toggle.
const PREVIEWABLE = new Set(["markdown", "html"]);

/**
 * The side panel: the document the model is building with the reader.
 *
 * One canvas is shown at a time, chosen from the switcher when a conversation
 * has more than one. The body is a plain editor the reader can type into; a
 * markdown or html canvas can be flipped to a preview. Edits save themselves
 * on a debounce, so there is no save button to forget.
 *
 * The model's own writes arrive from outside as a replaced `active`, so the
 * editor re-syncs whenever the active canvas or its server timestamp changes --
 * which is a model rewrite, not the reader's own typing (that only bumps the
 * timestamp once the save lands, by which point the text already matches).
 */
export function Canvas({
  canvases,
  active,
  onSelect,
  onClose,
  onSave,
  onCreate,
  onDelete,
}) {
  const [draft, setDraft] = useState(active?.content ?? "");
  const [titleDraft, setTitleDraft] = useState(active?.title ?? "");
  // Open on the rendered view for a page or a written document that already
  // has content -- you want to see it, not read its source. A blank or code
  // canvas opens in the editor, since there is nothing to render.
  const [mode, setMode] = useState(() =>
    active && PREVIEWABLE.has(active.kind) && (active.content || "").trim()
      ? "preview"
      : "edit",
  );
  const [copied, setCopied] = useState(false);
  const timer = useRef(0);

  const activeId = active?.id || null;
  const stamp = active?.updated_at;

  // Re-sync the editor to the canvas when it changes underneath -- a switch to
  // another canvas, or a rewrite the model just streamed in. Keyed on the
  // server timestamp so the reader's own keystrokes (which do not move it until
  // the save resolves) never yank the cursor back.
  useEffect(() => {
    setDraft(active?.content ?? "");
    setTitleDraft(active?.title ?? "");
  }, [activeId, stamp]); // eslint-disable-line react-hooks/exhaustive-deps

  // When a *different* canvas is opened, default to its rendered view if it has
  // one and something to show. Keyed on identity only, not the timestamp, so an
  // autosave while the reader is editing does not yank them back to preview
  // every keystroke -- only opening or switching canvases sets the view.
  useEffect(() => {
    const previewable = active && PREVIEWABLE.has(active.kind);
    setMode(previewable && (active.content || "").trim() ? "preview" : "edit");
  }, [activeId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => clearTimeout(timer.current), []);

  const scheduleSave = useCallback(
    (patch) => {
      clearTimeout(timer.current);
      const id = activeId;
      timer.current = setTimeout(() => {
        if (id) onSave(id, patch).catch(() => {});
      }, SAVE_DEBOUNCE);
    },
    [activeId, onSave],
  );

  const onBody = useCallback(
    (event) => {
      const value = event.target.value;
      setDraft(value);
      scheduleSave({ content: value });
    },
    [scheduleSave],
  );

  const onTitle = useCallback(
    (event) => {
      const value = event.target.value;
      setTitleDraft(value);
      if (value.trim()) scheduleSave({ title: value.trim() });
    },
    [scheduleSave],
  );

  const copy = useCallback(() => {
    navigator.clipboard?.writeText(draft).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      },
      () => {},
    );
  }, [draft]);

  const previewHtml = useMemo(
    () =>
      active?.kind === "markdown" && mode === "preview"
        ? { __html: renderMarkdown(draft) }
        : null,
    [active?.kind, mode, draft],
  );

  const canPreview = active && PREVIEWABLE.has(active.kind);
  const mono = active && (active.kind === "code" || active.kind === "html");

  return (
    <aside className="canvas" aria-label="Canvas">
      <header className="canvas-head">
        {canvases.length > 1 ? (
          <select
            className="canvas-switch"
            aria-label="Which canvas"
            value={activeId || ""}
            onChange={(event) => onSelect(event.target.value)}
          >
            {canvases.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
        ) : active ? (
          <input
            className="canvas-title-input"
            value={titleDraft}
            aria-label="Canvas title"
            onChange={onTitle}
            spellCheck={false}
          />
        ) : (
          <span className="canvas-title-input" data-empty>
            No canvas
          </span>
        )}

        {active ? (
          <span className="canvas-kind mi">
            {active.kind === "code" && active.language
              ? active.language
              : active.kind}
          </span>
        ) : null}

        <div className="spacer" />

        {canPreview ? (
          <div className="canvas-modes" role="tablist" aria-label="View">
            <button
              type="button"
              className="canvas-mode"
              data-on={mode === "edit" ? "" : undefined}
              onClick={() => setMode("edit")}
            >
              Edit
            </button>
            <button
              type="button"
              className="canvas-mode"
              data-on={mode === "preview" ? "" : undefined}
              onClick={() => setMode("preview")}
            >
              Preview
            </button>
          </div>
        ) : null}

        <button
          type="button"
          className="icon-btn"
          aria-label="New canvas"
          title="New canvas"
          onClick={() => onCreate().catch(() => {})}
        >
          <Icon name="plus" />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label="Close canvas"
          title="Close"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </header>

      {active ? (
        <>
          <div className="canvas-body">
            {previewHtml ? (
              <div className="body canvas-preview" dangerouslySetInnerHTML={previewHtml} />
            ) : active.kind === "html" && mode === "preview" ? (
              // Locked down: no scripts, no same-origin, no forms. A preview is
              // for looking at the page's shape, not for running it.
              <iframe
                className="canvas-preview-frame"
                sandbox=""
                title="HTML preview"
                srcDoc={draft}
              />
            ) : (
              <textarea
                className="canvas-editor"
                data-mono={mono ? "" : undefined}
                value={draft}
                onChange={onBody}
                spellCheck={active.kind === "markdown"}
                placeholder="Empty. Type here, or ask for it to be written."
              />
            )}
          </div>

          <footer className="canvas-foot">
            <button type="button" className="canvas-foot-btn" onClick={copy}>
              {copied ? "Copied" : "Copy"}
            </button>
            <div className="spacer" />
            <button
              type="button"
              className="canvas-foot-btn"
              data-danger=""
              onClick={() => onDelete(activeId).catch(() => {})}
            >
              Delete
            </button>
          </footer>
        </>
      ) : (
        <div className="canvas-empty">
          <p>No canvas in this conversation yet.</p>
          <button
            type="button"
            className="canvas-foot-btn"
            onClick={() => onCreate().catch(() => {})}
          >
            New canvas
          </button>
          <p className="mi" data-soft>
            Or ask the assistant to draft one — it opens here.
          </p>
        </div>
      )}
    </aside>
  );
}
