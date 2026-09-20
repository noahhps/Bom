import { useCallback, useEffect, useMemo, useState } from "react";

import { seedFromContext } from "../lib/autotheme";
import { swatchOf } from "../lib/theme";
import { useDialog } from "./Dialog";
import { Icon } from "./Icon";
import { ThemePicker } from "./ThemePicker";

// The glyphs an agent can wear. Names the Icon component draws; the server
// validates against the same shape, so a typo is a 422 rather than a blank.
const AGENT_ICONS = [
  "agents", "search", "code", "pen", "list", "chart",
  "spark", "compass", "bolt", "document", "memory", "skills",
];

// The draft the editor edits, whether for a new agent or one being changed.
// `all` is the skills switch: true means "every enabled skill" (stored as
// null), false means only the names in `chosen` -- which may be none, a
// deliberate choice the store keeps distinct from the default.
const blankDraft = () => ({
  name: "",
  instructions: "",
  all: true,
  chosen: new Set(),
  icon: null,
  theme: null,
});

function draftFrom(agent) {
  return {
    name: agent.name || "",
    instructions: agent.instructions || "",
    all: agent.skills == null,
    chosen: new Set(agent.skills || []),
    icon: agent.icon || null,
    theme: agent.theme || null,
  };
}

/**
 * The Agents page: make a persona, give it a subset of the skills, and it
 * becomes something a conversation can be run as (assigned from the top bar).
 *
 * The list on the left, the editor on the right. "New" and a picked agent share
 * the one editor -- the difference is only whether Save creates or updates.
 */
export function Agents({ api, agents, onCreate, onUpdate, onDelete, onChanged }) {
  const { confirm } = useDialog();
  const [catalog, setCatalog] = useState([]);
  const [presets, setPresets] = useState([]);
  // The id being edited, or "new". Null when nothing is open yet.
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState(blankDraft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // The skills an agent can be given. The same list the Skills page reads, so a
  // tool added by an MCP server shows up here to be assigned like any other.
  useEffect(() => {
    let live = true;
    api
      .listSkills()
      .then((data) => {
        if (live) setCatalog(data.skills || []);
      })
      .catch(() => {});
    api
      .listAgentPresets()
      .then((data) => {
        if (live) setPresets(data.presets || []);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [api]);

  const openNew = useCallback(() => {
    setEditing("new");
    setDraft(blankDraft());
    setError("");
  }, []);

  const openAgent = useCallback((agent) => {
    setEditing(agent.id);
    setDraft(draftFrom(agent));
    setError("");
  }, []);

  // A preset opens as a new, prefilled draft rather than saving straight away,
  // so the skills it names can be reviewed against what this machine actually
  // has before it becomes a real agent.
  const fromPreset = useCallback((preset) => {
    setEditing("new");
    setDraft(draftFrom(preset));
    setError("");
  }, []);

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
    const body = {
      name,
      instructions: draft.instructions.trim() || null,
      skills: draft.all ? null : [...draft.chosen],
      icon: draft.icon || null,
      theme: draft.theme || null,
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
      onChanged?.();
    } catch (problem) {
      setError(problem.message || "Could not save.");
    } finally {
      setBusy(false);
    }
  }, [draft, editing, onCreate, onUpdate, onChanged]);

  const remove = useCallback(
    async (agent) => {
      const yes = await confirm(`Delete the agent “${agent.name}”?`, {
        title: "Delete agent",
        confirmLabel: "Delete",
        destructive: true,
      });
      if (!yes) return;
      await onDelete(agent.id);
      onChanged?.();
      if (editing === agent.id) setEditing(null);
    },
    [confirm, onDelete, onChanged, editing],
  );

  const skillCount = useMemo(
    () => (draft.all ? "every skill" : `${draft.chosen.size} skill${draft.chosen.size === 1 ? "" : "s"}`),
    [draft.all, draft.chosen],
  );

  // Seeds the auto-accent preview and tints the icon swatches, from the agent's
  // own name so the colour is stable for a given agent rather than the chat.
  const iconSeed = useMemo(
    () => seedFromContext({ id: editing || "new", title: draft.name }),
    [editing, draft.name],
  );

  return (
    <div className="page">
      <div className="page-head" data-tint="blue">
        <div className="inner">
          <div>
            <h1 className="h">Agents</h1>
            <p>
              A named persona with its own standing instructions and its own
              subset of the skills. Assign one to a conversation from the top
              bar; with none, you are talking to the default assistant with the
              whole shelf.
            </p>
          </div>
          <div className="actions">
            <button type="button" className="btnp" onClick={openNew}>
              New agent
            </button>
          </div>
        </div>
      </div>

      <div className="page-body agents-body">
        <div className="agents-list">
          {presets.length > 0 ? (
            <div className="agents-presets">
              <span className="mi">Start from a preset</span>
              <div className="agents-preset-chips">
                {presets.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    className="agents-preset"
                    title={preset.instructions}
                    onClick={() => fromPreset(preset)}
                  >
                    {preset.name}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {agents.length > 0 ? <span className="mi agents-list-head">Your agents</span> : null}

          {agents.length === 0 ? (
            <p className="agents-empty mi">No agents yet — start from a preset above.</p>
          ) : (
            agents.map((agent) => (
              <button
                key={agent.id}
                type="button"
                className="agents-item"
                data-active={editing === agent.id ? "" : undefined}
                onClick={() => openAgent(agent)}
              >
                <span className="agents-item-head">
                  <span
                    className="agents-badge"
                    style={{
                      color: agent.theme
                        ? swatchOf(agent.theme, seedFromContext({ id: agent.id, title: agent.name }))
                        : undefined,
                    }}
                  >
                    <Icon name={agent.icon || "agents"} />
                  </span>
                  <span className="agents-item-name">{agent.name}</span>
                </span>
                <span className="mi">
                  {agent.skills == null
                    ? "every skill"
                    : `${agent.skills.length} skill${agent.skills.length === 1 ? "" : "s"}`}
                </span>
              </button>
            ))
          )}
        </div>

        <div className="agents-editor">
          {editing == null ? (
            <p className="agents-hint mi">
              Start from a preset, pick an agent to edit, or make a new one.
            </p>
          ) : (
            <>
              <label className="agents-field">
                <span className="mi">Name</span>
                <input
                  type="text"
                  value={draft.name}
                  placeholder="Researcher"
                  onChange={(e) => setDraft((p) => ({ ...p, name: e.target.value }))}
                />
              </label>

              <div className="agents-field">
                <span className="mi">Icon</span>
                <div className="agents-icons">
                  {AGENT_ICONS.map((name) => (
                    <button
                      key={name}
                      type="button"
                      className="agents-icon"
                      data-on={draft.icon === name ? "" : undefined}
                      aria-label={name}
                      aria-pressed={draft.icon === name}
                      style={{ color: draft.theme ? swatchOf(draft.theme, iconSeed) : undefined }}
                      onClick={() =>
                        setDraft((p) => ({ ...p, icon: p.icon === name ? null : name }))
                      }
                    >
                      <Icon name={name} />
                    </button>
                  ))}
                </div>
              </div>

              <div className="agents-field">
                <span className="mi">Accent</span>
                <ThemePicker
                  value={draft.theme}
                  onChange={(theme) => setDraft((p) => ({ ...p, theme }))}
                  scope="agent"
                  seed={iconSeed}
                  inheritedLabel="Follow the project or app-wide accent"
                />
                <p className="agents-hint mi">
                  Worn by every conversation run as this agent.
                </p>
              </div>

              <label className="agents-field">
                <span className="mi">Instructions</span>
                <textarea
                  className="agents-instructions"
                  value={draft.instructions}
                  placeholder="How this agent should behave — its role, its voice, what it should always or never do. Added on top of the base system prompt."
                  onChange={(e) =>
                    setDraft((p) => ({ ...p, instructions: e.target.value }))
                  }
                />
              </label>

              <div className="agents-field">
                <span className="mi">Skills · {skillCount}</span>
                <label className="agents-check">
                  <input
                    type="checkbox"
                    checked={draft.all}
                    onChange={(e) => setDraft((p) => ({ ...p, all: e.target.checked }))}
                  />
                  <span>Give this agent every skill</span>
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
                            {skill.server ? (
                              <span className="mi"> · {skill.server}</span>
                            ) : null}
                          </span>
                        </label>
                      ))
                    )}
                  </div>
                ) : null}
              </div>

              {error ? <p className="agents-error">{error}</p> : null}

              <div className="agents-actions">
                <button type="button" className="btnp" disabled={busy} onClick={save}>
                  {busy ? "Saving…" : editing === "new" ? "Create" : "Save"}
                </button>
                {editing !== "new" ? (
                  <button
                    type="button"
                    className="btn"
                    data-danger=""
                    disabled={busy}
                    onClick={() => {
                      const agent = agents.find((a) => a.id === editing);
                      if (agent) remove(agent);
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
