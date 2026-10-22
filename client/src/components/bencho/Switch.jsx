import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { clamp, createSpring } from "./spring";

/* The switch, as Bencho's liquid toggle (bencho.dev/blocks/liq-toggle, MIT).
 *
 * It replaces the `.switch` button that snapped its dot from one end to the
 * other. The droplet now crosses on a spring, lengthens along its travel and
 * thins across it while it moves (area kept: scaleY is 1/scaleX), swells a
 * touch under the pointer, and can be dragged as well as clicked -- flipping
 * as it passes the middle, so the track answers under the finger.
 *
 * Bom's colours rather than Bencho's black-and-white: the track fills with
 * the accent when on, which is the one thing `--accent` exists to say.
 *
 * Controlled. `on` is the truth; `onToggle(next)` asks for a change. Between
 * a drag's release and the parent's answer the switch shows where it was let
 * go, so a slow save does not snap the droplet back first. */

const TRACK = 40;
const THUMB = 18;
const PAD = 3;
const SHUT_X = PAD;
const OPEN_X = TRACK - THUMB - PAD;
const MID_X = (SHUT_X + OPEN_X) / 2;
// How much the droplet lengthens into its own travel, 0..1.
const STRETCH = 0.55;

export function Switch({ on, onToggle, label, disabled = false, title, className = "" }) {
  const [pending, setPending] = useState(null);
  const shown = pending ?? Boolean(on);
  const rail = useRef(null);
  const body = useRef(null);
  const drop = useRef(null);
  const grip = useRef(null);
  const dragged = useRef(null);
  const spring = useRef(null);
  const speed = useRef(0);

  // The parent has answered; its value is the truth again.
  useEffect(() => setPending(null), [on]);

  if (!spring.current) {
    spring.current = createSpring({
      value: shown ? OPEN_X : SHUT_X,
      stiffness: 260,
      damping: 24,
      mass: 0.9,
      onFrame(x, v) {
        // A little low-pass on the velocity so a single fast frame is a
        // stretch and not a flicker.
        speed.current += (v - speed.current) * 0.35;
        const long = 1 + Math.min(0.4, Math.abs(speed.current) / 260) * STRETCH;
        if (body.current) body.current.style.transform = `translateX(${x.toFixed(2)}px)`;
        if (drop.current) drop.current.style.transform = `scale(${long.toFixed(3)}, ${(1 / long).toFixed(3)})`;
      },
    });
  }

  // The first frame is written by hand, not by a style prop: React would
  // re-apply a prop on every render and yank the droplet out of its spring.
  useLayoutEffect(() => {
    spring.current.set(spring.current.get(), 0);
  }, []);

  useLayoutEffect(() => {
    if (grip.current) return;
    spring.current.to(shown ? OPEN_X : SHUT_X);
  }, [shown]);

  useEffect(() => () => spring.current?.stop(), []);

  const local = (clientX) => {
    const el = rail.current;
    if (!el) return 0;
    const b = el.getBoundingClientRect();
    const k = b.width / (el.offsetWidth || b.width) || 1;
    return (clientX - b.left) / k;
  };

  const down = (event) => {
    if (disabled || event.button > 0) return;
    grip.current = { id: event.pointerId, grab: null, moved: false, at: performance.now() };
    dragged.current = null;
    try {
      rail.current?.setPointerCapture(event.pointerId);
    } catch {
      /* not a live pointer -- the drag works without capture */
    }
  };

  const move = (event) => {
    const g = grip.current;
    if (!g || g.id !== event.pointerId) return;
    const at = local(event.clientX);
    // The offset is taken at the first move, from where the droplet is, so
    // a press off the thumb can never make it jump.
    if (g.grab === null) g.grab = at - spring.current.get();
    const next = clamp(at - g.grab, SHUT_X, OPEN_X);
    const now = performance.now();
    if (Math.abs(next - spring.current.get()) > 0.4) g.moved = true;
    spring.current.set(next, (now - g.at) / 1000);
    g.at = now;
    if (g.moved) setPending(next > MID_X);
  };

  const up = (event) => {
    const g = grip.current;
    if (!g) return;
    grip.current = null;
    try {
      rail.current?.releasePointerCapture?.(event.pointerId);
    } catch {
      /* never captured */
    }
    if (g.moved) {
      // The click that follows this pointerup reads the drag's verdict.
      dragged.current = spring.current.get() > MID_X;
      setPending(dragged.current);
    }
    spring.current.to((g.moved ? dragged.current : shown) ? OPEN_X : SHUT_X);
  };

  const click = () => {
    if (disabled) return;
    const verdict = dragged.current;
    dragged.current = null;
    // A press that travelled has already chosen a side; it only asks for a
    // change if it ended on the other one.
    const next = verdict === null ? !on : verdict;
    if (next === Boolean(on)) {
      setPending(null);
      return;
    }
    setPending(next);
    onToggle?.(next);
  };

  return (
    <button
      ref={rail}
      type="button"
      className={`lq-switch ${className}`.trim()}
      role="switch"
      aria-checked={shown}
      aria-label={label}
      title={title}
      disabled={disabled}
      data-on={shown ? "" : undefined}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onClick={click}
    >
      <span
        ref={body}
        className="lq-switch-body"
        aria-hidden="true"
      >
        <span className="lq-switch-swell">
          <span ref={drop} className="lq-switch-drop" />
        </span>
      </span>
    </button>
  );
}
