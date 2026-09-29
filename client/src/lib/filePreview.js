/* Which files the Code view can show rendered rather than as source, and how
 * to point at them. */

const IMAGE = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"];

/** "html", "markdown", "pdf", "image", or null when there is nothing to
 *  render -- a source file is its own best view. */
export function previewKind(path) {
  const name = String(path || "").split("/").pop().toLowerCase();
  const ext = name.includes(".") ? name.split(".").pop() : "";
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "md" || ext === "markdown" || ext === "mdx") return "markdown";
  if (ext === "pdf") return "pdf";
  if (IMAGE.includes(ext)) return "image";
  return null;
}

/** A file the text editor cannot open: its preview is the only view of it.
 *  An SVG is a picture but also text, so it opens as source like any other. */
export function onlyPreviewable(path) {
  const kind = previewKind(path);
  return kind === "pdf" || (kind === "image" && !/\.svg$/i.test(String(path)));
}

/** A project path as a URL path: each segment escaped, the slashes kept. */
export function urlPath(path) {
  return String(path || "")
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

/** The folder a file is in, as a URL prefix ending in "/" (or ""). */
export function folderOf(path) {
  const at = String(path || "").lastIndexOf("/");
  return at < 0 ? "" : urlPath(path.slice(0, at + 1));
}

/** Where a link in `from` points, as a project path: "../b.md" from
 *  "docs/a.md" is "b.md". Null for a link that leaves the project, or one
 *  that is not a path at all (a web address, an anchor, mail). */
export function resolvePath(from, link) {
  const bare = String(link || "").split(/[?#]/)[0];
  if (!bare || /^[a-z][a-z0-9+.-]*:/i.test(bare) || bare.startsWith("/")) return null;
  let decoded = bare;
  try {
    decoded = decodeURIComponent(bare);
  } catch {
    // A stray % is part of the name.
  }
  const parts = String(from || "").split("/").slice(0, -1);
  for (const part of decoded.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join("/") || null;
}
