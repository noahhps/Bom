import { useRef } from "react";

import { FADE_MS, renderRevealed } from "../lib/reveal";
import { renderMarkdown } from "../lib/markdown";

/**
 * Markdown for a turn, with text that has just arrived still fading in.
 *
 * The chunk list is kept in refs and updated during render rather than in
 * state, exactly as QuickView's `FadingText` does: it is derived from `text`
 * alone, and putting it in state would mean a second render for every delta
 * of every turn.
 *
 * Chunks retire themselves by age. Once nothing has arrived for FADE_MS the
 * list is empty and the output is the same string `renderMarkdown` produced
 * before any of this existed -- a settled conversation carries no spans, no
 * animations, and nothing to clean up.
 */
export function useReveal(text, streaming) {
  const chunks = useRef([]);
  const prev = useRef("");

  const source = text || "";
  if (!streaming) {
    // Nothing is arriving, so nothing should be mid-fade. Anything already on
    // screen keeps the animation the browser is running for it; this only
    // stops the next render from re-marking settled text.
    if (chunks.current.length) chunks.current = [];
    prev.current = source;
    return { __html: renderMarkdown(source) };
  }

  const now = performance.now();
  if (source.length > prev.current.length && source.startsWith(prev.current)) {
    chunks.current.push({ start: prev.current.length, at: now });
  } else if (source !== prev.current) {
    // A different message in the same component -- a retry, or a reset. Show
    // it whole: it is not new text arriving, so there is nothing to fade.
    chunks.current = [];
  }
  prev.current = source;

  // Dropped here rather than at the point of use so the list cannot grow
  // without bound on a long reply.
  if (chunks.current.length) {
    const live = chunks.current.filter((c) => now - c.at < FADE_MS);
    if (live.length !== chunks.current.length) chunks.current = live;
  }

  return { __html: renderRevealed(source, chunks.current, now) };
}
