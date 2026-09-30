// The glyphs the shell uses, as one component.
//
// Tabler's (tabler.io/icons, MIT): one consistent outline set on a 24px grid,
// imported per icon so the bundle carries only these. The stroke, its width
// and its caps come from the `svg` rule in styles.css rather than from
// Tabler's own attributes, so every glyph is drawn at the shell's weight and
// takes the colour of the text around it, in either theme.
//
// Callers ask by the shell's names, not Tabler's: the names say what a glyph
// means here -- `canvas`, `wireframe`, `thinking` -- and swapping the artwork
// behind one is a change to this table alone.
import {
  IconAdjustmentsHorizontal,
  IconApps,
  IconArrowRight,
  IconArtboard,
  IconBolt,
  IconBrain,
  IconBuildingSkyscraper,
  IconCalendar,
  IconChartBar,
  IconCheck,
  IconChevronDown,
  IconCode,
  IconCompass,
  IconCopy,
  IconExternalLink,
  IconEye,
  IconFileText,
  IconFolder,
  IconFolderOpen,
  IconGitBranch,
  IconHome,
  IconLayoutNavbar,
  IconLayoutSidebar,
  IconList,
  IconMail,
  IconMenu2,
  IconMessageCircle,
  IconPalette,
  IconPaperclip,
  IconPencil,
  IconPhoto,
  IconPin,
  IconPlayerPlay,
  IconPinned,
  IconPlus,
  IconPresentation,
  IconPuzzle,
  IconRefresh,
  IconSearch,
  IconSettings,
  IconSparkles,
  IconTable,
  IconTerminal2,
  IconTool,
  IconTopologyStar3,
  IconOctagonFilled,
  IconTrash,
  IconUserCircle,
  IconUsers,
  IconWorld,
  IconX,
} from "@tabler/icons-react";

const GLYPHS = {
  menu: IconMenu2,
  // Home, the first of the three modes at the top left.
  home: IconHome,
  plus: IconPlus,
  close: IconX,
  send: IconArrowRight,
  // A stop sign: the octagon, filled -- the shape reads as "stop" where a
  // square reads as a media control.
  stop: IconOctagonFilled,
  // Sliders rather than a cog: "the things you can set", and no teeth to turn
  // to mush at rail size.
  settings: IconAdjustmentsHorizontal,
  gear: IconSettings,
  check: IconCheck,
  refresh: IconRefresh,
  branch: IconGitBranch,
  terminal: IconTerminal2,
  // The project running, in the preview; starting it; and leaving for a
  // real browser.
  globe: IconWorld,
  play: IconPlayerPlay,
  external: IconExternalLink,
  preview: IconEye,
  copy: IconCopy,
  document: IconFileText,
  sheet: IconTable,
  image: IconPhoto,
  slides: IconPresentation,
  // A screen with its header bar: a wireframe.
  wireframe: IconLayoutNavbar,
  // More than one person: a team of agents.
  agents: IconUsers,
  // The glyphs an agent can wear -- the Agents editor offers these by name.
  search: IconSearch,
  code: IconCode,
  pen: IconPencil,
  list: IconList,
  chart: IconChartBar,
  spark: IconSparkles,
  compass: IconCompass,
  bolt: IconBolt,
  // Enterprise mode, in Settings.
  enterprise: IconBuildingSkyscraper,
  // The document beside the conversation, and a page made in it.
  canvas: IconArtboard,
  sidebar: IconLayoutSidebar,
  // Rotated in CSS to point right when its section is folded shut.
  chevron: IconChevronDown,
  pin: IconPin,
  pinned: IconPinned,
  attachment: IconPaperclip,
  // Reasoning, not a lightbulb.
  thinking: IconBrain,
  calendar: IconCalendar,
  chat_bubble: IconMessageCircle,
  chat_bubble_outline: IconMessageCircle,
  folder: IconFolder,
  folder_open: IconFolderOpen,
  // A person, not a memory chip: this page is what the assistant remembers
  // about you, not how much silicon it has.
  memory: IconUserCircle,
  skills: IconPuzzle,
  tools: IconTool,
  // Which MCP server a tool came from, for the few whose sites offer no logo
  // (see ServiceIcon) and the small inline tags.
  mail: IconMail,
  trash: IconTrash,
  design: IconPalette,
  apps: IconApps,
  device_hub: IconTopologyStar3,
};

// The solid part of a glyph that has one, drawn inside it and only when the
// caller asks: the sidebar's left column fills in when the sidebar is open,
// which is the whole state that control reports.
const SOLIDS = {
  sidebar: "M6 4h3v16h-3a2 2 0 0 1 -2 -2v-12a2 2 0 0 1 2 -2z",
};

function Glyph({ name, className, children }) {
  const Drawn = GLYPHS[name];
  // An unknown name keeps its square rather than collapsing the row it is in.
  if (!Drawn) return <svg className={className} viewBox="0 0 24 24" aria-hidden="true" />;
  return (
    <Drawn className={className} aria-hidden="true" focusable="false">
      {children}
    </Drawn>
  );
}

export function Icon({ name, badge, filled }) {
  const glyph = (
    <Glyph name={name}>
      {filled && SOLIDS[name] ? <path className="icon-solid" d={SOLIDS[name]} /> : null}
    </Glyph>
  );

  if (!badge) return glyph;

  // A second glyph tucked into the bottom-right corner, inside the icon's own
  // box rather than hanging off it. It sits on a patch of the page background
  // so it stays legible over whatever the artwork underneath is doing.
  return (
    <span className="icon-stack" aria-hidden="true">
      {glyph}
      <Glyph name={badge} className="icon-badge" />
    </span>
  );
}
