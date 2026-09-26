import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { DeckView, exportDeck } from "./DeckView";
import { Icon } from "./Icon";
import { SheetView } from "./SheetView";
import { fileStem, saveFile } from "../lib/files";
import { renderMarkdown } from "../lib/markdown";
import { blankSheet, parseSheet, serializeSheet, toCsv } from "../lib/sheet";
import { blankDeck, parseDeck, serializeDeck } from "../lib/slides";

// How long after the last keystroke the panel saves. Long enough that a fast
// typist is not firing a request per word, short enough that a glance away and
// back finds the work already kept.
const SAVE_DEBOUNCE = 700;

// The kinds that have something to preview. A code canvas is only ever the
// editor -- there is nothing to render it into -- so it never shows the toggle.
const PREVIEWABLE = new Set(["markdown", "html", "sheet", "slides"]);

// Stored as JSON and drawn by a component of their own. Their "preview" is the
// real working view -- the grid, the deck -- and the text editor is the
// escape hatch, labelled Source rather than Edit.
const STRUCTURED = new Set(["sheet", "slides"]);

/* What the + menu can make, in the order a person reaches for them. Each
   starts with something in it: an empty grid with a header, a deck with a
   title slide. A blank JSON box is not a sheet. */
export const CANVAS_KINDS = [
  { kind: "markdown", label: "Document", icon: "document", title: "Untitled document", content: () => "" },
  { kind: "sheet", label: "Sheet", icon: "sheet", title: "Untitled sheet", content: () => serializeSheet(blankSheet()) },
  { kind: "slides", label: "Slides", icon: "slides", title: "Untitled deck", content: () => serializeDeck(blankDeck()) },
  { kind: "html", label: "Web page", icon: "canvas", title: "Untitled page", content: () => "" },
  { kind: "code", label: "Code", icon: "code", title: "Untitled code", content: () => "" },
];

// How each kind is named in the header. "markdown" and "html" are how they are
// stored, not how anyone refers to them.
const KIND_LABEL = { markdown: "document", html: "page", sheet: "sheet", slides: "slides" };

// The file a code canvas saves as, by the language it says it is in.
const EXTENSIONS = {
  python: "py", javascript: "js", typescript: "ts", jsx: "jsx", tsx: "tsx", html: "html",
  css: "css", json: "json", rust: "rs", go: "go", java: "java", ruby: "rb", shell: "sh",
  bash: "sh", sql: "sql", c: "c", cpp: "cpp", swift: "swift", kotlin: "kt", yaml: "yml",
};

/* The kinds, as a row of choices -- in the + menu and on the empty panel. */
function KindChoices({ onPick }) {
  return CANVAS_KINDS.map((k) => (
    <button key={k.kind} type="button" className="canvas-kind-choice" onClick={() => onPick(k)}>
      <Icon name={k.icon} />
      {k.label}
    </button>
  ));
}

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
/* Which view a canvas opens on. A page or a written document that already has
   content opens rendered -- you want to see it, not read its source -- and a
   sheet or a deck always does, since its source is not where you work on it. A
   blank or code canvas opens in the editor. */
const openingMode = (canvas) =>
  canvas &&
  (STRUCTURED.has(canvas.kind) ||
    (PREVIEWABLE.has(canvas.kind) && (canvas.content || "").trim()))
    ? "preview"
    : "edit";

export function Canvas({
  canvases,
  active,
  onSelect,
  onClose,
  onSave,
  onCreate,
  onDelete,
  fallbackTheme = null,
  resizable = false,
  width,
  onResizeStart,
  onResizeKey,
}) {
  const [draft, setDraft] = useState(active?.content ?? "");
  const [titleDraft, setTitleDraft] = useState(active?.title ?? "");
  const [mode, setMode] = useState(() => openingMode(active));
  // The + menu of kinds to make.
  const [menu, setMenu] = useState(false);
  const menuNode = useRef(null);
  // The last body this panel sent to be saved. When the save lands the canvas
  // comes back with a new timestamp and that same body, and re-syncing to it
  // would throw away anything typed while the request was in flight -- so an
  // echo of our own save is recognised and skipped. A rewrite from the model
  // carries different content and still comes through.
  const sent = useRef(null);
  const [copied, setCopied] = useState(false);
  // Whether the HTML preview runs JavaScript. On by default so an interactive
  // page or a JS slideshow just works; the iframe is sandboxed to an opaque
  // origin (allow-scripts, never allow-same-origin), so scripts can render but
  // cannot reach Bom's page, storage, cookies or token. Toggle off for a
  // locked, static view of a page you have not read.
  const [runScripts, setRunScripts] = useState(true);
  const timer = useRef(0);

  const activeId = active?.id || null;
  const stamp = active?.updated_at;

  // Re-sync the editor to the canvas when it changes underneath -- a switch to
  // another canvas, or a rewrite the model just streamed in. Keyed on the
  // server timestamp so the reader's own keystrokes (which do not move it until
  // the save resolves) never yank the cursor back.
  const lastId = useRef(activeId);
  useEffect(() => {
    const switched = lastId.current !== activeId;
    lastId.current = activeId;
    if (!switched && sent.current !== null && active?.content === sent.current) {
      setTitleDraft(active?.title ?? "");
      return;
    }
    sent.current = null;
    setDraft(active?.content ?? "");
    setTitleDraft(active?.title ?? "");
  }, [activeId, stamp]); // eslint-disable-line react-hooks/exhaustive-deps

  // When a *different* canvas is opened, default to its rendered view if it has
  // one and something to show. Keyed on identity only, not the timestamp, so an
  // autosave while the reader is editing does not yank them back to preview
  // every keystroke -- only opening or switching canvases sets the view.
  useEffect(() => {
    setMode(openingMode(active));
  }, [activeId]); // eslint-disable-line react-hooks/exhaustive-deps

  // The + menu shuts on a click anywhere else, or Escape.
  useEffect(() => {
    if (!menu) return undefined;
    const away = (event) => {
      if (!menuNode.current?.contains(event.target)) setMenu(false);
    };
    const key = (event) => event.key === "Escape" && setMenu(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key);
    };
  }, [menu]);

  const make = useCallback(
    (choice) => {
      setMenu(false);
      onCreate({ title: choice.title, kind: choice.kind, content: choice.content() }).catch(() => {});
    },
    [onCreate],
  );

  useEffect(() => () => clearTimeout(timer.current), []);

  const scheduleSave = useCallback(
    (patch) => {
      clearTimeout(timer.current);
      const id = activeId;
      timer.current = setTimeout(() => {
        if (!id) return;
        if (patch.content !== undefined) sent.current = patch.content;
        onSave(id, patch).catch(() => {});
      }, SAVE_DEBOUNCE);
    },
    [activeId, onSave],
  );

  // A sheet or a deck edited in its own view. The view hands back the whole
  // new document; it is written into the draft (so Source shows it) and saved
  // on the same debounce as typing.
  const onStructured = useCallback(
    (data) => {
      const text = active?.kind === "sheet" ? serializeSheet(data) : serializeDeck(data);
      setDraft(text);
      scheduleSave({ content: text });
    },
    [active?.kind, scheduleSave],
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

  const kind = active?.kind;
  const sheet = useMemo(() => (kind === "sheet" ? parseSheet(draft) : null), [kind, draft]);
  const deck = useMemo(() => (kind === "slides" ? parseDeck(draft) : null), [kind, draft]);

  // A sheet copies as tab-separated values, which is what a spreadsheet
  // splits into cells on paste. Everything else copies as its text.
  const copy = useCallback(() => {
    const text = sheet ? toCsv(sheet, "\t") : draft;
    navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      },
      () => {},
    );
  }, [draft, sheet]);

  // Each kind leaves as the file someone would expect to open it with: a sheet
  // as CSV, a deck as a standalone HTML presentation, a page as .html.
  const download = useCallback(async () => {
    if (!active) return;
    const stem = fileStem(titleDraft || active.title);
    if (sheet) return saveFile(`${stem}.csv`, toCsv(sheet), "text/csv");
    if (deck) {
      const html = await exportDeck(deck, fallbackTheme, titleDraft || active.title);
      return saveFile(`${stem}.html`, html, "text/html");
    }
    if (active.kind === "html") return saveFile(`${stem}.html`, stripFence(draft), "text/html");
    if (active.kind === "code") {
      const ext = EXTENSIONS[(active.language || "").toLowerCase()] || "txt";
      return saveFile(`${stem}.${ext}`, draft);
    }
    return saveFile(`${stem}.md`, draft, "text/markdown");
  }, [active, deck, draft, fallbackTheme, sheet, titleDraft]);

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
  const structured = active && STRUCTURED.has(active.kind);
  const mono = active && (active.kind === "code" || isHtml || structured);
  // What the two views are called. For a sheet or a deck the rendered view is
  // where the work happens and comes first; the text is its source.
  const views = structured
    ? [["preview", active.kind === "sheet" ? "Grid" : "Deck"], ["edit", "Source"]]
    : [["edit", "Edit"], ["preview", "Preview"]];

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
              : KIND_LABEL[active.kind] || active.kind}
          </span>
        ) : null}

        <div className="spacer" />

        {canPreview ? (
          <div className="canvas-modes" role="tablist" aria-label="View">
            {views.map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={mode === value}
                className="canvas-mode"
                data-on={mode === value ? "" : undefined}
                onClick={() => setMode(value)}
              >
                {label}
              </button>
            ))}
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
                ? "Scripts run (isolated from Bom). Click for a static view."
                : "Scripts off. Click to run the page's JavaScript."
            }
            onClick={() => setRunScripts((was) => !was)}
          >
            Scripts
          </button>
        ) : null}

        <div className="canvas-new" ref={menuNode}>
          <button
            type="button"
            className="icon-btn"
            aria-label="New canvas"
            aria-haspopup="menu"
            aria-expanded={menu}
            title="New canvas"
            onClick={() => setMenu((was) => !was)}
          >
            <Icon name="plus" />
          </button>
          {menu ? (
            <div className="canvas-new-menu" role="menu" aria-label="New canvas">
              <KindChoices onPick={make} />
            </div>
          ) : null}
        </div>
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
          <div className="canvas-body" data-kind={active.kind}>
            {structured && mode === "preview" ? (
              sheet ? (
                <SheetView sheet={sheet} fallbackTheme={fallbackTheme} onChange={onStructured} />
              ) : deck ? (
                <DeckView deck={deck} fallbackTheme={fallbackTheme} onChange={onStructured} />
              ) : (
                <div className="canvas-empty">
                  <p>This {KIND_LABEL[active.kind]}’s source isn’t valid JSON, so it can’t be drawn.</p>
                  <button type="button" className="canvas-foot-btn" onClick={() => setMode("edit")}>
                    Open the source
                  </button>
                </div>
              )
            ) : previewHtml ? (
              <div className="body canvas-preview" dangerouslySetInnerHTML={previewHtml} />
            ) : isHtml && mode === "preview" ? (
              // Sandboxed to an opaque origin: with `allow-scripts` the page's
              // JavaScript runs, but WITHOUT `allow-same-origin` it cannot reach
              // Bom -- no access to the parent DOM, cookies, localStorage or
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
            <button
              type="button"
              className="canvas-foot-btn"
              onClick={() => download().catch(() => {})}
              title={
                sheet ? "Download as CSV" : deck ? "Download as a standalone HTML presentation" : "Download"
              }
            >
              {sheet ? "CSV" : deck ? "Export" : "Download"}
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
          <p>No canvas in this conversation yet. Start one:</p>
          <div className="canvas-kind-choices">
            <KindChoices onPick={make} />
          </div>
          <p className="mi" data-soft>
            Or ask for one — a deck, a sheet, a page — and it opens here.
          </p>
        </div>
      )}
    </aside>
  );
}
