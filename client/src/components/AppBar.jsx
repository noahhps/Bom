import {
  SegmentedControl,
  SegmentedControlItem,
} from "@/components/base/segmented-control/segmented-control";

import { Icon } from "./Icon";
import { Glyph, QuietIconButton } from "./ui";

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
 * new Studio conversation is, is chosen in its composer. */
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
}) {
  return (
    <header className="appbar" data-tauri-drag-region>
      <QuietIconButton
        size="small"
        className="appbar-rail"
        pressed={sidebarOpen}
        label={sidebarOpen ? "Close sidebar" : "Open sidebar"}
        onClick={onToggleSidebar}
        icon={<Icon name="sidebar" filled={sidebarOpen} />}
      />
      {/* BoardUI's segmented control: a tertiary track and a white thumb that
          slides behind the chosen space. */}
      <SegmentedControl
        aria-label="Space"
        className="appbar-spaces"
        selectedKeys={[space]}
        onSelectionChange={(keys) => {
          const [next] = [...keys];
          if (next) onSpace?.(next);
        }}
      >
        {SPACES.map((item) => (
          <SegmentedControlItem key={item.id} id={item.id} className="gap-1.5 px-2.5 py-0.5">
            <Glyph name={item.icon} className="size-4" />
            {item.label}
          </SegmentedControlItem>
        ))}
      </SegmentedControl>
      <div className="appbar-fill" data-tauri-drag-region />
      <QuietIconButton
        size="small"
        className="appbar-rail appbar-settings"
        pressed={settingsOpen}
        label="Settings (⌘,)"
        onClick={onSettings}
        icon="gear"
      />
    </header>
  );
}
