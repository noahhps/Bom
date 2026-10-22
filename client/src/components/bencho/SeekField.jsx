import { useEffect, useRef, useState } from "react";

import { clamp, createSpring, stillness } from "./spring";

/* A search that starts as its own icon, as Bencho's Search
 * (bencho.dev/blocks/seek, MIT).
 *
 * Shut, it is a round button with a lens in it that leans a few pixels toward
 * the pointer as it comes near. Pressed, it dips, then opens along a spring
 * into the field it was all along -- one object, not a button that summons an
 * input -- and the field fades in only once there is room for it. Escape, or
 * leaving it empty, folds it back.
 *
 * Controlled: `value` / `onChange(text)`. A non-empty value keeps it open, so
 * a filter that is doing something is never hidden behind an icon. */

const SHUT = 40;
const LENS = 18;

export function SeekField({ value, onChange, placeholder = "Search", label = "Search", width = 280 }) {
  const frame = useRef(null);
  const skin = useRef(null);
  const field = useRef(null);
  const beat = useRef(0);
  const [open, setOpen] = useState(() => Boolean(value));
  const [press, setPress] = useState(false);
  const [lean, setLean] = useState({ x: 0, y: 0 });
  const spring = useRef(null);

  if (!spring.current) {
    spring.current = createSpring({
      value: open ? width : SHUT,
      stiffness: 300,
      damping: 26,
      onFrame(w) {
        const el = skin.current;
        if (!el) return;
        const p = clamp((w - SHUT) / Math.max(1, width - SHUT), 0, 1);
        el.style.width = `${w.toFixed(2)}px`;
        el.style.setProperty("--say", clamp((p - 0.55) / 0.45, 0, 1).toFixed(3));
      },
    });
  }

  useEffect(() => {
    spring.current.to(open ? width : SHUT);
  }, [open, width]);

  useEffect(() => {
    spring.current.set(spring.current.get(), 0);
    return () => {
      spring.current.stop();
      window.clearTimeout(beat.current);
    };
  }, []);

  // A value set from outside (a cleared filter, a restored one) opens or
  // shuts it to match.
  useEffect(() => {
    if (value) setOpen(true);
  }, [value]);

  // The lean: shut, the button is drawn a few pixels toward a nearby pointer.
  useEffect(() => {
    const el = frame.current;
    if (!el || open || stillness()) return undefined;
    let raf = 0;
    let at = { x: 0, y: 0 };
    const publish = () => {
      raf = 0;
      setLean(at);
    };
    const read = (event) => {
      const b = el.getBoundingClientRect();
      const dx = event.clientX - (b.left + SHUT / 2);
      const dy = event.clientY - (b.top + b.height / 2);
      const d = Math.hypot(dx, dy);
      const R = 90;
      const pull = d > R ? 0 : (1 - d / R) ** 1.4 * 4;
      at = { x: (dx / (d || 1)) * pull, y: (dy / (d || 1)) * pull };
      if (!raf) raf = requestAnimationFrame(publish);
    };
    document.addEventListener("pointermove", read, { passive: true });
    return () => {
      document.removeEventListener("pointermove", read);
      cancelAnimationFrame(raf);
      setLean({ x: 0, y: 0 });
    };
  }, [open]);

  const start = () => {
    if (open) return;
    setPress(true);
    window.clearTimeout(beat.current);
    beat.current = window.setTimeout(
      () => {
        setPress(false);
        setOpen(true);
        field.current?.focus();
      },
      stillness() ? 0 : 90,
    );
  };

  return (
    <div
      ref={frame}
      className="seek"
      data-open={open ? "" : undefined}
      data-press={press ? "" : undefined}
      style={{ "--lx": `${lean.x.toFixed(2)}px`, "--ly": `${lean.y.toFixed(2)}px`, "--seek-h": `${SHUT}px`, "--lens": `${LENS}px` }}
    >
      <div ref={skin} className="seek-skin">
        <svg className="seek-lens" viewBox="0 0 18 18" aria-hidden="true">
          <circle cx="7.6" cy="7.6" r="5.4" />
          <path d="M11.6 11.6 L15.4 15.4" />
        </svg>
        <input
          ref={field}
          className="seek-field"
          type="search"
          value={value}
          placeholder={placeholder}
          aria-label={label}
          tabIndex={open ? 0 : -1}
          onChange={(event) => onChange(event.target.value)}
          onBlur={() => {
            if (!value.trim()) setOpen(false);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            onChange("");
            setOpen(false);
            field.current?.blur();
          }}
        />
        {open ? null : <button type="button" className="seek-hit" aria-label={label} onClick={start} />}
      </div>
    </div>
  );
}
