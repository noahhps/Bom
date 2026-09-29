// A turn's thinking, skills and words, put back in the order they happened.
//
// Run with `npm test` in client/.

import assert from "node:assert/strict";

import { turnTimeline } from "../src/lib/timeline.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`ok  ${name}`);
}

const shape = (parts) =>
  parts.map((p) => (p.type === "skills" ? `skills:${p.skills.map((s) => s.name).join("+")}` : `${p.type}:${p.text}`));

test("thinking, a skill, then words -- in that order", () => {
  const parts = turnTimeline({
    reasoning: "Need the weather.",
    content: "It is sunny.",
    skills: [{ name: "weather", r: 17, t: 0 }],
  });
  assert.deepEqual(shape(parts), ["reasoning:Need the weather.", "skills:weather", "text:It is sunny."]);
});

test("rounds interleave: think, say, call, think, call, say", () => {
  const reasoning = "Plan A. Plan B.";
  const content = "Looking. Done.";
  const parts = turnTimeline({
    reasoning,
    content,
    skills: [
      { name: "search", r: 7, t: 8 },
      { name: "read", r: 15, t: 8 },
    ],
  });
  assert.deepEqual(shape(parts), [
    "reasoning:Plan A.",
    "text:Looking.",
    "skills:search",
    "reasoning: Plan B.",
    "skills:read",
    "text: Done.",
  ]);
});

test("skills called together share one trace", () => {
  const parts = turnTimeline({
    reasoning: "Two at once.",
    content: "Both done.",
    skills: [
      { name: "a", r: 12, t: 0 },
      { name: "b", r: 12, t: 0 },
    ],
  });
  assert.deepEqual(shape(parts), ["reasoning:Two at once.", "skills:a+b", "text:Both done."]);
  assert.equal(parts[1].start, 0);
});

test("a stored turn without marks reads as it always did", () => {
  const parts = turnTimeline({
    reasoning: "Thought.",
    content: "Answer.",
    skills: [{ name: "a" }, { name: "b" }],
  });
  assert.deepEqual(shape(parts), ["reasoning:Thought.", "skills:a+b", "text:Answer."]);
});

test("marks past what has arrived yet are held at the end", () => {
  // Live, a tool_call can land before the frame that flushes the text
  // written ahead of it.
  const parts = turnTimeline({ reasoning: "", content: "Hel", skills: [{ name: "a", r: 0, t: 6 }] });
  assert.deepEqual(shape(parts), ["text:Hel", "skills:a"]);
});

test("whitespace between skills is not a part", () => {
  const parts = turnTimeline({
    reasoning: "",
    content: "\n\nFinal.",
    skills: [
      { name: "a", r: 0, t: 0 },
      { name: "b", r: 0, t: 2 },
    ],
  });
  assert.deepEqual(shape(parts), ["skills:a+b", "text:Final."]);
});

test("nothing at all is nothing", () => {
  assert.deepEqual(turnTimeline({}), []);
  assert.deepEqual(shape(turnTimeline({ content: "Hi" })), ["text:Hi"]);
});

console.log(`\n${passed} passed`);
