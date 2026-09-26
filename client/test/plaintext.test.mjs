// Text a model wrapped in an object, read back as the words it meant.
//
// Run with `npm test` in client/. The case that prompted it: a deck whose
// slide titles were stored as `{'title': 'Aesthetic Summary'}` and drawn with
// the braces on.

import assert from "node:assert/strict";

import { lineText, plainText } from "../src/lib/plainText.js";
import { parseSheet } from "../src/lib/sheet.js";
import { describeSkill } from "../src/lib/skillWidgets.js";
import { parseDeck } from "../src/lib/slides.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`ok  ${name}`);
}

test("objects, lists and their printed forms unwrap", () => {
  assert.equal(plainText("{'title': 'Aesthetic Summary'}"), "Aesthetic Summary");
  assert.equal(plainText('{"title": "Overview"}'), "Overview");
  assert.equal(plainText({ text: "Hi" }), "Hi");
  assert.equal(plainText(["a", { label: "b" }]), "a\nb");
  assert.equal(lineText(["a", "b"]), "a b");
  assert.equal(plainText("{'a': True, 'b': None}"), "true");
  assert.equal(plainText("just {braces} inside"), "just {braces} inside");
  assert.equal(plainText(42), "42");
});

test("a deck stored with wrapped titles draws the words", () => {
  const deck = parseDeck(JSON.stringify({
    theme: {},
    slides: [
      {
        layout: "bullets",
        title: "{'title': 'Aesthetic Summary'}",
        bullets: ["Color palette: pink", { text: "Textures" }, "{'text': 'Layout'}"],
        notes: "The visual grammar.",
      },
      { layout: "stat", title: { title: "Numbers" }, stats: [{ value: 12, label: { text: "km" } }] },
      { layout: "table", title: "T", columns: [{ name: "A" }], rows: [[{ value: 1 }]] },
    ],
  }));
  assert.equal(deck.slides[0].title, "Aesthetic Summary");
  assert.deepEqual(deck.slides[0].bullets, ["Color palette: pink", "Textures", "Layout"]);
  assert.equal(deck.slides[0].notes, "The visual grammar.");
  assert.equal(deck.slides[1].title, "Numbers");
  assert.deepEqual(deck.slides[1].stats, [{ value: "12", label: "km" }]);
  assert.deepEqual(deck.slides[2].columns, ["A"]);
  assert.deepEqual(deck.slides[2].rows, [["1"]]);
});

test("every field a slide renders is a string", () => {
  const deck = parseDeck(JSON.stringify({
    slides: [{ layout: "quote", quote: { text: "Q" }, attribution: ["X"], kicker: 3, visual: { svg: 1 } }],
  }));
  const s = deck.slides[0];
  for (const key of ["quote", "attribution", "kicker"]) assert.equal(typeof s[key], "string", key);
  assert.equal("visual" in s, false);
});

test("a sheet stored with wrapped cells shows values", () => {
  const sheet = parseSheet(JSON.stringify({
    columns: [{ name: "Item" }, "{'title': 'Cost'}"],
    rows: [[{ value: "Rent" }, { value: 1200 }], ["{'text': 'Food'}", "=B2*2"]],
  }));
  assert.deepEqual(sheet.columns, ["Item", "Cost"]);
  assert.deepEqual(sheet.rows, [["Rent", 1200], ["Food", "=B2*2"]]);
});

test("a tool card names wrapped arguments by their text", () => {
  const card = describeSkill({
    name: "write_canvas",
    arguments: { title: { title: "Poster" }, kind: { value: "html" } },
  });
  assert.equal(card.title, "Poster");
  assert.deepEqual(card.rows, [{ label: "Kind", value: "html" }]);
  assert.equal(describeSkill({ name: "mcp_tool", arguments: { q: { text: "find" } } }).title, "find");
});

console.log(`\n${passed} passed`);
