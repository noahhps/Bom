// Text that appears as it arrives, for markdown that is re-rendered whole.
//
// QuickView does this by giving each arriving chunk its own element and
// letting React keep that element alive while it fades. The main thread
// cannot: it renders markdown to an HTML string and hands that to
// `dangerouslySetInnerHTML`, so every node is destroyed and rebuilt on every
// delta. A CSS animation on a node that is replaced fifteen times a second
// restarts fifteen times a second, and the reply sits permanently at opacity
// zero.
//
// So the age is carried in the markup instead of in the element's identity.
// Each fading run is emitted with a negative `animation-delay` equal to how
// long ago its text arrived: a run that is 300ms old starts its 420ms fade
// 300ms in, which is where it would have been had it survived. Rebuilding the
// node changes nothing, because nothing about the animation depends on the
// node having existed before.
//
// The spans are woven into the markdown *source* as sentinels and turned into
// tags after rendering, which is the same trick markdown.js already uses for
// code spans. Doing it to the source rather than the output means the runs
// land inside whatever element the renderer built for that line, so a fading
// word inside a list item is inside the <li> and the HTML stays well formed.

import { renderMarkdown } from "./markdown.js";

/** How long a run takes to fade in, and how long it stays worth tracking. */
export const FADE_MS = 420;

// Private to this module and stripped before anything is displayed. NUL is
// already taken by markdown.js's own placeholders, so these are the next two.
const OPEN = "\u0001";
const CLOSE = "\u0002";

// Lines whose text is not prose, and which a sentinel would break outright:
// a fence marker, a table row (the leading text would become a cell), and the
// three horizontal rules.
const SKIP_LINE = /^\s*(?:```|~~~|\||(?:-{3,}|\*{3,}|_{3,})\s*$)/;

// What a line spends on being a list item, a heading or a quote before its
// text starts. A sentinel before any of this stops the line being read as a
// list item at all, so runs are clamped to start after it.
const PREFIX = /^(?:\s*(?:[-*+]|\d+[.)])\s+|\s*#{1,6}\s+|\s*>\s?)?/;

// Characters that may turn into a tag. A run must never straddle one: the
// renderer would open `<code>` or `<strong>` between a run's two sentinels,
// and the span would close inside an element it never opened.
//
// Found by fuzzing rather than by reading the renderer -- a half-typed `` is
// a code span for exactly one keystroke, which is the sort of thing streaming
// produces constantly and reasoning about the grammar does not catch.
// Markers are left out of runs entirely, which costs nothing: they render as
// tags, so there is no visible character there to fade.
const MARKER = /[`*_~[\]()$\\<>|!#]/;

/**
 * Where each line of `source` begins, and how much of it is structure.
 *
 * Also tracks fenced code, whose contents look like prose to the rules above
 * but must be left alone -- a fade inside a code block would animate a
 * fragment of someone's program.
 */
function lineTable(source) {
  const lines = [];
  let at = 0;
  let fenced = false;
  for (const line of source.split("\n")) {
    const fence = /^\s*(?:```|~~~)/.test(line);
    const skip = fenced || fence || SKIP_LINE.test(line) || !line.trim();
    lines.push({
      start: at,
      end: at + line.length,
      // Where a sentinel may first appear on this line.
      floor: at + (skip ? line.length : PREFIX.exec(line)[0].length),
      skip,
    });
    if (fence) fenced = !fenced;
    at += line.length + 1;
  }
  return lines;
}

/**
 * `[start, end)` broken into the stretches that hold no markdown marker.
 *
 * Whitespace-only pieces are dropped: a span around a single space animates
 * nothing and only adds a node.
 */
function plainRuns(source, start, end) {
  const out = [];
  let at = start;
  while (at < end) {
    while (at < end && MARKER.test(source[at])) at += 1;
    let to = at;
    while (to < end && !MARKER.test(source[to])) to += 1;
    if (to > at && source.slice(at, to).trim()) out.push({ start: at, end: to });
    at = to;
  }
  return out;
}

/**
 * The runs of `source` that should still be fading, newest chunk first.
 *
 * A run never crosses a newline: the renderer turns a newline into a block
 * boundary, and a span opened in one paragraph and closed in the next is not
 * something a browser will keep -- it rearranges the tags and the fade lands
 * on the wrong text.
 */
function runs(source, chunks, now) {
  const lines = lineTable(source);
  let line = 0;
  const out = [];

  for (let i = 0; i < chunks.length; i += 1) {
    const age = now - chunks[i].at;
    if (age >= FADE_MS) continue;
    const from = chunks[i].start;
    const to = i + 1 < chunks.length ? chunks[i + 1].start : source.length;

    // Walk forward through the line table rather than searching it: chunks
    // arrive in order, so this is one pass over both.
    while (line < lines.length - 1 && lines[line].end < from) line += 1;
    for (let k = line; k < lines.length && lines[k].start < to; k += 1) {
      const l = lines[k];
      if (l.skip) continue;
      const start = Math.max(from, l.floor);
      const end = Math.min(to, l.end);
      for (const piece of plainRuns(source, start, end)) {
        out.push({ ...piece, age });
      }
    }
  }
  return out;
}

/**
 * `source` rendered to HTML, with everything that arrived in the last
 * FADE_MS wrapped in spans that fade from where they should already be.
 *
 * `chunks` is `[{ start, at }]` -- the source offset each delta began at, and
 * when it landed. Anything older than the fade is left plain, so a settled
 * reply is exactly the HTML it was before this existed.
 */
export function renderRevealed(source, chunks, now) {
  const marked = runs(source, chunks, now);
  if (marked.length === 0) return renderMarkdown(source);

  // Inserted back to front so the offsets ahead of each cut stay valid.
  let woven = source;
  for (let i = marked.length - 1; i >= 0; i -= 1) {
    const { start, end } = marked[i];
    woven = woven.slice(0, start) + OPEN + i + OPEN + woven.slice(start, end) + CLOSE + woven.slice(end);
  }

  const html = renderMarkdown(woven);
  return html
    .replace(new RegExp(OPEN + "(\\d+)" + OPEN, "g"), (_m, i) => {
      const age = Math.min(marked[Number(i)].age, FADE_MS);
      return `<span class="tw" style="animation-delay:${(-age).toFixed(0)}ms">`;
    })
    .replace(new RegExp(CLOSE, "g"), "</span>");
}
