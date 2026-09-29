import { useCallback, useEffect, useState } from "react";

import { Icon } from "../Icon";

/* Choosing the project folder a code conversation works on.
 *
 * Recent projects first -- most of the time the answer is one of them -- then a
 * browser over the folders projects may be opened from, and a field to paste a
 * path. The server decides what can be opened (never the home folder itself,
 * never a folder of keys) and this says why when it will not, rather than
 * greying a button out with no explanation. */

export function FolderPicker({ api, onPick, onCancel, onNewProject, embedded = false }) {
  const [recent, setRecent] = useState([]);
  const [listing, setListing] = useState(null);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const browse = useCallback(
    async (path = null) => {
      setError("");
      try {
        setListing(await api.browseFolders(path));
      } catch (exc) {
        setError(exc.message || "That folder cannot be browsed.");
      }
    },
    [api],
  );

  useEffect(() => {
    api.recentFolders().then((data) => setRecent(data.folders || [])).catch(() => {});
    browse();
  }, [api, browse]);

  const open = async (path) => {
    setBusy(true);
    setError("");
    try {
      const folder = await api.openFolder(path);
      onPick(folder.root);
    } catch (exc) {
      setError(exc.message || "That folder cannot be opened.");
    } finally {
      setBusy(false);
    }
  };

  const body = (
    <div className="code-picker">
      <div className="code-picker-head">
        <div className="code-picker-title">
          <h2 className="h">Open a project folder</h2>
          {onNewProject ? (
            <button type="button" className="btn" onClick={onNewProject}>
              <Icon name="plus" />
              New project
            </button>
          ) : null}
        </div>
        <p>
          The assistant works inside the folder you open, and nowhere else.
          {onNewProject ? " Or make a new one -- empty, or built from your designs." : ""}
        </p>
      </div>

      {recent.length ? (
        <section className="code-picker-section">
          <span className="mi" data-strong="">Recent</span>
          <ul className="code-picker-recent">
            {recent.map((folder) => (
              <li key={folder.root}>
                <button type="button" onClick={() => open(folder.root)} disabled={busy}>
                  <Icon name="folder" />
                  <span className="code-picker-name">{folder.name}</span>
                  <span className="code-picker-path">{folder.root}</span>
                  {folder.branch ? <span className="code-picker-branch mi">{folder.branch}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="code-picker-section">
        <span className="mi" data-strong="">Browse</span>
        {listing ? (
          <div className="code-picker-browser">
            <div className="code-picker-where">
              <button
                type="button"
                className="code-icon-btn"
                title="Up one folder"
                aria-label="Up one folder"
                disabled={!listing.parent}
                onClick={() => browse(listing.parent)}
              >
                <Icon name="chevron" />
              </button>
              <span className="code-picker-path" title={listing.path}>{listing.path}</span>
              <button
                type="button"
                className="btnp code-picker-open"
                disabled={!listing.openable || busy}
                title={listing.openable ? "Open this folder" : listing.reason || ""}
                onClick={() => open(listing.path)}
              >
                Open this folder
              </button>
            </div>
            <ul className="code-picker-dirs">
              {listing.dirs.length ? (
                listing.dirs.map((dir) => (
                  <li key={dir.path}>
                    <button type="button" onClick={() => browse(dir.path)} onDoubleClick={() => open(dir.path)}>
                      <Icon name="folder" />
                      <span className="code-picker-name">{dir.name}</span>
                      {dir.project ? <span className="code-picker-badge mi">project</span> : null}
                    </button>
                  </li>
                ))
              ) : (
                <li className="code-picker-empty">No folders here.</li>
              )}
            </ul>
          </div>
        ) : (
          <p className="code-picker-empty">Loading…</p>
        )}
      </section>

      <form
        className="code-picker-typed"
        onSubmit={(event) => {
          event.preventDefault();
          if (typed.trim()) open(typed.trim());
        }}
      >
        <input
          value={typed}
          placeholder="…or paste a folder's full path"
          spellCheck="false"
          autoCapitalize="off"
          onChange={(event) => setTyped(event.target.value)}
        />
        <button type="submit" className="btn" disabled={!typed.trim() || busy}>
          Open
        </button>
      </form>

      {error ? <p className="code-picker-error" role="alert">{error}</p> : null}
      {onCancel ? (
        <div className="code-picker-foot">
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
        </div>
      ) : null}
    </div>
  );

  if (embedded) return body;
  return (
    <div className="code-quick-scrim" role="presentation" onMouseDown={onCancel}>
      <div className="code-picker-dialog" role="dialog" aria-label="Open a project folder" onMouseDown={(e) => e.stopPropagation()}>
        {body}
      </div>
    </div>
  );
}
