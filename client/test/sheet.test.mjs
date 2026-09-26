// The sheet's formula engine, checked the way a spreadsheet would be.
//
// Run with `npm test` in client/. Row 1 is the header throughout, so the first
// row of data is row 2 -- the convention write_sheet teaches the model.

import assert from "node:assert/strict";

import {
  coerceInput,
  colIndex,
  colLetter,
  display,
  evaluator,
  isError,
  parseSheet,
  rewriteRefs,
  serializeSheet,
  toCsv,
} from "../src/lib/sheet.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`ok  ${name}`);
}

const sheet = (rows, columns = ["A", "B", "C", "D"], formats) =>
  parseSheet(JSON.stringify({ columns, rows, formats }));

const at = (s, ref) => {
  const [, letters, row] = /^([A-Z]+)(\d+)$/.exec(ref);
  return evaluator(s)(Number(row), colIndex(letters));
};

test("column letters round-trip", () => {
  for (const i of [0, 1, 25, 26, 27, 51, 52, 701]) assert.equal(colIndex(colLetter(i)), i);
  assert.equal(colLetter(26), "AA");
});

test("arithmetic, precedence and references", () => {
  const s = sheet([[2, 3, "=A2+B2*2", "=(A2+B2)*2"], [4, "=A2^2", "=-A3+1", "=10%"]]);
  assert.equal(at(s, "C2"), 8);
  assert.equal(at(s, "D2"), 10);
  assert.equal(at(s, "B3"), 4);
  assert.equal(at(s, "C3"), -3);
  assert.equal(at(s, "D3"), 0.1);
});

test("ranges and functions", () => {
  const s = sheet([
    [10, "x", "=SUM(A2:A4)", "=AVERAGE(A2:A4)"],
    [20, "", "=MAX(A2:A4)", "=COUNT(A2:B4)"],
    [30, "", "=ROUND(D2/7, 2)", '=IF(A4>25, "big", "small")'],
  ]);
  assert.equal(at(s, "C2"), 60);
  assert.equal(at(s, "D2"), 20);
  assert.equal(at(s, "C3"), 30);
  assert.equal(at(s, "D3"), 3);
  assert.equal(at(s, "C4"), 2.86);
  assert.equal(at(s, "D4"), "big");
});

test("formulas chain through other formulas", () => {
  const s = sheet([[1, "=A2*2", "=B2*2", "=SUM(A2:C2)"]]);
  assert.equal(at(s, "D2"), 7);
});

test("errors are values, not crashes", () => {
  const s = sheet([["=1/0", "=NOPE(1)", "=1+", "=C2"], ["=A3", "text", "=B3*2", "=SUM(Z9:Z10)"]]);
  assert.equal(at(s, "A2").code, "#DIV/0!");
  assert.equal(at(s, "B2").code, "#NAME?");
  assert.equal(at(s, "C2").code, "#ERR!");
  assert.ok(isError(at(s, "D2")), "an error propagates");
  assert.equal(at(s, "A3").code, "#CYCLE!");
  assert.equal(at(s, "C3").code, "#VALUE!");
  assert.equal(at(s, "D3"), 0);
});

test("text joins and compares", () => {
  const s = sheet([["Ada", "Lovelace", '=A2&" "&B2', '=A2="ada"']]);
  assert.equal(at(s, "C2"), "Ada Lovelace");
  assert.equal(at(s, "D2"), true);
});

test("the header is row 1 and never a formula", () => {
  const s = sheet([[1]], ["=1+1", "B"]);
  assert.equal(at(s, "A1"), "=1+1");
});

test("typed input becomes numbers where it should", () => {
  assert.equal(coerceInput("1200"), 1200);
  assert.equal(coerceInput("$1,200", "currency"), 1200);
  assert.equal(coerceInput("12%", "percent"), 0.12);
  assert.equal(coerceInput("$1,200"), "$1,200");
  assert.equal(coerceInput("=A2"), "=A2");
});

test("display follows the column format", () => {
  assert.equal(display(0.1 + 0.2), "0.3");
  assert.equal(display(0.125, "percent").replace(/\s/g, ""), "12.5%");
  assert.ok(display(1200, "currency").includes("1,200"));
  assert.equal(display(true), "TRUE");
});

test("csv exports values and quotes what needs it", () => {
  const s = sheet([['He said "hi"', 2, "=B2*2", "a,b"]]);
  assert.equal(toCsv(s), 'A,B,C,D\n"He said ""hi""",2,4,"a,b"\n');
});

test("a sheet round-trips and pads ragged rows", () => {
  const s = sheet([[1], [1, 2, 3, 4, 5]]);
  assert.deepEqual(s.rows, [[1, "", "", ""], [1, 2, 3, 4]]);
  assert.deepEqual(parseSheet(serializeSheet(s)).rows, s.rows);
  assert.equal(parseSheet("not json"), null);
});

test("references move with the rows, and quoted text does not", () => {
  const down = ({ row, col }) => (row >= 4 ? { row: row + 1, col } : null);
  assert.equal(rewriteRefs("=SUM(B2:B9)+$C$4", down), "=SUM(B2:B10)+$C$5");
  assert.equal(rewriteRefs('="B4 "&B4', down), '="B4 "&B5');
  assert.equal(rewriteRefs("=ROUND(B4, 2)", down), "=ROUND(B5, 2)");
  assert.equal(rewriteRefs("plain B4", down), "plain B4");
});

console.log(`\n${passed} passed`);
