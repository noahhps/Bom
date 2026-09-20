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

// Strip a single wrapping code fence, which a model often puts around canvas
// content (```html … ```) even when asked not to. The editor keeps the raw
// text; only the preview renders the inside.
function stripFence(text) {
  const match = String(text || "").trim().match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
  return match ? match[1] : String(text ?? "");
}

// Whether content is really HTML, however it was stored. Mirrors the server's
// rescue so a page renders even against an older server, one that saved it as
// markdown, or a fenced block. Conservative: a full document, or a fragment
// that opens with a structural tag and closes one.
function looksLikeHtml(text) {
  const t = stripFence(text).trim();
  if (!t) return false;
  if (/<!doctype\s+html|<html[\s>]/i.test(t)) return true;
  return (
    t.startsWith("<") &&
    /<(?:body|head|section|article|main|div|table|ul|ol|form|style|script|h[1-6]|p)[\s>]/i.test(t) &&
    t.includes("</")
  );
}

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
  resizable = false,
  width,
  onResizeStart,
  onResizeKey,
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
  // Whether the HTML preview runs JavaScript. On by default so an interactive
  // page or a JS slideshow just works; the iframe is sandboxed to an opaque
  // origin (allow-scripts, never allow-same-origin), so scripts can render but
  // cannot reach Courier's page, storage, cookies or token. Toggle off for a
  // locked, static view of a page you have not read.
  const [runScripts, setRunScripts] = useState(true);
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

  // HTML regardless of how it was labelled: an explicit html canvas, or a
  // markdown one whose content is plainly a page (the common case when the
  // model forgets kind or wraps it in a fence). Code stays code -- an explicit
  // code kind means the user wants to read the source.
  const isHtml =
    active && (active.kind === "html" || (active.kind === "markdown" && looksLikeHtml(draft)));

  // Markdown preview only when it is not really HTML -- otherwise the renderer
  // would escape the tags and show the source, which is the bug this fixes.
  const previewHtml = useMemo(
    () =>
      active && mode === "preview" && !isHtml && active.kind === "markdown"
        ? { __html: renderMarkdown(draft) }
        : null,
    [active, isHtml, mode, draft],
  );

  const canPreview = active && (PREVIEWABLE.has(active.kind) || isHtml);
  const mono = active && (active.kind === "code" || isHtml);

  return (
    <aside className="canvas" aria-label="Canvas">
      {/* The panel's inner edge, as a drag handle. It is docked right, so this
          grows leftwards -- see useCanvasWidth. Desktop only: below 900px the
          canvas is a full overlay and there is no width to choose. */}
      {resizable ? (
        <div
          className="canvas-resize"
          role="separator"
          aria-orientation="vertical"
          aria-label="Canvas width"
          aria-valuenow={width}
          aria-valuemin={320}
          aria-valuemax={900}
          tabIndex={0}
          onPointerDown={onResizeStart}
          onKeyDown={onResizeKey}
          // Double-click restores the drawn width, which is otherwise only
          // reachable by dragging back to a number nobody remembers.
          onDoubleClick={() => onResizeKey({ key: "Reset", preventDefault() {} })}
        >
          <i />
        </div>
      ) : null}

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

        {/* Scripts on/off, only while previewing an HTML page. Its own control
            because running the page's JavaScript is a choice the reader should
            see -- isolated though it is. */}
        {isHtml && mode === "preview" ? (
          <button
            type="button"
            className="canvas-mode canvas-scripts"
            data-on={runScripts ? "" : undefined}
            aria-pressed={runScripts}
            title={
              runScripts
                ? "Scripts run (isolated from Courier). Click for a static view."
                : "Scripts off. Click to run the page's JavaScript."
            }
            onClick={() => setRunScripts((was) => !was)}
          >
            Scripts
          </button>
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
            ) : isHtml && mode === "preview" ? (
              // Sandboxed to an opaque origin: with `allow-scripts` the page's
              // JavaScript runs, but WITHOUT `allow-same-origin` it cannot reach
              // Courier -- no access to the parent DOM, cookies, localStorage or
              // the bearer token, and any fetch goes out cross-origin without
              // the app's credentials. Never add allow-same-origin here; the two
              // together let framed content drop its own sandbox. `key` remounts
              // the frame when scripts are toggled so they actually re-run. The
              // fence is stripped so a model-wrapped ```html block renders.
              <iframe
                key={runScripts ? "js" : "static"}
                className="canvas-preview-frame"
                sandbox={runScripts ? "allow-scripts" : ""}
                title="HTML preview"
                srcDoc={stripFence(draft)}
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
