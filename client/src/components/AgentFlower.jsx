import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { bloomTimeline, installMotion } from "../lib/drawkit";

/* The agent's flower -- beside every answer, and the app's logo.
 *
 * Beside an answer it blooms while the turn is live -- from the moment the
 * message is sent, through the thinking, to the last token -- and then comes
 * to rest open, every petal out, still. Clicking a resting one plays the
 * bloom once, from open back to open; hovering it does nothing. (The logo,
 * `mark`, is the other way round: it blooms while hovered, never on click.) The turn's `streaming` flag is the
 * whole signal, so a reply that stops early, errors, or waits on a skill
 * approval opens and closes with exactly the same honesty as the stop button
 * does.
 *
 * While it is live a wave runs round it: each petal in turn leans out a
 * little and settles back, and the flower rests before the next one. See
 * BLOOM in lib/drawkit for the timeline.
 *
 * As the logo (`mark`) it is the same character, drawn open at `size` pixels
 * across and left in the normal flow: the head of the rail and the greeting on
 * an empty conversation. It blooms only while hovered.
 *
 * Eight rounded petals, 45 degrees apart, each on a radius of the flower with
 * its inner half tucked under the face, so the flower stays one piece. Plain
 * elements rather than an SVG: each petal is an arm pinned to the centre and
 * rotated about it, which is a transform-origin HTML boxes agree on in every
 * webview. The petals keep their own eight colours whatever the chat wears:
 * the flower is where the app's palette comes from. Decorative -- the working
 * label, and the controls the logo sits in, say the same thing to a screen
 * reader.
 *
 * `mood` is for where the flower stands for the app's state rather than a
 * turn's -- the model it is answering with, a turn that failed: "warn" droops,
 * "down" goes grey and shuts its eyes. */

installMotion();

const PETALS = 8;

// A replay is one wave. The loop starts and ends on the open flower a resting
// one already is, so it needs no offset to begin without a jump.
const { cycle: CYCLE } = bloomTimeline();

function Flower({ open, bloom, mood, rest = false, replay = false, onClick }) {
  const petals = useRef(null);
  // What the DOM is doing, which lags `bloom` by one render on the way down.
  const [blooming, setBlooming] = useState(bloom);

  // Starting is immediate. Stopping is not: the wave is caught wherever it has
  // got to, frozen there inline, and then glided home -- so a petal caught
  // mid-swell settles back instead of jumping. Removing the animation alone would snap: a
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
      // Home quickly and without overshoot. The petals' own transition is the
      // bud's slow, springing opening, which on a swell of a tenth would read
      // as a wobble; this one is lent for the glide and handed back after.
      arm.style.transition = "transform var(--dur-settle) var(--ease-out)";
      arm.style.transform = "";
      arm.addEventListener("transitionend", () => (arm.style.transition = ""), { once: true });
    }
  }, [blooming]);

  return (
    <span
      className="flower"
      data-open={open ? "" : undefined}
      data-bloom={blooming ? "" : undefined}
      data-mood={mood || undefined}
      data-rest={rest ? "" : undefined}
      data-playable={onClick ? "" : undefined}
      data-replay={replay ? "" : undefined}
      aria-hidden="true"
      onClick={onClick}
    >
      <span className="flower-petals" ref={petals}>
        {Array.from({ length: PETALS }, (_, i) => (
          <span
            key={i}
            className="flower-petal"
            style={{ "--i": i }}
          />
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

/* `blooming` keeps a mark blooming whether or not it is hovered -- for a logo
   that should look alive while something is under way, as the sign-in screen's
   does while it connects. */
/* The flower beside an answer. `live` is the turn streaming. */
function AnswerFlower({ live, mood }) {
  const [playing, setPlaying] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  // A turn that starts again (a continue) takes over from a replay.
  useEffect(() => {
    if (live) {
      clearTimeout(timer.current);
      setPlaying(false);
    }
  }, [live]);

  const play = () => {
    if (live || playing) return;
    setPlaying(true);
    timer.current = setTimeout(() => setPlaying(false), CYCLE);
  };

  return (
    <Flower
      open
      bloom={live || playing}
      mood={mood}
      rest={!live && !playing}
      replay={playing}
      onClick={live ? undefined : play}
    />
  );
}

export function AgentFlower({ open, mark = false, size = 26, className, blooming = false, mood }) {
  const [hovered, setHovered] = useState(false);
  if (!mark) return <AnswerFlower live={Boolean(open)} mood={mood} />;
  return (
    <span
      className={className ? `flower-mark ${className}` : "flower-mark"}
      style={{ "--mark": size }}
      aria-hidden="true"
      data-hover={hovered ? "" : undefined}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      <Flower open={open} bloom={(hovered && mood !== "down") || Boolean(blooming)} mood={mood} />
    </span>
  );
}
