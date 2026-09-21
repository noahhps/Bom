import { AgentFlower } from "./AgentFlower";
import { Icon } from "./Icon";

/* The empty conversation.
 *
 * A small shelf of recommended capabilities rather than a blank box. Each
 * card is written as a useful starting point and puts a ready-to-edit prompt
 * in the composer, so a recommendation never becomes a dead-end label.
 *
 * The recommendations are deliberately grounded in capabilities this build
 * exposes: web research, analysis, code, files, canvas work, and memory.
 * A card that promises something the server cannot do is worse than no card.
 */

const RECOMMENDED = [
  {
    kind: "Skill",
    icon: "search",
    title: "Research a question",
    description: "Search the web for current facts, sources, and context.",
    prompt: "Research this question and include the most useful sources: ",
  },
  {
    kind: "Skill",
    icon: "chart",
    title: "Analyze a dataset",
    description: "Find patterns, compare segments, and explain what changed.",
    prompt: "Analyze this dataset and call out the most important patterns and anomalies:\n\n",
  },
  {
    kind: "Skill",
    icon: "code",
    title: "Review or write code",
    description: "Debug an issue, explain a function, or shape a clean implementation.",
    prompt: "Help me with this code. Explain the issue and suggest a clear fix:\n\n",
  },
  {
    kind: "Tool",
    icon: "attachment",
    title: "Work with a file",
    description: "Attach a document, image, or spreadsheet and work from its contents.",
    prompt: "Help me understand and work with the attached file. Start with a concise summary.",
  },
  {
    kind: "Tool",
    icon: "canvas",
    title: "Draft on a canvas",
    description: "Turn an idea into a plan, document, or reusable working draft.",
    prompt: "Create a working draft for this idea, with a clear structure and next steps:\n\n",
  },
  {
    kind: "Tool",
    icon: "memory",
    title: "Recall my context",
    description: "Use saved preferences and previous notes to make the answer more useful.",
    prompt: "Use what you remember about my preferences and help me with this:\n\n",
  },
];

/* Above the composer. The greeting belongs on the side of the box the eye
   reaches first, which is not the side the openers belong on. */
export function StartersHead() {
  return (
    <div className="starters-head">
      {/* The one place the mark gets to be large: the flower, open, with
          room to be seen. Decorative, so it is hidden from screen readers --
          the heading under it already says where you are. */}
      <AgentFlower open mark size={68} className="starters-mark" />
      <h2 className="h">What are we working on?</h2>
      <p className="p">
        Everything here runs on your own hardware. Nothing leaves the machine
        unless you send it to the cloud provider on purpose.
      </p>
    </div>
  );
}

/* Below it, so the composer itself lands on the centre line rather than being
   pushed under it by whatever sits above. */
export function Starters({ onPick }) {
  return (
    <div className="starters">
      <div className="starters-section-head">
        <span className="mi">Recommended for you</span>
        <span className="starters-section-hint">Pick a capability to get started</span>
      </div>
      <div className="starters-grid">
        {RECOMMENDED.map((starter) => (
          <button
            key={starter.title}
            type="button"
            className="starter"
            // The full prompt, so a screen reader hears what pressing this
            // will actually put in the box rather than just the label.
            aria-label={`Use ${starter.title}: ${starter.description}`}
            onClick={() => onPick(starter.prompt)}
          >
            <span className="starter-icon"><Icon name={starter.icon} /></span>
            <span className="starter-copy">
              <span className="starter-meta">{starter.kind}</span>
              <span className="starter-title">{starter.title}</span>
              <span className="starter-body">{starter.description}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
