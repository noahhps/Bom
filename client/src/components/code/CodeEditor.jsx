import { useEffect, useRef, useState } from "react";

/* The editor itself: Monaco, loaded the first time the Code view needs it.
 *
 * One Monaco model per open file, kept for as long as its tab is, so switching
 * tabs keeps each file's undo history, cursor and scroll -- the way VS Code
 * does. The view state is saved as a tab loses focus and put back when it
 * regains it.
 *
 * The file's text lives in two places, and this is the only place they meet:
 * the model, which is what the reader types into, and `value`, the tab's copy
 * in useWorkspace. Typing flows model -> tab through `onChange`. A reload from
 * disk -- the agent changed the file -- flows tab -> model, and only when the
 * two actually differ, so the round trip of the reader's own typing never
 * resets their cursor. */

let loading = null;
function loadMonaco() {
  loading ||= import("../../lib/monaco");
  return loading;
}

export function CodeEditor({ path, value, tabs, onChange, onSave, reveal, mode, themeKey, onCursor, onPreview, canPreview }) {
  const host = useRef(null);
  const editor = useRef(null);
  const kit = useRef(null);
  const models = useRef(new Map());
  const views = useRef(new Map());
  const current = useRef(null);
  const handlers = useRef({ onChange, onSave, onCursor, onPreview, canPreview });
  handlers.current = { onChange, onSave, onCursor, onPreview, canPreview };
  // Whether the open file has a preview, for Monaco's own menu to ask.
  const previewable = useRef(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState("");

  // Monaco, and the one editor instance.
  useEffect(() => {
    let live = true;
    loadMonaco()
      .then((module) => {
        if (!live || !host.current) return;
        kit.current = module;
        const { default: monaco } = module;
        const style = getComputedStyle(document.documentElement);
        module.applyTheme(mode);
        const instance = monaco.editor.create(host.current, {
          automaticLayout: true,
          fontFamily: style.getPropertyValue("--font-mono").trim() || "ui-monospace, Menlo, monospace",
          fontSize: 13,
          lineHeight: 20,
          minimap: { enabled: true, renderCharacters: false, scale: 1 },
          scrollBeyondLastLine: false,
          smoothScrolling: true,
          cursorSmoothCaretAnimation: "on",
          renderLineHighlight: "all",
          bracketPairColorization: { enabled: true },
          guides: { indentation: true, bracketPairs: false },
          padding: { top: 10 },
          tabSize: 2,
          detectIndentation: true,
          stickyScroll: { enabled: true },
          fixedOverflowWidgets: true,
        });
        instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
          if (current.current) handlers.current.onSave?.(current.current);
        });
        // Preview, in the editor's own right-click menu and on ⇧⌘V (VS Code's
        // key for it), offered only on a file that has one.
        previewable.current = instance.createContextKey("bomCanPreview", false);
        instance.addAction({
          id: "bom.preview",
          label: "Preview",
          keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyV],
          precondition: "bomCanPreview",
          contextMenuGroupId: "navigation",
          contextMenuOrder: 0,
          run: () => {
            if (current.current) handlers.current.onPreview?.(current.current);
          },
        });
        instance.onDidChangeCursorPosition((event) =>
          handlers.current.onCursor?.({ line: event.position.lineNumber, column: event.position.column }),
        );
        editor.current = instance;
        setReady(true);
      })
      .catch((exc) => live && setFailed(exc?.message || "The editor could not be loaded."));
    return () => {
      live = false;
      editor.current?.dispose();
      editor.current = null;
      for (const model of models.current.values()) model.dispose();
      models.current.clear();
    };
    // Created once; the theme follows below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Light or dark, and the accent -- whatever the rest of the app wears. A
  // frame late: the app writes the new palette in its own effect, which runs
  // after this one, and the theme is read off the document.
  useEffect(() => {
    if (!ready) return undefined;
    const frame = requestAnimationFrame(() => kit.current.applyTheme(mode));
    return () => cancelAnimationFrame(frame);
  }, [ready, mode, themeKey]);

  // Close a tab, and its model goes with it.
  useEffect(() => {
    if (!ready) return;
    const open = new Set(tabs);
    for (const [key, model] of models.current) {
      if (!open.has(key)) {
        model.dispose();
        models.current.delete(key);
        views.current.delete(key);
      }
    }
  }, [ready, tabs]);

  // The active file: find or make its model, and swap it in.
  useEffect(() => {
    if (!ready || !path || value === undefined) return;
    const { default: monaco, languageFor } = kit.current;
    const instance = editor.current;
    let model = models.current.get(path);
    if (!model) {
      model = monaco.editor.createModel(value, languageFor(path), monaco.Uri.file("/" + path));
      model.onDidChangeContent(() => {
        handlers.current.onChange?.(path, model.getValue());
      });
      models.current.set(path, model);
    } else if (model.getValue() !== value) {
      // Changed on disk and reloaded: replace the text as one edit, so it can
      // be undone like any other.
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text: value }], () => null);
    }
    if (current.current !== path) {
      if (current.current) views.current.set(current.current, instance.saveViewState());
      instance.setModel(model);
      const view = views.current.get(path);
      if (view) instance.restoreViewState(view);
      current.current = path;
      instance.focus();
    }
    previewable.current?.set(Boolean(handlers.current.canPreview?.(path)));
  }, [ready, path, value]);

  // Go to a line: a result card or quick open asked for one.
  useEffect(() => {
    if (!ready || !reveal || reveal.path !== path || !editor.current) return;
    const instance = editor.current;
    instance.revealLineInCenter(reveal.line);
    instance.setPosition({ lineNumber: reveal.line, column: 1 });
    instance.focus();
  }, [ready, reveal, path, value]);

  return (
    <div className="code-editor">
      <div className="code-editor-host" ref={host} />
      {!ready && !failed ? <div className="code-editor-note">Loading the editor…</div> : null}
      {failed ? <div className="code-editor-note" data-error="">{failed}</div> : null}
    </div>
  );
}
