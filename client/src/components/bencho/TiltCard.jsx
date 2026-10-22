import { useEffect, useRef } from "react";

import { clamp, createSpring, stillness } from "./spring";

/* A card that sinks under the pointer instead of rising to meet it, as
 * Bencho's tilt card (bencho.dev/blocks/tilt, MIT).
 *
 * The side you press on goes down and away, a shadow pools under the pointer
 * and a rim of light catches the far edge -- the reverse of the usual hover
 * lift, which makes a card feel like something you could push rather than
 * something trying to get your attention. Kept small here (a few degrees, a
 * few pixels) because these are cards with text on, not photographs.
 *
 * `still` turns it off -- a card with a form open in it should not move under
 * the hand that is typing. Everything is written straight to the element on
 * the spring's frames, so a gallery of these never re-renders on hover. */

const TILT = 4; // degrees at the edge
const SINK = 8; // px pushed away at full hover
const DEPTH = 900;

export function TiltCard({ className = "", still = false, children, ...rest }) {
  const outer = useRef(null);
  const card = useRef(null);
  const sheen = useRef(null);
  const springs = useRef(null);
  const live = useRef({ x: 0, y: 0, lit: 0 });

  const paint = () => {
    const { x, y, lit } = live.current;
    if (card.current && lit < 0.001 && Math.abs(x) < 0.001 && Math.abs(y) < 0.001) {
      // At rest the card carries no transform at all, so its text is drawn
      // as plain text again rather than as a layer.
      card.current.style.transform = "";
    } else if (card.current) {
      card.current.style.transform = `translateZ(${(-SINK * lit).toFixed(2)}px) rotateX(${(-y * TILT).toFixed(2)}deg) rotateY(${(x * TILT).toFixed(2)}deg)`;
    }
    if (sheen.current) {
      const px = ((x + 1) / 2) * 100;
      const py = ((y + 1) / 2) * 100;
      sheen.current.style.backgroundImage =
        `radial-gradient(42% 38% at ${px.toFixed(1)}% ${py.toFixed(1)}%, rgba(9, 14, 28, ${(0.07 * lit).toFixed(3)}), transparent), ` +
        `radial-gradient(55% 45% at ${(100 - px).toFixed(1)}% ${(100 - py).toFixed(1)}%, rgba(255, 255, 255, ${(0.5 * lit).toFixed(3)}), transparent)`;
    }
  };

  if (!springs.current) {
    const make = (key) =>
      createSpring({
        stiffness: 220,
        damping: 22,
        onFrame(v) {
          live.current[key] = v;
          paint();
        },
      });
    springs.current = { x: make("x"), y: make("y"), lit: make("lit") };
  }

  useEffect(() => {
    const s = springs.current;
    return () => Object.values(s).forEach((spring) => spring.stop());
  }, []);

  useEffect(() => {
    if (!still) return;
    const s = springs.current;
    s.x.to(0);
    s.y.to(0);
    s.lit.to(0);
  }, [still]);

  const track = (event) => {
    if (still || stillness() || event.pointerType !== "mouse") return;
    const b = outer.current.getBoundingClientRect();
    const s = springs.current;
    s.x.to(clamp(((event.clientX - b.left) / b.width) * 2 - 1, -1, 1));
    s.y.to(clamp(((event.clientY - b.top) / b.height) * 2 - 1, -1, 1));
    s.lit.to(1);
  };

  const leave = () => {
    const s = springs.current;
    s.x.to(0);
    s.y.to(0);
    s.lit.to(0);
  };

  return (
    <div
      ref={outer}
      className="tilt"
      style={{ perspective: DEPTH }}
      onPointerMove={track}
      onPointerLeave={leave}
    >
      <div ref={card} className={`tilt-card ${className}`.trim()} {...rest}>
        {children}
        <span ref={sheen} className="tilt-sheen" aria-hidden="true" />
      </div>
    </div>
  );
}
