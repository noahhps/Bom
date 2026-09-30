import { useCallback, useEffect, useMemo, useState } from "react";

import { HATS, ITEMS, lookOf } from "../lib/accessories";
import { seedFromContext } from "../lib/autotheme";
import { AgentAvatar } from "./AgentAvatar";
import { useDialog } from "./Dialog";
import { Icon } from "./Icon";
import { ThemePicker } from "./ThemePicker";

// The draft the sheet edits. `all` is the abilities switch: true means every
// enabled skill (stored as null) -- the same abilities as Bom itself, and the
// default -- false means only the names in `chosen`, which may be none.
function draftFrom(agent, presets) {
  // The look it is shown wearing, not only the one stored: an agent named
  // like a preset wears that preset's look until one is chosen, and the
  // sheet should open on what the card showed.
  const look = lookOf(agent, presets);
  return {
    name: agent?.name || "",
    instructions: agent?.instructions || "",
    all: agent?.skills == null,
    chosen: new Set(agent?.skills || []),
    theme: agent?.theme || null,
    hat: look?.hat || null,
    item: look?.item || null,
  };
}

/**
 * Customise an agent: how it looks, what it is good at, what it may use.
 *
 * One sheet for a new agent, one made from a preset, and one being changed --
 * the difference is only whether Save creates or updates. `agent` is the
 * stored agent being edited, or null for a new one; `initial` is what a new
 * one starts from (a preset, or nothing).
 *
 * The look is chosen from two rows of the agent itself wearing each option,
 * so what you pick is what you see; the preview at the head follows every
 * change. The specialty is the agent's instructions -- the system prompt it
 * is given on top of Bom's own.
 */
export function AgentEditor({ api, agent, initial, presets = [], onSave, onDelete, onClose }) {
  const { confirm } = useDialog();
  const [draft, setDraft] = useState(() => draftFrom(agent || initial, presets));
  const [catalog, setCatalog] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    api
      .listSkills()
      .then((data) => {
        if (live) setCatalog(data.skills || []);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [api]);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const look = useMemo(
    () => (draft.hat || draft.item ? { hat: draft.hat || undefined, item: draft.item || undefined } : null),
    [draft.hat, draft.item],
  );

  const seed = useMemo(
    () => seedFromContext({ id: agent?.id || "new", title: draft.name }),
    [agent?.id, draft.name],
  );

  const toggleSkill = useCallback((name) => {
    setDraft((prev) => {
      const chosen = new Set(prev.chosen);
      if (chosen.has(name)) chosen.delete(name);
      else chosen.add(name);
      return { ...prev, chosen };
    });
  }, []);

  const save = useCallback(async () => {
    const name = draft.name.trim();
    if (!name) {
      setError("An agent needs a name.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await onSave({
        name,
        instructions: draft.instructions.trim() || null,
        skills: draft.all ? null : [...draft.chosen],
        theme: draft.theme || null,
        look: draft.hat || draft.item ? { hat: draft.hat, item: draft.item } : null,
      });
      onClose();
    } catch (problem) {
      setError(problem.message || "Could not save.");
    } finally {
      setBusy(false);
    }
  }, [draft, onSave, onClose]);

  const remove = useCallback(async () => {
    const yes = await confirm(`Delete the agent “${agent.name}”? Its conversations are kept.`, {
      title: "Delete agent",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!yes) return;
    await onDelete(agent.id);
    onClose();
  }, [agent, confirm, onDelete, onClose]);

  const abilities = draft.all
    ? "everything Bom can do"
    : `${draft.chosen.size} skill${draft.chosen.size === 1 ? "" : "s"}`;

  return (
    <div className="agent-sheet-scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="agent-sheet" role="dialog" aria-modal="true" aria-label="Customize agent">
        <button type="button" className="agent-sheet-close" aria-label="Close" onClick={onClose}>
          <Icon name="close" />
        </button>

        <div className="agent-sheet-head">
          <AgentAvatar look={look} size={88} />
          <input
            className="agent-sheet-name"
            type="text"
            value={draft.name}
            placeholder="Name your agent"
            aria-label="Name"
            onChange={(e) => setDraft((p) => ({ ...p, name: e.target.value }))}
          />
        </div>

        <div className="agent-sheet-body">
          <section className="agent-sheet-field">
            <span className="mi">Hat</span>
            <div className="agent-wear-row" role="group" aria-label="Hat">
              {[{ id: null, label: "No hat" }, ...HATS].map((hat) => (
                <button
                  key={hat.id || "none"}
                  type="button"
                  className="agent-wear"
                  data-on={draft.hat === hat.id ? "" : undefined}
                  aria-pressed={draft.hat === hat.id}
                  title={hat.label}
                  onClick={() => setDraft((p) => ({ ...p, hat: hat.id }))}
                >
                  <AgentAvatar look={{ hat: hat.id || undefined, item: draft.item || undefined }} size={34} />
                </button>
              ))}
            </div>
          </section>

          <section className="agent-sheet-field">
            <span className="mi">Holding or wearing</span>
            <div className="agent-wear-row" role="group" aria-label="Item">
              {[{ id: null, label: "Nothing" }, ...ITEMS].map((item) => (
                <button
                  key={item.id || "none"}
                  type="button"
                  className="agent-wear"
                  data-on={draft.item === item.id ? "" : undefined}
                  aria-pressed={draft.item === item.id}
                  title={item.label}
                  onClick={() => setDraft((p) => ({ ...p, item: item.id }))}
                >
                  <AgentAvatar look={{ hat: draft.hat || undefined, item: item.id || undefined }} size={34} />
                </button>
              ))}
            </div>
          </section>

          <label className="agent-sheet-field">
            <span className="mi">Specialty</span>
            <textarea
              className="agents-instructions"
              value={draft.instructions}
              placeholder="What this agent is for and how it works -- its role, its voice, what it should always or never do. Given to it as its system prompt, on top of Bom's own."
              onChange={(e) => setDraft((p) => ({ ...p, instructions: e.target.value }))}
            />
          </label>

          <section className="agent-sheet-field">
            <span className="mi">Colour</span>
            <ThemePicker
              value={draft.theme}
              onChange={(theme) => setDraft((p) => ({ ...p, theme }))}
              scope="agent"
              seed={seed}
              inheritedLabel="Follow the project or app-wide accent"
            />
          </section>

          <section className="agent-sheet-field">
            <span className="mi">Abilities · {abilities}</span>
            <label className="agents-check">
              <input
                type="checkbox"
                checked={draft.all}
                onChange={(e) => setDraft((p) => ({ ...p, all: e.target.checked }))}
              />
              <span>Everything Bom can do</span>
            </label>
            {!draft.all ? (
              <div className="agents-skills">
                {catalog.length === 0 ? (
                  <p className="mi">No skills registered.</p>
                ) : (
                  catalog.map((skill) => (
                    <label key={skill.name} className="agents-check">
                      <input
                        type="checkbox"
                        checked={draft.chosen.has(skill.name)}
                        onChange={() => toggleSkill(skill.name)}
                      />
                      <span>
                        {skill.name}
                        {skill.server ? <span className="mi"> · {skill.server}</span> : null}
                      </span>
                    </label>
                  ))
                )}
              </div>
            ) : null}
          </section>
        </div>

        {error ? <p className="agents-error">{error}</p> : null}

        <div className="agent-sheet-actions">
          {agent ? (
            <button type="button" className="btn" data-danger="" disabled={busy} onClick={remove}>
              Delete
            </button>
          ) : null}
          <span className="spacer" />
          <button type="button" className="btn" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btnp" disabled={busy} onClick={save}>
            {busy ? "Saving…" : agent ? "Save" : "Add agent"}
          </button>
        </div>
      </div>
    </div>
  );
}
