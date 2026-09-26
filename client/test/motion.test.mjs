// The motion kit and the working label's words.
//
// Run with `npm test` in client/. The kit is pure -- timelines in, CSS out --
// so everything that can go wrong with it can be checked here without a
// browser: a petal opening out of turn, the eight closing at different
// moments, a marker running ahead of its line, a word that is not true.

import assert from "node:assert/strict";

import {
  BLOOM,
  PLANS,
  SKETCHES,
  bloomCSS,
  bloomTimeline,
  keyframes,
  measure,
  sketchFor,
} from "../src/lib/drawkit.js";
import { workingWord } from "../src/lib/skillWidgets.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`ok  ${name}`);
}

/** Every "N% { ... }" stop of one @keyframes block, as [percent, body]. */
function stops(css, name) {
  const block = css.match(new RegExp(`@keyframes ${name} \\{([\\s\\S]*?)\\n\\}`))[1];
  return [...block.matchAll(/([\d.]+)% \{ ([^}]*) \}/g)].map((m) => [parseFloat(m[1]), m[2]]);
}

test("bloom's timeline is the one the design settled on", () => {
  assert.deepEqual(bloomTimeline(), { whole: 1250, shut: 1700, cycle: 2400 });
});

test("each petal opens 130ms after the last, and all eight close together", () => {
  const css = bloomCSS();
  const { shut, cycle } = bloomTimeline();
  const closeAt = +((shut / cycle) * 100).toFixed(3);
  const tuckedAt = +(((shut + BLOOM.shutFor) / cycle) * 100).toFixed(3);
  for (let i = 0; i < 8; i++) {
    const s = stops(css, `flower-bloom-${i}`);
    const opens = s.find(([, body]) => body.includes(`scale(${BLOOM.tucked})`) && body.includes("cubic-bezier(.16"));
    assert.equal(opens[0], +(((i * BLOOM.step) / cycle) * 100).toFixed(3), `petal ${i} opens on time`);
    assert.ok(s.some(([p, body]) => p === closeAt && body.includes("scale(1)")), `petal ${i} starts closing at ${closeAt}%`);
    assert.ok(s.some(([p, body]) => p === tuckedAt && body.includes(`scale(${BLOOM.tucked})`)), `petal ${i} is tucked by ${tuckedAt}%`);
    assert.ok(s.every(([, body]) => body.includes(`rotate(${i * 45}deg)`)), `petal ${i} keeps its slot`);
  }
});

test("a timeline that runs backwards is refused", () => {
  assert.throws(() => keyframes("x", 1000, [[0, "a"], [600, "b"], [400, "c"], [1000, "d"]]), /backwards/);
  assert.throws(() => keyframes("x", 1000, [[0, "a"], [900, "b"]]), /0 to 1000/);
});

test("the path measurer agrees with plain geometry", () => {
  assert.equal(measure("M0 0 L3 4").length, 5);
  // A cubic with its handles on the chord is that chord.
  assert.ok(Math.abs(measure("M0 0 C10 0 20 0 30 0").length - 30) < 1e-9);
  assert.deepEqual(measure("M1 2 L5 2 Q7 2 7 4").end, [7, 4]);
});

for (const id of Object.keys(SKETCHES)) {
  test(`${id}: the marker never runs ahead of the drawing, and finishes on it`, () => {
    const plan = PLANS[id];
    const pen = stops(plan.css, `k-board-${id}-pen`).map(([p, body]) => [p, parseFloat(body.match(/offset-distance: ([\d.]+)%/)[1])]);
    for (let k = 1; k < pen.length; k++) assert.ok(pen[k][1] >= pen[k - 1][1], `distance only grows (${pen[k - 1][1]} -> ${pen[k][1]})`);
    assert.equal(pen[pen.length - 1][1], 100);
    plan.strokes.forEach((s, i) => {
      assert.ok(s.to > s.from, `stroke ${i} has length`);
      if (i) assert.ok(s.from >= plan.strokes[i - 1].to, `stroke ${i} starts after stroke ${i - 1} ends`);
    });
    assert.ok(plan.drawn < plan.cycle, "the drawing is finished inside its own cycle");
  });
}

test("a canvas call gets the drawing for its kind", () => {
  assert.equal(sketchFor({ kind: "html" }), "wireframe");
  assert.equal(sketchFor({ kind: " HTML " }), "wireframe");
  assert.equal(sketchFor({ kind: "markdown" }), "scribble");
  assert.equal(sketchFor({ kind: "code" }), "zigzag");
  // Unknown kinds are normalised the way the server stores them.
  assert.equal(sketchFor({ language: "python" }), "zigzag");
  assert.equal(sketchFor({ kind: "slides" }), "scribble");
  assert.equal(sketchFor(undefined), "scribble");
});

test("the working word is read off the turn", () => {
  assert.equal(workingWord(undefined, false), "Working");
  assert.equal(workingWord([], true), "Thinking");
  assert.equal(workingWord([{ name: "web_search" }], true), "Searching");
  assert.equal(workingWord([{ name: "write_canvas" }], false), "Drafting");
  assert.equal(workingWord([{ name: "some_mcp_tool" }], false), "Running a skill");
  // Finished skills say nothing about now.
  assert.equal(workingWord([{ name: "web_search", result: "..." }], true), "Thinking");
  // Held on the reader beats everything, including a running row.
  assert.equal(workingWord([{ name: "run_shell", approval: { id: "a" } }], false), "Waiting on you");
});

test("every working word fits the label", () => {
  const names = ["web_search", "search_files", "search_history", "remember", "forget", "current_time",
    "list_directory", "read_file", "read_canvas", "write_canvas", "add_event", "update_event",
    "list_events", "find_events", "list_photos", "list_albums", "create_album", "add_to_album",
    "run_python", "run_shell", "unknown"];
  for (const name of names) {
    const word = workingWord([{ name }], false);
    assert.ok(word.length <= 15, `${name}: "${word}" is ${word.length} characters`);
  }
  assert.ok(workingWord([{ approval: {} }]).length <= 15);
});

console.log(`\n${passed} passed`);
