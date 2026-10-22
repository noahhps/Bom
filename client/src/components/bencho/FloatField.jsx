import { useId, useLayoutEffect, useRef, useState } from "react";

/* A text field whose label lifts into its top edge, as Bencho's label input
 * (bencho.dev/blocks/label-input, MIT).
 *
 * At rest the label sits inside the field where a placeholder would. On focus
 * -- or once there is a value -- it rises and shrinks into the outline, and
 * the outline opens a notch for it from the middle of the gap outward. The
 * letters hop one after another as it goes, which is the whole charm of it.
 *
 * Bencho draws it at a fixed 280px. Here the outline is measured, so the field
 * fills whatever column it is put in; the corner follows Bom's `--r-control`.
 *
 * Everything an <input> takes passes through. `trailing` is drawn inside the
 * right edge (the token's Show / Hide), and the field pads itself to clear it. */

const H = 50;
const S = 0.8; // the label's scale once it has lifted
const IN = 0.75; // half the stroke, so the outline is not clipped

export function FloatField({
  label,
  value,
  corner = 12,
  invalid = false,
  trailing = null,
  trailingWidth = 64,
  inputRef,
  id: givenId,
  onFocus,
  onBlur,
  ...input
}) {
  const ownId = useId();
  const id = givenId || ownId;
  const box = useRef(null);
  const lab = useRef(null);
  const [W, setW] = useState(320);
  const [lw, setLw] = useState(60);
  const [focus, setFocus] = useState(false);

  useLayoutEffect(() => {
    if (lab.current) setLw(lab.current.offsetWidth);
  }, [label]);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return undefined;
    const read = () => setW(el.offsetWidth || 320);
    read();
    const watch = new ResizeObserver(read);
    watch.observe(el);
    return () => watch.disconnect();
  }, []);

  const up = focus || String(value ?? "").length > 0;
  const r = Math.min(corner, H / 2);
  const lx = Math.max(14, r + 4);
  // The notch: a little wider than the lifted label on each side.
  const x0 = Math.max(r * 0.6, lx - 5);
  const x1 = lx + lw * S + 5;
  const a = r - IN;
  const R = W - IN;
  const B = H - IN;
  const mid = W / 2;
  const nm = (x0 + x1) / 2;

  // Two halves drawn from the notch round to the bottom centre, plus the two
  // short gap segments that retract from the notch's middle when it opens.
  const right = `M${x1},${IN} L${W - r},${IN} A${a},${a} 0 0 1 ${R},${r} L${R},${H - r} A${a},${a} 0 0 1 ${W - r},${B} L${mid},${B}`;
  const left = `M${x0},${IN} L${r},${IN} A${a},${a} 0 0 0 ${IN},${r} L${IN},${H - r} A${a},${a} 0 0 0 ${r},${B} L${mid},${B}`;
  const gapL = `M${nm},${IN} L${x0},${IN}`;
  const gapR = `M${nm},${IN} L${x1},${IN}`;

  return (
    <div
      className="flf"
      data-up={up ? "" : undefined}
      data-focus={focus ? "" : undefined}
      data-invalid={invalid ? "" : undefined}
    >
      <div ref={box} className="flf-box" style={{ height: H, borderRadius: r, "--flf-x": `${lx}px` }}>
        <svg className="flf-ring" width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
          <path d={right} />
          <path d={left} />
          <path className="flf-gap" d={gapL} pathLength={1} />
          <path className="flf-gap" d={gapR} pathLength={1} />
        </svg>
        <label className="flf-label" htmlFor={id} ref={lab}>
          {[...label].map((ch, i) => (
            <span key={i} style={{ "--i": i }}>
              {ch}
            </span>
          ))}
        </label>
        <input
          {...input}
          ref={inputRef}
          id={id}
          className="flf-field"
          value={value}
          aria-invalid={invalid || undefined}
          style={{ paddingRight: trailing ? trailingWidth : lx }}
          onFocus={(event) => {
            setFocus(true);
            onFocus?.(event);
          }}
          onBlur={(event) => {
            setFocus(false);
            onBlur?.(event);
          }}
        />
        {trailing}
      </div>
    </div>
  );
}
