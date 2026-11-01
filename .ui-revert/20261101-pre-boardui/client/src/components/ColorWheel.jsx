import { useEffect, useMemo, useRef, useState } from "react";

import { oklch } from "../lib/color";
import { seedOf, swatchOf } from "../lib/theme";

/* A colour wheel for a project's colour.
 *
 * Angle is hue, distance from the centre is chroma -- how far from grey --
 * which are the two numbers an accent is made of (lib/theme.js), so what is
 * picked here is stored as a `custom` accent and dresses the project's
 * conversations exactly as a preset would. The disc is drawn in the same
 * OKLCH the palette is built in, so a point's colour on the wheel is the
 * colour the dot will be.
 *
 * Dragging previews live -- the swatch, the hex and a sidebar row with the
 * dot as it will look -- and saves once, on release, rather than on every
 * pixel of the drag. Arrow keys work too: left and right turn the hue, up
 * and down move toward or away from grey. */

// The ring's outer edge. Past about 0.22 most hues leave sRGB at the
// swatch's lightness, and the server caps chroma at 0.25.
const MAX_CHROMA = 0.22;
const SIZE = 168;

// The hue ring as conic-gradient stops, computed rather than written
// `in oklch` so it draws the same in every webview.
const RING = Array.from({ length: 25 }, (_, i) => {
  const hue = i * 15;
  return `${oklch(0.62, MAX_CHROMA, hue)} ${hue}deg`;
}).join(", ");

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

export function ColorWheel({ value, fallbackSeed, onChange, sampleLabel = "A conversation" }) {
  // What is showing: the drag or keys in progress, else what is stored, else
  // the colour the project gets on its own (derived from its name).
  const stored = useMemo(() => seedOf(value, null) || fallbackSeed || { hue: 254, chroma: 0.14 }, [value, fallbackSeed]);
  const [draft, setDraft] = useState(null);
  const shown = draft || stored;
  const disc = useRef(null);
  const dragging = useRef(false);
  const latest = useRef(shown);
  latest.current = shown;

  // A new stored value (saved, or a different project) ends any draft.
  useEffect(() => setDraft(null), [value]);

  const colour = swatchOf({ mode: "custom", hue: shown.hue, chroma: shown.chroma });
  const automatic = !value || value.mode === "auto";

  const fromPoint = (event) => {
    const box = disc.current.getBoundingClientRect();
    const dx = event.clientX - (box.left + box.width / 2);
    const dy = event.clientY - (box.top + box.height / 2);
    // 0deg at the top, clockwise -- the way conic-gradient lays the ring out.
    const hue = (Math.atan2(dx, -dy) * 180) / Math.PI;
    const reach = clamp(Math.hypot(dx, dy) / (box.width / 2), 0, 1);
    return { hue: (hue + 360) % 360, chroma: +(reach * MAX_CHROMA).toFixed(3) };
  };

  const commit = (pick) => {
    onChange({ ...(value || {}), mode: "custom", hue: +pick.hue.toFixed(1), chroma: pick.chroma, preset: undefined });
  };

  const onKey = (event) => {
    const step = event.shiftKey ? 15 : 5;
    const moves = {
      ArrowLeft: { hue: -step },
      ArrowRight: { hue: step },
      ArrowUp: { chroma: 0.01 },
      ArrowDown: { chroma: -0.01 },
    };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    const next = {
      hue: (latest.current.hue + (move.hue || 0) + 360) % 360,
      chroma: +clamp(latest.current.chroma + (move.chroma || 0), 0, MAX_CHROMA).toFixed(3),
    };
    setDraft(next);
    commit(next);
  };

  // The knob: the point on the disc the colour came from.
  const angle = (shown.hue * Math.PI) / 180;
  const reach = clamp(shown.chroma / MAX_CHROMA, 0, 1) * (SIZE / 2);
  const knob = {
    left: SIZE / 2 + Math.sin(angle) * reach,
    top: SIZE / 2 - Math.cos(angle) * reach,
  };

  return (
    <div className="cw">
      <div
        ref={disc}
        className="cw-disc"
        role="slider"
        tabIndex={0}
        aria-label="Colour"
        aria-valuemin={0}
        aria-valuemax={360}
        aria-valuenow={Math.round(shown.hue)}
        aria-valuetext={`Hue ${Math.round(shown.hue)} degrees, ${Math.round((shown.chroma / MAX_CHROMA) * 100)}% colour`}
        style={{
          width: SIZE,
          height: SIZE,
          // The ring of hues, washed toward grey at the centre: a point's
          // distance out is how much colour it carries.
          background: `radial-gradient(circle closest-side, ${oklch(0.62, 0, 0)}, transparent), conic-gradient(${RING})`,
        }}
        onPointerDown={(event) => {
          event.preventDefault();
          disc.current.setPointerCapture(event.pointerId);
          dragging.current = true;
          setDraft(fromPoint(event));
        }}
        onPointerMove={(event) => {
          if (dragging.current) setDraft(fromPoint(event));
        }}
        onPointerUp={(event) => {
          if (!dragging.current) return;
          dragging.current = false;
          const pick = fromPoint(event);
          setDraft(pick);
          commit(pick);
        }}
        onPointerCancel={() => {
          dragging.current = false;
          setDraft(null);
        }}
        onKeyDown={onKey}
      >
        <span className="cw-knob" style={{ left: knob.left, top: knob.top, background: colour }} />
      </div>

      {/* The preview: the colour, its code, and a sidebar row wearing it --
          what every conversation in the project will show. */}
      <div className="cw-preview">
        <span className="mi">Colour</span>
        <span className="cw-swatch" style={{ background: colour }} />
        <code className="cw-hex">{colour}</code>
        <span className="cw-sample" aria-hidden="true">
          <span className="accent-bead" style={{ background: colour }} />
          <span className="cw-sample-title">{sampleLabel}</span>
        </span>
        <span className="mi">{automatic && !draft ? "Automatic, from its name" : "Chosen"}</span>
        {!automatic ? (
          <button
            type="button"
            className="cw-reset"
            onClick={() => {
              setDraft(null);
              onChange(null);
            }}
          >
            Use automatic
          </button>
        ) : null}
      </div>
    </div>
  );
}
