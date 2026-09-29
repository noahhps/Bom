import { useMemo, useState } from "react";

import { Icon } from "../Icon";
import { FolderPicker } from "./FolderPicker";
import { KIND_ICON, STACKS, kickoff } from "../../lib/designs";

/* A new code project: a folder, and -- when it is built from designs -- the
 * designs it is built from.
 *
 * The folder is a new one in the projects folder unless the reader points at
 * one they already have. The designs are a design project's, or a design
 * conversation's, all of them unless some are unticked. "Create and start
 * building" makes the project, opens it in the Code view and sends the first
 * message; "Create" makes it and leaves the message in the composer. */

export function NewProject({ api, library, projectsDir, initial = {}, onCreate, onCancel }) {
  const [name, setName] = useState(initial.name || "");
  const [where, setWhere] = useState("new");
  const [folder, setFolder] = useState("");
  const [choosing, setChoosing] = useState(false);
  const [source, setSource] = useState(initial.source || "");
  const [unticked, setUnticked] = useState(() => new Set());
  const [stack, setStack] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // "p:<id>" is a design project, "s:<id>" a design conversation filed in none.
  const sources = useMemo(
    () =>
      (library || [])
        .filter((group) => group.designs.length)
        .map((group) => ({
          key: group.project_id ? `p:${group.project_id}` : `s:${group.session_id}`,
          label: group.name,
          filed: Boolean(group.project_id),
          designs: group.designs,
        })),
    [library],
  );
  const chosen = sources.find((s) => s.key === source) || null;
  const designs = chosen ? chosen.designs.filter((d) => !unticked.has(d.id)) : [];

  const pickSource = (key) => {
    setSource(key);
    setUnticked(new Set());
    const picked = sources.find((s) => s.key === key);
    // A name to start from, when there is none yet.
    if (picked && !name.trim()) setName(picked.label);
  };

  const submit = async (start) => {
    if (!name.trim()) return;
    if (where === "existing" && !folder) {
      setError("Choose the folder first.");
      return;
    }
    if (chosen && !designs.length) {
      setError("Tick at least one design, or build from nothing.");
      return;
    }
    const extra = {};
    if (where === "existing") extra.folder = folder;
    if (chosen) {
      if (source.startsWith("p:")) extra.source_id = source.slice(2);
      else extra.session_id = source.slice(2);
      if (designs.length !== chosen.designs.length) extra.designs = designs.map((d) => d.id);
    }
    setBusy(true);
    setError("");
    try {
      const message = chosen
        ? kickoff({ designs, stack, notes, source: chosen.label })
        : notes.trim() || null;
      await onCreate(name.trim(), extra, { message, start: start && Boolean(message) });
    } catch (exc) {
      setError(exc.message || "The project could not be made.");
      setBusy(false);
    }
  };

  if (choosing) {
    return (
      <div className="code-quick-scrim" role="presentation" onMouseDown={() => setChoosing(false)}>
        <div className="code-picker-dialog" role="dialog" aria-label="Choose a folder" onMouseDown={(e) => e.stopPropagation()}>
          <FolderPicker
            api={api}
            embedded
            onPick={(root) => {
              setFolder(root);
              setWhere("existing");
              setChoosing(false);
              if (!name.trim()) setName(root.split("/").pop());
            }}
            onCancel={() => setChoosing(false)}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="code-quick-scrim" role="presentation" onMouseDown={onCancel}>
      <form
        className="code-picker-dialog newprj"
        role="dialog"
        aria-label="New code project"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          submit(Boolean(chosen));
        }}
      >
        <div className="code-picker-head">
          <h2 className="h">New code project</h2>
          <p>A folder the assistant builds in. Start it from your designs, or from nothing.</p>
        </div>

        <label className="newprj-field">
          <span className="mi" data-strong="">Name</span>
          <input
            value={name}
            autoFocus
            maxLength={120}
            placeholder="Harbour Coffee app"
            onChange={(event) => setName(event.target.value)}
          />
        </label>

        <fieldset className="newprj-field">
          <legend className="mi" data-strong="">Folder</legend>
          <label className="newprj-choice">
            <input type="radio" checked={where === "new"} onChange={() => setWhere("new")} />
            <span>
              A new folder{projectsDir ? <> in <code>{projectsDir}</code></> : null}
            </span>
          </label>
          <label className="newprj-choice">
            <input
              type="radio"
              checked={where === "existing"}
              onChange={() => (folder ? setWhere("existing") : setChoosing(true))}
            />
            <span>
              A folder I already have
              {folder ? <> -- <code>{folder}</code></> : null}
            </span>
            <button type="button" className="btn newprj-browse" onClick={() => setChoosing(true)}>
              {folder ? "Change…" : "Choose…"}
            </button>
          </label>
        </fieldset>

        <label className="newprj-field">
          <span className="mi" data-strong="">Build from designs</span>
          <select value={source} onChange={(event) => pickSource(event.target.value)}>
            <option value="">Nothing -- start empty</option>
            {sources.some((s) => s.filed) ? (
              <optgroup label="Design projects">
                {sources.filter((s) => s.filed).map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.label} ({s.designs.length})
                  </option>
                ))}
              </optgroup>
            ) : null}
            {sources.some((s) => !s.filed) ? (
              <optgroup label="Design conversations">
                {sources.filter((s) => !s.filed).map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.label} ({s.designs.length})
                  </option>
                ))}
              </optgroup>
            ) : null}
          </select>
          {!sources.length ? (
            <span className="newprj-hint">
              No designs yet -- make some in a design conversation first, or start empty.
            </span>
          ) : null}
        </label>

        {chosen ? (
          <>
            <ul className="newprj-designs" aria-label="Designs to include">
              {chosen.designs.map((design) => (
                <li key={design.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={!unticked.has(design.id)}
                      onChange={() =>
                        setUnticked((was) => {
                          const next = new Set(was);
                          if (next.has(design.id)) next.delete(design.id);
                          else next.add(design.id);
                          return next;
                        })
                      }
                    />
                    <Icon name={KIND_ICON[design.kind] || "document"} />
                    <span className="newprj-design-title">{design.title}</span>
                    <span className="mi">{design.detail}</span>
                  </label>
                </li>
              ))}
            </ul>
            <label className="newprj-field">
              <span className="mi" data-strong="">Build it with</span>
              <select value={stack} onChange={(event) => setStack(event.target.value)}>
                {STACKS.map((option) => (
                  <option key={option.label} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </>
        ) : null}

        <label className="newprj-field">
          <span className="mi" data-strong="">{chosen ? "Anything else" : "What is it?"}</span>
          <textarea
            rows={3}
            value={notes}
            placeholder={
              chosen
                ? "Optional: pages to skip, data to use, how it should behave…"
                : "Optional: what you want to build. It becomes your first message."
            }
            onChange={(event) => setNotes(event.target.value)}
          />
        </label>

        {error ? <p className="code-picker-error" role="alert">{error}</p> : null}

        <div className="newprj-foot">
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className={chosen ? "btn" : "btnp"}
            disabled={busy || !name.trim()}
            onClick={() => submit(false)}
          >
            Create
          </button>
          {chosen ? (
            <button type="submit" className="btnp" disabled={busy || !name.trim() || !designs.length}>
              {busy ? "Creating…" : "Create and start building"}
            </button>
          ) : null}
        </div>
      </form>
    </div>
  );
}
