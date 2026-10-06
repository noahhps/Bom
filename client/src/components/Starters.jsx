import { AgentFlower } from "./AgentFlower";
import { Icon } from "./Icon";

/* The empty conversation.
 *
 * A small shelf of recommended capabilities rather than a blank box. Each
 * card is written as a useful starting point and puts a ready-to-edit prompt
 * in the composer, so a recommendation never becomes a dead-end label.
 *
 * The recommendations are deliberately grounded in capabilities this build
 * exposes, and in the office work it is for: the calendar, drafting, data,
 * paperwork, research and files.
 * A card that promises something the server cannot do is worse than no card.
 */

const RECOMMENDED = [
  {
    kind: "Skill",
    icon: "calendar",
    label: "Plan my week",
    title: "Plan my week",
    description: "Read the calendar, find the gaps, and put what matters in them.",
    prompt: "Look at my calendar for this week and help me fit these in: ",
  },
  {
    kind: "Skill",
    icon: "mail",
    label: "Draft a reply",
    title: "Draft an email or message",
    description: "Write it in your voice, in a canvas you can edit before it goes.",
    prompt: "Draft a reply to this, friendly and short:\n\n",
  },
  {
    kind: "Skill",
    icon: "chart",
    label: "Analyze data",
    title: "Analyze a spreadsheet",
    description: "Compute from the numbers, then explain what changed and why.",
    prompt: "Analyze the attached spreadsheet and call out the most important patterns and anomalies.",
  },
  {
    kind: "Tool",
    icon: "sheet",
    label: "Make a table",
    title: "Turn paperwork into a table",
    description: "Receipts, invoices and forms become rows you can total and sort.",
    prompt: "Turn the attached documents into one table with a row each, and total the amounts.",
  },
  {
    kind: "Skill",
    icon: "search",
    label: "Research",
    title: "Research a question",
    description: "Search the web for current facts, and say where each came from.",
    prompt: "Research this question and include the most useful sources: ",
  },
  {
    kind: "Tool",
    icon: "attachment",
    label: "Use a file",
    title: "Summarize a document",
    description: "Attach a PDF, a contract or notes and get the short version.",
    prompt: "Summarize the attached document: the main points, any dates or amounts, and what needs doing.",
  },
];

/* Above the composer. The greeting belongs on the side of the box the eye
   reaches first, which is not the side the openers belong on. */
export function StartersHead() {
  return (
    <div className="starters-head">
      {/* The mark and the greeting on one line, centred over the composer and
          the chips beneath it, so the whole empty screen sits on a single
          axis rather than reading left-aligned above a centred row.
          *
          * Smaller than it was at 68px: standing beside 27px text rather than
          * above it, the old size made the heading look like its caption.
          * Decorative, so it stays out of the accessible tree -- the heading
          * next to it already says where you are. */}
      <div className="starters-greeting">
        <AgentFlower open mark size={40} className="starters-mark" />
        <h2 className="h">What are we working on?</h2>
      </div>
      <p className="p">
        Everything here runs on your own hardware. Nothing leaves the machine
        unless you send it to the cloud provider on purpose.
      </p>
    </div>
  );
}

/* Below it, so the composer itself lands on the centre line rather than being
   pushed under it by whatever sits above.
 *
 * A row of chips rather than a shelf of cards. These are suggestions, and a
 * suggestion that takes a paragraph to make itself is competing with the box
 * it is meant to be feeding: five cards put ~300px of prose under the
 * composer on the one screen whose subject is the composer.
 *
 * The long copy has not gone anywhere -- it is the button's accessible name,
 * and the title is its tooltip. A chip is a glance; the sentence is there for
 * anyone who stops on it or is listening rather than looking. */
export function Starters({ onPick }) {
  return (
    <div className="starters">
      <div className="starters-row">
        {RECOMMENDED.map((starter) => (
          <button
            key={starter.title}
            type="button"
            className="starter"
            title={starter.description}
            // The full sentence, so a screen reader hears what pressing this
            // will actually put in the box rather than the two words on it.
            aria-label={`${starter.title}: ${starter.description}`}
            onClick={() => onPick(starter.prompt)}
          >
            <Icon name={starter.icon} />
            {starter.label}
          </button>
        ))}
      </div>
    </div>
  );
}
