import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The project folder the Code view has open: its tree, its open files, and
 * what the agent has changed.
 *
 * A tab keeps two copies of its file -- `content`, what is in the editor, and
 * `saved`, what was last read from or written to disk -- and the modification
 * time it was read at. A save sends that time, and the server refuses one made
 * from an older version than the file on disk: the agent may have edited it
 * meanwhile, and that edit must not be written over without the reader
 * choosing to (`conflict`).
 *
 * When the agent changes a file, a tab with no unsaved edits simply reloads.
 * One with unsaved edits is left alone and marked, because the reader's
 * typing is the one thing here that exists nowhere else.
 */
export function useWorkspace(api, root) {
  const [info, setInfo] = useState(null);
  const [error, setError] = useState("");
  const [dirs, setDirs] = useState({});
  const [expanded, setExpanded] = useState(() => new Set(["."]));
  const [tabs, setTabs] = useState([]);
  const [active, setActive] = useState(null);
  const [reveal, setReveal] = useState(null);
  const [changed, setChanged] = useState(() => new Set());
  const [files, setFiles] = useState(null);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const dirsRef = useRef(dirs);
  dirsRef.current = dirs;
  const rootRef = useRef(root);
  rootRef.current = root;
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;

  const loadDir = useCallback(
    async (path = ".") => {
      if (!root) return;
      try {
        const data = await api.folderTree(root, path);
        if (rootRef.current !== root) return;
        setDirs((was) => ({ ...was, [path]: data.entries }));
      } catch (exc) {
        if (path === ".") setError(exc.message || "The folder could not be read.");
      }
    },
    [api, root],
  );

  // A different folder is a fresh editor: nothing of the last one carries over.
  useEffect(() => {
    setInfo(null);
    setError("");
    setDirs({});
    setExpanded(new Set(["."]));
    setTabs([]);
    setActive(null);
    setChanged(new Set());
    setFiles(null);
    if (!root) return undefined;
    let live = true;
    api
      .openFolder(root)
      .then((data) => live && setInfo(data))
      .catch((exc) => live && setError(exc.message || "That folder cannot be opened."));
    loadDir(".");
    return () => {
      live = false;
    };
  }, [api, root, loadDir]);

  const toggleDir = useCallback(
    (path) => {
      const next = new Set(expandedRef.current);
      if (next.has(path)) next.delete(path);
      else {
        next.add(path);
        if (!dirsRef.current[path]) loadDir(path);
      }
      setExpanded(next);
    },
    [loadDir],
  );

  const collapseAll = useCallback(() => setExpanded(new Set(["."])), []);

  /** Open a file in a tab (or bring its tab forward), optionally at a line. */
  const openFile = useCallback(
    async (path, line = null) => {
      if (!root || !path) return;
      const clean = path.replace(/^\.\//, "");
      setActive(clean);
      if (line) setReveal({ path: clean, line, nonce: Date.now() });
      // Unfold the folders it is in, so the tree shows where it lives.
      const parts = clean.split("/").slice(0, -1);
      if (parts.length) {
        const next = new Set(expandedRef.current);
        parts.forEach((_, i) => {
          const folder = parts.slice(0, i + 1).join("/");
          if (!next.has(folder)) {
            next.add(folder);
            if (!dirsRef.current[folder]) loadDir(folder);
          }
        });
        setExpanded(next);
      }
      if (tabsRef.current.some((t) => t.path === clean)) return;
      setTabs((was) => [...was, { path: clean, loading: true }]);
      try {
        const file = await api.readProjectFile(root, clean);
        setTabs((was) =>
          was.map((t) =>
            t.path === clean
              ? { path: clean, content: file.content, saved: file.content, mtime: file.mtime }
              : t,
          ),
        );
      } catch (exc) {
        setTabs((was) =>
          was.map((t) => (t.path === clean ? { path: clean, error: exc.message || "Could not open." } : t)),
        );
      }
    },
    [api, root, loadDir],
  );

  const edit = useCallback((path, content) => {
    setTabs((was) => was.map((t) => (t.path === path ? { ...t, content } : t)));
  }, []);

  /** Re-read a file from disk, dropping unsaved edits. */
  const reload = useCallback(
    async (path) => {
      if (!root) return;
      try {
        const file = await api.readProjectFile(root, path);
        setTabs((was) =>
          was.map((t) =>
            t.path === path
              ? { path, content: file.content, saved: file.content, mtime: file.mtime }
              : t,
          ),
        );
      } catch (exc) {
        setTabs((was) =>
          was.map((t) => (t.path === path ? { ...t, error: exc.message || "It is gone." } : t)),
        );
      }
    },
    [api, root],
  );

  /** Write a tab to disk. `force` writes over a newer version on disk. */
  const save = useCallback(
    async (path, force = false) => {
      const tab = tabsRef.current.find((t) => t.path === path);
      if (!root || !tab || tab.content === undefined) return false;
      if (tab.content === tab.saved && !force && !tab.conflict) return true;
      const content = tab.content;
      try {
        const result = await api.saveProjectFile(root, path, content, tab.mtime, force);
        setTabs((was) =>
          was.map((t) =>
            t.path === path
              ? { ...t, saved: content, mtime: result.mtime, conflict: false, saveError: null }
              : t,
          ),
        );
        return true;
      } catch (exc) {
        setTabs((was) =>
          was.map((t) =>
            t.path === path
              ? exc.status === 409
                ? { ...t, conflict: true }
                : { ...t, saveError: exc.message || "Could not save." }
              : t,
          ),
        );
        return false;
      }
    },
    [api, root],
  );

  const close = useCallback((path) => {
    const was = tabsRef.current;
    const index = was.findIndex((t) => t.path === path);
    const next = was.filter((t) => t.path !== path);
    setTabs(next);
    setActive((current) =>
      current === path ? (next[Math.min(index, next.length - 1)]?.path ?? null) : current,
    );
  }, []);

  /** The agent changed these files ("*" for anything, after a command). */
  const refresh = useCallback(
    async (paths) => {
      if (!root) return;
      const all = paths.includes("*");
      const named = paths.filter((p) => p !== "*");
      if (named.length) {
        setChanged((was) => new Set([...was, ...named]));
      }
      // The folders whose listing may have changed: all of them after a
      // command, or every folder above a named file -- a file written into a
      // new folder changes the listing of the folder that folder is in.
      const above = (p) => {
        const parts = p.split("/").slice(0, -1);
        return [".", ...parts.map((_, i) => parts.slice(0, i + 1).join("/"))];
      };
      const folders = all ? Object.keys(dirsRef.current) : [...new Set(named.flatMap(above))];
      for (const folder of folders) {
        if (all || dirsRef.current[folder] || folder === ".") loadDir(folder);
      }
      setFiles(null);
      for (const tab of tabsRef.current) {
        if (!all && !named.includes(tab.path)) continue;
        if (tab.content !== undefined && tab.content !== tab.saved) {
          // Unsaved edits win until the reader decides: say the file moved on.
          setTabs((was) => was.map((t) => (t.path === tab.path ? { ...t, conflict: true } : t)));
          continue;
        }
        if (all) {
          // After a command, only reload a file that actually changed.
          try {
            const file = await api.readProjectFile(root, tab.path);
            if (file.mtime === tab.mtime) continue;
            setTabs((was) =>
              was.map((t) =>
                t.path === tab.path && t.content === t.saved
                  ? { path: tab.path, content: file.content, saved: file.content, mtime: file.mtime }
                  : t,
              ),
            );
          } catch {
            // Gone, most likely -- the tab keeps what it had.
          }
        } else {
          reload(tab.path);
        }
      }
    },
    [api, root, loadDir, reload],
  );

  const create = useCallback(
    async (path, kind = "file") => {
      if (!root || !path) return;
      const made = await api.createProjectEntry(root, path, kind);
      const parent = made.path.includes("/") ? made.path.slice(0, made.path.lastIndexOf("/")) : ".";
      await loadDir(parent);
      setFiles(null);
      if (kind === "file") openFile(made.path);
      else toggleDir(made.path);
    },
    [api, root, loadDir, openFile, toggleDir],
  );

  /** Every file in the project, for quick open. Fetched when first wanted. */
  const loadFiles = useCallback(async () => {
    if (!root) return [];
    if (files) return files;
    try {
      const data = await api.folderFiles(root);
      setFiles(data.files);
      return data.files;
    } catch {
      return [];
    }
  }, [api, root, files]);

  return {
    root,
    info,
    error,
    dirs,
    expanded,
    toggleDir,
    collapseAll,
    loadDir,
    tabs,
    active,
    setActive,
    reveal,
    openFile,
    edit,
    save,
    reload,
    close,
    refresh,
    create,
    changed,
    loadFiles,
  };
}
