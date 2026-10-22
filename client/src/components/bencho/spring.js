// A damped spring stepped on requestAnimationFrame, shared by the Bencho ports.
//
// Bencho's blocks lean on framer-motion for their springs. Bom has no motion
// library and every one of these needs exactly one thing from it -- a value
// that chases a target with some give -- so the step is written out here once
// rather than adding a dependency for it. Bencho's own Seek block does the
// same thing for the same reason.

export const stillness = () =>
  typeof window !== "undefined" &&
  Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/* A spring that writes through `onFrame` instead of through React state, so a
 * drag or a settle never re-renders the component that owns it.
 *
 * `stiffness` and `damping` are per-second units, the same pair framer-motion
 * takes, so a value tuned on bencho.dev reads the same here. */
export function createSpring({ value = 0, stiffness = 170, damping = 21.5, mass = 1, onFrame }) {
  let x = value;
  let v = 0;
  let target = value;
  let raf = 0;
  let prev = 0;

  const tick = (t) => {
    const dt = prev ? clamp((t - prev) / 1000, 0, 1 / 30) : 1 / 60;
    prev = t;
    const force = -stiffness * (x - target) - damping * v;
    v += (force / mass) * dt;
    x += v * dt;
    if (Math.abs(x - target) < 0.01 && Math.abs(v) < 0.5) {
      x = target;
      v = 0;
      raf = 0;
      prev = 0;
      onFrame(x, 0);
      return;
    }
    onFrame(x, v);
    raf = requestAnimationFrame(tick);
  };

  return {
    get: () => x,
    velocity: () => v,
    // A hard write, for a finger: velocity is measured from the move so the
    // shape can still stretch while it is held.
    set(next, dt = 1 / 60) {
      cancelAnimationFrame(raf);
      raf = 0;
      prev = 0;
      v = dt > 0 ? (next - x) / dt : 0;
      x = next;
      target = next;
      onFrame(x, v);
    },
    to(next) {
      target = next;
      if (stillness()) {
        x = next;
        v = 0;
        onFrame(x, 0);
        return;
      }
      if (!raf) raf = requestAnimationFrame(tick);
    },
    stop() {
      cancelAnimationFrame(raf);
      raf = 0;
      prev = 0;
    },
  };
}
