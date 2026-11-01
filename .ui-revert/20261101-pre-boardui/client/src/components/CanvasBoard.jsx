import { useId } from "react";

import { BOARD, PLANS, installMotion, scalePath } from "../lib/drawkit";

/**
 * A marker drawing on a board -- what a write_canvas call shows while it runs.
 *
 * Three drawings, one per kind of canvas, so what is drawn says what is being
 * made: a wireframe for a page, a scribble for prose, the canvas glyph's own
 * zig-zag for code. `sketchFor` in lib/drawkit picks one from the call's
 * arguments. The timelines are generated there too; this only lays the parts
 * out.
 *
 * The marker is an HTML element riding `offset-path` over the SVG rather than a
 * shape inside it. offset-path on an HTML box is the settled part of that
 * spec, and it is exact: the path is scaled to the board's pixels here, and
 * because offset-distance and the strokes' dashes both measure arc length, the
 * tip sits on the end of the line in every frame.
 *
 * At rest -- reduced motion, where every animation is off -- each part falls
 * back to its finished state: the drawing complete, the marker and eraser
 * gone.
 */

installMotion();

const NIB = (
  <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
    <path className="board-nib-body" d="M3.8 10.8 L12.8 1.8 Q14.2 0.4 15.6 1.8 L16.2 2.4 Q17.6 3.8 16.2 5.2 L7.2 14.2 Z" />
    <path className="board-nib-band" d="M11.2 3.4 L14.6 6.8" />
    <path className="board-nib-collar" d="M2.4 12.2 L3.8 10.8 L7.2 14.2 L5.8 15.6 Z" />
    <path className="board-nib-tip" d="M0.5 17.5 L2.4 12.2 L5.8 15.6 Z" />
  </svg>
);

export function CanvasBoard({ sketch, scale = 1.25 }) {
  const mask = `board-mask-${useId().replace(/[^a-zA-Z0-9-]/g, "")}`;
  const plan = PLANS[sketch] || PLANS.scribble;
  const w = BOARD.w * scale;
  const h = BOARD.h * scale;

  const ink = plan.strokes.map((s) => (
    <path
      key={s.cls}
      className={`board-stroke ${s.cls}`}
      pathLength="100"
      d={s.d}
      style={{ strokeWidth: s.width }}
    />
  ));

  return (
    <span className="board" style={{ width: w, height: h }} role="img" aria-label="Drawing on the canvas">
      <svg viewBox={`0 0 ${BOARD.w} ${BOARD.h}`} width={w} height={h} aria-hidden="true">
        {/* The canvas glyph's own frame -- the same rounded rectangle, scaled
            -- and a ledge under it, which is what makes it a board. */}
        <rect className="board-frame" x="4" y="4" width="88" height="50" rx="5" />
        <path className="board-ledge" d="M24 58.5 L72 58.5" />
        {plan.wipe ? (
          <>
            <defs>
              <mask id={mask} maskUnits="userSpaceOnUse" x="-10" y="-10" width={BOARD.w + 20} height={BOARD.h + 20}>
                <rect className={`board-${plan.id}-mask`} x="0" y="-10" width={BOARD.w + 20} height={BOARD.h + 20} fill="#fff" />
              </mask>
            </defs>
            <g className="board-ink" mask={`url(#${mask})`}>
              {ink}
            </g>
            {/* Tall enough to cover every drawing's ink top to bottom, so the
                line being rubbed out is always under the block. */}
            <g className={`board-eraser board-${plan.id}-eraser`}>
              <rect className="board-eraser-block" x="-5.5" y="10.5" width="11" height="39" rx="2.5" />
              <rect className="board-eraser-felt" x="-5.5" y="44" width="11" height="5.5" rx="1.5" />
            </g>
          </>
        ) : (
          <g className="board-ink">{ink}</g>
        )}
      </svg>
      <span className={`board-nib board-${plan.id}-pen`} style={{ offsetPath: `path('${scalePath(plan.pen, scale)}')` }}>
        {NIB}
      </span>
    </span>
  );
}
