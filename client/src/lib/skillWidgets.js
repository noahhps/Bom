import { lineText } from "./plainText.js";

/* What a finished tool call looks like as a card.
 *
 * The trace used to be one monospace line per call -- the tool's name and its
 * raw arguments -- which says what was *asked for* and nothing about what came
 * back. A widget says both: which service answered, in one line what the call
 * was for, and a short look at the result, with the full text still one press
 * away.
 *
 * Everything here is derived in the client from what the turn already recorded.
 * No extra model call: a summary that cost a generation would slow every turn
 * that used a tool, and the arguments already carry the intent.
 *
 * Deliberately arguments-first. Parsing each skill's prose result to pull
 * fields out of it would be a dozen fragile little scrapers that break the day
 * a sentence is reworded; the arguments are a contract, so the title and the
 * rows come from those and the result is shown as itself.
 */

const PREVIEW_CHARS = 240;

/** One value as a line of text, whatever the model put in the argument --
 *  including an object wrapping the text, which is unwrapped rather than
 *  printed as JSON. See lib/plainText. */
function asText(value) {
  return lineText(value);
}

function clip(text, limit = PREVIEW_CHARS) {
  const clean = String(text || "").trim();
  if (clean.length <= limit) return clean;
  return clean.slice(0, limit).trimEnd() + "…";
}

/* A server's name as a label: "google_calendar" -> "Google Calendar". These
 * are written as identifiers and read as brands, so the card capitalises. */
function prettyServer(name) {
  return String(name || "")
    .split(/[\s_\-./]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

/** The first argument present from `keys`, as text. */
function pick(args, keys) {
  for (const key of keys) {
    const value = args?.[key];
    if (value !== undefined && value !== null && value !== "") return asText(value);
  }
  return "";
}

/** Rows built from whichever of `keys` the call actually carried. */
function rowsFrom(args, keys) {
  return keys
    .map(([key, label]) => [label, pick(args, [key])])
    .filter(([, value]) => value)
    .map(([label, value]) => ({ label, value: clip(value, 90) }));
}

/* Which service a tool belongs to. One entry per built-in; anything not listed
 * -- including every MCP tool -- falls through to the generic card, which wears
 * its server's mark instead. */
const SOURCES = {
  web_search: { source: "Web search", icon: "search" },
  search_history: { source: "Memory", icon: "memory" },
  remember: { source: "Memory", icon: "memory" },
  forget: { source: "Memory", icon: "memory" },
  current_time: { source: "Clock", icon: "calendar" },
  list_directory: { source: "Files", icon: "folder" },
  read_file: { source: "Files", icon: "folder" },
  search_files: { source: "Files", icon: "folder" },
  add_event: { source: "Calendar", icon: "calendar" },
  update_event: { source: "Calendar", icon: "calendar" },
  list_events: { source: "Calendar", icon: "calendar" },
  find_events: { source: "Calendar", icon: "calendar" },
  list_photos: { source: "Photos", icon: "apps" },
  list_albums: { source: "Photos", icon: "apps" },
  create_album: { source: "Photos", icon: "apps" },
  add_to_album: { source: "Photos", icon: "apps" },
  write_canvas: { source: "Canvas", icon: "document" },
  edit_canvas: { source: "Canvas", icon: "document" },
  read_canvas: { source: "Canvas", icon: "document" },
  view_canvas: { source: "Canvas", icon: "image" },
  check_design: { source: "Design", icon: "design" },
  write_slides: { source: "Slides", icon: "slides" },
  edit_slides: { source: "Slides", icon: "slides" },
  write_sheet: { source: "Sheet", icon: "sheet" },
  edit_sheet: { source: "Sheet", icon: "sheet" },
  write_wireframe: { source: "Wireframe", icon: "wireframe" },
  edit_wireframe: { source: "Wireframe", icon: "wireframe" },
  wireframe_to_slides: { source: "Wireframe", icon: "slides" },
  open_canvas: { source: "Canvas", icon: "document" },
  ask_for_design: { source: "Design", icon: "design" },
  list_images: { source: "Images", icon: "image" },
  generate_image: { source: "Images", icon: "image" },
  run_python: { source: "Sandbox", icon: "code" },
  run_shell: { source: "Sandbox", icon: "code" },
  code_ls: { source: "Code", icon: "folder" },
  code_glob: { source: "Code", icon: "search" },
  code_grep: { source: "Code", icon: "search" },
  code_read: { source: "Code", icon: "document" },
  code_edit: { source: "Code", icon: "pen" },
  code_write: { source: "Code", icon: "pen" },
  code_bash: { source: "Terminal", icon: "terminal" },
  code_todo: { source: "Tasks", icon: "list" },
  create_project: { source: "Projects", icon: "folder" },
  create_code_project: { source: "Projects", icon: "code" },
  list_designs: { source: "Designs", icon: "design" },
  read_design: { source: "Designs", icon: "wireframe" },
  import_design: { source: "Designs", icon: "design" },
};

/* The argument that best says what the call was for, per tool. First match
 * wins; the generic fallback below takes whatever the first argument is. */
const TITLE_KEYS = {
  web_search: ["query"],
  search_history: ["query"],
  remember: ["text", "fact"],
  forget: ["text", "query"],
  list_directory: ["path"],
  read_file: ["path"],
  search_files: ["pattern", "path"],
  add_event: ["title"],
  update_event: ["query", "title"],
  find_events: ["query"],
  list_events: [],
  write_canvas: ["title"],
  edit_canvas: ["title"],
  generate_image: ["prompt"],
  read_canvas: ["title"],
  view_canvas: ["title"],
  check_design: ["title"],
  write_slides: ["title"],
  edit_slides: ["title"],
  write_sheet: ["title"],
  edit_sheet: ["title"],
  write_wireframe: ["title"],
  edit_wireframe: ["title"],
  wireframe_to_slides: ["title"],
  open_canvas: ["title"],
  ask_for_design: ["name"],
  run_python: ["code"],
  run_shell: ["command"],
  code_ls: ["path"],
  code_glob: ["pattern"],
  code_grep: ["pattern"],
  code_read: ["path"],
  // The body draws these -- a diff, a file, a command, a list -- so the title
  // would only repeat it.
  code_edit: [],
  code_write: [],
  code_bash: [],
  code_todo: [],
  create_project: ["name"],
  create_code_project: ["name"],
  list_designs: [],
  read_design: ["design"],
  import_design: ["design", "project"],
};

/* Extra label/value rows worth pulling out of the arguments. */
const ROW_KEYS = {
  create_project: [["kind", "Kind"]],
  create_code_project: [["from_design", "From"]],
  read_design: [["project", "In"]],
  import_design: [["into", "Into"]],
  add_event: [["starts_at", "Starts"], ["ends_at", "Ends"], ["notes", "Notes"]],
  update_event: [["starts_at", "Starts"], ["ends_at", "Ends"], ["on", "On"]],
  list_events: [["days", "Days ahead"]],
  write_canvas: [["kind", "Kind"], ["language", "Language"]],
  view_canvas: [["device", "Device"]],
  generate_image: [["shape", "Shape"]],
  read_file: [["offset", "From line"]],
  web_search: [["count", "Results"]],
};

/**
 * One finished (or running) tool call, as the card should show it.
 *
 * `title` is what the call was for, `rows` are the details worth lifting out of
 * the arguments, and `preview` is the head of what came back.
 */
export function describeSkill(skill) {
  const name = skill?.name || "a tool";
  const args = skill?.arguments || {};
  const known = SOURCES[name];

  // An MCP tool wears its server's name rather than "Tool": these read as
  // brands, and "Gmail" locates a card faster than "search_emails" does.
  const source = known?.source || prettyServer(skill?.server) || "Tool";

  const keys = TITLE_KEYS[name];
  let title = keys ? pick(args, keys) : "";
  if (!title && !keys) {
    // Unknown tool, including every MCP one: the first argument it carried is
    // the best guess at its subject.
    const first = Object.values(args).find(
      (value) => value !== undefined && value !== null && value !== "",
    );
    title = asText(first);
  }

  // What a deck or a sheet call made, counted rather than quoted: the
  // arguments are the whole document, and the card is a glance at it.
  const rows = rowsFrom(args, ROW_KEYS[name] || []);
  if (name === "write_slides" && Array.isArray(args.slides)) {
    rows.push({ label: "Slides", value: String(args.slides.length) });
  }
  if (name === "write_wireframe" && Array.isArray(args.frames)) {
    rows.push({ label: "Screens", value: String(args.frames.length) });
  }
  // An edit is counted by what it changes, not quoted: the finds and
  // replacements are the document's own text.
  if (name === "edit_canvas" && Array.isArray(args.edits)) {
    rows.push({ label: "Changes", value: String(args.edits.length) });
  }
  if ((name === "edit_wireframe" || name === "edit_slides") && Array.isArray(args.ops)) {
    rows.push({ label: "Changes", value: String(args.ops.length) });
  }
  if (name === "write_sheet" && Array.isArray(args.columns)) {
    const count = Array.isArray(args.rows) ? args.rows.length : 0;
    rows.push({ label: "Size", value: `${args.columns.length} × ${count}` });
  }

  return {
    source,
    // Null icon means "draw the service mark instead" -- see SkillTrace.
    icon: known?.icon || null,
    server: known ? null : skill?.server || null,
    name,
    title: clip(title, 120),
    rows,
    preview: clip(skill?.result),
  };
}

/* What a turn is doing, in the words the working label settles into.
 *
 * Every word has to be true. A label that rotated through "Searching",
 * "Reading", "Drafting" on a timer while the model did something else entirely
 * would look like information and be the opposite -- worse than the one word
 * it replaced. So each word here is read off the turn itself: a skill that is
 * running says what that skill does, a turn held on the reader says so, and
 * otherwise it is the model's own work, with "Thinking" only once the model has
 * actually started to reason.
 *
 * Fifteen characters at most -- the label grows and shrinks to fit each word,
 * and a long one would push it across the column. */
const DOING = {
  web_search: "Searching",
  search_files: "Searching",
  search_history: "Recalling",
  remember: "Remembering",
  forget: "Forgetting",
  current_time: "Checking time",
  list_directory: "Reading",
  read_file: "Reading",
  read_canvas: "Reading",
  write_canvas: "Drafting",
  edit_canvas: "Revising",
  view_canvas: "Looking it over",
  check_design: "Reviewing",
  write_slides: "Building slides",
  edit_slides: "Editing slides",
  write_sheet: "Building sheet",
  edit_sheet: "Editing sheet",
  write_wireframe: "Wireframing",
  edit_wireframe: "Editing screens",
  wireframe_to_slides: "Building slides",
  open_canvas: "Opening canvas",
  ask_for_design: "Choosing a look",
  list_images: "Finding images",
  generate_image: "Drawing image",
  add_event: "Scheduling",
  update_event: "Scheduling",
  list_events: "Checking dates",
  find_events: "Checking dates",
  list_photos: "Looking",
  list_albums: "Looking",
  create_album: "Sorting photos",
  add_to_album: "Sorting photos",
  run_python: "Running code",
  run_shell: "Running code",
  code_ls: "Looking around",
  code_glob: "Finding files",
  code_grep: "Searching",
  code_read: "Reading",
  code_edit: "Editing",
  code_write: "Writing",
  code_bash: "Running",
  code_todo: "Planning",
  create_project: "Filing",
  create_code_project: "Setting up",
  list_designs: "Looking at designs",
  read_design: "Reading the design",
  import_design: "Copying designs",
};

export function workingWord(skills, thinking) {
  // Held on the reader rather than working: an approval or a design choice is
  // on screen and nothing moves until it is answered.
  if (skills?.some((s) => s.approval || s.design)) return "Waiting on you";
  // The one still waiting, for the same reason SkillTrace names it.
  const running = skills?.find((s) => s.result === undefined);
  if (running) return DOING[running.name] || "Running a skill";
  return thinking ? "Thinking" : "Working";
}
