import { useLayoutEffect, useRef, useState } from "react";

import { installMotion } from "../lib/drawkit";

/* The agent's flower -- beside every answer, and the app's logo.
 *
 * Beside an answer it is a bud while the turn is at rest, and a flower while
 * it is live -- from the moment the message is sent, through the thinking, to
 * the last token. Then it folds back up. The turn's `streaming` flag is the
 * whole signal, so a reply that stops early, errors, or waits on a skill
 * approval opens and closes with exactly the same honesty as the stop button
 * does.
 *
 * While it is live it blooms: the petals come out from under the face one at
 * a time, the whole flower holds, and then all eight fold back under together
 * and it starts again. See BLOOM in lib/drawkit for the timeline.
 *
 * As the logo (`mark`) it is the same character, drawn open at `size` pixels
 * across and left in the normal flow: the head of the rail and the greeting on
 * an empty conversation. It blooms only while hovered.
 *
 * Eight rounded petals, 45 degrees apart, each on a radius of the flower with
 * its inner half tucked under the face, so the flower stays one piece. Plain
 * elements rather than an SVG: each petal is an arm pinned to the centre and
 * rotated about it, which is a transform-origin HTML boxes agree on in every
 * webview. The colours are accent tokens, so a chat in teal grows a teal
 * flower. Decorative -- the working label, and the controls the logo sits in,
 * say the same thing to a screen reader. */

installMotion();

const PETALS = 8;

function Flower({ open, bloom }) {
  const petals = useRef(null);
  // What the DOM is doing, which lags `bloom` by one render on the way down.
  const [blooming, setBlooming] = useState(bloom);

  // Starting is immediate. Stopping is not: the loop is caught wherever it has
  // got to, frozen there inline, and then handed to the petals' own
  // transition -- so a flower whose turn ends mid-close eases into the bud
  // instead of jumping to it. Removing the animation alone would snap: a
  // transition never starts from an animated value.
  useLayoutEffect(() => {
    if (bloom) {
      setBlooming(true);
      return;
    }
    if (!blooming) return;
    // `data-bloom` is still on, so this reads the animated pose.
    for (const arm of petals.current.children) {
      arm.style.transform = getComputedStyle(arm).transform;
      arm.style.transition = "none";
    }
    setBlooming(false);
    // `blooming` is read, not watched: this runs when the signal changes.
  }, [bloom]);

  useLayoutEffect(() => {
    if (blooming || !petals.current) return;
    const arms = [...petals.current.children];
    if (!arms.some((arm) => arm.style.transform)) return;
    for (const arm of arms) {
      // Flush the frozen pose as a style of its own, so the transition that
      // follows has something to start from.
      void getComputedStyle(arm).transform;
      arm.style.transition = "";
      arm.style.transform = "";
    }
  }, [blooming]);

  return (
    <span
      className="flower"
      data-open={open ? "" : undefined}
      data-bloom={blooming ? "" : undefined}
      aria-hidden="true"
    >
      <span className="flower-petals" ref={petals}>
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
  const [hovered, setHovered] = useState(false);
  if (!mark) return <Flower open={open} bloom={Boolean(open)} />;
  return (
    <span
      className={className ? `flower-mark ${className}` : "flower-mark"}
      style={{ "--mark": size }}
      aria-hidden="true"
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      <Flower open={open} bloom={hovered} />
    </span>
  );
}
