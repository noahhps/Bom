// The glyphs the shell uses, as one component.
//
// Remix Icon (remixicon.com, Apache-2.0) -- the set BoardUI is drawn with, so
// a glyph Bom draws and a glyph inside a BoardUI control are the same family
// at the same weight. Imported per icon so the bundle carries only these.
// They are filled shapes, not strokes: styles/bom-boardui.css lets them out
// of the stroke-drawing `svg` rule in styles.css, while keeping its sizing.
//
// Callers ask by the shell's names, not Remix's: the names say what a glyph
// means here -- `canvas`, `wireframe`, `thinking` -- and swapping the artwork
// behind one is a change to this table alone.
import {
  RiAccountCircleLine,
  RiAddLine,
  RiApps2Line,
  RiArrowDownSLine,
  RiArrowUpLine,
  RiArtboardLine,
  RiAttachment2,
  RiBarChartBoxLine,
  RiBrain2Line,
  RiBuilding2Line,
  RiCalendarLine,
  RiChat3Line,
  RiCheckLine,
  RiCloseLine,
  RiCodeSSlashLine,
  RiCompass3Line,
  RiDeleteBinLine,
  RiEqualizer2Line,
  RiExternalLinkLine,
  RiEyeLine,
  RiFileCopyLine,
  RiFileTextLine,
  RiFlashlightLine,
  RiFolderLine,
  RiFolderOpenLine,
  RiGitBranchLine,
  RiGlobalLine,
  RiHomeLine,
  RiImageLine,
  RiLayoutTopLine,
  RiListUnordered,
  RiMailLine,
  RiMenuLine,
  RiNodeTree,
  RiPaletteLine,
  RiPencilLine,
  RiPlayLine,
  RiPuzzle2Line,
  RiPushpinFill,
  RiPushpinLine,
  RiRefreshLine,
  RiSearchLine,
  RiSettings3Line,
  RiSideBarFill,
  RiSideBarLine,
  RiSlideshowLine,
  RiSparklingLine,
  RiStopFill,
  RiTableLine,
  RiTeamLine,
  RiTerminalBoxLine,
  RiToolsLine,
} from "@remixicon/react";

export const GLYPHS = {
  menu: RiMenuLine,
  // Home, the first of the three modes at the top left.
  home: RiHomeLine,
  plus: RiAddLine,
  close: RiCloseLine,
  // Up, as BoardUI's composer sends: the message rises into the thread.
  send: RiArrowUpLine,
  stop: RiStopFill,
  // Sliders rather than a cog: "the things you can set".
  settings: RiEqualizer2Line,
  gear: RiSettings3Line,
  check: RiCheckLine,
  refresh: RiRefreshLine,
  branch: RiGitBranchLine,
  terminal: RiTerminalBoxLine,
  // The project running, in the preview; starting it; and leaving for a
  // real browser.
  globe: RiGlobalLine,
  play: RiPlayLine,
  external: RiExternalLinkLine,
  preview: RiEyeLine,
  copy: RiFileCopyLine,
  document: RiFileTextLine,
  sheet: RiTableLine,
  image: RiImageLine,
  slides: RiSlideshowLine,
  // A screen with its header bar: a wireframe.
  wireframe: RiLayoutTopLine,
  // More than one person: a team of agents.
  agents: RiTeamLine,
  // The glyphs an agent can wear -- the Agents editor offers these by name.
  search: RiSearchLine,
  code: RiCodeSSlashLine,
  pen: RiPencilLine,
  list: RiListUnordered,
  chart: RiBarChartBoxLine,
  spark: RiSparklingLine,
  compass: RiCompass3Line,
  bolt: RiFlashlightLine,
  // Enterprise mode, in Settings.
  enterprise: RiBuilding2Line,
  // The document beside the conversation, and a page made in it.
  canvas: RiArtboardLine,
  sidebar: RiSideBarLine,
  // Rotated in CSS to point right when its section is folded shut.
  chevron: RiArrowDownSLine,
  pin: RiPushpinLine,
  pinned: RiPushpinFill,
  attachment: RiAttachment2,
  // Reasoning, not a lightbulb.
  thinking: RiBrain2Line,
  calendar: RiCalendarLine,
  chat_bubble: RiChat3Line,
  chat_bubble_outline: RiChat3Line,
  folder: RiFolderLine,
  folder_open: RiFolderOpenLine,
  // A person, not a memory chip: this page is what the assistant remembers
  // about you, not how much silicon it has.
  memory: RiAccountCircleLine,
  skills: RiPuzzle2Line,
  tools: RiToolsLine,
  // Which MCP server a tool came from, for the few whose sites offer no logo
  // (see ServiceIcon) and the small inline tags.
  mail: RiMailLine,
  trash: RiDeleteBinLine,
  design: RiPaletteLine,
  apps: RiApps2Line,
  device_hub: RiNodeTree,
};

// The filled form of a glyph that has one, drawn only when the caller asks:
// the sidebar's left column fills in when the sidebar is open, which is the
// whole state that control reports.
const SOLIDS = {
  sidebar: RiSideBarFill,
};

function Glyph({ name, className, filled = false }) {
  const Drawn = (filled && SOLIDS[name]) || GLYPHS[name];
  // An unknown name keeps its square rather than collapsing the row it is in.
  if (!Drawn) return <svg className={className} viewBox="0 0 24 24" aria-hidden="true" />;
  return <Drawn className={className} aria-hidden="true" focusable="false" />;
}

export function Icon({ name, badge, filled }) {
  const glyph = <Glyph name={name} filled={filled} />;

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
