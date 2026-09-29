// Which files the Code view renders, and how their paths become addresses.
//
// Run with `npm test` in client/.

import assert from "node:assert/strict";

import { folderOf, onlyPreviewable, previewKind, resolvePath, urlPath } from "../src/lib/filePreview.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`ok  ${name}`);
}

test("pages, documents, PDFs and pictures have a preview; source does not", () => {
  assert.equal(previewKind("index.html"), "html");
  assert.equal(previewKind("site/About.HTM"), "html");
  assert.equal(previewKind("README.md"), "markdown");
  assert.equal(previewKind("docs/guide.mdx"), "markdown");
  assert.equal(previewKind("spec.pdf"), "pdf");
  assert.equal(previewKind("img/logo.png"), "image");
  assert.equal(previewKind("icon.svg"), "image");
  assert.equal(previewKind("app.jsx"), null);
  assert.equal(previewKind("Makefile"), null);
  assert.equal(previewKind(""), null);
});

test("only a picture or a PDF skips the editor; an SVG is text too", () => {
  assert.equal(onlyPreviewable("a.png"), true);
  assert.equal(onlyPreviewable("a.pdf"), true);
  assert.equal(onlyPreviewable("a.svg"), false);
  assert.equal(onlyPreviewable("a.html"), false);
  assert.equal(onlyPreviewable("a.md"), false);
});

test("paths become URL paths with the slashes kept", () => {
  assert.equal(urlPath("my docs/a b.md"), "my%20docs/a%20b.md");
  assert.equal(urlPath("a#1/b?.png"), "a%231/b%3F.png");
  assert.equal(folderOf("docs/img/a.png"), "docs/img/");
  assert.equal(folderOf("a.png"), "");
});

test("relative links resolve inside the project, and no further", () => {
  assert.equal(resolvePath("docs/a.md", "b.md"), "docs/b.md");
  assert.equal(resolvePath("docs/a.md", "./b.md#part"), "docs/b.md");
  assert.equal(resolvePath("docs/a.md", "../README.md"), "README.md");
  assert.equal(resolvePath("docs/a.md", "../src/app%20x.js?raw"), "src/app x.js");
  assert.equal(resolvePath("a.md", "../outside.md"), null);
  assert.equal(resolvePath("a.md", "https://example.com"), null);
  assert.equal(resolvePath("a.md", "mailto:x@y.z"), null);
  assert.equal(resolvePath("a.md", "/etc/passwd"), null);
  assert.equal(resolvePath("a.md", "#top"), null);
});

console.log(`\n${passed} passed`);
