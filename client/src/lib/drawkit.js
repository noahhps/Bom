/* The motion kit: the flower's Bloom and the canvas boards.
 *
 * Both are CSS animations whose parts each need their own moment inside one
 * shared cycle -- eight petals opening one after another but closing
 * together; a marker's strokes drawn one after another but wiped together.
 * `animation-delay` cannot say that, because a delay moves a part's end along
 * with its start. So every part gets its own keyframes, written here as a
 * timeline in milliseconds and turned into percentages, rather than as
 * columns of percentages in the stylesheet that all have to be worked out
 * again the moment one duration changes.
 *
 * Everything in this file is pure -- strings in, strings out -- so the test
 * suite runs it under node. The one function that touches the page is
 * `installMotion`, which puts the generated CSS in a <style> once.
 */

const SOFT = "cubic-bezier(.45,0,.55,1)";
const DRAW = "cubic-bezier(.4,.05,.35,1)"; // a pen stroke: sets off briskly, eases in to finish

/* -- keyframes from a timeline ---------------------------------------------- */

function pct(ms, cycle) {
  return `${+((ms / cycle) * 100).toFixed(3)}%`;
}

/**
 * One animated part. `points` are [ms, declarations, easing-to-next?], from 0
 * to `cycle` and strictly increasing -- a timeline that runs backwards is a
 * mistake in the numbers above it, and is thrown rather than drawn.
 */
export function keyframes(name, cycle, points) {
  if (points[0][0] !== 0 || points[points.length - 1][0] !== cycle) {
    throw new Error(`${name}: must run from 0 to ${cycle}`);
  }
  for (let i = 1; i < points.length; i++) {
    if (points[i][0] <= points[i - 1][0]) {
      throw new Error(`${name}: time runs backwards at ${points[i][0]}ms`);
    }
  }
  const body = points
    .map(([ms, decl, ease]) => `  ${pct(ms, cycle)} { ${decl}${ease ? `; animation-timing-function: ${ease}` : ""}; }`)
    .join("\n");
  return `@keyframes ${name} {\n${body}\n}\n`;
}

/** A class running one looped animation, and that animation. */
function track(cls, cycle, points) {
  return (
    `.${cls} { animation: k-${cls} calc(${cycle / 1000}s * var(--motion-speed, 1)) linear infinite; }\n` +
    keyframes(`k-${cls}`, cycle, points)
  );
}

/* -- Bloom -------------------------------------------------------------------
 *
 * The flower opening a petal at a time, then folding away.
 *
 * Nothing fades. Every petal is scaled about the flower's centre, and at 0.3
 * its tip is at radius 4 against a face of 6.5 -- so a closed petal is not
 * transparent, it is tucked under the face. Opening, a petal grows out from
 * behind the face with a small overshoot; closing, all eight retract under it
 * together. The two rests -- the whole flower held, and the bare face after --
 * are what make it a cycle rather than a churn: without the hold, eight petals
 * opening and at once shutting read as a shiver; without the beat, the first
 * petal of the next flower leaves in the frame the last one arrived.
 *
 *      0  petal 0 starts out from under the face
 *    130  petal 1, and on every 130ms
 *   1250  petal 7 settles -- the flower is whole
 *   1700  a 450ms hold, then all eight retract
 *   2200  all eight back under the face (500ms)
 *   2400  a 200ms beat on the bare face, then round again
 */
export const BLOOM = {
  step: 130, // between one petal opening and the next
  peak: 240, // into a petal's own opening, where it overshoots
  settle: 340, // a petal's whole opening
  hold: 450, // the whole flower, before it starts to close
  shutFor: 500, // all eight retracting, together
  beat: 200, // the bare face, before it opens again
  tucked: 0.3,
  overshoot: 1.08,
};

export function bloomTimeline(b = BLOOM) {
  const whole = 7 * b.step + b.settle;
  const shut = whole + b.hold;
  return { whole, shut, cycle: shut + b.shutFor + b.beat };
}

/**
 * Eight keyframe sets, one per petal, each carrying the petal's own 45-degree
 * slot so the arm keeps its place on the ring while it scales.
 */
export function bloomCSS(b = BLOOM) {
  const { shut, cycle } = bloomTimeline(b);
  let css = "";
  for (let i = 0; i < 8; i++) {
    const at = (s) => `transform: rotate(${i * 45}deg) scale(${s})`;
    const open = i * b.step;
    const points = [];
    if (open > 0) points.push([0, at(b.tucked)]);
    points.push(
      [open, at(b.tucked), "cubic-bezier(.16,.9,.3,1)"],
      [open + b.peak, at(b.overshoot), "cubic-bezier(.4,0,.3,1)"],
      [open + b.settle, at(1)],
      [shut, at(1), "cubic-bezier(.55,0,.35,1)"],
      [shut + b.shutFor, at(b.tucked)],
      [cycle, at(b.tucked)],
    );
    css +=
      `.flower[data-bloom] .flower-petal:nth-child(${i + 1}) ` +
      `{ animation: flower-bloom-${i} ${cycle / 1000}s linear infinite; }\n` +
      keyframes(`flower-bloom-${i}`, cycle, points);
  }
  return css;
}

/* -- measuring a path ----------------------------------------------------------
 *
 * The boards' marker needs each stroke's length, to know what share of its
 * joined path a stroke is. The browser can measure a <path>, but only one in
 * the page; this measures the string, which is all the paths here need --
 * every one is written in absolute M / L / C / Q commands -- and keeps the
 * kit free of the DOM. Curves are flattened into 64 chords each, which is
 * within a hundredth of a percent of the browser's own figure at these sizes.
 */
export function measure(d) {
  const tokens = d.match(/[MLCQ]|-?\d*\.?\d+(?:e-?\d+)?/g) || [];
  let i = 0;
  let cmd = null;
  let x = 0;
  let y = 0;
  let start = null;
  let length = 0;
  const num = () => parseFloat(tokens[i++]);
  // `pts` is the current point then the command's own: 8 numbers for a cubic,
  // 6 for a quadratic.
  const curve = (pts) => {
    const n = 64;
    let px = x;
    let py = y;
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      const u = 1 - t;
      let qx;
      let qy;
      if (pts.length === 8) {
        qx = u * u * u * pts[0] + 3 * u * u * t * pts[2] + 3 * u * t * t * pts[4] + t * t * t * pts[6];
        qy = u * u * u * pts[1] + 3 * u * u * t * pts[3] + 3 * u * t * t * pts[5] + t * t * t * pts[7];
      } else {
        qx = u * u * pts[0] + 2 * u * t * pts[2] + t * t * pts[4];
        qy = u * u * pts[1] + 2 * u * t * pts[3] + t * t * pts[5];
      }
      length += Math.hypot(qx - px, qy - py);
      px = qx;
      py = qy;
    }
  };
  while (i < tokens.length) {
    if (/[MLCQ]/.test(tokens[i])) cmd = tokens[i++];
    if (cmd === "M") {
      x = num();
      y = num();
      if (!start) start = [x, y];
      cmd = "L"; // coordinates after an M's first pair are line-tos
    } else if (cmd === "L") {
      const nx = num();
      const ny = num();
      length += Math.hypot(nx - x, ny - y);
      x = nx;
      y = ny;
    } else if (cmd === "C") {
      const p = [x, y, num(), num(), num(), num(), num(), num()];
      curve(p);
      x = p[6];
      y = p[7];
    } else if (cmd === "Q") {
      const p = [x, y, num(), num(), num(), num()];
      curve(p);
      x = p[4];
      y = p[5];
    } else {
      throw new Error(`measure: unsupported path data near "${tokens[i]}"`);
    }
  }
  return { length, start, end: [x, y] };
}

/** Every path here is absolute with its origin at 0,0, so scaling it is
 *  scaling every number in it. */
export function scalePath(d, k) {
  return d.replace(/-?\d*\.?\d+/g, (n) => String(+(parseFloat(n) * k).toFixed(2)));
}

/* A seeded generator, so a "random" scribble is the same scribble on every
   load and in every screenshot. */
function seeded(seed) {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* Points to a smooth path, Catmull-Rom as cubic Beziers. */
function smooth(pts) {
  const f = (v) => v.toFixed(1);
  let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    d +=
      ` C${f(p1[0] + (p2[0] - p0[0]) / 6)} ${f(p1[1] + (p2[1] - p0[1]) / 6)}` +
      ` ${f(p2[0] - (p3[0] - p1[0]) / 6)} ${f(p2[1] - (p3[1] - p1[1]) / 6)}` +
      ` ${f(p2[0])} ${f(p2[1])}`;
  }
  return d;
}

/* A scribble: loops travelling along a line -- a prolate trochoid -- with
   every loop its own size and the line drifting a little, which is the
   difference between a hand and a spirograph. */
export function scribblePath(x0, x1, yc, loops, seed) {
  const rnd = seeded(seed);
  const radii = [];
  const pts = [];
  const per = 9;
  for (let i = 0; i <= loops + 1; i++) radii.push(6 + rnd() * 3.5);
  const T = 2 * Math.PI * loops;
  const a = (x1 - x0) / T;
  for (let k = 0; k <= per * loops; k++) {
    const t = (T * k) / (per * loops);
    const u = t / (2 * Math.PI);
    const j = Math.floor(u);
    const f = u - j;
    const r = radii[j] * (1 - f) + radii[Math.min(j + 1, radii.length - 1)] * f;
    pts.push([x0 + a * t + r * 0.85 * Math.sin(t), yc + r * Math.cos(t) - 1.5 * Math.sin(u * 1.3)]);
  }
  return smooth(pts);
}

/* -- the canvas boards -----------------------------------------------------------
 *
 * Shown while a turn is writing to the canvas: a marker drawing on a board,
 * so the wait looks like the work it is waiting on. One drawing per kind of
 * canvas, so what is drawn says what is being made:
 *
 *   html      Wireframe -- a page roughed out: title, picture, text, button
 *   markdown  Scribble  -- loops across the board, the look of handwriting
 *   code      Zig-zag   -- the canvas glyph's own trail, drawn stroke for stroke
 *
 * Every drawing sits in a 96x64 box; the board is the canvas glyph's frame --
 * the same rounded rectangle, scaled -- with a ledge under it.
 */
export const BOARD = { w: 96, h: 64 };

/* Where the eraser starts and stops: inside the frame at both ends (it spans
   4-92) and clear of the ink on both sides (13-82), so it never hangs off the
   board and its edge has crossed every stroke before it stops. */
const WIPE_FROM = 10;
const WIPE_TO = 86;

export const SKETCHES = {
  scribble: {
    cycle: 3800,
    strokes: [{ d: scribblePath(14, 81, 29, 5, 7), at: 350, dur: 1800, width: 2.2 }],
    end: { mode: "wipe", at: 2750, dur: 650 },
  },
  // The canvas glyph's trail from Icon.jsx, scaled five times and centred:
  // every run still exactly 45 degrees, every turn the same quadratic. It
  // leaves the way it came, off its far end.
  zigzag: {
    cycle: 2900,
    strokes: [
      {
        d: "M20.5 39 L33.45 26.05 Q40.5 19 47.55 26.05 L50.95 29.45 Q58 36.5 65.05 29.45 L75.5 19",
        at: 300,
        dur: 1000,
        width: 3.4,
      },
    ],
    end: { mode: "run", at: 2000, dur: 550 },
  },
  // Each closed shape spells out its closing line rather than using Z: in the
  // marker's joined path a Z would close back to the drawing's very first point.
  wireframe: {
    cycle: 5500,
    strokes: [
      { d: "M14 14 C17 12 20 16 23 14 C26 12 29 16 32 14 C35 12 38 16 41 14", at: 300, dur: 420, width: 2.4 },
      { d: "M14 21 L41 21 L41 45 L14 45 L14 21", at: 850, dur: 520, width: 1.6, ease: SOFT },
      { d: "M16 43 L23 34 L28 39 L32 33 L39 43", at: 1500, dur: 380, width: 1.6 },
      { d: "M49 23 C52 21.5 55 24.5 58 23 C61 21.5 64 24.5 67 23 C70 21.5 73 24.5 78 23", at: 2000, dur: 340, width: 1.8 },
      { d: "M49 29 C52 27.5 55 30.5 58 29 C61 27.5 64 30.5 67 29 C70 27.5 72 30 74 29", at: 2460, dur: 300, width: 1.8 },
      { d: "M49 35 C52 33.5 55 36.5 58 35 C61 33.5 63 36 65 35", at: 2880, dur: 220, width: 1.8 },
      { d: "M51 41 L67 41 Q70 41 70 44 Q70 47 67 47 L51 47 Q48 47 48 44 Q48 41 51 41", at: 3220, dur: 420, width: 1.6, ease: SOFT },
    ],
    end: { mode: "wipe", at: 4300, dur: 650 },
  },
};

/** Which drawing a write_canvas call gets, from its arguments -- normalised
 *  the way the server stores the kind: unknown becomes code when a language
 *  was named, markdown otherwise. */
export function sketchFor(args = {}) {
  const kind = String(args.kind || "").trim().toLowerCase();
  const known = { html: "wireframe", markdown: "scribble", code: "zigzag" }[kind];
  if (known) return known;
  return String(args.language || "").trim() ? "zigzag" : "scribble";
}

/* A dash of 100 on and 104 off against a pathLength of 100: "hidden" (offset
   102) puts the dash wholly before the start and the next one wholly after
   the end. With 100/100, hidden leaves a dash ending exactly on the first
   point, and a round cap draws a dot there before the stroke has begun. */
const HID = "stroke-dashoffset: 102";
const SHOWN = "stroke-dashoffset: 0";
const GONE = "stroke-dashoffset: -102";

function strokeTrack(cls, cycle, s, end) {
  const points = [
    [0, `${HID}; opacity: 1`],
    [s.at, `${HID}; opacity: 1`, s.ease || DRAW],
    [s.at + s.dur, `${SHOWN}; opacity: 1`],
  ];
  if (end.mode === "cut") {
    // Gone in one frame, under a wipe that has already hidden it, so it is not
    // sitting there drawn when the wipe's mask resets.
    points.push([end.at, `${SHOWN}; opacity: 1`], [end.at + 1, `${HID}; opacity: 1`]);
  } else {
    points.push([end.at, `${SHOWN}; opacity: 1`, SOFT], [end.at + end.dur, `${GONE}; opacity: 1`]);
  }
  points.push([cycle, points[points.length - 1][1]]);
  return track(cls, cycle, points);
}

/**
 * Everything a board needs: the strokes with their classes, the marker's
 * joined path, the moment the drawing is finished, and the CSS.
 *
 * There is one marker however many strokes there are. Its path is every stroke
 * joined end to start by a straight hop, and its keyframes map each stroke's
 * window onto that stroke's stretch of the joined path; between strokes it
 * lifts, travels the hop, and comes down on the next. offset-distance and a
 * pathLength dash are both proportional to arc length, so with the same easing
 * the marker's tip sits on the end of the line in every frame.
 */
export function sketchPlan(id, sketch = SKETCHES[id]) {
  const C = sketch.cycle;
  const wipe = sketch.end.mode === "wipe";
  const strokeEnd = wipe ? { mode: "cut", at: sketch.end.at + sketch.end.dur } : sketch.end;
  let css = "";
  let pen = "";
  let total = 0;
  let last = null;

  const strokes = sketch.strokes.map((s, i) => {
    const cls = `board-${id}-s${i}`;
    css += strokeTrack(cls, C, s, strokeEnd);
    const m = measure(s.d);
    if (last) {
      total += Math.hypot(m.start[0] - last[0], m.start[1] - last[1]);
      pen += ` L${m.start[0]} ${m.start[1]}${s.d.replace(/^M\s*-?[\d.]+[\s,]+-?[\d.]+/, "")}`;
    } else {
      pen = s.d;
    }
    const from = total;
    total += m.length;
    last = m.end;
    return { ...s, cls, from, to: total };
  });

  const at = (dist, shown, lifted) =>
    `offset-distance: ${+((dist / total) * 100).toFixed(3)}%; opacity: ${shown}; translate: ${lifted ? "2px -4px" : "0px 0px"}`;
  const first = strokes[0];
  const final = strokes[strokes.length - 1];
  const penPoints = [
    [0, at(first.from, 0, true)],
    [first.at - 180, at(first.from, 0, true), SOFT],
  ];
  strokes.forEach((s, i) => {
    const next = strokes[i + 1];
    penPoints.push([s.at, at(s.from, 1, false), s.ease || DRAW]);
    penPoints.push([s.at + s.dur, at(s.to, 1, false), SOFT]);
    if (next) penPoints.push([(s.at + s.dur + next.at) / 2, at((s.to + next.from) / 2, 1, true), SOFT]);
  });
  const drawn = final.at + final.dur + 200;
  penPoints.push([drawn, at(final.to, 0, true)], [C, at(final.to, 0, true)]);
  css += track(`board-${id}-pen`, C, penPoints);

  if (wipe) {
    const w0 = sketch.end.at;
    const w1 = sketch.end.at + sketch.end.dur;
    const from = `transform: translateX(${WIPE_FROM}px)`;
    const to = `transform: translateX(${WIPE_TO}px)`;
    css += track(`board-${id}-mask`, C, [[0, from], [w0, from, SOFT], [w1, to], [C - 1, to], [C, from]]);
    css += track(`board-${id}-eraser`, C, [
      [0, `${from}; opacity: 0`],
      [w0 - 200, `${from}; opacity: 0`, SOFT],
      [w0, `${from}; opacity: 1`, SOFT],
      [w1, `${to}; opacity: 1`, SOFT],
      [w1 + 200, `${to}; opacity: 0`],
      [C, `${to}; opacity: 0`],
    ]);
  }

  return { id, strokes, pen, wipe, drawn, cycle: C, css };
}

export const PLANS = Object.fromEntries(Object.keys(SKETCHES).map((id) => [id, sketchPlan(id)]));

/* -- installing ------------------------------------------------------------------ */

let installed = false;

/** Puts the generated CSS in the page, once. The static look of the flower
 *  and the boards lives in styles.css; this is only their timelines. */
export function installMotion() {
  if (installed || typeof document === "undefined") return;
  installed = true;
  const style = document.createElement("style");
  style.id = "motion-kit";
  style.textContent = bloomCSS() + Object.values(PLANS).map((p) => p.css).join("");
  document.head.appendChild(style);
}
