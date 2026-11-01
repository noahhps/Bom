import { useEffect, useRef } from "react";

/**
 * The working label: a word that codes itself away and settles back in.
 *
 * A front runs left to right over what is on screen, turning each letter back
 * into noise, and resizes the line as it goes -- from the length that is there
 * to the length of the word that is coming -- so a longer word grows out to
 * the right under the front and a shorter one is eaten back from the right.
 * Then the new word settles out of the noise, a letter at a time. When the
 * word has not changed it does the same to itself, which is what keeps the
 * label moving through a long wait; when it has, the change is picked up at
 * once -- mid-settle or mid-pause -- rather than after the stale word is done.
 *
 * `word` has to be true -- see `workingWord` for where it comes from.
 *
 * Driven by timers on the DOM directly rather than by state: it changes a
 * letter every 45-70ms, and a render per letter would re-run the whole answer
 * it sits in. React renders an empty span and never looks inside it.
 */

const GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ#%&$*+=~";
const GAP = " ";

/* The sweep runs at a fixed rate per letter rather than a fixed total: it is
   one front travelling across the line, and a front that sped up for a long
   word would not read as one thing moving. The settle has no front -- it is a
   coin flip per tick -- so there the total is held steady instead, and a long
   word arrives in about the time a short one does. */
const HOLD = 950;
const SWEEP = 45;
const TICK = 70;
const TICKS = 14;

const noise = () => GLYPHS[Math.floor(Math.random() * GLYPHS.length)];

export function Decode({ word, className }) {
  const box = useRef(null);
  const target = useRef(word);
  const nudge = useRef(null);
  target.current = word;

  useEffect(() => {
    nudge.current?.();
  }, [word]);

  useEffect(() => {
    const el = box.current;
    let shown = null; // the word settled on screen, once there is one
    // Every pending timer, for the cleanup. Each phase keeps its own handle:
    // a phase ends by starting the next one from inside its own tick, and a
    // single shared handle would by then name the new timer -- so the old one
    // would cancel its successor and keep running itself.
    const live = new Set();

    // One <i> per letter, added and removed as the line grows and shrinks,
    // and written to only when its glyph actually changes.
    const fit = (len) => {
      while (el.children.length > len) el.lastChild.remove();
      while (el.children.length < len) el.appendChild(document.createElement("i"));
      return el.children;
    };
    const put = (cell, ch, settled) => {
      if (cell.textContent !== ch) cell.textContent = ch;
      if (settled !== cell.hasAttribute("data-settled")) {
        if (settled) cell.setAttribute("data-settled", "");
        else cell.removeAttribute("data-settled");
      }
    };
    // Both return the function that cancels them.
    const every = (ms, step) => {
      const t = setInterval(() => {
        if (step() === false) {
          clearInterval(t);
          live.delete(t);
        }
      }, ms);
      live.add(t);
      return () => {
        clearInterval(t);
        live.delete(t);
      };
    };
    const after = (ms, fn) => {
      const t = setTimeout(() => {
        live.delete(t);
        fn();
      }, ms);
      live.add(t);
      return () => {
        clearTimeout(t);
        live.delete(t);
      };
    };

    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      // The word, as it is, whenever it changes.
      const show = () => {
        const w = target.current;
        const cells = fit(w.length);
        for (let i = 0; i < w.length; i++) put(cells[i], w[i] === " " ? GAP : w[i], true);
      };
      show();
      nudge.current = show;
      return () => {
        nudge.current = null;
      };
    }

    let phase = null; // "sweep" | "settle" | "hold"
    let stop = null; // cancels whatever the current phase has pending

    // Coding what is on screen away, resizing the line as the front travels.
    //
    // It starts from the cells as they are, not from a word: a change can
    // arrive mid-settle, when some letters are in and the rest are noise, and
    // the sweep has to carry on from exactly that. Ahead of the front a
    // settled letter stays and noise stays noise. Behind it everything is
    // noise, and so is any cell past the old end: that is the new room, and
    // it should arrive as static, not as blank.
    //
    // The word it is heading for is read on every tick, so a change during
    // the sweep simply retargets it.
    const sweep = () => {
      phase = "sweep";
      const from = [...el.children].map((c) => ({ ch: c.textContent, settled: c.hasAttribute("data-settled") }));
      const n = from.length;
      let k = -1;
      stop = every(SWEEP, () => {
        const to = target.current;
        const m = to.length;
        k++;
        if (k >= m) {
          settle(to);
          return false;
        }
        const len = Math.round(n + ((m - n) * (k + 1)) / m);
        const cells = fit(len);
        for (let i = 0; i < len; i++) {
          if (i <= k || i >= n || !from[i].settled) put(cells[i], noise(), false);
          else put(cells[i], from[i].ch, true);
        }
      });
    };

    // The word settling out of the noise, left to right. A space is never
    // scrambled and never waited for, so the shape of a phrase is legible
    // before a letter of it is.
    const settle = (w) => {
      phase = "settle";
      let settled = 0;
      const gap = (i) => w[i] === " ";
      const odds = Math.min(0.8, w.length / TICKS);
      stop = every(TICK, () => {
        if (Math.random() < odds && settled < w.length) {
          while (settled < w.length && gap(settled)) settled++;
          if (settled < w.length) settled++;
          while (settled < w.length && gap(settled)) settled++;
        }
        const cells = fit(w.length);
        for (let i = 0; i < w.length; i++) {
          if (i < settled || gap(i)) put(cells[i], gap(i) ? GAP : w[i], true);
          else put(cells[i], noise(), false);
        }
        if (settled >= w.length) {
          shown = w;
          hold();
          return false;
        }
      });
    };

    const hold = () => {
      phase = "hold";
      if (target.current !== shown) {
        sweep();
        return;
      }
      stop = after(HOLD, sweep);
    };

    // A new word interrupts a settle or a hold at once -- they are carrying a
    // word that is no longer true -- and the sweep starts from whatever is on
    // screen. A sweep already in flight is left alone: it reads the newest
    // word as it goes.
    nudge.current = () => {
      if (phase === "sweep") return;
      stop?.();
      sweep();
    };

    // The first word has nothing to code away: the sweep runs over an empty
    // line, which draws it out as noise from the left, and it settles from there.
    sweep();
    return () => {
      for (const t of live) {
        clearTimeout(t);
        clearInterval(t);
      }
      nudge.current = null;
    };
  }, []);

  return (
    <span className="decode">
      <span ref={box} className={className} aria-hidden="true" />
      {/* The real word for a screen reader; the letters above are noise half
          the time and say nothing to one. */}
      <span className="sr-only">{word}</span>
    </span>
  );
}
