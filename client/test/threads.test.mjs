// Conversations as Messages lists them: by who is in them.
//
// Run with `npm test` in client/. The rule that matters most: writing to
// people you already have a conversation with carries that conversation on,
// whatever order you add them in.

import assert from "node:assert/strict";

import { BOM, findThread, keyOf, membersOf, namesOf } from "../src/lib/threads.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`ok  ${name}`);
}

const sessions = [
  { id: "s1", mode: "chat", agent_id: null, members: [], updated_at: 10 },
  { id: "s2", mode: "chat", agent_id: "a1", members: [], updated_at: 20 },
  { id: "s3", mode: "chat", agent_id: "a2", members: ["a1", "a2"], updated_at: 30 },
  { id: "s4", mode: "design", agent_id: "a1", members: [], updated_at: 40 },
  { id: "s5", mode: "chat", agent_id: null, members: [], updated_at: 50 },
];

test("a session is with its group, its agent, or Bom", () => {
  assert.deepEqual(membersOf(sessions[0]), [BOM]);
  assert.deepEqual(membersOf(sessions[1]), ["a1"]);
  assert.deepEqual(membersOf(sessions[2]), ["a1", "a2"]);
});

test("the same people in any order are the same conversation", () => {
  assert.equal(keyOf(["a2", "a1"]), keyOf(["a1", "a2"]));
  assert.equal(findThread(sessions, ["a2", "a1"]).id, "s3");
});

test("the newest chat wins, and a design session is never a thread", () => {
  assert.equal(findThread(sessions, [BOM]).id, "s5");
  assert.equal(findThread(sessions, ["a1"]).id, "s2");
  assert.equal(findThread(sessions, ["a3"]), null);
});

test("names read the way a messenger heads a thread", () => {
  const people = ["Secretary", "Analyst", "Writer", "Clerk"].map((name) => ({ name }));
  assert.equal(namesOf(people.slice(0, 1)), "Secretary");
  assert.equal(namesOf(people.slice(0, 2)), "Secretary & Analyst");
  assert.equal(namesOf(people.slice(0, 3)), "Secretary, Analyst & Writer");
  assert.equal(namesOf(people), "Secretary, Analyst & 2 more");
});

console.log(`\n${passed} passed`);
