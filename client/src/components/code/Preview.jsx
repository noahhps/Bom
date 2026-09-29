import { useEffect, useState } from "react";

import { Icon } from "../Icon";
import { isDesktop, serverOrigin } from "../../lib/serverOrigin";

/* The project, running: a page in a frame beside the code.
 *
 * Two sources. A project with no build step is served straight from its folder
 * (see server/app/workbench.py); a project with a dev server is shown at the
 * address it prints -- start it here, or in the terminal, and the preview
 * picks the address up.
 *
 * The frame is sandboxed. The project's own files come from the same server as
 * the app, so they are shown without `allow-same-origin`: a page on that
 * origin could otherwise read the app's storage, token and all. A dev server
 * is another origin already and keeps its own storage, which apps expect. */

const SANDBOX = "allow-scripts allow-forms allow-modals allow-popups allow-downloads";

function sameOriginAsApp(url) {
  try {
    const origin = new URL(url).origin;
    return origin === window.location.origin || origin === (serverOrigin() || window.location.origin);
  } catch {
    return true;
  }
}

export function Preview({ api, root, url, onUrl, detected, onRun }) {
  const [typed, setTyped] = useState(url || "");
  const [files, setFiles] = useState(null);
  const [scripts, setScripts] = useState({});
  const [waiting, setWaiting] = useState(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => setTyped(url || ""), [url]);

  // What this project can be previewed as: its own files, and the scripts in
  // its package.json that start a server.
  useEffect(() => {
    let live = true;
    setFiles(null);
    setScripts({});
    if (!root) return undefined;
    api.previewFiles(root).then((found) => live && setFiles(found)).catch(() => {});
    api
      .readProjectFile(root, "package.json")
      .then((file) => {
        const parsed = JSON.parse(file.content || "{}");
        if (live) setScripts(parsed.scripts || {});
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [api, root]);

  // A dev server started from here: its address, as soon as it prints one.
  useEffect(() => {
    if (waiting && detected) {
      setWaiting(null);
      onUrl(detected);
    }
  }, [waiting, detected, onUrl]);

  const go = (event) => {
    event.preventDefault();
    let next = typed.trim();
    if (!next) return;
    if (!/^https?:\/\//.test(next)) next = `http://${next}`;
    onUrl(next);
    setNonce((n) => n + 1);
  };

  const showFiles = () => {
    if (!files) return;
    onUrl(files.base + (files.entry || ""));
    setNonce((n) => n + 1);
  };

  const run = (name) => {
    setWaiting(name);
    onRun(`npm run ${name}`);
  };

  const devScript = ["dev", "start", "serve", "preview"].find((name) => scripts[name]);

  return (
    <div className="code-preview">
      <form className="code-preview-bar" onSubmit={go}>
        <button
          type="button"
          className="code-icon-btn"
          title="Reload"
          aria-label="Reload the preview"
          disabled={!url}
          onClick={() => setNonce((n) => n + 1)}
        >
          <Icon name="refresh" />
        </button>
        <input
          value={typed}
          spellCheck="false"
          autoCapitalize="off"
          placeholder="http://localhost:5173"
          aria-label="Address"
          onChange={(event) => setTyped(event.target.value)}
        />
        {files ? (
          <button type="button" className="code-preview-chip mi" title="Serve the project's own files" onClick={showFiles}>
            files
          </button>
        ) : null}
        {detected && detected !== url ? (
          <button type="button" className="code-preview-chip mi" data-accent="" title={detected} onClick={() => onUrl(detected)}>
            {detected.replace(/^https?:\/\//, "")}
          </button>
        ) : null}
        {url && !isDesktop() ? (
          <a className="code-icon-btn" href={url} target="_blank" rel="noreferrer" title="Open in a browser tab" aria-label="Open in a browser tab">
            <Icon name="external" />
          </a>
        ) : null}
      </form>

      {url ? (
        <iframe
          key={`${url}#${nonce}`}
          className="code-preview-frame"
          title="Preview"
          src={url}
          sandbox={sameOriginAsApp(url) ? SANDBOX : `${SANDBOX} allow-same-origin`}
        />
      ) : (
        <div className="code-preview-empty">
          <Icon name="globe" />
          <p className="code-preview-lead">See the project running.</p>
          {waiting ? (
            <p className="code-preview-hint">
              Waiting for <code>npm run {waiting}</code> to print its address…
            </p>
          ) : (
            <div className="code-preview-actions">
              {devScript ? (
                <button type="button" className="btnp" onClick={() => run(devScript)}>
                  <Icon name="play" />
                  Start <code>npm run {devScript}</code>
                </button>
              ) : null}
              {files ? (
                <button type="button" className={devScript ? "btn" : "btnp"} onClick={showFiles}>
                  <Icon name="document" />
                  {files.entry ? `Open ${files.entry}` : "Serve the project's files"}
                </button>
              ) : null}
              {detected ? (
                <button type="button" className="btn" onClick={() => onUrl(detected)}>
                  <Icon name="globe" />
                  {detected.replace(/^https?:\/\//, "")}
                </button>
              ) : null}
            </div>
          )}
          <p className="code-preview-hint">
            Or run a server in the terminal -- its address shows up here -- or type one above.
          </p>
        </div>
      )}
    </div>
  );
}
