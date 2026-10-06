import { lookOf, taglineOf } from "../lib/accessories";
import { AgentAvatar } from "./AgentAvatar";
import { Icon } from "./Icon";

/**
 * Your agents, and the ones you could add: the contacts behind Messages.
 *
 * An agent is Bom with a specialty -- its own instructions and its own short
 * toolbox -- and it comes dressed for the job. Your own come first, each a
 * message away; the ready-made ones follow, "Add" taking one as it comes and
 * the pencil opening it in the customise sheet first. A ready-made one you
 * already have is not offered again -- it is already in Yours.
 */
export function AgentsPage({ agents, presets, onMessage, onCustomize, onNew, onAddPreset, onCustomizePreset }) {
  const have = new Set(agents.map((a) => a.name.trim().toLowerCase()));
  const more = presets.filter((preset) => !have.has(preset.name.trim().toLowerCase()));
  return (
    <div className="agent-gallery">
      <div className="agent-gallery-head">
        <h1 className="h">Agents</h1>
        <p>
          Bom with a specialty. Each one has its own instructions and the few tools
          its job needs -- a short toolbox is what keeps a small local model on task.
          Message one on its own, or put a few in a group chat.
        </p>
        <button type="button" className="btnp" onClick={onNew}>
          <Icon name="plus" />
          Make your own
        </button>
      </div>

      {agents.length > 0 ? (
        <section className="agent-gallery-section">
          <span className="mi agents-section-head">Yours</span>
          <div className="agent-presets">
            {agents.map((agent) => (
              <div key={agent.id} className="agent-preset">
                <AgentAvatar look={lookOf(agent, presets)} size={46} />
                <span className="agent-preset-text">
                  <span className="agent-preset-name">{agent.name}</span>
                  <span className="agent-preset-tagline">{taglineOf(agent, presets)}</span>
                </span>
                <span className="agent-preset-actions">
                  <button
                    type="button"
                    className="btn"
                    title={`Customize ${agent.name}`}
                    aria-label={`Customize ${agent.name}`}
                    onClick={() => onCustomize(agent)}
                  >
                    <Icon name="pen" />
                  </button>
                  <button
                    type="button"
                    className="btnp"
                    title={`Message ${agent.name}`}
                    aria-label={`Message ${agent.name}`}
                    onClick={() => onMessage(agent.id)}
                  >
                    <Icon name="chat_bubble" />
                  </button>
                </span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {more.length > 0 ? (
        <section className="agent-gallery-section">
          <span className="mi agents-section-head">Ready-made</span>
          <div className="agent-presets">
            {more.map((preset) => {
              return (
                <div key={preset.id} className="agent-preset">
                  <AgentAvatar look={preset.look} size={46} />
                  <span className="agent-preset-text">
                    <span className="agent-preset-name">{preset.name}</span>
                    <span className="agent-preset-tagline">{preset.tagline}</span>
                  </span>
                  <span className="agent-preset-actions">
                    <button
                      type="button"
                      className="btn"
                      title="Adjust it before adding"
                      aria-label={`Customize ${preset.name} before adding`}
                      onClick={() => onCustomizePreset(preset)}
                    >
                      <Icon name="pen" />
                    </button>
                    <button type="button" className="btnp" onClick={() => onAddPreset(preset)}>
                      <Icon name="plus" />
                      Add
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}
    </div>
  );
}
