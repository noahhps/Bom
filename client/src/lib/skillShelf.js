// How the Skills page groups what the model can do -- one card per shelf.
//
// The server registers skills as a flat list of tool names; fifty-odd rows of
// identical weight is a wall, not a page. These are the shelves they go on,
// decided here from the name because the name is all that says what a skill
// is for. A skill no rule claims lands in "Other" rather than disappearing,
// so a new tool on the server is never hidden by an old client.

export const SHELVES = [
  { key: "time", label: "Time & schedule", icon: "calendar", blurb: "Knows the time, keeps your calendar, and runs work later on its own." },
  { key: "files", label: "Files", icon: "folder", blurb: "Finds and reads files in the folders you share with me." },
  { key: "memory", label: "Memory", icon: "memory", blurb: "Remembers what you tell me, and searches everything we have said before." },
  { key: "canvas", label: "Canvas, decks & sheets", icon: "canvas", blurb: "Writes and edits pages, slide decks, spreadsheets and wireframes." },
  { key: "design", label: "Design & images", icon: "design", blurb: "Works to a design standard, checks the result, and makes pictures." },
  { key: "code", label: "Code", icon: "code", blurb: "Reads, writes and runs code in a project, and in a sandbox." },
  { key: "web", label: "The web", icon: "globe", blurb: "Searches the web and reads pages in a browser of my own." },
  { key: "browser", label: "Your browser", icon: "compass", blurb: "Works in your own browser, where you are already signed in." },
  { key: "other", label: "Other", icon: "tools", blurb: "Everything that does not fit on another card." },
];

const RULES = [
  ["browser", /_my_browser$/],
  ["web", /^web_search$|_page$/],
  ["code", /^code_|^run_(shell|python)$|_project$/],
  ["canvas", /_(canvas|slides|sheet|wireframe)$|^wireframe_to_slides$/],
  ["design", /design|_images?$/],
  ["memory", /^(remember|forget|search_history)$/],
  ["time", /^current_time$|_events?$|schedule/],
  ["files", /^(list_directory|read_file|search_files)$/],
];

export function shelfOf(name) {
  for (const [key, rule] of RULES) if (rule.test(name)) return key;
  return "other";
}

// "list_scheduled_tasks" -> "List scheduled tasks". The tool name stays on the
// card too, in mono: it is what a transcript shows when the skill runs.
export function skillTitle(name) {
  const words = String(name).replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// The presets' names are their ids ("jira_confluence"); a gallery reads
// better with the names the services call themselves.
const SERVICE_NAMES = {
  atlassian: "Atlassian",
  jira_confluence: "Jira & Confluence",
  linear: "Linear",
  notion: "Notion",
  sentry: "Sentry",
  stripe: "Stripe",
  hosted_oauth: "Any hosted server",
  figma: "Figma",
  figma_api: "Figma (API key)",
  google_workspace: "Google Workspace",
  google_calendar: "Google Calendar",
  github: "GitHub",
  deepwiki: "DeepWiki",
  context7: "Context7",
  exa: "Exa",
  huggingface: "Hugging Face",
  firecrawl: "Firecrawl",
  playwright: "Playwright",
  supabase: "Supabase",
  vercel: "Vercel",
  filesystem: "Filesystem",
  sequential_thinking: "Sequential thinking",
  remote_bridge: "Remote bridge",
};

export function serviceName(id) {
  if (SERVICE_NAMES[id]) return SERVICE_NAMES[id];
  return String(id)
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
