import { Icon } from "./Icon";

/* The empty design conversation.
 *
 * The same shape as the chat's empty screen -- a greeting above the composer,
 * chips below it -- so the two read as one app. What differs is what the chips
 * offer: formats rather than capabilities, because someone who came here to
 * design already knows they want to make something, and the useful question
 * is what kind of thing.
 *
 * Under them, the look. Picking a standard here settles it before anything is
 * sent, so the first answer is already styled and nothing is asked mid-turn.
 * Leaving it on "Ask me" is a real choice too: the model stops and puts the
 * list up the moment it is about to build something.
 */

const FORMATS = [
  {
    icon: "slides",
    label: "Slide deck",
    description: "A presentation with a title slide, sections, big numbers and speaker notes.",
    prompt: "Make a slide deck about ",
  },
  {
    icon: "sheet",
    label: "Spreadsheet",
    description: "A live sheet with formats and formulas -- a budget, a tracker, a plan.",
    prompt: "Build a spreadsheet for ",
  },
  {
    icon: "canvas",
    label: "Web page",
    description: "A complete, responsive page -- a landing page, a portfolio, an invitation.",
    prompt: "Design a landing page for ",
  },
  {
    icon: "spark",
    label: "Poster",
    description: "A single striking composition, drawn in HTML and SVG.",
    prompt: "Design a poster for ",
  },
  {
    icon: "document",
    label: "One-pager",
    description: "A designed brief or report that reads in two minutes.",
    prompt: "Write and design a one-page brief on ",
  },
  {
    icon: "chart",
    label: "Dashboard",
    description: "Key numbers and simple charts, laid out to be read at a glance.",
    prompt: "Design a dashboard showing ",
  },
];

/** Three colours that say what a standard looks like: ground, ink, accent. */
export function Swatch({ colours }) {
  if (!colours?.length) {
    return (
      <span className="swatch" data-custom="" aria-hidden="true">
        <Icon name="pen" />
      </span>
    );
  }
  return (
    <span className="swatch" aria-hidden="true">
      {colours.map((c, i) => (
        <i key={i} style={{ background: c }} />
      ))}
    </span>
  );
}

export const swatchOf = (tokens) =>
  tokens ? [tokens.background, tokens.text, tokens.accent] : null;

export function DesignStartersHead() {
  return (
    <div className="starters-head design-head">
      <div className="starters-greeting">
        <span className="design-mark" aria-hidden="true">
          <Icon name="design" />
        </span>
        <h2 className="h">What are we designing?</h2>
      </div>
      <p className="p">
        Decks, sheets, pages and posters, made to a design standard you pick.
        Choose a look below, or leave it and you’ll be asked when the work
        starts.
      </p>
    </div>
  );
}

export function DesignStarters({ onPick, presets = [], designs = [], value = null, onChoose, onManage }) {
  return (
    <div className="starters design-starters">
      <div className="starters-row">
        {FORMATS.map((format) => (
          <button
            key={format.label}
            type="button"
            className="starter"
            title={format.description}
            aria-label={`${format.label}: ${format.description}`}
            onClick={() => onPick(format.prompt)}
          >
            <Icon name={format.icon} />
            {format.label}
          </button>
        ))}
      </div>

      <div className="design-looks">
        <div className="design-looks-head">
          <span className="mi">Look</span>
          <button type="button" className="design-looks-manage mi" onClick={onManage}>
            Manage standards
          </button>
        </div>
        <div className="design-looks-row" role="radiogroup" aria-label="Design standard">
          <button
            type="button"
            role="radio"
            aria-checked={!value}
            className="design-look"
            data-on={!value ? "" : undefined}
            onClick={() => onChoose(null)}
          >
            <span className="swatch" data-ask="" aria-hidden="true">?</span>
            Ask me
          </button>
          {designs.map((design) => (
            <button
              key={design.id}
              type="button"
              role="radio"
              aria-checked={value === design.id}
              className="design-look"
              data-on={value === design.id ? "" : undefined}
              title={design.summary || design.name}
              onClick={() => onChoose(design.id)}
            >
              <Swatch colours={null} />
              {design.name}
            </button>
          ))}
          {presets.map((preset) => (
            <button
              key={preset.id}
              type="button"
              role="radio"
              aria-checked={value === preset.id}
              className="design-look"
              data-on={value === preset.id ? "" : undefined}
              title={preset.summary}
              onClick={() => onChoose(preset.id)}
            >
              <Swatch colours={swatchOf(preset.tokens)} />
              {preset.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
