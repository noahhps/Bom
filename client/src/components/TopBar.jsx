import { Icon } from "./Icon";

/**
 * The 64px header from 1a: the conversation's name, what the system is doing,
 * and the one control that belongs to the thread rather than to the app.
 *
 * There is no menu button. Picking a conversation is the rail's job now -- the
 * list unfolds under Chat when the rail opens.
 *
 * `badge` is the provider/model line the turn reports back. It is rendered as
 * the design's dot-plus-label state rather than as a pill, so "cloud" reads as
 * a condition of the conversation rather than as a piece of chrome.
 */
export function TopBar({
  title,
  badge,
  projects,
  projectId,
  onProject,
  canFile,
  onNewSession,
  canvasCount = 0,
  canvasOpen = false,
  onToggleCanvas,
  agents = [],
  agentId = null,
  onAgent,
  // A design conversation: its tag beside the title, and the standard it is
  // styled to as a picker of its own.
  mode = "chat",
  looks = [],
  look = null,
  onLook,
}) {
  const design = mode === "design";
  return (
    <header className="topbar" data-mode={design ? "design" : undefined}>
      {design ? (
        <span className="topbar-mode mi" title="Design conversation">
          <Icon name="design" />
          <span className="topbar-mode-label">Design</span>
        </span>
      ) : null}
      <span className="title">{title}</span>

      {badge ? (
        <span className="state" data-tone={badge.tone || undefined}>
          <i aria-hidden="true" />
          <span className="mi">{badge.text}</span>
        </span>
      ) : null}

      <div className="spacer" />

      {/* Filing lives here rather than on the rail row: the rail is 252px of
          conversation titles, and a select crammed into one would be a target
          nobody hits. This is about the conversation you are reading, which is
          what the rest of this bar is about too.

          Hidden until there is a conversation to file -- a new, unsent chat
          has no id yet, and offering to file it would fail on submit. */}
      {canFile ? (
        <label className="topbar-project">
          <span className="mi">Project</span>
          <select
            value={projectId || ""}
            aria-label="File this conversation"
            onChange={(event) => onProject(event.target.value || null)}
          >
            <option value="">None</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {/* The look. On in every design conversation, sent or not -- an
          unsent one keeps the pick locally and sends it with the first
          message. "Ask when needed" is no pick at all, which is what makes the
          model stop and ask before it builds something. */}
      {design ? (
        <label className="topbar-project topbar-look">
          <span className="mi">Look</span>
          <select
            value={look || ""}
            aria-label="Design standard for this conversation"
            onChange={(event) => onLook(event.target.value || null)}
          >
            <option value="">Ask when needed</option>
            {looks.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
            <option value="none">No standard</option>
          </select>
        </label>
      ) : null}

      {/* Which agent answers in this conversation. Beside filing, and hidden
          for the same reasons: it is a property of the thread, so an unsent
          chat has no id to write it against, and it only appears once there is
          at least one agent to choose. */}
      {canFile && agents.length > 0 ? (
        <label className="topbar-project">
          <span className="mi">Agent</span>
          <select
            value={agentId || ""}
            aria-label="Run this conversation as an agent"
            onChange={(event) => onAgent(event.target.value || null)}
          >
            <option value="">Default</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {/* The canvas toggle. Shown only once a conversation has a canvas to
          open -- an empty conversation has nothing to look at, and the model
          opens the panel itself the moment it writes one. */}
      {canvasCount > 0 ? (
        <button
          type="button"
          className="icon-btn canvas-btn"
          data-on={canvasOpen ? "" : undefined}
          aria-label={canvasOpen ? "Hide canvas" : "Show canvas"}
          aria-pressed={canvasOpen}
          title="Canvas"
          onClick={onToggleCanvas}
        >
          <Icon name="canvas" />
        </button>
      ) : null}

      <button className="icon-btn" aria-label="New conversation" onClick={onNewSession}>
        <Icon name="plus" />
      </button>
    </header>
  );
}
