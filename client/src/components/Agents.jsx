import { AgentAvatar } from "./AgentAvatar";
import { Icon } from "./Icon";

/**
 * Adding agents: the ready-made ones, and a blank one to make your own.
 *
 * Shown on the right of the Agents screen when no agent is picked, or from
 * its "+". An agent is Bom with a specialty -- every ability Bom has, its own
 * instructions for how -- and it comes dressed for the job. "Add" takes a
 * preset as it is, look and all; the pencil opens it in the customise sheet
 * first.
 */
export function AgentGallery({ presets, onNew, onAddPreset, onCustomizePreset }) {
  return (
    <div className="agent-gallery">
      <div className="agent-gallery-head">
        <h1 className="h">Add an agent</h1>
        <p>
          Bom with a specialty. Each one can do everything Bom can, with its own
          instructions for how -- and each keeps one ongoing chat with you.
        </p>
        <button type="button" className="btnp" onClick={onNew}>
          <Icon name="plus" />
          Make your own
        </button>
      </div>

      {presets.length > 0 ? (
        <section className="agent-gallery-section">
          <span className="mi agents-section-head">Ready-made</span>
          <div className="agent-presets">
            {presets.map((preset) => (
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
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
