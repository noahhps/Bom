// Conversations as Messages lists them: by who is in them.
//
// Run with `npm test` in client/. The rule that matters most: writing to
// people you already have a conversation with carries that conversation on,
// whatever order you add them in.

import assert from "node:assert/strict";

import {
  BOM,
  agentThread,
  findThread,
  keyOf,
  membersOf,
  namesOf,
  threadOf,
  threadsOf,
  threadsWith,
  titleOf,
} from "../src/lib/threads.js";

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

test("an agent is one thread, however many sessions older builds left", () => {
  const more = [...sessions, { id: "s6", mode: "chat", agent_id: "a1", members: [], updated_at: 5 }];
  const threads = threadsOf(more);
  const secretary = agentThread(threads, "a1");
  assert.equal(secretary.id, "s2"); // the newest carries it on
  assert.deepEqual(secretary.sessions.map((s) => s.id), ["s2", "s6"]);
  assert.equal(threadOf(threads, "s6").id, "s2");
  // Groups and chats with Bom are each their own; designs are not threads.
  assert.deepEqual(threads.map((t) => t.id), ["s5", "s3", "s2", "s1"]);
});

test("a new message to a group is offered the groups already with them", () => {
  const twice = [...sessions, { id: "s7", mode: "chat", agent_id: "a1", members: ["a2", "a1"], updated_at: 60, title: "Offsite" }];
  const threads = threadsOf(twice);
  assert.deepEqual(threadsWith(threads, ["a1", "a2"]).map((t) => t.id), ["s7", "s3"]);
  assert.deepEqual(threadsWith(threads, [BOM]).map((t) => t.id), ["s5", "s1"]);
  // Named by what it is about once it has a title, by who is in it until then.
  const people = [{ name: "Secretary" }, { name: "Analyst" }];
  assert.equal(titleOf(threads[0], people), "Offsite");
  assert.equal(titleOf(threadOf(threads, "s3"), people), "Secretary & Analyst");
});

console.log(`\n${passed} passed`);
