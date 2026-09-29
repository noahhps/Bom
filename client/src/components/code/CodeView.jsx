import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Icon } from "../Icon";
import { onlyPreviewable, previewKind } from "../../lib/filePreview";
import { CodeEditor } from "./CodeEditor";
import { CodeContext } from "./CodeParts";
import { ContextMenu } from "./ContextMenu";
import { DesignsPanel } from "./DesignsPanel";
import { Explorer } from "./Explorer";
import { FilePreview } from "./FilePreview";
import { FolderPicker } from "./FolderPicker";
import { Preview } from "./Preview";
import { TerminalPanel } from "./TerminalPanel";
import { QuickOpen } from "./QuickOpen";

/* The Code view: an editor on the left, the conversation on the right.
 *
 * The left is laid out the way VS Code is -- Explorer, tabs, breadcrumbs, the
 * editor, a status bar -- because that is the arrangement anyone who writes
 * code already reads without thinking. The right is the same conversation as
 * everywhere else in the app, working on this folder: what it changes appears
 * in the editor as it changes it, and every path it mentions opens there.
 *
 * The divider between them is dragged to taste and remembered on this device. */

const WIDTH_KEY = "bom.code.chat-width";
const PANE_KEY = "bom.code.pane";
const TERM_KEY = "bom.code.terminal";
const TERM_HEIGHT_KEY = "bom.code.terminal-height";
const MIN_CHAT = 340;

const LANGUAGE_NAMES = {
  js: "JavaScript", jsx: "JavaScript JSX", mjs: "JavaScript", cjs: "JavaScript",
  ts: "TypeScript", tsx: "TypeScript JSX", py: "Python", rs: "Rust", go: "Go",
  java: "Java", kt: "Kotlin", swift: "Swift", rb: "Ruby", php: "PHP", c: "C",
  h: "C", cpp: "C++", cc: "C++", hpp: "C++", cs: "C#", css: "CSS", scss: "SCSS",
  less: "Less", html: "HTML", vue: "Vue", svelte: "Svelte", json: "JSON",
  md: "Markdown", yml: "YAML", yaml: "YAML", toml: "TOML", ini: "INI", sh: "Shell",
  zsh: "Shell", bash: "Shell", sql: "SQL", xml: "XML", svg: "SVG", txt: "Plain Text",
  dockerfile: "Dockerfile", lua: "Lua", dart: "Dart", r: "R",
};

function languageLabel(path) {
  const name = (path || "").split("/").pop().toLowerCase();
  if (name === "dockerfile") return "Dockerfile";
  if (name === "makefile") return "Makefile";
  const ext = name.includes(".") ? name.split(".").pop() : "";
  return LANGUAGE_NAMES[ext] || (ext ? ext.toUpperCase() : "Plain Text");
}

function useChatWidth() {
  const [width, setWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(WIDTH_KEY));
      return Number.isFinite(saved) && saved >= MIN_CHAT ? saved : 440;
    } catch {
      return 440;
    }
  });
  const [dragging, setDragging] = useState(false);
  const live = useRef(width);
  live.current = width;

  const start = useCallback((event) => {
    event.preventDefault();
    const pane = event.currentTarget.parentElement;
    const right = pane.getBoundingClientRect().right;
    const max = Math.max(MIN_CHAT, pane.getBoundingClientRect().width * 0.7);
    setDragging(true);
    const move = (e) => setWidth(Math.round(Math.min(max, Math.max(MIN_CHAT, right - e.clientX))));
    const stop = () => {
      setDragging(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      try {
        localStorage.setItem(WIDTH_KEY, String(live.current));
      } catch {
        // A width that is not remembered is still a width.
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  }, []);

  return { width, dragging, start };
}

/* The tab strip: the open files, then any previews -- one per previewed file,
 * then the project's own preview -- and at its right end the Run/Preview
 * button for whatever is in front. `front` is null while the editor is. */
function Tabs({ ws, front, filePreviews, url, onFile, onFilePreview, onCloseFilePreview, onMenu, action }) {
  return (
    <div className="code-tabs-row">
      <div className="code-tabs" role="tablist" aria-label="Open files">
        {ws.tabs.map((tab) => {
          const name = tab.path.split("/").pop();
          const dirty = tab.content !== undefined && tab.content !== tab.saved;
          const active = tab.path === ws.active && front === null;
          return (
            <div
              key={tab.path}
              className="code-tab"
              role="tab"
              aria-selected={active}
              data-active={active ? "" : undefined}
              data-dirty={dirty ? "" : undefined}
              title={tab.path}
              onMouseDown={(event) => {
                if (event.button === 1) {
                  event.preventDefault();
                  ws.close(tab.path);
                }
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                onMenu(event, tab.path, false);
              }}
            >
              <button type="button" className="code-tab-name" onClick={() => onFile(tab.path)}>
                {tab.conflict ? <span className="code-tab-warn" title="Changed on disk">!</span> : null}
                {name}
              </button>
              <button
                type="button"
                className="code-tab-close"
                aria-label={`Close ${name}`}
                title={dirty ? "Unsaved changes -- close anyway" : "Close"}
                onClick={() => ws.close(tab.path)}
              >
                <span className="code-tab-dot" aria-hidden="true" />
                <Icon name="close" />
              </button>
            </div>
          );
        })}
        {filePreviews.map((path) => {
          const active = front === `file:${path}`;
          const name = path.split("/").pop();
          return (
            <div
              key={`preview:${path}`}
              className="code-tab"
              role="tab"
              aria-selected={active}
              data-active={active ? "" : undefined}
              data-preview=""
              title={`Preview of ${path}`}
              onMouseDown={(event) => {
                if (event.button === 1) {
                  event.preventDefault();
                  onCloseFilePreview(path);
                }
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                onMenu(event, path, true);
              }}
            >
              <button type="button" className="code-tab-name" onClick={() => onFilePreview(path)}>
                <Icon name="preview" />
                {name}
              </button>
              <button
                type="button"
                className="code-tab-close"
                aria-label={`Close the preview of ${name}`}
                title="Close"
                onClick={() => onCloseFilePreview(path)}
              >
                <span className="code-tab-dot" aria-hidden="true" />
                <Icon name="close" />
              </button>
            </div>
          );
        })}
        {url.shown ? (
          <div
            className="code-tab"
            role="tab"
            aria-selected={front === "url"}
            data-active={front === "url" ? "" : undefined}
            data-preview=""
            title={url.url || "Preview"}
          >
            <button type="button" className="code-tab-name" onClick={url.onSelect}>
              <Icon name="globe" />
              Preview
            </button>
            <button type="button" className="code-tab-close" aria-label="Close the preview" title="Close" onClick={url.onClose}>
              <span className="code-tab-dot" aria-hidden="true" />
              <Icon name="close" />
            </button>
          </div>
        ) : null}
      </div>
      {action}
    </div>
  );
}

function Welcome({ ws, onOpen }) {
  const changed = [...ws.changed].slice(-6).reverse();
  return (
    <div className="code-welcome">
      <p className="code-welcome-name">{ws.info?.name || ""}</p>
      <dl className="code-welcome-keys">
        <div>
          <dt>Go to file</dt>
          <dd><kbd>⌘</kbd><kbd>P</kbd></dd>
        </div>
        <div>
          <dt>Save</dt>
          <dd><kbd>⌘</kbd><kbd>S</kbd></dd>
        </div>
        <div>
          <dt>Change the code</dt>
          <dd>ask on the right</dd>
        </div>
      </dl>
      {changed.length ? (
        <div className="code-welcome-changed">
          <span className="mi">Changed by the assistant</span>
          {changed.map((path) => (
            <button key={path} type="button" className="code-path" data-link="" onClick={() => onOpen(path)}>
              {path}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function CodeView({
  api,
  ws,
  mode,
  themeKey,
  onChangeFolder,
  onPickFolder,
  onNewProject,
  designs = [],
  linkedDesign = null,
  onRefreshDesigns,
  onAskAboutDesign,
  chat,
  busy,
}) {
  const [quick, setQuick] = useState(false);
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  // What the left column shows: the project's files, or the designs to build
  // them from. Remembered on this device.
  const [pane, setPane] = useState(() => {
    try {
      return localStorage.getItem(PANE_KEY) === "designs" ? "designs" : "files";
    } catch {
      return "files";
    }
  });
  const showPane = (next) => {
    setPane(next);
    try {
      localStorage.setItem(PANE_KEY, next);
    } catch {
      // Not remembered; still shown.
    }
  };
  const designCount = designs.reduce((n, group) => n + group.designs.length, 0);
  const switcher = (
    <div className="code-side-tabs" role="tablist" aria-label="Sidebar">
      <button type="button" role="tab" aria-selected={pane === "files"} onClick={() => showPane("files")}>
        Files
      </button>
      <button type="button" role="tab" aria-selected={pane === "designs"} onClick={() => showPane("designs")}>
        Designs{designCount ? <span className="mi">{designCount}</span> : null}
      </button>
    </div>
  );
  const split = useChatWidth();

  // What is in front of the editor: nothing (null), the project running
  // ("url"), or one file rendered ("file:<path>"). Each has a tab of its own.
  const [front, setFront] = useState(null);
  // The project's own preview: a tab beside the files, showing it running.
  const [urlShown, setUrlShown] = useState(false);
  const [previewUrl, setPreviewUrl] = useState(null);
  // The last local address a terminal printed -- what the preview offers.
  const [detected, setDetected] = useState(null);
  const openPreview = useCallback((url = null) => {
    setUrlShown(true);
    setFront("url");
    if (url) setPreviewUrl(url);
  }, []);
  // Files shown rendered -- a page, a document, a PDF, a picture -- each in
  // its own tab after the files' own.
  const [filePreviews, setFilePreviews] = useState([]);
  const openFilePreview = useCallback((path) => {
    const clean = String(path || "").replace(/^\.\//, "");
    if (!previewKind(clean)) return;
    setFilePreviews((was) => (was.includes(clean) ? was : [...was, clean]));
    setFront(`file:${clean}`);
  }, []);
  const closeFilePreview = useCallback((path) => {
    setFilePreviews((was) => was.filter((p) => p !== path));
    setFront((was) => (was === `file:${path}` ? null : was));
  }, []);
  // Any path, opened the one way it can be: a picture or a PDF as its
  // preview, anything else in the editor.
  const openPath = useCallback(
    (path, line = null) => {
      if (onlyPreviewable(path)) openFilePreview(path);
      else ws.openFile(path, line);
    },
    [ws.openFile, openFilePreview],
  );
  // Opening a file brings the editor back to the front.
  useEffect(() => setFront((was) => (was === null ? was : null)), [ws.active]);
  const showSource = useCallback(
    (path) => {
      setFront(null);
      ws.openFile(path);
    },
    [ws.openFile],
  );

  // Where the preview route serves this project's files from.
  const [previewBase, setPreviewBase] = useState(null);
  const wantBase = filePreviews.length > 0;
  useEffect(() => {
    let live = true;
    setPreviewBase(null);
    if (!ws.root || !wantBase) return undefined;
    api
      .previewFiles(ws.root)
      .then((found) => live && setPreviewBase(found.base))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [api, ws.root, wantBase]);

  // A count that moves whenever something in the project is saved or changed
  // on disk -- what runs a previewed page again.
  const [diskStamp, setDiskStamp] = useState(0);
  const savedRef = useRef(new Map());
  useEffect(() => {
    let moved = false;
    const next = new Map();
    for (const t of ws.tabs) {
      next.set(t.path, t.saved);
      const was = savedRef.current.get(t.path);
      if (was !== undefined && was !== t.saved) moved = true;
    }
    savedRef.current = next;
    if (moved) setDiskStamp((n) => n + 1);
  }, [ws.tabs]);
  useEffect(() => setDiskStamp((n) => n + 1), [ws.changed]);

  // The right-click menu, on a file in the tree or a tab.
  const [menu, setMenu] = useState(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const copy = (value) => navigator.clipboard?.writeText(value).catch(() => {});
  const menuFor = useCallback(
    (event, path, { isDir = false, close = null } = {}) => {
      const absolute = `${ws.root.replace(/\/$/, "")}/${path}`;
      const items = [];
      if (!isDir) {
        const kind = previewKind(path);
        if (!onlyPreviewable(path)) {
          items.push({ label: "Open", onClick: () => showSource(path) });
        }
        items.push({
          label: kind === "html" ? "Run" : "Preview",
          keys: "⇧⌘V",
          disabled: !kind,
          onClick: () => openFilePreview(path),
        });
        items.push("-");
      }
      items.push({ label: "Copy path", onClick: () => copy(absolute) });
      items.push({ label: "Copy relative path", onClick: () => copy(path) });
      if (close) {
        items.push("-");
        items.push({ label: "Close", onClick: close });
      }
      setMenu({ x: event.clientX, y: event.clientY, items });
    },
    [ws.root, showSource, openFilePreview],
  );

  // The terminal: a panel under the editor, open or shut as it was left.
  // Mounted the first time it opens and kept after, hidden, so its shells
  // stay attached while it is out of the way.
  const [termOpen, setTermOpen] = useState(() => {
    try {
      return localStorage.getItem(TERM_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [termMounted, setTermMounted] = useState(termOpen);
  const [termHeight, setTermHeight] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(TERM_HEIGHT_KEY));
      return Number.isFinite(saved) && saved >= 120 ? saved : 240;
    } catch {
      return 240;
    }
  });
  const showTerminal = useCallback((open) => {
    setTermOpen(open);
    if (open) setTermMounted(true);
    try {
      localStorage.setItem(TERM_KEY, open ? "1" : "0");
    } catch {
      // Not remembered; still shown.
    }
  }, []);
  // A command to run in a new terminal tab -- the preview's "Start". Held
  // until the panel is there to take it.
  const runRef = useRef(null);
  const [pendingRun, setPendingRun] = useState(null);
  useEffect(() => {
    if (pendingRun && termMounted && runRef.current) {
      runRef.current(pendingRun);
      setPendingRun(null);
    }
  }, [pendingRun, termMounted]);
  const runInTerminal = useCallback(
    (command) => {
      showTerminal(true);
      setPendingRun(command);
    },
    [showTerminal],
  );
  // A link in the terminal: a local server opens in the preview, anything
  // else in a browser.
  const onTerminalLink = useCallback(
    (uri) => {
      if (/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])[:/]/.test(uri)) {
        openPreview(uri.replace("0.0.0.0", "localhost"));
      } else {
        window.open(uri, "_blank", "noopener");
      }
    },
    [openPreview],
  );
  const startTermResize = useCallback(
    (event) => {
      event.preventDefault();
      const panel = event.currentTarget.parentElement;
      const bottom = panel.getBoundingClientRect().bottom;
      const max = Math.max(160, panel.getBoundingClientRect().height * 0.75);
      let latest = termHeight;
      const move = (e) => {
        latest = Math.round(Math.min(max, Math.max(120, bottom - e.clientY - 24)));
        setTermHeight(latest);
      };
      const stop = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", stop);
        try {
          localStorage.setItem(TERM_HEIGHT_KEY, String(latest));
        } catch {
          // A height that is not remembered is still a height.
        }
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", stop);
    },
    [termHeight],
  );
  // Another project: its own preview, and the terminal starts again from
  // that project's shells.
  useEffect(() => {
    setPreviewUrl(null);
    setDetected(null);
    setUrlShown(false);
    setFilePreviews([]);
    setFront(null);
    setMenu(null);
  }, [ws.root]);

  const tab = ws.tabs.find((t) => t.path === ws.active) || null;
  const dirty = tab && tab.content !== undefined && tab.content !== tab.saved;
  const context = useMemo(() => ({ openFile: openPath }), [openPath]);
  const previewing = front?.startsWith("file:") ? front.slice(5) : null;
  const previewTab = previewing ? ws.tabs.find((t) => t.path === previewing) || null : null;
  const editing = front === null;

  // The button at the right end of the tabs: run the page, or preview the
  // document, that is open -- and, from a preview, back to its source.
  const activeKind = tab && editing ? previewKind(tab.path) : null;
  const action = previewing && !onlyPreviewable(previewing) ? (
    <button
      type="button"
      className="code-tabs-action"
      title="Back to the source"
      onClick={() => showSource(previewing)}
    >
      <Icon name="code" />
      <span>Source</span>
    </button>
  ) : activeKind ? (
    <button
      type="button"
      className="code-tabs-action"
      data-run={activeKind === "html" ? "" : undefined}
      title={`${activeKind === "html" ? "Run" : "Preview"} ${tab.path.split("/").pop()} (⇧⌘V)`}
      onClick={() => openFilePreview(tab.path)}
    >
      <Icon name={activeKind === "html" ? "play" : "preview"} />
      <span>{activeKind === "html" ? "Run" : "Preview"}</span>
    </button>
  ) : null;

  // ⌘P from anywhere in the view, as in VS Code.
  useEffect(() => {
    const onKey = (event) => {
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === "p") {
        if (!ws.root) return;
        event.preventDefault();
        setQuick(true);
      }
      // ⌃` for the terminal, as in VS Code.
      if (event.ctrlKey && !event.metaKey && (event.key === "`" || event.code === "Backquote")) {
        if (!ws.root) return;
        event.preventDefault();
        showTerminal(!termOpen);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ws.root, termOpen, showTerminal]);

  return (
    <CodeContext.Provider value={context}>
      <div
        className="code-view"
        data-dragging={split.dragging ? "" : undefined}
        style={{ "--code-chat-w": `${split.width}px` }}
      >
        <section className="code-ide" aria-label="Editor">
          {ws.root ? (
            <>
              {pane === "designs" ? (
                <DesignsPanel
                  api={api}
                  ws={ws}
                  groups={designs}
                  linked={linkedDesign}
                  onRefresh={onRefreshDesigns}
                  onAsk={onAskAboutDesign}
                  switcher={switcher}
                />
              ) : (
                <Explorer
                  ws={ws}
                  onChangeFolder={onChangeFolder}
                  switcher={switcher}
                  onOpen={openPath}
                  onMenu={(event, entry) => menuFor(event, entry.path, { isDir: entry.kind === "dir" })}
                />
              )}
              <div className="code-main">
                <Tabs
                  ws={ws}
                  front={front}
                  filePreviews={filePreviews}
                  onFile={(path) => {
                    setFront(null);
                    ws.setActive(path);
                  }}
                  onFilePreview={(path) => setFront(`file:${path}`)}
                  onCloseFilePreview={closeFilePreview}
                  onMenu={(event, path, isPreview) =>
                    menuFor(event, path, { close: () => (isPreview ? closeFilePreview(path) : ws.close(path)) })
                  }
                  url={{
                    shown: urlShown,
                    url: previewUrl,
                    onSelect: () => openPreview(),
                    onClose: () => {
                      setUrlShown(false);
                      setFront((was) => (was === "url" ? null : was));
                    },
                  }}
                  action={action}
                />
                {tab && editing ? (
                  <div className="code-crumbs" aria-label="Path">
                    {tab.path.split("/").map((part, i, parts) => (
                      <span key={i} data-last={i === parts.length - 1 ? "" : undefined}>
                        {part}
                      </span>
                    ))}
                  </div>
                ) : null}
                {!editing ? null : tab?.conflict ? (
                  <div className="code-banner" role="alert">
                    <span>
                      <b>{tab.path}</b> changed on disk
                      {dirty ? " while you had unsaved edits" : ""}.
                    </span>
                    <button type="button" className="btn" onClick={() => ws.reload(tab.path)}>
                      Load theirs
                    </button>
                    {dirty ? (
                      <button type="button" className="btn" onClick={() => ws.save(tab.path, true)}>
                        Keep mine
                      </button>
                    ) : null}
                  </div>
                ) : tab?.saveError ? (
                  <div className="code-banner" role="alert" data-error="">
                    <span>{tab.saveError}</span>
                    <button type="button" className="btn" onClick={() => ws.save(tab.path)}>
                      Try again
                    </button>
                  </div>
                ) : null}
                <div className="code-slot" data-behind={editing ? undefined : ""}>
                  {/* Kept mounted whatever is open, so every tab's model --
                      its undo history and its scroll -- outlives the switch. */}
                  <CodeEditor
                    path={tab && tab.content !== undefined ? tab.path : null}
                    value={tab?.content}
                    tabs={ws.tabs.map((t) => t.path)}
                    onChange={ws.edit}
                    onSave={(path) => ws.save(path)}
                    reveal={ws.reveal}
                    mode={mode}
                    themeKey={themeKey}
                    onCursor={setCursor}
                    onPreview={openFilePreview}
                    canPreview={(path) => Boolean(previewKind(path))}
                  />
                  {previewing ? (
                    <FilePreview
                      key={previewing}
                      api={api}
                      root={ws.root}
                      path={previewing}
                      base={previewBase}
                      text={previewTab?.content}
                      dirty={Boolean(previewTab && previewTab.content !== undefined && previewTab.content !== previewTab.saved)}
                      stamp={diskStamp}
                      onSource={onlyPreviewable(previewing) ? null : () => showSource(previewing)}
                      onOpen={openPath}
                    />
                  ) : front === "url" ? (
                    <Preview
                      api={api}
                      root={ws.root}
                      url={previewUrl}
                      onUrl={setPreviewUrl}
                      detected={detected}
                      onRun={runInTerminal}
                    />
                  ) : !tab ? (
                    <Welcome ws={ws} onOpen={openPath} />
                  ) : tab.loading ? (
                    <div className="code-editor-note">Opening {tab.path}…</div>
                  ) : tab.error ? (
                    <div className="code-editor-note" data-error="">{tab.error}</div>
                  ) : null}
                </div>
                {termMounted ? (
                  <div
                    className="code-term-wrap"
                    hidden={!termOpen}
                    style={{ "--term-h": `${termHeight}px` }}
                  >
                    <div
                      className="code-term-grip"
                      role="separator"
                      aria-orientation="horizontal"
                      aria-label="Resize the terminal"
                      onPointerDown={startTermResize}
                    />
                    <TerminalPanel
                      api={api}
                      root={ws.root}
                      mode={mode}
                      themeKey={themeKey}
                      onLink={onTerminalLink}
                      onUrl={setDetected}
                      onHide={() => showTerminal(false)}
                      runRef={runRef}
                    />
                  </div>
                ) : null}
                <footer className="code-status">
                  <button type="button" className="code-status-item" onClick={onChangeFolder} title={ws.root}>
                    <Icon name="folder" />
                    {ws.info?.name || ws.root.split("/").pop()}
                  </button>
                  {ws.info?.branch ? (
                    <span className="code-status-item" title="Git branch">
                      <Icon name="branch" />
                      {ws.info.branch}
                    </span>
                  ) : null}
                  {busy ? <span className="code-status-item" data-busy="">Working…</span> : null}
                  <span className="spacer" />
                  <button
                    type="button"
                    className="code-status-item"
                    data-on={front === "url" ? "" : undefined}
                    title={detected ? `Preview -- ${detected}` : "Preview the project"}
                    onClick={() => (front === "url" ? setFront(null) : openPreview())}
                  >
                    <Icon name="globe" />
                    Preview
                    {detected && !previewUrl ? <span className="code-status-dot" aria-hidden="true" /> : null}
                  </button>
                  <button
                    type="button"
                    className="code-status-item"
                    data-on={termOpen ? "" : undefined}
                    title="Terminal (⌃`)"
                    onClick={() => showTerminal(!termOpen)}
                  >
                    <Icon name="terminal" />
                    Terminal
                  </button>
                  {tab && tab.content !== undefined && editing ? (
                    <>
                      <span className="code-status-item">
                        Ln {cursor.line}, Col {cursor.column}
                      </span>
                      <span className="code-status-item">{languageLabel(tab.path)}</span>
                      <span className="code-status-item" data-dirty={dirty ? "" : undefined}>
                        {dirty ? "Unsaved" : "Saved"}
                      </span>
                    </>
                  ) : null}
                </footer>
              </div>
            </>
          ) : (
            <div className="code-empty">
              <FolderPicker api={api} onPick={onPickFolder} onNewProject={onNewProject} embedded />
            </div>
          )}
        </section>

        <div
          className="code-split"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the conversation"
          onPointerDown={split.start}
        />

        <section className="code-chat" aria-label="Conversation">
          {chat}
        </section>

        {quick ? (
          <QuickOpen loadFiles={ws.loadFiles} onOpen={openPath} onClose={() => setQuick(false)} />
        ) : null}
        {menu ? <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={closeMenu} /> : null}
      </div>
    </CodeContext.Provider>
  );
}
