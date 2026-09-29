import { useDialog } from "../Dialog";
import { Icon } from "../Icon";

/* The file tree, VS Code's Explorer: the project's name as the heading, a
 * handful of actions beside it, and folders that unfold in place.
 *
 * Dependency and build folders (node_modules, dist, .venv…) are listed but
 * dimmed -- they are part of the project on disk, just not part of what anyone
 * is working on. A file the agent changed this session carries a dot, and one
 * open with unsaved edits a filled circle, the way the editor's tabs do. */

const EXT_TINT = {
  js: "#e9c46a", jsx: "#61dafb", ts: "#3178c6", tsx: "#3178c6", mjs: "#e9c46a",
  py: "#3572a5", rs: "#dea584", go: "#00add8", java: "#b07219", rb: "#cc342d",
  css: "#663399", scss: "#c6538c", html: "#e34c26", json: "#cbcb41", md: "#519aba",
  yml: "#cb171e", yaml: "#cb171e", toml: "#9c4221", sh: "#89e051", swift: "#f05138",
  kt: "#a97bff", c: "#555555", h: "#555555", cpp: "#f34b7d", sql: "#e38c00",
};

function tintFor(name) {
  const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
  return EXT_TINT[ext] || "var(--text-faint)";
}

function Rows({ folder, depth, ws, dirty, onOpen, onMenu }) {
  const entries = ws.dirs[folder];
  if (!entries) {
    return <div className="code-tree-row" data-note="" style={{ "--depth": depth }}>Loading…</div>;
  }
  if (!entries.length && depth > 0) {
    return <div className="code-tree-row" data-note="" style={{ "--depth": depth }}>Empty</div>;
  }
  return entries.map((entry) => {
    const open = entry.kind === "dir" && ws.expanded.has(entry.path);
    return (
      <div key={entry.path} role="none">
        <button
          type="button"
          role="treeitem"
          aria-expanded={entry.kind === "dir" ? open : undefined}
          aria-selected={ws.active === entry.path}
          className="code-tree-row"
          data-kind={entry.kind}
          data-ignored={entry.ignored ? "" : undefined}
          data-active={ws.active === entry.path ? "" : undefined}
          style={{ "--depth": depth }}
          title={entry.path}
          onClick={() => (entry.kind === "dir" ? ws.toggleDir(entry.path) : onOpen(entry.path))}
          onContextMenu={(event) => {
            if (!onMenu) return;
            event.preventDefault();
            onMenu(event, entry);
          }}
        >
          {entry.kind === "dir" ? (
            <span className="code-tree-chevron" data-open={open ? "" : undefined}>
              <Icon name="chevron" />
            </span>
          ) : (
            <span className="code-tree-dot" style={{ background: tintFor(entry.name) }} />
          )}
          <span className="code-tree-name">{entry.name}</span>
          {dirty.has(entry.path) ? (
            <span className="code-tree-mark" data-dirty="" title="Unsaved changes" />
          ) : ws.changed.has(entry.path) ? (
            <span className="code-tree-mark" title="Changed by the assistant" />
          ) : null}
        </button>
        {open ? (
          <Rows folder={entry.path} depth={depth + 1} ws={ws} dirty={dirty} onOpen={onOpen} onMenu={onMenu} />
        ) : null}
      </div>
    );
  });
}

// `onOpen` is what clicking a file does -- open it in the editor, or show its
// preview when it is a picture or a PDF the editor cannot hold -- and `onMenu`
// the right-click menu on a row.
export function Explorer({ ws, onChangeFolder, switcher = null, onOpen, onMenu }) {
  const { ask } = useDialog();
  const dirty = new Set(
    ws.tabs.filter((t) => t.content !== undefined && t.content !== t.saved).map((t) => t.path),
  );
  // New files land beside whatever is open, the way VS Code does it.
  const here = ws.active && ws.active.includes("/") ? ws.active.slice(0, ws.active.lastIndexOf("/") + 1) : "";

  const make = async (kind) => {
    const name = await ask(kind === "folder" ? "New folder" : "New file", {
      value: here,
      confirmLabel: "Create",
    });
    if (!name || !name.trim()) return;
    try {
      await ws.create(name.trim(), kind);
    } catch (exc) {
      window.alert(exc.message || "That could not be created.");
    }
  };

  return (
    <aside className="code-explorer" aria-label="Explorer">
      {switcher}
      <div className="code-explorer-head">
        <button
          type="button"
          className="code-explorer-name mi"
          title={`${ws.root} -- open another folder`}
          onClick={onChangeFolder}
        >
          {ws.info?.name || ws.root?.split("/").pop() || "Project"}
        </button>
        <span className="spacer" />
        <button type="button" className="code-icon-btn" title="New file" aria-label="New file" onClick={() => make("file")}>
          <Icon name="plus" />
        </button>
        <button type="button" className="code-icon-btn" title="New folder" aria-label="New folder" onClick={() => make("folder")}>
          <Icon name="folder" />
        </button>
        <button type="button" className="code-icon-btn" title="Refresh" aria-label="Refresh" onClick={() => ws.refresh(["*"])}>
          <Icon name="refresh" />
        </button>
        <button type="button" className="code-icon-btn" data-collapse="" title="Collapse folders" aria-label="Collapse folders" onClick={ws.collapseAll}>
          <Icon name="chevron" />
        </button>
      </div>
      <div className="code-tree" role="tree" aria-label={ws.info?.name || "Files"}>
        {ws.error ? (
          <p className="code-tree-error">{ws.error}</p>
        ) : (
          <Rows folder="." depth={0} ws={ws} dirty={dirty} onOpen={onOpen || ws.openFile} onMenu={onMenu} />
        )}
      </div>
    </aside>
  );
}
