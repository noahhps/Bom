// The reveal, fuzzed against every prefix of a streaming reply.
//
// Run with `npm test` in client/. No framework: node and the two modules
// under test, which is all this needs and all the repo has.
//
// The thing that can actually go wrong here is malformed HTML. The spans are
// woven into the markdown source, so the renderer is free to open a tag
// between a span's two sentinels -- and then the span closes inside an
// element it never opened, and the browser rearranges the document. Reading
// the grammar does not find those cases; a half-typed `` is a code span for
// exactly one keystroke, and streaming produces that constantly. So every
// prefix of every sample is rendered and checked for balance.

import assert from "node:assert/strict";

import { FADE_MS, renderRevealed } from "../src/lib/reveal.js";
import { renderMarkdown } from "../src/lib/markdown.js";

const VOID = new Set(["br", "hr", "img", "input", "meta", "link"]);

/** Every tag closes, in order, inside its parent. */
function balanced(html) {
  const stack = [];
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)[^>]*?(\/?)>/g;
  let m;
  while ((m = re.exec(html))) {
    const [, slash, name, selfClose] = m;
    const tag = name.toLowerCase();
    if (VOID.has(tag) || selfClose) continue;
    if (!slash) stack.push(tag);
    else if (stack.pop() !== tag) return false;
  }
  return stack.length === 0;
}

const SAMPLES = [
  "Here is the plan.\n\n## Findings\n- **Alpha** costs less\n- Beta is faster\n\n" +
    "| Café | Drive |\n|---|---|\n| Fleur | 20 min |\n\n```js\nconst x = 1;\n```\n\nA closing thought",
  "A paragraph with `inline code` and *emphasis* and **bold** and a [link](https://a.test) plus $x_i$ maths.",
  "> A quote that grows\n> across two lines\n\n1. first\n2. second with `code`\n\n---\n\nEnd.",
  "Plain prose with no markup at all, just words arriving one after another over time.",
];

let prefixes = 0;
let withSpans = 0;

for (const source of SAMPLES) {
  for (let n = 1; n <= source.length; n += 1) {
    const text = source.slice(0, n);
    // The harshest case: a chunk boundary at every one of the last 40
    // characters, so a span can start or end absolutely anywhere.
    const chunks = [];
    for (let k = Math.max(0, n - 40); k < n; k += 1) chunks.push({ start: k, at: 0 });
    const html = renderRevealed(text, chunks, 100);
    prefixes += 1;

    assert.ok(
      !/[\u0001\u0002]/.test(html),
      `sentinel reached the output at ${n}: ${JSON.stringify(text.slice(-24))}`,
    );
    assert.ok(
      balanced(html),
      `unbalanced HTML at ${n}: ${JSON.stringify(text.slice(-24))}\n${html.slice(-200)}`,
    );
    if (html.includes('class="tw"')) withSpans += 1;
  }
}

// Once nothing is fading the output has to be the string the app rendered
// before any of this existed -- a settled conversation carries no spans.
for (const source of SAMPLES) {
  assert.equal(
    renderRevealed(source, [{ start: 0, at: 0 }], FADE_MS + 1),
    renderMarkdown(source),
    "a settled reply should render exactly as plain markdown",
  );
}
assert.equal(renderRevealed(SAMPLES[3], [], 0), renderMarkdown(SAMPLES[3]));

// The age has to reach the markup, or every span fades from the start at once.
assert.match(
  renderRevealed(SAMPLES[3], [{ start: 40, at: 0 }], 120),
  /animation-delay:-120ms/,
);
// And it is clamped, so a late render cannot emit a delay past the duration.
assert.match(
  renderRevealed(SAMPLES[3], [{ start: 40, at: 0 }], FADE_MS - 1),
  new RegExp(`animation-delay:-${FADE_MS - 1}ms`),
);

console.log(`ok — ${prefixes} prefixes, ${withSpans} with spans, all balanced`);
