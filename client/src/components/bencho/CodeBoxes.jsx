import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { createSpring } from "./spring";

/* Boxes that are one field, as Bencho's one-time code
 * (bencho.dev/blocks/one-time-code, MIT).
 *
 * One real <input> lies invisibly over a row of cells, so paste, autofill,
 * backspace and select-all all behave as they do in any text field -- the
 * cells only draw what it holds. A caret glides between cells on a spring
 * and stretches as it travels; each character rises into its cell as it is
 * typed; the row breathes while the code is being checked and shakes when it
 * is refused.
 *
 * Bom's codes are two groups of four (ABCD-EFGH), so the row is drawn with a
 * gap and a dash between the groups. `value` keeps whatever form the caller
 * stores; the boxes read only its letters and digits. */

const W = 31;
const G = 5;
const DASH = 16;

export function CodeBoxes({
  value,
  onChange,
  groups = [4, 4],
  label = "Code",
  busy = false,
  invalid = false,
  inputRef,
  ...input
}) {
  const n = groups.reduce((a, b) => a + b, 0);
  const raw = String(value || "").replace(/[^A-Z0-9]/gi, "").toUpperCase().slice(0, n);
  const [focus, setFocus] = useState(false);
  const [shaking, setShaking] = useState(false);
  const caret = useRef(null);
  const spring = useRef(null);
  const ownInput = useRef(null);
  const field = inputRef || ownInput;

  // Where cell i starts, with the dash's room after each group but the last.
  const starts = [];
  let x = 0;
  groups.forEach((size, g) => {
    for (let i = 0; i < size; i += 1) {
      starts.push(x);
      x += W + G;
    }
    if (g < groups.length - 1) x += DASH;
  });
  const rowW = x - G;
  const breaks = groups.slice(0, -1).map((_, g) => {
    const last = groups.slice(0, g + 1).reduce((a, b) => a + b, 0) - 1;
    return starts[last] + W + (G + DASH) / 2;
  });

  if (!spring.current) {
    spring.current = createSpring({
      // Born where the next character goes, so a pre-filled code (one that
      // arrived in the address) does not start with the caret on the first box.
      value: starts[Math.min(raw.length, n - 1)] + W / 2,
      stiffness: 520,
      damping: 34,
      onFrame(at, v) {
        if (!caret.current) return;
        const stretch = 1 + Math.min(4, Math.abs(v) / 120);
        caret.current.style.transform = `translateX(${(at - 1).toFixed(2)}px) scaleX(${stretch.toFixed(3)})`;
      },
    });
  }

  useLayoutEffect(() => {
    spring.current.to(starts[Math.min(raw.length, n - 1)] + W / 2);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw.length, n]);

  useLayoutEffect(() => {
    spring.current.set(spring.current.get(), 0);
    return () => spring.current.stop();
  }, []);

  // A refusal is a shake, once per refusal.
  useEffect(() => {
    if (invalid) setShaking(true);
  }, [invalid]);

  return (
    <div
      className="otp"
      data-focus={focus ? "" : undefined}
      data-busy={busy ? "" : undefined}
      data-invalid={invalid ? "" : undefined}
      data-full={raw.length === n ? "" : undefined}
    >
      <div
        className="otp-row"
        data-shake={shaking ? "" : undefined}
        onAnimationEnd={(event) => {
          if (event.target === event.currentTarget) setShaking(false);
        }}
        style={{ width: rowW }}
      >
        {starts.map((left, i) => (
          <span
            key={i}
            className="otp-cell"
            data-filled={raw[i] ? "" : undefined}
            data-here={focus && i === Math.min(raw.length, n - 1) ? "" : undefined}
            style={{ left, width: W, "--i": i }}
          >
            {raw[i] ? (
              <span key={`${i}-${raw[i]}`} className="otp-char">
                {raw[i]}
              </span>
            ) : null}
          </span>
        ))}
        {breaks.map((at) => (
          <span key={at} className="otp-dash" style={{ left: at }} aria-hidden="true" />
        ))}
        <i ref={caret} className="otp-caret" data-on={focus && raw.length < n && !busy ? "" : undefined} />
        <input
          {...input}
          ref={field}
          className="otp-field"
          value={value}
          aria-label={label}
          aria-invalid={invalid || undefined}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck="false"
          onChange={(event) => onChange(event.target.value)}
          onFocus={() => setFocus(true)}
          onBlur={() => setFocus(false)}
        />
      </div>
    </div>
  );
}
