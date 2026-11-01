/* Light or dark, per device.
 *
 * Stored here rather than on the server, beside the token and the pinned
 * rail: appearance belongs to a screen, not to an account. A phone in a dark
 * room and a laptop in daylight are the same user wanting different things,
 * and "System" -- the default -- lets each follow its own OS.
 *
 * The resolved mode is written onto <html> as `data-theme`, which is what the
 * stylesheet's dark block keys on, and as `color-scheme`, which is what turns
 * the native parts dark too: scrollbars, form controls, the caret.
 */

export const APPEARANCES = [
  { id: "system", name: "System" },
  { id: "light", name: "Light" },
  { id: "dark", name: "Dark" },
];

const KEY = "bom.appearance";
const IDS = new Set(APPEARANCES.map((a) => a.id));
const DARK_QUERY = "(prefers-color-scheme: dark)";

// What the browser chrome paints around the page: the status bar on a phone,
// the title bar where the shell lets it. The shell's own ground in each mode.
const THEME_COLOR = { light: "#e2e5ea", dark: "#000000" };

/** The preference this device has saved, or "system". */
export function storedAppearance() {
  try {
    const saved = localStorage.getItem(KEY);
    return IDS.has(saved) ? saved : "system";
  } catch {
    return "system";
  }
}

export function saveAppearance(preference) {
  try {
    if (preference === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, preference);
  } catch {
    // Private mode or storage switched off: the choice holds for this session.
  }
}

export function systemIsDark() {
  return typeof window !== "undefined" && window.matchMedia?.(DARK_QUERY).matches === true;
}

/** "light" or "dark", from a preference that may be "system". */
export function resolveAppearance(preference) {
  if (preference === "light" || preference === "dark") return preference;
  return systemIsDark() ? "dark" : "light";
}

/** Put a resolved mode on the document. Safe to call before React renders. */
export function applyAppearance(mode) {
  const root = document.documentElement;
  const switching = root.hasAttribute("data-theme") && root.getAttribute("data-theme") !== mode;
  if (switching) {
    // A change of mode is a cut, not a fade. The accent's 900ms recolour is
    // right for a hue drifting as a chat changes subject; across light and
    // dark it animates some surfaces while others -- the drafting grid, a
    // border -- have already flipped, and for most of a second the sheet is
    // black under a white grid. Held off for the two frames the palette takes
    // to land, then handed back.
    root.setAttribute("data-theme-switching", "");
    requestAnimationFrame(() =>
      requestAnimationFrame(() => root.removeAttribute("data-theme-switching")),
    );
  }
  root.setAttribute("data-theme", mode);
  root.style.colorScheme = mode;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", THEME_COLOR[mode] || THEME_COLOR.light);
}

/** Call `onChange` whenever the OS switches between light and dark. */
export function watchSystem(onChange) {
  const query = window.matchMedia?.(DARK_QUERY);
  if (!query) return () => {};
  const handle = () => onChange(query.matches ? "dark" : "light");
  query.addEventListener("change", handle);
  return () => query.removeEventListener("change", handle);
}
