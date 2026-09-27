// The wireframe renderer and its exporters: one model of a screen, drawn as
// HTML for the editor, HTML + CSS for the export, and packed into a zip or a
// PDF. Run with `npm test` in client/.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  blankWireframe,
  buildPdf,
  buildZip,
  cleanFrame,
  crc32,
  expand,
  palette,
  parseWireframe,
  renderFrame,
  serializeWireframe,
  toDeck,
  toDocument,
  toHtmlCss,
  toSheet,
  wireframeImageIds,
} from "../src/lib/wireframe.js";
import { parseDeck } from "../src/lib/slides.js";
import { deckImageIds } from "../src/lib/images.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}
async function testAsync(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

const P = palette({ fidelity: "wireframe" });
const doc = {
  version: 1,
  fidelity: "wireframe",
  theme: {},
  frames: [
    {
      id: "f1", name: "Sign in", x: 0, y: 0, w: 393, h: 852,
      layers: [
        { id: "f1_l1", type: "text", x: 24, y: 80, w: 345, h: 40, text: "<b>Hi</b> & \"you\"", size: 28 },
        { id: "f1_l2", type: "button", x: 24, y: 700, w: 345, h: 48, text: "Continue", link: "f2" },
        { id: "f1_l3", type: "input", x: 24, y: 200, w: 345, h: 48, text: "Email" },
        { id: "f1_l4", type: "image", x: 24, y: 300, w: 345, h: 160, image: "img_abc" },
        { id: "f1_l5", type: "rect", x: 0, y: 0, w: 10, h: 10, hidden: true },
      ],
    },
    { id: "f2", name: "Home", x: 480, y: 0, w: 393, h: 852, layers: [] },
  ],
};

test("parse keeps a wireframe and refuses what is not one", () => {
  assert.equal(parseWireframe("nope"), null);
  assert.equal(parseWireframe('{"slides": []}'), null);
  const back = parseWireframe(serializeWireframe(doc));
  assert.equal(back.frames.length, 2);
  assert.equal(back.frames[0].layers[1].link, "f2");
  const odd = parseWireframe('{"frames":[{"layers":[{"type":"blob","x":"12"}]}]}');
  assert.equal(odd.frames[0].layers[0].type, "rect");
  assert.equal(odd.frames[0].layers[0].x, 12);
  assert.ok(parseWireframe(serializeWireframe(blankWireframe())).frames[0].layers.length >= 3);
});

test("every layer type expands into drawable nodes", () => {
  const kinds = new Set(["box", "ellipse", "line", "text", "image"]);
  for (const type of ["rect", "ellipse", "line", "text", "image", "button", "input", "checkbox",
    "toggle", "avatar", "icon", "nav", "card", "lines"]) {
    const nodes = expand(cleanFrame({ layers: [{ type, x: 0, y: 0, w: 200, h: 60, text: "T" }] }).layers[0], P);
    assert.ok(nodes.length > 0, type);
    for (const node of nodes) assert.ok(kinds.has(node.k), `${type}: ${node.k}`);
  }
});

test("text is escaped and hidden layers are left out", () => {
  const html = renderFrame(doc.frames[0], P, {});
  assert.ok(html.includes("&lt;b&gt;Hi&lt;/b&gt; &amp; &quot;you&quot;"));
  assert.ok(!html.includes("<b>"));
  assert.ok(!html.includes('data-layer="f1_l5"'));
  assert.ok(html.includes('data-link="f2"'));
});

test("a picture is only ever a resolved blob: or data: address", () => {
  const safe = renderFrame(doc.frames[0], P, { img_abc: "data:image/png;base64,AAAA" });
  assert.ok(safe.includes("data:image/png;base64,AAAA"));
  const web = renderFrame(doc.frames[0], P, { img_abc: "https://evil.example/x.png" });
  assert.ok(!web.includes("evil.example"));
});

test("a colour that is not a colour never reaches the markup", () => {
  const frame = cleanFrame({ fill: "red;background:url(x)", layers: [{ type: "rect", fill: "x;}</style>" }] });
  const html = renderFrame(frame, P, {});
  assert.ok(!html.includes("url(x)"));
  assert.ok(!html.includes("</style>"));
});

test("HTML + CSS export: classes, a stylesheet, anchors for links, real controls", () => {
  const out = toHtmlCss(doc, P, {}, "My <app>");
  assert.ok(out.html.includes('<link rel="stylesheet" href="styles.css">'));
  assert.ok(!out.html.includes("style="));
  assert.ok(out.html.includes('<section id="f1"'));
  assert.ok(out.html.includes('href="#f2"'));
  assert.ok(out.html.includes("<button"));
  assert.ok(out.html.includes('<input') && out.html.includes('placeholder="Email"'));
  assert.ok(out.html.includes("<title>My &lt;app&gt;</title>"));
  assert.ok(out.css.includes(".sign-in{"));
  assert.ok(out.single.includes("<style>") && out.single.includes(".sign-in{"));
});

test("crc32 matches the standard check value", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});

test("image ids are collected from frames and from board slides", () => {
  assert.deepEqual(wireframeImageIds(doc), ["img_abc"]);
  const deck = parseDeck(JSON.stringify(toDeck(doc)));
  assert.equal(deck.slides.length, 2);
  assert.equal(deck.slides[0].layout, "board");
  assert.equal(deck.slides[0].board.frame.name, "Sign in");
  assert.deepEqual(deckImageIds(deck), ["img_abc"]);
  // A board without a frame is not a board.
  assert.equal(parseDeck('{"slides":[{"layout":"board","title":"x"}]}').slides[0].layout, "bullets");
});

test("a sheet inventory: one row per visible element, in reading order", () => {
  const sheet = toSheet(doc);
  assert.deepEqual(sheet.columns.slice(0, 5), ["Screen", "Order", "Element", "Content", "Goes to"]);
  assert.equal(sheet.columns.length, sheet.formats.length);
  const rows = sheet.rows.filter((r) => r[0] === "Sign in");
  assert.equal(rows.length, 4); // the hidden rect is left out
  assert.deepEqual(rows.map((r) => r[2]), ["Heading", "Input", "Image", "Button (primary)"]);
  assert.equal(rows.find((r) => r[3] === "Continue")[4], "Home");
  assert.ok(sheet.rows.every((r) => r.length === sheet.columns.length));
});

test("a document spec: screens, elements, links and the flow", () => {
  const text = toDocument(doc, "Onboarding");
  assert.ok(text.startsWith("# Onboarding\n"));
  assert.ok(text.includes("## 1. Sign in"));
  assert.ok(text.includes("leads to Home"));
  assert.ok(text.includes("- **Button (primary)** — Continue → Home"));
  assert.ok(text.includes("## Flow") && text.includes("- Sign in → Home (Continue)"));
  // Markdown in the content is escaped, so it reads as the text it was.
  assert.ok(text.includes("\\<b\\>Hi\\</b\\>"));
  assert.ok(text.includes("_Empty screen._"));
});

test("the wireframe kit is Bom's: slate, cobalt and the monospace", () => {
  const kit = palette({ fidelity: "wireframe" });
  assert.equal(kit.accent, "#1F4FD8");
  assert.equal(kit.text, "#0F172A");
  assert.ok(kit.body.includes("DM Mono"));
});

const dir = mkdtempSync(join(tmpdir(), "wf-"));
const has = (cmd) => {
  try {
    execFileSync("sh", ["-c", `command -v ${cmd}`]);
    return true;
  } catch {
    return false;
  }
};

await testAsync("a zip that unzip reads back", async () => {
  const out = toHtmlCss(doc, P, {});
  const blob = buildZip([{ name: "index.html", data: out.html }, { name: "styles.css", data: out.css }]);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  assert.equal(bytes[0], 0x50);
  assert.equal(bytes[1], 0x4b);
  const path = join(dir, "site.zip");
  writeFileSync(path, bytes);
  if (has("python3")) {
    const listing = execFileSync("python3", ["-c",
      "import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print(' '.join(z.namelist()));print(z.read('styles.css').decode()[:40])",
      path]).toString();
    assert.ok(listing.includes("index.html styles.css"), listing);
  }
});

await testAsync("a PDF with a page per frame and a valid cross-reference table", async () => {
  // A tiny JPEG is not needed to check the structure: any bytes stand in.
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const blob = buildPdf([
    { w: 393, h: 852, pw: 786, ph: 1704, jpeg },
    { w: 1280, h: 720, pw: 2560, ph: 1440, jpeg },
  ]);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const text = Buffer.from(bytes).toString("latin1");
  assert.ok(text.startsWith("%PDF-1.4"));
  assert.ok(text.includes("/Count 2"));
  assert.ok(text.includes("/MediaBox [0 0 294.75 639.00]"));
  // Every xref offset points at the object it names.
  const xrefAt = Number(/startxref\n(\d+)/.exec(text)[1]);
  assert.ok(text.slice(xrefAt).startsWith("xref"));
  const offsets = [...text.slice(xrefAt).matchAll(/(\d{10}) 00000 n/g)].map((m) => Number(m[1]));
  offsets.forEach((offset, i) => assert.ok(text.slice(offset).startsWith(`${i + 1} 0 obj`), `object ${i + 1}`));
});

console.log(`\n${passed} passed`);
