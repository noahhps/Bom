import { useCallback, useEffect, useRef, useState } from "react";

// Under a pixel of scroll left counts as the end: a fractional scrollTop at
// some zoom levels never quite reaches scrollHeight - clientHeight.
const END_PX = 1;

/**
 * Whether a scroll box has more below what it shows -- for a cue that says so,
 * such as the fade at the foot of the rail's conversation list.
 *
 * A cue like that is a state, not an edge: it belongs on a box that is cut
 * off, and nowhere else. Drawn unconditionally it is a line across the bottom
 * of a list that fits, and still there once you have scrolled to the end.
 *
 * Re-measured when the box scrolls, when it changes size (the list unfolding,
 * the window or the rail resizing), and when `content` changes -- pass what
 * the box renders, so rows arriving or leaving count. A ref callback rather
 * than a ref object, so a box that mounts later (the list is only there while
 * the rail is open) is still the one being watched.
 */
export function useMoreBelow(content) {
  const [node, setNode] = useState(null);
  const [more, setMore] = useState(false);
  const frame = useRef(0);

  const measure = useCallback((el) => {
    if (!el) return;
    setMore(el.scrollHeight - el.scrollTop - el.clientHeight > END_PX);
  }, []);

  useEffect(() => {
    if (!node) {
      setMore(false);
      return undefined;
    }
    measure(node);
    // Scroll events arrive many to a frame; one measurement per frame is all
    // the cue can show anyway.
    const onScroll = () => {
      cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(() => measure(node));
    };
    node.addEventListener("scroll", onScroll, { passive: true });
    const resized = new ResizeObserver(() => measure(node));
    resized.observe(node);
    return () => {
      cancelAnimationFrame(frame.current);
      node.removeEventListener("scroll", onScroll);
      resized.disconnect();
    };
  }, [node, measure]);

  // New or removed rows change what there is to scroll without resizing the
  // box itself, which is fixed by the column it fills.
  useEffect(() => {
    measure(node);
  }, [node, content, measure]);

  return [setNode, more];
}
