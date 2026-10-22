import { useLayoutEffect, useRef, useState } from "react";

import { Icon } from "../Icon";

/* A row of glyphs that swell toward the pointer, as Bencho's magnifying dock
 * (bencho.dev/blocks/dock, MIT).
 *
 * The item under the pointer grows most and lifts; its neighbours grow less
 * on a cosine falloff, so the row bulges like a lens passed along it. A pill
 * above names whatever is nearest and glides from item to item rather than
 * blinking between them, and a dot under the chosen one says which is on.
 *
 * Bom uses it as a picker (`value` / `onChange(key)`), so it is a radiogroup
 * rather than a nav, and each item can carry a small `count`. */

const MAGNIFY = 1.38;
const SPREAD = 2;
const LIFT = 7;

export function Dock({ items, value, onChange, label }) {
  const [hover, setHover] = useState(null);
  const bar = useRef(null);

  const nearest = (clientX) => {
    const nodes = bar.current?.querySelectorAll(".dock-item");
    if (!nodes?.length) return null;
    let best = 0;
    let gap = Infinity;
    nodes.forEach((el, i) => {
      const b = el.getBoundingClientRect();
      const d = Math.abs(clientX - (b.left + b.width / 2));
      if (d < gap) {
        gap = d;
        best = i;
      }
    });
    return best;
  };

  return (
    <div
      ref={bar}
      className="dock"
      role="radiogroup"
      aria-label={label}
      onPointerMove={(event) => {
        if (event.pointerType === "mouse") setHover(nearest(event.clientX));
      }}
      onPointerLeave={() => setHover(null)}
    >
      {items.map((item, i) => {
        const d = hover === null ? 99 : Math.abs(i - hover);
        const f = d > SPREAD ? 0 : (1 + Math.cos((Math.PI * d) / (SPREAD + 1))) / 2;
        const on = item.key === value;
        return (
          <button
            key={item.key}
            type="button"
            className="dock-item"
            role="radio"
            aria-checked={on}
            aria-label={item.count === undefined ? item.label : `${item.label}, ${item.count}`}
            data-on={on ? "" : undefined}
            data-near={d <= 1 ? d : undefined}
            onClick={() => onChange(item.key)}
          >
            <span
              className="dock-glyph"
              style={{ transform: `translateY(${(-LIFT * f).toFixed(2)}px) scale(${(1 + (MAGNIFY - 1) * f).toFixed(3)})` }}
            >
              <Icon name={item.icon} />
              {item.count !== undefined ? <span className="dock-count">{item.count}</span> : null}
            </span>
            <span className="dock-dot" />
          </button>
        );
      })}
      <DockTip bar={bar} at={hover} items={items} />
    </div>
  );
}

/* The name of the nearest item, in a pill that slides and resizes between
 * them. It keeps its last place while hidden, so it fades out where it was
 * rather than flying home. */
function DockTip({ bar, at, items }) {
  const [last, setLast] = useState(0);
  const [place, setPlace] = useState(null);
  const [ready, setReady] = useState(false);
  const word = useRef(null);
  if (at !== null && at !== last) setLast(at);

  useLayoutEffect(() => {
    const item = bar.current?.querySelectorAll(".dock-item")[last];
    if (!item || !word.current) return;
    const w = Math.ceil(word.current.scrollWidth) + 24;
    setPlace({ x: item.offsetLeft + item.offsetWidth / 2 - w / 2, w });
  }, [last, bar, items]);

  // One frame without a transition, so the first appearance does not slide
  // in from the left edge.
  useLayoutEffect(() => {
    if (!place || ready) return undefined;
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
  }, [place, ready]);

  return (
    <span
      className="dock-tip"
      aria-hidden="true"
      data-on={at !== null && place ? "" : undefined}
      data-ready={ready ? "" : undefined}
      style={place ? { width: place.w, transform: `translateX(${place.x}px)` } : undefined}
    >
      <span ref={word}>{items[last]?.label}</span>
    </span>
  );
}
