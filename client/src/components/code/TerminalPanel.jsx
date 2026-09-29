import { useCallback, useEffect, useRef, useState } from "react";

import { Icon } from "../Icon";

/* The terminal: a panel under the editor, one tab per shell, as in VS Code.
 *
 * Each tab is a real shell on the server (see server/app/workbench.py) drawn
 * by xterm.js, which is loaded the first time the panel opens -- like the
 * editor, it has no business in the bundle of a chat. A shell outlives its
 * tab's socket: hiding the panel, reloading, or opening the project in another
 * window reattaches to the same shells, with what they printed meanwhile. Only
 * closing a tab ends one.
 *
 * Anything a shell prints that looks like a local server's address is handed
 * up, so the preview can show it -- `npm run dev` and the page appears. */

let loading = null;
function loadXterm() {
  loading ||= Promise.all([
    import("@xterm/xterm"),
    import("@xterm/addon-fit"),
    import("@xterm/addon-web-links"),
    import("@xterm/xterm/css/xterm.css"),
  ]).then(([xterm, fit, links]) => ({
    Terminal: xterm.Terminal,
    FitAddon: fit.FitAddon,
    WebLinksAddon: links.WebLinksAddon,
  }));
  return loading;
}

// A local server's address, as dev servers print it. Colour codes are taken
// out first: Vite paints the port in a different colour from the host.
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d{2,5}(?:\/[^\s"'<>]*)?/;

export function localUrlIn(text) {
  const found = String(text || "").replace(ANSI, "").match(LOCAL_URL);
  // 0.0.0.0 is where a server listens, not somewhere a browser can go.
  return found ? found[0].replace("0.0.0.0", "localhost").replace(/[.,;:)]+$/, "") : null;
}

/* The palette, from the app's own tokens -- read when asked, so the terminal
 * wears whatever the rest of the app is wearing. The sixteen colours are
 * picked per mode: the defaults are drawn for a dark ground and half of them
 * vanish on a light one. */
function xtermTheme(mode) {
  const style = getComputedStyle(document.documentElement);
  const token = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
  const dark = mode === "dark";
  const ansi = dark
    ? {
        black: "#1f1f1f", red: "#ff6369", green: "#62c073", yellow: "#ffb224",
        blue: "#52a8ff", magenta: "#bf7af0", cyan: "#0ac7b4", white: "#d4d4d4",
        brightBlack: "#6f6f6f", brightRed: "#ff8589", brightGreen: "#7fd18d",
        brightYellow: "#ffc75a", brightBlue: "#7bbcff", brightMagenta: "#d19ef5",
        brightCyan: "#3ed9c8", brightWhite: "#ffffff",
      }
    : {
        black: "#1f2328", red: "#cf222e", green: "#116329", yellow: "#7d4e00",
        blue: "#0550ae", magenta: "#8250df", cyan: "#1b7c83", white: "#6e7781",
        brightBlack: "#57606a", brightRed: "#a40e26", brightGreen: "#1a7f37",
        brightYellow: "#633c01", brightBlue: "#0969da", brightMagenta: "#a475f9",
        brightCyan: "#3192aa", brightWhite: "#8c959f",
      };
  return {
    background: token("--ground", dark ? "#000000" : "#ffffff"),
    foreground: token("--ink", dark ? "#ededed" : "#0f172a"),
    cursor: token("--accent", dark ? "#52a8ff" : "#1f4fd8"),
    cursorAccent: dark ? "#000000" : "#ffffff",
    selectionBackground: dark ? "#264f78" : "#add6ff",
    ...ansi,
  };
}

/** One shell, drawn. Mounted for as long as its tab is open. */
function TerminalView({ api, hello, command, active, mode, themeKey, onReady, onExit, onLink, onUrl }) {
  const host = useRef(null);
  // Typed once, when the shell is there to hear it.
  const pending = useRef(command);
  const term = useRef(null);
  const fitter = useRef(null);
  const handlers = useRef({ onReady, onExit, onLink, onUrl });
  handlers.current = { onReady, onExit, onLink, onUrl };
  const [failed, setFailed] = useState("");

  useEffect(() => {
    let live = true;
    let socket = null;
    let observer = null;
    let xt = null;
    loadXterm()
      .then(({ Terminal, FitAddon, WebLinksAddon }) => {
        if (!live || !host.current) return;
        const style = getComputedStyle(document.documentElement);
        xt = new Terminal({
          fontFamily: style.getPropertyValue("--font-mono").trim() || "ui-monospace, Menlo, monospace",
          fontSize: 12.5,
          lineHeight: 1.2,
          cursorBlink: true,
          scrollback: 5000,
          macOptionIsMeta: true,
          allowTransparency: false,
          theme: xtermTheme(mode),
        });
        const fit = new FitAddon();
        xt.loadAddon(fit);
        xt.loadAddon(new WebLinksAddon((_event, uri) => handlers.current.onLink?.(uri)));
        xt.open(host.current);
        try {
          fit.fit();
        } catch {
          // Not laid out yet; the observer below fits it when it is.
        }
        term.current = xt;
        fitter.current = fit;

        socket = api.openTerminal({ ...hello, cols: xt.cols, rows: xt.rows });
        const send = (message) => {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
        };
        socket.addEventListener("message", (event) => {
          let message;
          try {
            message = JSON.parse(event.data);
          } catch {
            return;
          }
          if (message.type === "ready") {
            handlers.current.onReady?.(message);
            if (pending.current) {
              send({ type: "input", data: pending.current + "\r" });
              pending.current = null;
            }
          }
          else if (message.type === "output") {
            xt.write(message.data);
            const url = localUrlIn(message.data);
            if (url) handlers.current.onUrl?.(url);
          } else if (message.type === "exit") {
            xt.write(`\r\n\x1b[2m[exited${message.code != null ? ` with code ${message.code}` : ""}]\x1b[0m\r\n`);
            handlers.current.onExit?.(message.code);
          } else if (message.type === "error") {
            setFailed(message.message || "The terminal could not be opened.");
          }
        });
        socket.addEventListener("close", () => {
          if (live) setFailed((was) => was || "");
        });
        xt.onData((data) => send({ type: "input", data }));
        xt.onResize(({ cols, rows }) => send({ type: "resize", cols, rows }));
        observer = new ResizeObserver(() => {
          try {
            fit.fit();
          } catch {
            // Hidden: nothing to measure until it is shown again.
          }
        });
        observer.observe(host.current);
      })
      .catch((exc) => live && setFailed(exc?.message || "The terminal could not be loaded."));
    return () => {
      live = false;
      observer?.disconnect();
      // Closing the socket detaches; the shell stays until its tab is closed.
      socket?.close();
      xt?.dispose();
      term.current = null;
    };
    // Opened once per tab; the theme follows below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The theme, a frame late: the app writes the new palette in its own effect.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (term.current) term.current.options.theme = xtermTheme(mode);
    });
    return () => cancelAnimationFrame(frame);
  }, [mode, themeKey]);

  // Shown again: measure, and take the keyboard.
  useEffect(() => {
    if (!active || !term.current) return;
    const frame = requestAnimationFrame(() => {
      try {
        fitter.current?.fit();
      } catch {
        // Still not measurable.
      }
      term.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active]);

  return (
    <div className="code-term-view" hidden={!active}>
      <div className="code-term-host" ref={host} />
      {failed ? <p className="code-term-note" role="alert">{failed}</p> : null}
    </div>
  );
}

let counter = 0;
const newKey = () => `t${++counter}`;

export function TerminalPanel({ api, root, mode, themeKey, onLink, onUrl, onHide, runRef }) {
  // Each tab: `key` for React, `id` once the server has named its shell.
  const [tabs, setTabs] = useState([]);
  const [active, setActive] = useState(null);
  const [loaded, setLoaded] = useState(false);

  const add = useCallback((command = null) => {
    const key = newKey();
    setTabs((was) => [...was, { key, id: null, title: "shell", alive: true, command }]);
    setActive(key);
    return key;
  }, []);

  // The shells already running in this folder, from a reload or another
  // window, come back as tabs; with none, the panel opens on a fresh one.
  useEffect(() => {
    let live = true;
    setTabs([]);
    setActive(null);
    setLoaded(false);
    if (!root) return undefined;
    api
      .listTerminals(root)
      .then(({ terminals }) => {
        if (!live) return;
        const running = terminals.filter((t) => t.alive);
        if (running.length) {
          const restored = running.map((t) => ({ key: newKey(), id: t.id, title: t.title, alive: true }));
          setTabs(restored);
          setActive(restored[restored.length - 1].key);
        } else {
          add();
        }
      })
      .catch(() => live && add())
      .finally(() => live && setLoaded(true));
    return () => {
      live = false;
    };
  }, [api, root, add]);

  // For the preview's "Start the dev server": a new tab running a command.
  useEffect(() => {
    if (runRef) runRef.current = (command) => add(command);
  }, [runRef, add]);

  const close = async (key) => {
    const tab = tabs.find((t) => t.key === key);
    if (tab?.id) await api.closeTerminal(tab.id).catch(() => {});
    setTabs((was) => {
      const left = was.filter((t) => t.key !== key);
      if (active === key) setActive(left.length ? left[left.length - 1].key : null);
      return left;
    });
  };

  const patch = (key, changes) =>
    setTabs((was) => was.map((t) => (t.key === key ? { ...t, ...changes } : t)));

  return (
    <section className="code-term" aria-label="Terminal">
      <div className="code-term-head">
        <span className="code-term-label mi">Terminal</span>
        <div className="code-term-tabs" role="tablist">
          {tabs.map((tab, index) => (
            <div
              key={tab.key}
              className="code-term-tab"
              role="tab"
              aria-selected={active === tab.key}
              data-dead={tab.alive ? undefined : ""}
            >
              <button type="button" onClick={() => setActive(tab.key)}>
                <Icon name="terminal" />
                {tab.title} {index + 1}
              </button>
              <button
                type="button"
                className="code-term-x"
                aria-label={`Close ${tab.title} ${index + 1}`}
                title="Close -- ends the shell and anything running in it"
                onClick={() => close(tab.key)}
              >
                <Icon name="close" />
              </button>
            </div>
          ))}
        </div>
        <span className="spacer" />
        <button type="button" className="code-icon-btn" title="New terminal" aria-label="New terminal" onClick={() => add()}>
          <Icon name="plus" />
        </button>
        <button type="button" className="code-icon-btn" title="Hide the panel (⌃`)" aria-label="Hide the terminal" onClick={onHide}>
          <Icon name="chevron" />
        </button>
      </div>
      <div className="code-term-body">
        {tabs.map((tab) => (
          <TerminalView
            key={tab.key}
            api={api}
            hello={tab.id ? { id: tab.id } : { root }}
            active={active === tab.key}
            mode={mode}
            themeKey={themeKey}
            command={tab.command}
            onReady={(info) => patch(tab.key, { id: info.id, title: info.title, alive: info.alive })}
            onExit={() => patch(tab.key, { alive: false })}
            onLink={onLink}
            onUrl={onUrl}
          />
        ))}
        {loaded && !tabs.length ? (
          <div className="code-term-empty">
            <button type="button" className="btn" onClick={() => add()}>
              <Icon name="terminal" />
              New terminal
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
