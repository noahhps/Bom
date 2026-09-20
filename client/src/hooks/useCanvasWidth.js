import { useCallback, useEffect, useRef, useState } from "react";

// A layout preference rather than data, so it lives beside the rail's width in
// localStorage rather than on the server: it belongs to this screen, and a
// phone and a desktop want different answers.
const KEY = "unified-llm-canvas-width";

// Narrower than this and a document is not worth reading in the panel; wider
// and the conversation it is meant to sit beside stops being usable.
const MIN = 320;
const MAX = 900;
// Whatever the window, this much has to be left for the thread.
const KEEP_FOR_SHEET = 360;
// What the panel opens at, and what a double-click on the handle returns to.
const DEFAULT = 480;

function clamp(px) {
  // A viewport of 0 means the window has not been laid out yet -- a background
  // tab, a restored session, a mount before first paint. Clamping against it
  // would drag a saved 700px down to the floor and write that back, so the
  // preference would quietly disappear. Treat an unmeasurable window as
  // unbounded and let MIN/MAX do the work alone.
  const vw = window.innerWidth || Infinity;
  const ceiling = Math.min(MAX, Math.max(MIN, vw - KEEP_FOR_SHEET));
  return Math.round(Math.min(ceiling, Math.max(MIN, px)));
}

/**
 * The width of the canvas panel, dragged by its left edge.
 *
 * The mirror of `useRailWidth`: the panel is docked right, so the handle is on
 * its inner edge and dragging *left* makes it wider -- hence the inverted
 * delta. `resizing` comes back for the same reason it does there: the width
 * transition has to come off during a drag or the panel lags the pointer.
 *
 * Desktop only. Below 900px the canvas is a full overlay rather than a column
 * beside the thread, so there is no width to choose and a 9px handle would be
 * no use to a finger anyway.
 */
export function useCanvasWidth() {
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem(KEY));
    return Number.isFinite(saved) && saved > 0 ? clamp(saved) : DEFAULT;
  });
  const [resizing, setResizing] = useState(false);
  const [wide, setWide] = useState(
    () => window.matchMedia("(min-width: 901px)").matches,
  );

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 901px)");
    const sync = () => setWide(mq.matches);
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  // Read inside a pointermove handler created once, so it cannot see the
  // `width` from the render it closed over.
  const live = useRef(width);
  live.current = width;

  const commit = useCallback((px) => {
    const next = clamp(px);
    live.current = next;
    setWidth(next);
    return next;
  }, []);

  const start = useCallback(
    (event) => {
      // Stops the drag selecting the text either side of the handle.
      event.preventDefault();
      const originX = event.clientX;
      const originW = live.current;
      setResizing(true);

      // Inverted against the rail: this panel grows leftwards.
      const move = (moved) => commit(originW - (moved.clientX - originX));
      const stop = () => {
        window.removeEventListener("pointermove", move);
        setResizing(false);
        localStorage.setItem(KEY, String(live.current));
      };

      // On window rather than on the handle: the pointer routinely outruns a
      // 7px target, and losing the drag because it did would make the handle
      // feel broken rather than precise.
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", stop, { once: true });
      window.addEventListener("pointercancel", stop, { once: true });
    },
    [commit],
  );

  // The separator is focusable, so it answers to the keyboard too -- and the
  // arrows are mirrored to match which way the panel actually grows.
  const nudge = useCallback(
    (event) => {
      const step = event.shiftKey ? 48 : 16;
      let next = null;
      if (event.key === "ArrowLeft") next = live.current + step;
      else if (event.key === "ArrowRight") next = live.current - step;
      else if (event.key === "Home") next = MAX;
      else if (event.key === "End") next = MIN;
      // Sent by the handle's double-click, not by a keyboard.
      else if (event.key === "Reset") next = DEFAULT;
      if (next === null) return;
      event.preventDefault();
      localStorage.setItem(KEY, String(commit(next)));
    },
    [commit],
  );

  // A window narrow enough to break the clamp has to pull the panel in with
  // it, or the conversation is squeezed to nothing on a resize.
  useEffect(() => {
    const onResize = () => {
      setWidth((w) => clamp(w));
      setWide(window.matchMedia("(min-width: 901px)").matches);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return { width, resizing, start, nudge, enabled: wide, min: MIN, max: MAX };
}
