/* Monaco -- VS Code's own editor -- loaded for the Code view only.
 *
 * Imported lazily (`import("./monaco")`), never from the main bundle: it is
 * several megabytes, and a chat or a design conversation has no use for it.
 * Everything is bundled rather than fetched from a CDN, so it works offline
 * the way the rest of the app does.
 *
 * The workers are Vite `?worker` imports: each language service runs off the
 * main thread, which is what keeps typing in a large file smooth.
 */

import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import CssWorker from "monaco-editor/language/css/css.worker.js?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker.js?worker";
import JsonWorker from "monaco-editor/language/json/json.worker.js?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker.js?worker";

self.MonacoEnvironment = {
  getWorker(_id, label) {
    if (label === "json") return new JsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new CssWorker();
    if (label === "html" || label === "handlebars" || label === "razor") return new HtmlWorker();
    if (label === "typescript" || label === "javascript") return new TsWorker();
    return new EditorWorker();
  },
};

// The language services report errors against the files they can see, and
// they can see one file at a time -- so an import of a sibling module reads as
// an error in every file. Syntax checking stays; the cross-file semantics,
// which cannot be right here, go.
for (const defaults of [
  monaco.languages.typescript?.typescriptDefaults,
  monaco.languages.typescript?.javascriptDefaults,
]) {
  defaults?.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
  defaults?.setCompilerOptions({
    allowJs: true,
    jsx: monaco.languages.typescript.JsxEmit?.Preserve ?? 1,
    target: monaco.languages.typescript.ScriptTarget?.ESNext ?? 99,
    allowNonTsExtensions: true,
  });
}

/** The Monaco language for a file, by its name. Plain text when unknown. */
export function languageFor(path) {
  const name = (path || "").split("/").pop().toLowerCase();
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot) : "";
  for (const language of monaco.languages.getLanguages()) {
    if (language.filenames?.some((f) => f.toLowerCase() === name)) return language.id;
  }
  if (ext) {
    for (const language of monaco.languages.getLanguages()) {
      if (language.extensions?.some((e) => e.toLowerCase() === ext)) return language.id;
    }
  }
  if (name === "dockerfile") return "dockerfile";
  if (name === "makefile") return "makefile";
  return "plaintext";
}

/** A human name for a language id, for the status bar. */
export function languageName(id) {
  const found = monaco.languages.getLanguages().find((l) => l.id === id);
  return found?.aliases?.[0] || id;
}

/* The editor's theme, drawn from the app's own tokens.
 *
 * Read off the document at the moment it is asked for, so the editor wears
 * whatever the rest of the app is wearing: light or dark, and the accent of
 * the conversation. Monaco wants plain #rrggbb, which is what the palette
 * produces; anything that is not falls back to the base theme's value. */
const HEX = /^#[0-9a-f]{6}$/i;

function token(style, name, fallback) {
  const value = style.getPropertyValue(name).trim();
  return HEX.test(value) ? value : fallback;
}

export function applyTheme(mode) {
  const style = getComputedStyle(document.documentElement);
  const dark = mode === "dark";
  const ground = dark ? token(style, "--sheet", "#000000") : "#ffffff";
  const ink = token(style, "--ink", dark ? "#ededed" : "#0f172a");
  const faint = token(style, "--text-faint", dark ? "#8f8f8f" : "#5f6b7d");
  const line = token(style, "--line", dark ? "#262626" : "#d3dae6");
  const soft = token(style, "--line-soft", dark ? "#1f1f1f" : "#dce2ec");
  const accent = token(style, "--accent", dark ? "#52a8ff" : "#1f4fd8");
  const wash = token(style, "--accent-wash", dark ? "#0b1522" : "#e7ecf9");
  const name = dark ? "bom-dark" : "bom-light";
  monaco.editor.defineTheme(name, {
    base: dark ? "vs-dark" : "vs",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": ground,
      "editor.foreground": ink,
      "editorLineNumber.foreground": faint,
      "editorLineNumber.activeForeground": ink,
      "editor.lineHighlightBackground": dark ? "#0f0f0f" : "#f6f8fb",
      "editor.lineHighlightBorder": "#00000000",
      "editorCursor.foreground": accent,
      "editor.selectionBackground": wash,
      "editor.inactiveSelectionBackground": wash,
      "editorIndentGuide.background1": soft,
      "editorIndentGuide.activeBackground1": line,
      "editorWhitespace.foreground": soft,
      "editorGutter.background": ground,
      "editorWidget.background": dark ? "#0a0a0a" : "#ffffff",
      "editorWidget.border": line,
      "input.background": dark ? "#0a0a0a" : "#ffffff",
      "input.border": line,
      "focusBorder": accent,
      "scrollbarSlider.background": dark ? "#ffffff1a" : "#0f172a1a",
      "scrollbarSlider.hoverBackground": dark ? "#ffffff2e" : "#0f172a2e",
      "minimap.background": ground,
      "diffEditor.insertedTextBackground": dark ? "#2ea04326" : "#2ea04322",
      "diffEditor.removedTextBackground": dark ? "#f8514926" : "#f8514922",
    },
  });
  monaco.editor.setTheme(name);
}

export default monaco;
