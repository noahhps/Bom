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
