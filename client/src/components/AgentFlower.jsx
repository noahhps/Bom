/* The agent's flower -- beside every answer, and the app's logo.
 *
 * Beside an answer it is a bud while the turn is at rest, and a flower while
 * it is live -- from the moment the message is sent, through the thinking, to
 * the last token. Then it folds back up. The turn's `streaming` flag is the
 * whole signal, so a reply that stops early, errors, or waits on a skill
 * approval opens and closes with exactly the same honesty as the stop button
 * does.
 *
 * As the logo (`mark`) it is the same character, drawn open at `size` pixels
 * across and left in the normal flow: the head of the rail and the greeting on
 * an empty conversation. It turns only while hovered.
 *
 * Eight rounded petals, 45 degrees apart, each on a radius of the flower with
 * its inner half tucked under the face, so the flower stays one piece. Plain
 * elements rather than an SVG: each petal is an arm pinned to the centre and
 * rotated about it, which is a transform-origin HTML boxes agree on in every
 * webview. The colours are accent tokens, so a chat in teal grows a teal
 * flower. Decorative -- the "Thinking" / "Working" text, and the controls the
 * logo sits in, say the same thing to a screen reader. */

const PETALS = 8;

function Flower({ open }) {
  return (
    <span className="flower" data-open={open ? "" : undefined} aria-hidden="true">
      <span className="flower-petals">
        {Array.from({ length: PETALS }, (_, i) => (
          <span key={i} className="flower-petal" style={{ "--i": i }} />
        ))}
      </span>
      <span className="flower-face">
        <span className="flower-eyes">
          <i className="flower-eye" />
          <i className="flower-eye" />
        </span>
      </span>
    </span>
  );
}

export function AgentFlower({ open, mark = false, size = 26, className }) {
  if (!mark) return <Flower open={open} />;
  return (
    <span
      className={className ? `flower-mark ${className}` : "flower-mark"}
      style={{ "--mark": size }}
      aria-hidden="true"
    >
      <Flower open={open} />
    </span>
  );
}
