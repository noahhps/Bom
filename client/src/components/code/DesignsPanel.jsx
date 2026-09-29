import { useState } from "react";

import { Icon } from "../Icon";
import { KIND_ICON, KIND_LABEL, designLine } from "../../lib/designs";

/* The designs, beside the files: every design project and what is in it, so a
 * code project can take its screens from them.
 *
 * Two things to do with a design. Import writes it into the project's design/
 * folder -- spec, screens, pictures, standard -- and opens its index. Ask puts
 * a sentence about it in the composer, for the assistant to read it with
 * read_design and build from it. The project this folder was built from, if
 * any, is listed first. */

export function DesignsPanel({ api, ws, groups, linked, onRefresh, onAsk, switcher }) {
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");
  const ordered = [...(groups || [])]
    .filter((group) => group.designs.length)
    .sort((a, b) => (b.project_id === linked) - (a.project_id === linked));

  const importDesigns = async (designs, label) => {
    if (!ws.root || !designs.length) return;
    setBusy(label);
    setNote("");
    try {
      const { written } = await api.importDesigns(ws.root, designs.map((d) => d.id));
      await ws.refresh(written);
      ws.openFile("design/README.md");
      setNote(`${label} copied into design/ -- ${written.length} files.`);
    } catch (exc) {
      setNote(exc.message || "The designs could not be copied.");
    } finally {
      setBusy("");
    }
  };

  return (
    <aside className="code-explorer" aria-label="Designs">
      {switcher}
      <div className="code-explorer-head">
        <span className="code-explorer-name mi">Designs</span>
        <span className="spacer" />
        <button type="button" className="code-icon-btn" title="Refresh" aria-label="Refresh designs" onClick={onRefresh}>
          <Icon name="refresh" />
        </button>
      </div>
      <div className="code-designs">
        {note ? <p className="code-designs-note" role="status">{note}</p> : null}
        {!ordered.length ? (
          <p className="code-designs-empty">
            No designs yet. Make wireframes, pages or decks in a design conversation, and
            they show up here to build from.
          </p>
        ) : null}
        {ordered.map((group) => (
          <section key={group.project_id || group.session_id} className="code-designs-group">
            <div className="code-designs-head">
              <Icon name={group.project_id ? "folder" : "design"} />
              <span className="code-designs-name" title={group.name}>{group.name}</span>
              {group.project_id && group.project_id === linked ? (
                <span className="code-picker-badge mi" title="This project was built from it">source</span>
              ) : null}
              <button
                type="button"
                className="code-designs-act mi"
                disabled={Boolean(busy)}
                title="Copy every design here into design/"
                onClick={() => importDesigns(group.designs, group.name)}
              >
                {busy === group.name ? "…" : "import all"}
              </button>
            </div>
            <ul>
              {group.designs.map((design) => (
                <li key={design.id} className="code-design">
                  <Icon name={KIND_ICON[design.kind] || "document"} />
                  <span className="code-design-title" title={`${KIND_LABEL[design.kind] || design.kind} · ${design.detail}`}>
                    {design.title}
                  </span>
                  <span className="code-design-acts">
                    <button
                      type="button"
                      className="mi"
                      disabled={Boolean(busy)}
                      title="Copy into design/"
                      onClick={() => importDesigns([design], `"${design.title}"`)}
                    >
                      import
                    </button>
                    <button
                      type="button"
                      className="mi"
                      title="Ask the assistant to build from it"
                      onClick={() =>
                        onAsk(
                          `Build the design "${design.title}" from "${group.name}" -- ${designLine(design)}. ` +
                            "Read it with read_design first and match it closely.",
                        )
                      }
                    >
                      ask
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </aside>
  );
}
