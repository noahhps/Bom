import { lookOf, taglineOf } from "../lib/accessories";
import { AgentAvatar } from "./AgentAvatar";
import { Icon } from "./Icon";

const TIME = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const DAY = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

/* When a chat last moved, the way a messenger says it: the time for today,
   the day for anything older. */
function lastSeen(at) {
  if (!at) return "";
  const when = new Date(at);
  return when.toDateString() === new Date().toDateString() ? TIME.format(when) : DAY.format(when);
}

/**
 * The Agents screen, laid out like a messenger: your agents down the left as
 * contacts, and the one you picked on the right as a single, continuing chat.
 *
 * One chat per agent, not a list of conversations. An agent is someone you
 * keep talking to -- a researcher you come back to with the next question --
 * so picking it opens where you left off, the way picking a person in a
 * messenger does. The chat itself is the app's own conversation (thread,
 * composer, canvas), handed in as `children` and run as the agent; that is
 * what gives every agent all of Bom's abilities.
 *
 * With no agent picked -- or on "Add an agent" -- the right side is the
 * gallery (`gallery`) instead. Later, this is also where an agent's own
 * desktop will open.
 */
export function AgentsScreen({
  agents,
  presets,
  chatOf,
  selected,
  busy,
  onSelect,
  onGallery,
  onCustomize,
  canvasCount = 0,
  canvasOpen = false,
  onToggleCanvas,
  browserShown = false,
  browserOpen = false,
  onToggleBrowser,
  gallery,
  children,
}) {
  return (
    <div className="agent-room">
      <aside className="agent-room-side" aria-label="Agents">
        <div className="agent-room-list-head">
          <span className="agent-room-heading">Agents</span>
          <button
            type="button"
            className="agent-room-new"
            title="Add an agent"
            aria-label="Add an agent"
            aria-pressed={!selected}
            onClick={onGallery}
          >
            <Icon name="plus" />
          </button>
        </div>

        {agents.length === 0 ? (
          <p className="agent-room-empty">No agents yet — add one to start.</p>
        ) : (
          <ul className="agent-contacts">
            {agents.map((agent) => {
              const chat = chatOf(agent.id);
              const live = busy && selected?.id === agent.id;
              return (
                <li key={agent.id}>
                  <button
                    type="button"
                    className="agent-contact"
                    aria-current={selected?.id === agent.id ? "true" : undefined}
                    onClick={() => onSelect(agent.id)}
                  >
                    {/* Blooms while it is answering, like the flower beside
                        an answer. */}
                    <AgentAvatar look={lookOf(agent, presets)} size={40} blooming={live} />
                    <span className="agent-contact-text">
                      <span className="agent-contact-top">
                        <span className="agent-contact-name">{agent.name}</span>
                        {chat?.updated_at ? (
                          <span className="agent-contact-when">{lastSeen(chat.updated_at)}</span>
                        ) : null}
                      </span>
                      <span className="agent-contact-line">
                        {live ? "answering…" : chat ? chat.title || "Chat" : taglineOf(agent, presets)}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </aside>

      <div className="agent-room-main">
        {selected ? (
          <>
            {/* Who you are talking to, above the chat -- the way a messenger
                heads a thread with the contact, not with a conversation
                title. */}
            <div className="agent-chat-head">
              <AgentAvatar look={lookOf(selected, presets)} size={34} />
              <span className="agent-chat-who">
                <span className="agent-chat-name">{selected.name}</span>
                <span className="agent-chat-tagline">{taglineOf(selected, presets)}</span>
              </span>
              {/* The canvas toggle, as the chat screen's top bar has it: only
                  once the chat has a canvas to open. */}
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
              {/* And the browser's, once the chat has opened a page. */}
              {browserShown ? (
                <button
                  type="button"
                  className="icon-btn canvas-btn"
                  data-on={browserOpen ? "" : undefined}
                  aria-label={browserOpen ? "Hide browser" : "Show browser"}
                  aria-pressed={browserOpen}
                  title="Browser"
                  onClick={onToggleBrowser}
                >
                  <Icon name="globe" />
                </button>
              ) : null}
              <button type="button" className="btn" onClick={() => onCustomize(selected)}>
                <Icon name="pen" />
                Customize
              </button>
            </div>
            {children}
          </>
        ) : (
          gallery
        )}
      </div>
    </div>
  );
}

/* The greeting over an agent's chat before the first message: the agent
 * itself, dressed, saying what it is for -- in place of the app's own flower
 * and "What are we working on?", which would make every agent open as Bom. */
export function AgentGreeting({ agent, presets }) {
  return (
    <div className="starters-head agent-greeting">
      <div className="starters-greeting">
        <AgentAvatar look={lookOf(agent, presets)} size={56} className="starters-mark" />
        <h2 className="h">Hi, I’m {agent.name}.</h2>
      </div>
      <p className="p">{taglineOf(agent, presets)}</p>
    </div>
  );
}
