/* The desktop app's menus starting a new conversation of a kind: File ▸ New
 * Chat (⌘1), New Code Session (⌘2) and New Design (⌘3), and the tray's Code
 * and Design. Each lands on the one new-conversation page with its composer
 * set to that kind.
 *
 * Resolves to an unlisten; does nothing in a browser. */

import { isDesktop } from "./serverOrigin";

export async function listenForNew(handler) {
  if (!isDesktop()) return () => {};
  const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  return getCurrentWebviewWindow().listen("bom://new", (event) => handler(event.payload));
}

/* Bom ▸ Settings… (⌘,) in the desktop app's menu bar. The menu owns ⌘, once
 * it has the item, so the page's own key handler never sees the keystroke --
 * this is how the settings window opens from the keyboard in the app.
 *
 * Resolves to an unlisten; does nothing in a browser. */
export async function listenForSettings(handler) {
  if (!isDesktop()) return () => {};
  const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  return getCurrentWebviewWindow().listen("bom://settings", () => handler());
}
