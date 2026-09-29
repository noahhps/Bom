import { useCallback, useEffect, useRef, useState } from "react";

// A layout preference, kept beside the rail's and canvas's widths.
const KEY = "unified-llm-read-width";
const MIN = 480;
const MAX = 1500;
// Air left either side of the column so its handles stay reachable.
const GUTTER = 24;

/**
 * How wide the conversation column is, dragged by either of its edges.
 *
 * The column is centred, so an edge moves half as far as the width changes:
 * dragging one edge by d changes the width by 2d. `null` means "the stylesheet
 * default" (`--read-w`), which follows the window until someone chooses.
 */
export function useReadWidth(screenRef) {
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem(KEY));
    return Number.isFinite(saved) && saved > 0 ? saved : null;
  });
  const [resizing, setResizing] = useState(false);
  const live = useRef(width);
  live.current = width;

  const clamp = useCallback(
    (px) => {
      const room = (screenRef.current?.clientWidth || Infinity) - GUTTER * 2;
      return Math.round(Math.min(MAX, Math.max(MIN, Math.min(px, room))));
    },
    [screenRef],
  );

  const commit = useCallback(
    (px) => {
      const next = px === null ? null : clamp(px);
      live.current = next;
      setWidth(next);
      return next;
    },
    [clamp],
  );

  const save = (v) => {
    try {
      if (v === null) localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, String(v));
    } catch {}
  };

  // The column as drawn, for a drag that begins before anyone chose a width.
  const drawn = () => screenRef.current?.querySelector(".messages > *, .composer-box")?.getBoundingClientRect().width;

  const start = useCallback(
    (side) => (event) => {
      event.preventDefault();
      const originX = event.clientX;
      const originW = live.current ?? drawn() ?? 780;
      const dir = side === "left" ? -1 : 1;
      setResizing(true);
      const move = (m) => commit(originW + 2 * dir * (m.clientX - originX));
      const stop = () => {
        window.removeEventListener("pointermove", move);
        setResizing(false);
        save(live.current);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", stop, { once: true });
      window.addEventListener("pointercancel", stop, { once: true });
    },
    [commit],
  );

  const nudge = useCallback(
    (side) => (event) => {
      const step = (event.shiftKey ? 48 : 16) * 2;
      const dir = side === "left" ? -1 : 1;
      const cur = live.current ?? drawn() ?? 780;
      let next;
      if (event.key === "ArrowRight") next = cur + dir * step;
      else if (event.key === "ArrowLeft") next = cur - dir * step;
      else if (event.key === "Home") next = MAX;
      else if (event.key === "End") next = MIN;
      else if (event.key === "Reset") next = null;
      else return;
      event.preventDefault();
      save(commit(next));
    },
    [commit],
  );

  // A narrowing window pulls a chosen width in with it.
  useEffect(() => {
    const onResize = () => {
      if (live.current !== null) setWidth(clamp(live.current));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [clamp]);

  return { width, resizing, start, nudge };
}
