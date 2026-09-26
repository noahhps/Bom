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

/** One value as a line of text, whatever the model put in the argument. */
function asText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
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
  read_canvas: { source: "Canvas", icon: "document" },
  write_slides: { source: "Slides", icon: "slides" },
  write_sheet: { source: "Sheet", icon: "sheet" },
  edit_sheet: { source: "Sheet", icon: "sheet" },
  ask_for_design: { source: "Design", icon: "design" },
  run_python: { source: "Sandbox", icon: "code" },
  run_shell: { source: "Sandbox", icon: "code" },
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
  read_canvas: ["title"],
  write_slides: ["title"],
  write_sheet: ["title"],
  edit_sheet: ["title"],
  ask_for_design: ["name"],
  run_python: ["code"],
  run_shell: ["command"],
};

/* Extra label/value rows worth pulling out of the arguments. */
const ROW_KEYS = {
  add_event: [["starts_at", "Starts"], ["ends_at", "Ends"], ["notes", "Notes"]],
  update_event: [["starts_at", "Starts"], ["ends_at", "Ends"], ["on", "On"]],
  list_events: [["days", "Days ahead"]],
  write_canvas: [["kind", "Kind"], ["language", "Language"]],
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
  write_slides: "Building slides",
  write_sheet: "Building sheet",
  edit_sheet: "Editing sheet",
  ask_for_design: "Choosing a look",
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
