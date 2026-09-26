// Turning a picked File into something that fits in a JSON request body.
//
// Formats are not the client's problem: the server re-encodes anything the
// model cannot read, so this uploads what was picked and lets one place decide
// what that should become. Doing it here as well would mean two copies of the
// same policy, disagreeing the moment either changed.

/**
 * Read a File as base64.
 *
 * Via FileReader rather than a manual walk over an ArrayBuffer: building the
 * string by hand means chunking it to keep a multi-megabyte image from blowing
 * the argument limit on String.fromCharCode, and this does the same job
 * without the trap.
 *
 * `mime` is passed through exactly as the browser reported it -- including the
 * empty string it gives for unfamiliar extensions. The server classifies by
 * suffix when it arrives blank, so guessing here would only add a second,
 * disagreeing opinion.
 */
export function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => {
      // Named so the thread can tell an unreadable file from a dead network
      // and show this sentence instead of "lost the connection".
      const error = new Error(`Could not read ${file.name}.`);
      error.name = "FileReadError";
      reject(error);
    };
    reader.onload = () => {
      const result = String(reader.result);
      resolve({
        name: file.name,
        mime: file.type,
        size: file.size,
        data: result.slice(result.indexOf(",") + 1),
      });
    };
    reader.readAsDataURL(file);
  });
}

export const readFiles = (files) => Promise.all([...files].map(readFile));

/** Bytes as something a person reads. */
export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const isImage = (attachment) =>
  attachment.kind === "image" || (attachment.mime || "").startsWith("image/");

/**
 * Hand the reader a file to keep.
 *
 * An object URL on a throwaway link, the same move the memory export makes.
 * Revoked on the next tick rather than straight away: some engines start the
 * download asynchronously and would find the URL already gone.
 */
export function saveFile(name, text, mime = "text/plain") {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A title as a filename: lowercase words joined by dashes, never empty. */
export function fileStem(title) {
  const stem = String(title || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return stem || "canvas";
}
