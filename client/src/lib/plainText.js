/* The text a model meant, however it wrapped it.
 *
 * The server unwraps tool arguments before storing them (skills/args.py), but
 * decks and sheets saved before it did carry text like `{'title': 'Aesthetic
 * Summary'}` -- the Python repr of an object the model sent where a string
 * belonged. This mirrors the server's rules so those display as the words they
 * stand for, and so an object that reaches a component never becomes a React
 * child, which would take the whole panel down.
 */

const TEXT_KEYS = [
  "text", "title", "value", "content", "label", "name", "heading", "body",
  "caption", "quote", "subtitle", "description",
];

/** A string that is really a serialised object or list, parsed; else null.
 *  Handles JSON and the common Python repr (single quotes, True/False/None). */
function unwrap(text) {
  const t = text.trim();
  if (t.length < 2 || !"{[".includes(t[0]) || !"}]".includes(t[t.length - 1])) return null;
  try {
    return JSON.parse(t);
  } catch {
    // Python repr: swap its quoting for JSON's. Good enough for the flat
    // shapes models produce; anything it cannot read stays as it was.
    try {
      const json = t
        .replace(/\bTrue\b/g, "true")
        .replace(/\bFalse\b/g, "false")
        .replace(/\bNone\b/g, "null")
        .replace(/'((?:[^'\\]|\\.)*)'/g, (_, inner) => JSON.stringify(inner.replace(/\\'/g, "'")));
      return JSON.parse(json);
    } catch {
      return null;
    }
  }
}

export function plainText(value, depth = 0) {
  if (value == null || depth > 6) return "";
  if (typeof value === "string") {
    const inner = unwrap(value);
    return inner && typeof inner === "object" ? plainText(inner, depth + 1) : value.trim();
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value.map((v) => plainText(v, depth + 1)).filter(Boolean).join("\n");
  }
  if (typeof value === "object") {
    for (const key of TEXT_KEYS) {
      if (key in value) {
        const found = plainText(value[key], depth + 1);
        if (found) return found;
      }
    }
    return Object.values(value).map((v) => plainText(v, depth + 1)).filter(Boolean).join(" — ");
  }
  return String(value);
}

/** One line of text: newlines folded, for titles and labels. */
export const lineText = (value) => plainText(value).replace(/\s*\n\s*/g, " ");
