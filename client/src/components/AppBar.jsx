import { Icon } from "./Icon";

/* The row across the top of the window: the sidebar's toggle at its left,
 * and the settings gear at its right.
 *
 * In the desktop app this row is the window's title bar: the page is drawn
 * under it (titleBarStyle "Overlay" in tauri.conf.json), the traffic lights
 * sit at its left, and the empty stretch of it drags the window. The drag
 * attribute is on the bar and its filler only, so the buttons still click.
 *
 * It held a Home / Code / Design switch once. Those are kinds of conversation
 * now, chosen in the composer of the one page every conversation starts from,
 * rather than places to go. */
export function AppBar({ sidebarOpen, onToggleSidebar, settingsOpen = false, onSettings }) {
  return (
    <header className="appbar" data-tauri-drag-region>
      <button
        type="button"
        className="appbar-rail"
        aria-pressed={sidebarOpen}
        aria-label={sidebarOpen ? "Close sidebar" : "Open sidebar"}
        title={sidebarOpen ? "Close sidebar" : "Open sidebar"}
        onClick={onToggleSidebar}
      >
        <Icon name="sidebar" filled={sidebarOpen} />
      </button>
      <div className="appbar-fill" data-tauri-drag-region />
      <button
        type="button"
        className="appbar-rail appbar-settings"
        aria-pressed={settingsOpen}
        aria-label="Settings"
        title="Settings (⌘,)"
        onClick={onSettings}
      >
        <Icon name="gear" />
      </button>
    </header>
  );
}
