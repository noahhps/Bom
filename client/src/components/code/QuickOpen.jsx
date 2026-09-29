import { useEffect, useMemo, useRef, useState } from "react";

/* ⌘P: go to a file by typing part of its name, as in VS Code.
 *
 * Matching is a subsequence -- "cmpsr" finds components/Composer.jsx -- scored
 * so a hit in the file's own name beats one spread across its folders, and a
 * run of consecutive letters beats scattered ones. */

function score(path, query) {
  if (!query) return 1;
  const text = path.toLowerCase();
  const want = query.toLowerCase().replace(/\s+/g, "");
  const nameStart = text.lastIndexOf("/") + 1;
  let at = 0;
  let total = 0;
  let run = 0;
  for (const ch of want) {
    const found = text.indexOf(ch, at);
    if (found === -1) return 0;
    run = found === at ? run + 1 : 0;
    total += 1 + run * 2 + (found >= nameStart ? 3 : 0);
    at = found + 1;
  }
  // Shorter paths first among equals: the file you meant is rarely the one
  // six folders down.
  return total - path.length * 0.01;
}

export function QuickOpen({ loadFiles, onOpen, onClose }) {
  const [files, setFiles] = useState(null);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const input = useRef(null);

  useEffect(() => {
    input.current?.focus();
    let live = true;
    loadFiles().then((list) => live && setFiles(list));
    return () => {
      live = false;
    };
  }, [loadFiles]);

  const matches = useMemo(() => {
    if (!files) return [];
    // A trailing ":42" goes to that line once the file is open.
    const bare = query.replace(/:\d*$/, "");
    return files
      .map((path) => ({ path, rank: score(path, bare) }))
      .filter((m) => m.rank > 0)
      .sort((a, b) => b.rank - a.rank)
      .slice(0, 60);
  }, [files, query]);

  useEffect(() => setIndex(0), [query]);

  const choose = (path) => {
    const line = Number((query.match(/:(\d+)$/) || [])[1]) || null;
    onOpen(path, line);
    onClose();
  };

  return (
    <div className="code-quick-scrim" role="presentation" onMouseDown={onClose}>
      <div
        className="code-quick"
        role="dialog"
        aria-label="Go to file"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <input
          ref={input}
          className="code-quick-input"
          placeholder="Go to file…   (name, or name:line)"
          value={query}
          spellCheck="false"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") onClose();
            else if (event.key === "ArrowDown") {
              event.preventDefault();
              setIndex((i) => Math.min(i + 1, matches.length - 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setIndex((i) => Math.max(i - 1, 0));
            } else if (event.key === "Enter" && matches[index]) {
              choose(matches[index].path);
            }
          }}
        />
        <ul className="code-quick-list" role="listbox">
          {files === null ? <li className="code-quick-note">Listing files…</li> : null}
          {files !== null && !matches.length ? <li className="code-quick-note">No matching files</li> : null}
          {matches.map((match, i) => {
            const slash = match.path.lastIndexOf("/");
            return (
              <li key={match.path} role="option" aria-selected={i === index}>
                <button
                  type="button"
                  data-active={i === index ? "" : undefined}
                  onMouseEnter={() => setIndex(i)}
                  onClick={() => choose(match.path)}
                >
                  <span className="code-quick-name">{match.path.slice(slash + 1)}</span>
                  <span className="code-quick-dir">{slash > 0 ? match.path.slice(0, slash) : ""}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
