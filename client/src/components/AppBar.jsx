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
 * puts its Home and Code: Home is conversation -- chats and quick asks --
 * and Studio the longer work, designs and code,
 * with its own conversations and projects. Which kind of design-or-code a
 * new Studio conversation is, is chosen in its composer.
 *
 * With the rail pinned on a wide window the toggle and the switch move into
 * the head of the rail instead, under the traffic lights, as the Claude app
 * has them: the rail runs the full height of the window and this bar starts
 * at its edge (`inRail`). The two controls are the components below, so the
 * bar and the rail draw the same ones. */
export const SPACES = [
  { id: "home", label: "Home", icon: "home" },
  { id: "studio", label: "Studio", icon: "code" },
];

export function SidebarToggle({ open, onToggle }) {
  return (
    <button
      type="button"
      className="appbar-rail"
      aria-pressed={open}
      aria-label={open ? "Close sidebar" : "Open sidebar"}
      title={open ? "Close sidebar" : "Open sidebar"}
      onClick={onToggle}
    >
      <Icon name="sidebar" filled={open} />
    </button>
  );
}

export function SpaceSwitch({ space = "home", onSpace, className = "" }) {
  return (
    <div className={`segmented appbar-spaces ${className}`} role="tablist" aria-label="Space">
      {SPACES.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={space === item.id}
          aria-label={item.label}
          title={item.label}
          data-active={space === item.id ? "" : undefined}
          onClick={() => onSpace?.(item.id)}
        >
          <Icon name={item.icon} />
          {/* A span so the rail's narrow head can drop the word and keep the
              glyph; the button is named above either way. */}
          <span className="seg-label">{item.label}</span>
        </button>
      ))}
    </div>
  );
}

export function AppBar({
  sidebarOpen,
  onToggleSidebar,
  settingsOpen = false,
  onSettings,
  space = "home",
  onSpace,
  inRail = false,
}) {
  return (
    <header className="appbar" data-tauri-drag-region data-in-rail={inRail ? "" : undefined}>
      {inRail ? null : (
        <>
          <SidebarToggle open={sidebarOpen} onToggle={onToggleSidebar} />
          <SpaceSwitch space={space} onSpace={onSpace} />
        </>
      )}
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
