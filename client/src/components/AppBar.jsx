import { Icon } from "./Icon";

/* The row across the top of the window: the sidebar's toggle at its left,
 * and the settings gear at its right.
 *
 * In the desktop app this row is the window's title bar: the page is drawn
 * under it (titleBarStyle "Overlay" in tauri.conf.json), the traffic lights
 * sit at its left, and the empty stretch of it drags the window. The drag
 * attribute is on the bar and its filler only, so the buttons still click.
 *
 * Beside the toggle, the switch between the app's two spaces, where Claude
 * puts its Home and Code: Home is conversation -- chats, quick asks and the
 * agents you keep talking to -- and Studio the longer work, designs and code,
 * with its own conversations and projects. Which kind of design-or-code a
 * new Studio conversation is, is chosen in its composer.
 *
 * Studio is opt-in (Settings > General). Bom is for getting work done with a
 * small local model, and decks and codebases are the work it is worst at; with
 * Studio off there is only Home, and so no switch to draw. */
export const SPACES = [
  { id: "home", label: "Home", icon: "home" },
  { id: "studio", label: "Studio", icon: "code" },
];

export function AppBar({
  sidebarOpen,
  onToggleSidebar,
  settingsOpen = false,
  onSettings,
  space = "home",
  onSpace,
  studio = false,
}) {
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
      {studio ? (
      <div className="segmented appbar-spaces" role="tablist" aria-label="Space">
        {SPACES.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={space === item.id}
            data-active={space === item.id ? "" : undefined}
            onClick={() => onSpace?.(item.id)}
          >
            <Icon name={item.icon} />
            {item.label}
          </button>
        ))}
      </div>
      ) : null}
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
