/* Designs -- what design conversations make -- as the rest of the app shows
 * them, and the first message that sets a coding agent building from them. */

export const KIND_ICON = {
  wireframe: "wireframe",
  html: "canvas",
  slides: "slides",
  sheet: "sheet",
  markdown: "document",
  code: "code",
};

export const KIND_LABEL = {
  wireframe: "Wireframe",
  html: "Page",
  slides: "Slides",
  sheet: "Sheet",
  markdown: "Document",
  code: "Code",
};

/** What a new project can be built with. The empty one leaves it to the agent,
 *  which reads the designs and says what it picked. */
export const STACKS = [
  { id: "", label: "Let the agent choose" },
  { id: "HTML, CSS and plain JavaScript, no build step", label: "HTML, CSS & JavaScript" },
  { id: "React with Vite", label: "React + Vite" },
  { id: "Next.js with the App Router", label: "Next.js" },
  { id: "SvelteKit", label: "SvelteKit" },
  { id: "SwiftUI (an Xcode project for iOS)", label: "SwiftUI" },
  { id: "Flutter", label: "Flutter" },
];

/** Every design in the library, flat, with the group it came from. */
export function allDesigns(groups) {
  return (groups || []).flatMap((group) => group.designs.map((design) => ({ ...design, group })));
}

/** "Mobile app (wireframe, 4 screens)" */
export function designLine(design) {
  const kind = (KIND_LABEL[design.kind] || design.kind || "").toLowerCase();
  return `${design.title} (${kind}${design.detail ? `, ${design.detail}` : ""})`;
}

/** The first message of a project built from designs. */
export function kickoff({ designs, stack, notes, source }) {
  const lines = [
    `Build this project from the designs in \`design/\`${source ? ` (from "${source}")` : ""} -- ` +
      "start with `design/README.md`, which indexes them.",
    "",
    "The designs:",
    ...designs.map((design) => `- ${designLine(design)}`),
    "",
    stack
      ? `Build it with ${stack}.`
      : "Pick the simplest stack that fits the designs, and say which you picked and why.",
    "Match the designs closely: every screen, its text and layout, the links between " +
      "screens, and the design standard in `design/DESIGN.md` if there is one. Use the " +
      "pictures in `design/images/`.",
  ];
  if (notes && notes.trim()) lines.push("", notes.trim());
  lines.push(
    "",
    "Plan the work with code_todo first, then build it screen by screen. When it runs, " +
      "tell me how to start it.",
  );
  return lines.join("\n");
}
