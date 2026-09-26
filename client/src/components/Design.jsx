import { useCallback, useMemo, useRef, useState } from "react";

import { renderMarkdown } from "../lib/markdown";
import { Swatch, swatchOf } from "./DesignStarters";
import { useDialog } from "./Dialog";

/* A preset's tokens, drawn: the colours as chips and the two faces as
   specimens. What the tools will actually apply, shown before it is picked. */
function Tokens({ tokens }) {
  if (!tokens) return null;
  const colours = ["background", "surface", "text", "muted", "accent", "accent_2", "line"]
    .filter((key) => tokens[key])
    .map((key) => [key.replace("_", " "), tokens[key]]);
  return (
    <div className="design-tokens">
      <div className="design-token-colours">
        {colours.map(([name, value]) => (
          <span className="design-token" key={name} title={`${name}: ${value}`}>
            <i style={{ background: value }} />
            <span className="mi">{name}</span>
          </span>
        ))}
      </div>
      <div className="design-token-type">
        <span
          style={{
            fontFamily: tokens.heading_font,
            fontWeight: tokens.heading_weight,
            textTransform: tokens.heading_case === "upper" ? "uppercase" : "none",
          }}
        >
          Heading Aa
        </span>
        <span style={{ fontFamily: tokens.body_font }}>Body text reads like this.</span>
      </div>
    </div>
  );
}

// What a fresh standard starts as. Not empty: a blank textarea is a worse
// prompt than a skeleton, and these six headings are the ones every preset
// carries, so a design written here answers the same questions the shipped
// ones do.
const SKELETON = `# My standard

## Principles
What this look is for, in a sentence or two.

## Type
Which faces, at which sizes, with which weights.

## Colour
The palette, and what each colour is allowed to mean.

## Layout
The grid, the margins, the rhythm.

## Components
How a heading, a table, a callout, a figure should look.

## Voice
How the words themselves should read.
`;

const blankDraft = () => ({ name: "", summary: "", markdown: SKELETON });

function draftFrom(design) {
  return {
    name: design.name || "",
    summary: design.summary || "",
    markdown: design.markdown || "",
  };
}

// A preset, forked. The name is marked so the copy is tellable from the
// original in the chooser, where both appear in one list.
function forkOf(preset) {
  return {
    name: `${preset.name} (mine)`,
    summary: preset.summary || "",
    markdown: preset.markdown || "",
  };
}

/**
 * The Design page: the standards a result can be held to.
 *
 * A design.md is a short document about type, colour, layout, components and
 * voice. When the model is about to write something whose look matters it
 * stops and asks which one to follow; what it is offered is this page's
 * contents plus the presets that ship with the server.
 *
 * Presets are read-only and can only be forked — they are the same on every
 * install, and a "preset" that drifts per-machine is just an unlabelled custom
 * standard. Everything below the fold is the reader's own: written here,
 * pasted, or uploaded as a .md file.
 *
 * The editor keeps a live preview beside the source, because a design document
 * is read by two audiences with opposite needs. The model reads the markdown,
 * so the headings have to be right; the person writing it reads the prose, and
 * catching "this section is empty" is much easier rendered than in source.
 */
export function Design({ designs, presets, onCreate, onUpdate, onDelete, onUse }) {
  const { confirm, notify } = useDialog();
  // The id being edited, or "new". Null when nothing is open.
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState(blankDraft);
  // Which preset is being read. Separate from `editing`: looking at a preset
  // is not editing anything, and the two panes must not fight over the pane.
  const [reading, setReading] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const fileInput = useRef(null);

  const openNew = useCallback(() => {
    setReading(null);
    setEditing("new");
    setDraft(blankDraft());
    setError("");
  }, []);

  const openDesign = useCallback((design) => {
    setReading(null);
    setEditing(design.id);
    setDraft(draftFrom(design));
    setError("");
  }, []);

  // A preset opens as a prefilled new draft rather than saving straight away,
  // so it can be cut down to the bits that actually apply before it becomes
  // one of yours.
  const fork = useCallback((preset) => {
    setReading(null);
    setEditing("new");
    setDraft(forkOf(preset));
    setError("");
  }, []);

  /* Uploading is reading the file and filling the editor, not a separate
     import path. The same validation, the same preview, the same Save -- and
     a .md someone drops in is very often nearly right rather than exactly
     right, so landing in the editor is where they wanted to be anyway. */
  const onFile = useCallback(
    async (event) => {
      const file = event.target.files?.[0];
      // Cleared straight away so picking the same file twice fires again.
      event.target.value = "";
      if (!file) return;
      if (file.size > 256 * 1024) {
        await notify("That file is larger than 256 KB. A design standard should be a page or two.", {
          title: "Too large",
        });
        return;
      }
      const text = await file.text();
      // The first ATX heading is the document's name if it has one; otherwise
      // the filename without its extension. Either beats "Untitled".
      const heading = /^#\s+(.+)$/m.exec(text);
      setReading(null);
      setEditing("new");
      setDraft({
        name: (heading?.[1] || file.name.replace(/\.(md|markdown|txt)$/i, "")).trim(),
        summary: "",
        markdown: text,
      });
      setError("");
    },
    [notify],
  );

  const save = useCallback(async () => {
    const name = draft.name.trim();
    if (!name) {
      setError("A standard needs a name.");
      return;
    }
    if (!draft.markdown.trim()) {
      setError("A standard needs some content — that is the whole document the model is handed.");
      return;
    }
    setBusy(true);
    setError("");
    const body = {
      name,
      summary: draft.summary.trim() || null,
      markdown: draft.markdown,
    };
    try {
      if (editing === "new") {
        const created = await onCreate(body);
        setEditing(created?.id || null);
        if (created) setDraft(draftFrom(created));
      } else {
        const updated = await onUpdate(editing, body);
        if (updated) setDraft(draftFrom(updated));
      }
    } catch (problem) {
      setError(problem.message || "Could not save.");
    } finally {
      setBusy(false);
    }
  }, [draft, editing, onCreate, onUpdate]);

  const remove = useCallback(
    async (design) => {
      const yes = await confirm(`Delete the standard “${design.name}”?`, {
        title: "Delete standard",
        confirmLabel: "Delete",
        destructive: true,
      });
      if (!yes) return;
      await onDelete(design.id);
      if (editing === design.id) setEditing(null);
    },
    [confirm, onDelete, editing],
  );

  // Rendered from the draft, so it tracks typing. renderMarkdown escapes the
  // source before it emits a tag, which matters more here than anywhere else
  // in the app: this is the one pane whose input is a file off someone's disk.
  const preview = useMemo(
    () => ({ __html: renderMarkdown(reading ? reading.markdown : draft.markdown) }),
    [reading, draft.markdown],
  );

  return (
    <div className="page">
      <div className="page-head" data-tint="ochre">
        <div className="inner">
          <div>
            <h1 className="h">Design standards</h1>
            <p>
              A design.md is the brief a result is held to — type, colour,
              layout, components and the voice the words are written in. When
              the model is about to make a deck, a sheet or a page it stops and
              asks which of these to follow, and the one you pick styles
              everything else in that conversation too.
            </p>
          </div>
          <div className="actions">
            <button
              type="button"
              className="btn"
              onClick={() => fileInput.current?.click()}
            >
              Upload .md
            </button>
            <button type="button" className="btnp" onClick={openNew}>
              New standard
            </button>
            <input
              ref={fileInput}
              type="file"
              accept=".md,.markdown,.txt,text/markdown,text/plain"
              hidden
              onChange={onFile}
            />
          </div>
        </div>
      </div>

      <div className="page-body design-body">
        {/* Yours above the presets. This page is where your own standards are
            kept; the presets are the shelf you borrow from, and eight of them
            at the top would push the two you actually wrote off the fold.

            Rows open a preset for reading rather than forking it straight
            away -- forking is a button in the pane you land in, which is the
            right order anyway: nobody should adopt a standard they have not
            read. */}
        <div className="design-list">
          <span className="mi design-list-head">Yours</span>
          {designs.length === 0 ? (
            <p className="design-empty mi">
              None yet — read a preset and fork it, or upload a .md you already
              have.
            </p>
          ) : (
            designs.map((design) => (
              <button
                key={design.id}
                type="button"
                className="design-item"
                data-active={editing === design.id ? "" : undefined}
                onClick={() => openDesign(design)}
              >
                <span className="design-item-name">{design.name}</span>
                <span className="design-item-summary">
                  {design.summary || "No summary"}
                </span>
              </button>
            ))
          )}

          <span className="mi design-list-head">Presets</span>
          {presets.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className="design-item"
              data-active={reading?.id === preset.id ? "" : undefined}
              onClick={() => setReading(preset)}
            >
              <span className="design-item-top">
                <Swatch colours={swatchOf(preset.tokens)} />
                <span className="design-item-name">{preset.name}</span>
              </span>
              <span className="design-item-summary">{preset.summary}</span>
              {preset.tags?.length ? (
                <span className="design-opt-tags">
                  {preset.tags.map((tag) => (
                    <span className="design-tag" key={tag}>
                      {tag}
                    </span>
                  ))}
                </span>
              ) : null}
            </button>
          ))}
        </div>

        <div className="design-editor">
          {reading ? (
            <>
              <div className="design-reading-head">
                <div>
                  <h2 className="design-reading-name">{reading.name}</h2>
                  <p className="mi">Preset · read-only</p>
                </div>
                <div className="design-reading-actions">
                  {onUse ? (
                    <button type="button" className="btnp" onClick={() => onUse(reading.id)}>
                      Start a design with this
                    </button>
                  ) : null}
                  <button type="button" className="btn" onClick={() => fork(reading)}>
                    Fork to edit
                  </button>
                </div>
              </div>
              <Tokens tokens={reading.tokens} />
              <div className="design-preview body" dangerouslySetInnerHTML={preview} />
            </>
          ) : editing == null ? (
            <p className="design-hint mi">
              Read a preset, fork one, or write a standard of your own.
            </p>
          ) : (
            <>
              <div className="design-fields">
                <label className="design-field">
                  <span className="mi">Name</span>
                  <input
                    type="text"
                    value={draft.name}
                    placeholder="House style"
                    onChange={(e) => setDraft((p) => ({ ...p, name: e.target.value }))}
                  />
                </label>
                <label className="design-field">
                  <span className="mi">Summary</span>
                  <input
                    type="text"
                    value={draft.summary}
                    placeholder="One line — this is what you read when picking it mid-turn."
                    onChange={(e) => setDraft((p) => ({ ...p, summary: e.target.value }))}
                  />
                </label>
              </div>

              <div className="design-panes">
                <label className="design-field design-source">
                  <span className="mi">design.md</span>
                  <textarea
                    value={draft.markdown}
                    spellCheck="false"
                    onChange={(e) => setDraft((p) => ({ ...p, markdown: e.target.value }))}
                  />
                </label>
                <div className="design-field design-preview-pane">
                  <span className="mi">Preview</span>
                  <div className="design-preview body" dangerouslySetInnerHTML={preview} />
                </div>
              </div>

              {error ? <p className="design-error">{error}</p> : null}

              <div className="design-actions">
                <button type="button" className="btnp" disabled={busy} onClick={save}>
                  {busy ? "Saving…" : editing === "new" ? "Create" : "Save"}
                </button>
                {editing !== "new" && onUse ? (
                  <button type="button" className="btn" disabled={busy} onClick={() => onUse(editing)}>
                    Start a design with this
                  </button>
                ) : null}
                {editing !== "new" ? (
                  <button
                    type="button"
                    className="btn"
                    data-danger=""
                    disabled={busy}
                    onClick={() => {
                      const design = designs.find((d) => d.id === editing);
                      if (design) remove(design);
                    }}
                  >
                    Delete
                  </button>
                ) : null}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
