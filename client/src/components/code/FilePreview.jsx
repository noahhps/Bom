import { useEffect, useMemo, useRef, useState } from "react";

import { Icon } from "../Icon";
import { renderMarkdown } from "../../lib/markdown";
import { isDesktop } from "../../lib/serverOrigin";
import { folderOf, previewKind, resolvePath, urlPath } from "../../lib/filePreview";

/* One file, rendered: a page, a document, a PDF or a picture -- the other half
 * of the editor, opened from the Run/Preview button, a right-click, or by
 * clicking a file the editor cannot show as text.
 *
 * A document is drawn from what is in the editor, so unsaved edits show as
 * they are typed; one that is not open is read from disk. Everything else is
 * loaded from disk through the server's preview route (see
 * server/app/workbench.py), which is also what a page's relative links resolve
 * against -- its CSS, its scripts, its images. A page therefore shows what is
 * saved, and runs again whenever anything in the project is saved or changed
 * by the assistant, the way a live-reloading dev server does. (A page written
 * into the frame from the editor's text would inherit the desktop app's own
 * content policy, which stops inline scripts and outside stylesheets -- most
 * of what a page is.)
 *
 * The page runs in a sandboxed frame with no origin of its own, so its scripts
 * run but can never reach the app's storage, where the token is. */

const SANDBOX = "allow-scripts allow-forms allow-modals allow-popups allow-downloads";

// Relative image paths in markdown point at the project's own files; the
// renderer only draws absolute ones, so they are made absolute first. A
// relative link becomes an in-page anchor naming the file, which a click
// opens in the editor instead of navigating the app away.
function withProjectLinks(markdown, path, folderUrl) {
  return String(markdown || "")
    .replace(/!\[([^\]]*)\]\((?!https?:|data:|bom-image:|\/|#)([^)\s]+)\)/g, (_m, alt, src) =>
      `![${alt}](${folderUrl}${src.replace(/^\.\//, "")})`,
    )
    .replace(/(^|[^!])\[([^\]]+)\]\((?![a-z][a-z0-9+.-]*:|\/|#)([^)\s]+)\)/gi, (m, lead, label, href) => {
      const target = resolvePath(path, href);
      return target ? `${lead}[${label}](#bom-file:${urlPath(target)})` : m;
    });
}

// The desktop app's pages may only draw pictures from themselves, so one from
// the server is fetched and drawn from memory instead.
async function fetchBlob(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(response.status === 404 ? "That file is not there any more." : `It could not be loaded (${response.status}).`);
  }
  return URL.createObjectURL(await response.blob());
}

function usePicture(url, wanted) {
  const [picture, setPicture] = useState({ src: null, error: "" });
  useEffect(() => {
    if (!wanted || !url) return undefined;
    if (!isDesktop()) {
      setPicture({ src: url, error: "" });
      return undefined;
    }
    let live = true;
    let made = null;
    fetchBlob(url)
      .then((src) => {
        made = src;
        if (live) setPicture({ src, error: "" });
        else URL.revokeObjectURL(src);
      })
      .catch((exc) => live && setPicture({ src: null, error: exc.message }));
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [url, wanted]);
  return picture;
}

export function FilePreview({ api, root, path, base, text, dirty = false, stamp = 0, onSource, onOpen }) {
  const kind = previewKind(path);
  const [loaded, setLoaded] = useState(null);
  const [error, setError] = useState("");
  const [nonce, setNonce] = useState(0);
  const doc = useRef(null);

  // Anything saved or changed on disk runs the page (or redraws the file)
  // again: a page's own file is only one of the files it is made of.
  const version = `${stamp}.${nonce}`;

  // A document not open in the editor is read from disk, and again whenever
  // it may have changed.
  useEffect(() => {
    let live = true;
    setError("");
    if (kind !== "markdown" || text !== undefined || !root) return undefined;
    api
      .readProjectFile(root, path)
      .then((file) => live && setLoaded(file.content))
      .catch((exc) => live && setError(exc.message || "That file could not be read."));
    return () => {
      live = false;
    };
  }, [api, root, path, kind, text, version]);

  const fileUrl = base ? `${base}${urlPath(path)}` : null;
  const folderUrl = base ? `${base}${folderOf(path)}` : "";
  const picture = usePicture(fileUrl ? `${fileUrl}?v=${version}` : null, kind === "image");

  const source = text !== undefined ? text : loaded;
  const markdown = useMemo(
    () =>
      kind === "markdown" && source != null && base
        ? { __html: renderMarkdown(withProjectLinks(source, path, folderUrl)) }
        : null,
    [kind, source, base, path, folderUrl],
  );

  // The document's pictures, on the desktop: fetched and swapped in, for the
  // same reason as a picture on its own.
  useEffect(() => {
    if (!markdown || !isDesktop() || !doc.current || !base) return undefined;
    let live = true;
    const made = [];
    doc.current.querySelectorAll("img").forEach((img) => {
      const src = img.getAttribute("src") || "";
      if (!src.startsWith(base)) return;
      fetchBlob(src)
        .then((blob) => {
          made.push(blob);
          if (live) img.src = blob;
        })
        .catch(() => {});
    });
    return () => {
      live = false;
      made.forEach((blob) => URL.revokeObjectURL(blob));
    };
  }, [markdown, base]);

  const follow = (event) => {
    const anchor = event.target.closest?.("a[href]");
    if (!anchor) return;
    const href = anchor.getAttribute("href") || "";
    if (href.startsWith("#bom-file:")) {
      event.preventDefault();
      onOpen?.(decodeURIComponent(href.slice("#bom-file:".length)));
    }
  };

  const name = path.split("/").pop();

  return (
    <div className="code-filepreview" data-kind={kind || undefined}>
      <div className="code-preview-bar">
        <span className="code-filepreview-name" title={path}>
          <Icon name={kind === "image" ? "image" : kind === "html" ? "globe" : "document"} />
          {name}
        </span>
        {dirty && kind !== "markdown" ? (
          <span className="code-filepreview-hint" title="The preview shows the saved file">
            Unsaved -- <kbd>⌘</kbd><kbd>S</kbd> to update
          </span>
        ) : null}
        <span className="spacer" />
        <button
          type="button"
          className="code-icon-btn"
          title="Reload"
          aria-label="Reload the preview"
          onClick={() => setNonce((n) => n + 1)}
        >
          <Icon name="refresh" />
        </button>
        {fileUrl && !isDesktop() && kind !== "markdown" ? (
          <a className="code-icon-btn" href={fileUrl} target="_blank" rel="noreferrer" title="Open in a browser tab" aria-label="Open in a browser tab">
            <Icon name="external" />
          </a>
        ) : null}
        {onSource ? (
          <button type="button" className="code-preview-chip mi" title="Back to the source" onClick={onSource}>
            <Icon name="code" />
            source
          </button>
        ) : null}
      </div>

      <div className="code-filepreview-body">
        {error ? (
          <p className="code-filepreview-note" data-error="">{error}</p>
        ) : !kind ? (
          <p className="code-filepreview-note">There is no preview for this kind of file.</p>
        ) : !base ? (
          <p className="code-filepreview-note">Opening…</p>
        ) : kind === "image" ? (
          picture.error ? (
            <p className="code-filepreview-note" data-error="">{picture.error}</p>
          ) : (
            <div className="code-filepreview-image">
              {picture.src ? <img src={picture.src} alt={name} /> : null}
            </div>
          )
        ) : kind === "pdf" ? (
          // No sandbox: a PDF is drawn by the browser's own viewer, which a
          // sandboxed frame refuses to start.
          <iframe key={version} className="code-filepreview-frame" title={name} src={`${fileUrl}?v=${version}`} />
        ) : kind === "markdown" ? (
          markdown ? (
            <div className="code-filepreview-scroll" onClick={follow}>
              <div ref={doc} className="code-filepreview-doc body" dangerouslySetInnerHTML={markdown} />
            </div>
          ) : (
            <p className="code-filepreview-note">Opening…</p>
          )
        ) : (
          <iframe
            key={version}
            className="code-filepreview-frame"
            data-page=""
            title={name}
            sandbox={SANDBOX}
            src={`${fileUrl}?v=${version}`}
          />
        )}
      </div>
    </div>
  );
}
