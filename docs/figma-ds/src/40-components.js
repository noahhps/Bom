/* Components, atoms first. Every one is drawn from the component or the CSS
 * rule named in its description, and binds to Color / QuickView / Dimension
 * variables rather than carrying its own values. */

// Icon.jsx PATHS and client/public/*.svg.
const ICONS = {
  chat: { d: "M20 2H4C2.9 2 2 2.9 2 4V22L6 18H20C21.1 18 22 17.1 22 16V4C22 2.9 21.1 2 20 2Z", fill: true },
  folder: {
    d: "M9.17 6L11.17 8H20V18H4V6H9.17ZM10 4H4C2.9 4 2.01 4.9 2.01 6L2 18C2 19.1 2.9 20 4 20H20C21.1 20 22 19.1 22 18V8C22 6.9 21.1 6 20 6H12L10 4Z",
    fill: true,
  },
  memory: { d: "M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z", fill: true },
  skills: {
    d: "M20.5 11H19V7c0-1.1-.9-2-2-2h-4V3.5C13 2.12 11.88 1 10.5 1S8 2.12 8 3.5V5H4c-1.1 0-1.99.9-1.99 2v3.8H3.5c1.49 0 2.7 1.21 2.7 2.7s-1.21 2.7-2.7 2.7H2V20c0 1.1.9 2 2 2h3.8v-1.5c0-1.49 1.21-2.7 2.7-2.7 1.49 0 2.7 1.21 2.7 2.7V22H17c1.1 0 2-.9 2-2v-4h1.5c1.38 0 2.5-1.12 2.5-2.5S21.88 11 20.5 11z",
    fill: true,
  },
  attachments: {
    d: "M16 1H4C2.9 1 2 1.9 2 3V17H4V3H16V1ZM15 5H8C6.9 5 6.01 5.9 6.01 7L6 21C6 22.1 6.89 23 7.99 23H19C20.1 23 21 22.1 21 21V11L15 5ZM8 21V7H14V12H19V21H8Z",
    fill: true,
  },
  settings: { d: "M4 8h16M4 16h16M10.5 5.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 1 0 0-4.8M15 13.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 1 0 0-4.8" },
  pin: { d: "M9 4h6M12 4v7M8.5 11h7l1.5 4H7l1.5-4M12 15v5" },
  pinned: { d: "M8.5 4h7M12 4v5M7.5 9h9l2 5H5.5l2-5M12 14v6" },
  plus: { d: "M12 5v14M5 12h14" },
  close: { d: "M6 6l12 12M18 6L6 18" },
  check: { d: "M5 12.5l5 5 9-11" },
  send: { d: "M5 12h14M13 6l6 6-6 6" },
  stop: { d: "M8 8h8v8H8z" },
  thinking: { d: "M15.5 20.5v-2.2a6.5 6.5 0 10-7-10.6M6 13.5H4l2-3.6M9 20.5v-3.2M5 17.5l-2 3M12 11.5h.01M15 11.5h.01M9 11.5h.01" },
  chevrons: { d: "M8 9.5l4-4 4 4M8 14.5l4 4 4-4" },
  clip: { d: "M21 11.5l-8.6 8.6a5 5 0 01-7-7l8.6-8.6a3.3 3.3 0 014.7 4.7l-8.6 8.6a1.7 1.7 0 01-2.3-2.3l7.9-7.9" },
  up: { d: "M12 19V5M6 11l6-6 6 6" },
};

async function buildIcons(sec) {
  const grid = al("Icons", "HORIZONTAL", { gap: 20, pad: [24, 24, 24, 24], fill: "surface/raised", stroke: "border/soft", radius: "radius/row" });
  grid.layoutWrap = "WRAP";
  grid.counterAxisSpacing = 20;
  fixW(grid, 520);
  for (const [name, spec] of Object.entries(ICONS)) {
    const paintAttr = spec.fill
      ? 'fill="#000000"'
      : 'fill="none" stroke="#000000" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"';
    const tmp = figma.createNodeFromSvg(
      `<svg width="24" height="24" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="${spec.d}" ${paintAttr}/></svg>`,
    );
    const c = figma.createComponent();
    c.name = "Icon/" + name;
    c.resize(24, 24);
    c.fills = [];
    for (const child of [...tmp.children]) c.appendChild(child);
    tmp.remove();
    c.findAll((n) => n.type === "VECTOR").forEach((v) => {
      v.constraints = { horizontal: "SCALE", vertical: "SCALE" };
      if (spec.fill) v.fills = [paint("icon/default")];
      else v.strokes = [paint("icon/default")];
    });
    c.description = spec.fill ? "Material silhouette from client/public, drawn as a mask over currentColor." : "Stroked path from Icon.jsx PATHS.";
    grid.appendChild(c);
    REG["Icon/" + name] = { node: c, props: {} };
  }
  return grid;
}

// -- controls --------------------------------------------------------------------

async function buildButton(sec) {
  const cs = await variantSet(
    sec,
    "Button",
    { Kind: ["Primary", "Secondary"], State: ["Default", "Hover", "Disabled"] },
    async ({ Kind, State }) => {
      const primary = Kind === "Primary";
      const c = comp("", "HORIZONTAL", { gap: 7, pad: [10, 16], align: "CENTER", radius: "radius/square" });
      if (primary) c.fills = [paint(State === "Hover" ? "surface/inverse-hover" : "surface/inverse")];
      else stroke(c, State === "Hover" ? "border/strong" : "border/firm");
      c.appendChild(await txt("Save", "Control/SM", primary ? "text/on-inverse" : "text/primary", { name: "label" }));
      if (State === "Disabled") c.opacity = 0.45;
      return c;
    },
    ".btnp (Primary) and .btn (Secondary). Ink, not accent: the accent is reserved for the send button and links.",
  );
  addText("Button", "Label", "Save");
  return cs;
}

async function buildChip(sec) {
  const cs = await variantSet(
    sec,
    "Chip",
    { State: ["Default", "On", "Disabled"] },
    async ({ State }) => {
      const on = State === "On";
      const c = comp("", "HORIZONTAL", { gap: 7, pad: [7, 12], align: "CENTER", radius: "radius/square" });
      stroke(c, on ? "surface/inverse" : "border/firm");
      if (on) c.fills = [paint("surface/inverse")];
      c.appendChild(await txt("New conversation", "Control/XS", on ? "text/on-accent" : "text/secondary", { name: "label" }));
      if (State === "Disabled") c.opacity = 0.45;
      return c;
    },
    ".chip. On is also the reasoning switch for models that take a yes/no rather than an effort word.",
  );
  addText("Chip", "Label", "New conversation");
  return cs;
}

async function buildChipIcon(sec) {
  const c = comp("", "HORIZONTAL", { pad: [6, 9], align: "CENTER", radius: "radius/square", stroke: "border/firm" });
  c.appendChild(icon("attachments", 14, "icon/secondary"));
  single(sec, "Chip/Icon", c, ".chip.chip-icon -- the composer's attach button.");
  addSwap("Chip/Icon", "Icon", "attachments");
  return c;
}

async function buildEffortOption(sec) {
  const cs = await variantSet(
    sec,
    "Effort option",
    { Selected: ["No", "Yes"], State: ["Enabled", "Disabled"] },
    async ({ Selected, State }) => {
      const on = Selected === "Yes";
      const c = comp("", "HORIZONTAL", { pad: [7, 11], align: "CENTER", radius: "radius/square" });
      if (on) c.fills = [paint("surface/wash")];
      c.appendChild(await txt("medium", "Control/XS", on ? "text/primary" : "text/quiet", { name: "label" }));
      if (State === "Disabled") c.opacity = 0.45;
      return c;
    },
    "One option of .effort. Building block for Effort control.",
  );
  addText("Effort option", "Label", "medium");
  return cs;
}

async function buildEffortControl(sec) {
  const cs = await variantSet(
    sec,
    "Effort control",
    { Value: ["Low", "Medium", "High"] },
    async ({ Value }) => {
      const c = comp("", "HORIZONTAL", { gap: 4, align: "CENTER" });
      for (const level of ["low", "medium", "high"]) {
        const o = use("Effort option", { Selected: level === Value.toLowerCase() ? "Yes" : "No" }, { Label: level });
        o.name = "option:" + level;
        c.appendChild(o);
      }
      return c;
    },
    "ThinkingControl in effort mode. The options come from /status, so a model can offer a different set.",
  );
  return cs;
}

async function buildBudget(sec) {
  const c = comp("", "HORIZONTAL", { gap: 8, align: "CENTER" });
  c.appendChild(await txt("Budget", "Label/Micro", "text/tertiary", { name: "label" }));
  const track = figma.createFrame();
  track.name = "range";
  track.fills = [];
  track.resize(92, 16);
  const bg = rect("track", 92, 4, "border/default");
  bg.cornerRadius = 2;
  bg.y = 6;
  const done = rect("filled", 46, 4, "accent/default");
  done.cornerRadius = 2;
  done.y = 6;
  const knob = dot(14, "surface/raised", "knob");
  knob.strokes = [paint("accent/default")];
  knob.strokeWeight = 1.5;
  knob.x = 39;
  knob.y = 1;
  track.appendChild(bg);
  track.appendChild(done);
  track.appendChild(knob);
  c.appendChild(track);
  c.appendChild(await txt("8k", "Label/Micro", "text/tertiary", { name: "value" }));
  single(sec, "Budget control", c, "ThinkingControl in budget mode: a token budget, continuous, so a real range.");
  addText("Budget control", "Value", "8k");
  return c;
}

async function buildSend(sec) {
  const cs = await variantSet(
    sec,
    "Send button",
    { State: ["Send", "Stop", "Disabled"] },
    async ({ State }) => {
      const c = comp("", "HORIZONTAL", { align: "CENTER", justify: "CENTER", radius: "radius/full", fill: "accent/send" });
      fixed(c, 32, 32);
      c.appendChild(icon(State === "Stop" ? "stop" : "send", 15, "icon/on-accent"));
      if (State === "Disabled") c.opacity = 0.35;
      return c;
    },
    ".send. While a turn streams it becomes Stop rather than a greyed-out arrow.",
  );
  return cs;
}

async function buildIconButton(sec) {
  const cs = await variantSet(
    sec,
    "Icon button",
    { State: ["Default", "Hover"] },
    async ({ State }) => {
      const c = comp("", "HORIZONTAL", { align: "CENTER", justify: "CENTER", radius: "radius/full" });
      fixed(c, 34, 34);
      if (State === "Hover") c.fills = [paint("surface/hover-soft")];
      c.appendChild(icon("plus", 18, "icon/default"));
      return c;
    },
    ".icon-btn -- 34px round, used in the top bar.",
  );
  addSwap("Icon button", "Icon", "plus");
  return cs;
}

async function buildSelect(sec) {
  const cs = await variantSet(
    sec,
    "Select",
    { State: ["Default", "Focus"] },
    async ({ State }) => {
      const c = comp("", "HORIZONTAL", { gap: 6, pad: [5, 6, 5, 8], align: "CENTER", radius: "radius/square", fill: "surface/raised" });
      stroke(c, State === "Focus" ? "accent/default" : "border/default");
      c.appendChild(await txt("None", "Control/SM", "text/primary", { name: "value" }));
      c.appendChild(icon("chevrons", 12, "icon/default"));
      return c;
    },
    ".topbar-project select -- filing a conversation under a project.",
  );
  addText("Select", "Value", "None");
  return cs;
}

async function buildBead(sec) {
  const c = comp("", null, { radius: "radius/full", fill: "accent/pure", stroke: "border/composer" });
  fixed(c, 11, 11);
  single(sec, "Accent bead", c, ".accent-bead -- the colour a chat or project wears. Takes accent/pure from whichever mode it sits in.");
  return c;
}

async function buildStateIndicator(sec) {
  const cs = await variantSet(
    sec,
    "State indicator",
    { Tone: ["Accent", "Warn", "Down"] },
    async ({ Tone }) => {
      const c = comp("", "HORIZONTAL", { gap: 8, align: "CENTER" });
      c.appendChild(dot(7, Tone === "Accent" ? "accent/default" : Tone === "Warn" ? "status/warn" : "status/down"));
      c.appendChild(await txt("gpt-oss:latest", "Label/Micro", "text/tertiary", { name: "label" }));
      return c;
    },
    ".state -- a dot and a machine label for what answered. Warn: fell through to a cloud backend. Down: nothing reachable.",
  );
  addText("State indicator", "Label", "gpt-oss:latest");
  return cs;
}

async function buildApprovalButton(sec) {
  const cs = await variantSet(
    sec,
    "Approval button",
    { State: ["Default", "Hover"] },
    async ({ State }) => {
      const hover = State === "Hover";
      const c = comp("", "HORIZONTAL", { pad: [7, 12], align: "CENTER", radius: "radius/row", fill: "surface/raised" });
      stroke(c, hover ? "accent/default" : "border/default");
      c.appendChild(await txt("Allow once", "Control/SM Strong", hover ? "text/accent" : "text/primary", { name: "label" }));
      return c;
    },
    ".approval-btn. Deny is not styled as the dangerous option -- it is not one.",
  );
  addText("Approval button", "Label", "Allow once");
  return cs;
}

// -- navigation ------------------------------------------------------------------

async function buildNavRow(sec) {
  const cs = await variantSet(
    sec,
    "Nav row",
    { State: ["Default", "Hover", "Current"] },
    async ({ State }) => {
      const quiet = State === "Default";
      const c = comp("", "HORIZONTAL", { gap: 10, pad: [9, 10], align: "CENTER", radius: "radius/row" });
      fixW(c, 232);
      if (!quiet) c.fills = [paint("surface/hover")];
      c.appendChild(icon("chat", 18, quiet ? "icon/muted" : "icon/default"));
      c.appendChild(await txt("Chat", State === "Current" ? "UI/MD Strong" : "UI/MD", quiet ? "text/tertiary" : "text/primary", { name: "label" }));
      return c;
    },
    ".navrail-dest button with the rail open. Current is a grey plate and a heavier label, not an accent bar.",
  );
  addText("Nav row", "Label", "Chat");
  addSwap("Nav row", "Icon", "chat");
  return cs;
}

async function buildSessionRow(sec) {
  const cs = await variantSet(
    sec,
    "Session row",
    { State: ["Default", "Hover", "Current"] },
    async ({ State }) => {
      const c = comp("", "HORIZONTAL", { align: "CENTER", radius: "radius/list" });
      fixW(c, 232);
      if (State === "Hover") c.fills = [paint("surface/hover-strong")];
      if (State === "Current") c.fills = [paint("surface/hover")];
      const inner = al("row", "HORIZONTAL", { gap: 8, pad: [8, 10], align: "CENTER" });
      add(c, inner, { grow: true });
      const bead = use("Accent bead");
      bead.name = "bead";
      inner.appendChild(bead);
      add(inner, await txt("Untitled", "UI/SM", "text/primary", { name: "title" }), { grow: true });
      const del = al("delete", "HORIZONTAL", { pad: [6, 9] });
      del.appendChild(await txt("×", "UI/MD", "text/tertiary", { name: "x" }));
      c.appendChild(del);
      del.visible = State === "Hover";
      return c;
    },
    "A conversation in the rail. The bead is the project it is filed under -- shown only for filed chats.",
  );
  addText("Session row", "Title", "Untitled");
  addBool("Session row", "Project bead", false, "bead");
  return cs;
}

async function buildNewConversation(sec) {
  const c = comp("", "HORIZONTAL", { pad: [9, 10, 11, 10] });
  fixW(c, 232);
  c.appendChild(await txt("+ New conversation", "UI/MD", "text/accent", { name: "label" }));
  single(sec, "New conversation", c, ".navrail-new");
  return c;
}

async function buildProvider(sec) {
  const cs = await variantSet(
    sec,
    "Provider",
    { Tone: ["Pass", "Warn", "Down"] },
    async ({ Tone }) => {
      const c = comp("", "HORIZONTAL", { gap: 11, align: "CENTER" });
      c.appendChild(dot(24, Tone === "Pass" ? "status/pass" : Tone === "Warn" ? "status/warn" : "status/down", "provider-dot"));
      c.appendChild(await txt("gpt-oss:latest", "Label/Micro", "text/tertiary", { name: "model" }));
      return c;
    },
    ".navrail-foot. The dot is the model menu, and its colour is reachability: green local, ochre cloud fallback, grey nothing.",
  );
  addText("Provider", "Model", "gpt-oss:latest");
  return cs;
}

async function buildAura(sec) {
  // The ambient field. theme.js paints radial gradients; gradient stops cannot
  // take variables, so each disc is a blurred ellipse with a bound fill -- it
  // follows the mode, and is clear in Default, as the app is with no accent.
  // Radii are 0.46 of the CSS radius and the blur about 0.28 of it, which puts
  // the falloff where the gradient's `transparent 76%` stop puts it.
  const disc = (name, fillVar, cx, cy, rx, ry) => {
    const e = figma.createEllipse();
    e.name = name;
    e.resize(rx * 0.92, ry * 0.92);
    e.x = cx - rx * 0.46;
    e.y = cy - ry * 0.46;
    e.fills = [paint(fillVar)];
    e.effects = [{ type: "LAYER_BLUR", radius: Math.min(250, 0.28 * Math.min(rx, ry)), visible: true }];
    e.constraints = { horizontal: "SCALE", vertical: "SCALE" };
    return e;
  };

  const W = 928;
  const H = 820;
  const sheet = figma.createComponent();
  sheet.resize(W, H);
  sheet.fills = [];
  sheet.clipsContent = true;
  const field = figma.createFrame();
  field.name = "field";
  field.fills = [];
  field.resize(W, H);
  field.opacity = DATA.strength * 0.5 + 0.12; // --aura-opacity
  field.constraints = { horizontal: "STRETCH", vertical: "STRETCH" };
  field.appendChild(disc("aura-3", "aura/3", 0.444 * W, -0.498 * H, 1.232 * W, 1.023 * H));
  field.appendChild(disc("aura-1", "aura/1", 1.088 * W, 1.053 * H, 0.924 * W, 0.858 * H));
  field.appendChild(disc("aura-2", "aura/2", 0.052 * W, 1.416 * H, 1.008 * W, 0.957 * H));
  sheet.appendChild(field);
  single(sec, "Aura/Sheet", sheet, ".screen::before -- three discs of the accent behind the sheet. Clear in the Default mode.");

  const RW = 252;
  const rail = figma.createComponent();
  rail.resize(RW, H);
  rail.fills = [];
  rail.clipsContent = true;
  rail.appendChild(disc("aura-3", "aura/3", RW * 0.5, -0.172 * H, 1.26 * RW, 0.312 * H));
  rail.appendChild(disc("aura-2", "aura/2", RW * 0.5, 1.196 * H, 1.08 * RW, 0.36 * H));
  single(sec, "Aura/Rail", rail, ".navrail-inner::before -- the same field, turned for a strip. The rail's only colour.");

  const holder = al("Aura", "HORIZONTAL", { gap: 40 });
  holder.appendChild(sheet);
  holder.appendChild(rail);
  setMode(holder, "teal");
  return holder;
}

async function buildNavRail(sec) {
  const W = 252;
  const H = 820;
  const rail = comp("", "VERTICAL", { gap: 28, pad: [22, 10, 18, 10], clip: true });
  fixed(rail, W, H);
  // The glass itself: a luminance ramp, not a token -- it is the material.
  rail.fills = [
    {
      type: "GRADIENT_LINEAR",
      gradientTransform: [
        [0.37, 0.93, -0.15],
        [-0.93, 0.37, 0.78],
      ],
      gradientStops: [
        { position: 0, color: rgba("#ffffff", 0.2) },
        { position: 0.42, color: rgba("#ffffff", 0.06) },
        { position: 1, color: rgba("#ffffff", 0.13) },
      ],
    },
  ];
  strokeSides(rail, "border/glass", { right: true });
  await rail.setEffectStyleIdAsync(ES["Glass/Rail"].id);

  const aura = use("Aura/Rail");
  absolute(rail, aura, 0, 0, true);
  aura.constraints = { horizontal: "STRETCH", vertical: "STRETCH" };

  const top = al("top", "HORIZONTAL", { gap: 11, align: "CENTER" });
  add(rail, top, { fill: true });
  const slot = figma.createFrame();
  slot.name = "mark";
  slot.fills = [];
  slot.resize(24, 24);
  slot.clipsContent = false;
  const mark = markRect(9.4, 30);
  slot.appendChild(mark);
  mark.x = 7.3;
  mark.y = -3;
  top.appendChild(slot);
  add(top, await txt("Assistant", "Label/Micro", "text/primary", { name: "wordmark" }), { grow: true });
  const pin = al("pin", "HORIZONTAL", { align: "CENTER", justify: "CENTER", radius: "radius/row" });
  fixed(pin, 26, 26);
  pin.appendChild(icon("pinned", 15, "icon/accent"));
  top.appendChild(pin);

  const dest = al("destinations", "VERTICAL", { gap: 10 });
  add(rail, dest, { fill: true });
  const group = al("chat-group", "VERTICAL");
  add(dest, group, { fill: true });
  add(group, use("Nav row", { State: "Current" }, { Label: "Chat" }), { fill: true });
  add(group, use("New conversation"), { fill: true });
  const list = al("sessions", "VERTICAL", { pad: [6, 0, 2, 0] });
  strokeSides(list, "border/soft", { top: true });
  add(group, list, { fill: true });
  const titles = ["Untitled", "Cannot Edit Your Loca…", "Comparing Grok Claude…", "Another attempt at ti…", "Untitled"];
  titles.forEach((t, i) => {
    const row = use("Session row", { State: i === 0 ? "Current" : "Default" }, { Title: t });
    row.name = "session-" + i;
    add(list, row, { fill: true });
  });
  for (const [label, ic] of [
    ["Projects", "folder"],
    ["Memory", "memory"],
    ["Skills", "skills"],
    ["Settings", "settings"],
  ]) {
    add(dest, use("Nav row", { State: "Default" }, { Label: label, Icon: REG["Icon/" + ic].node.id }), { fill: true });
  }

  add(rail, spacer(), { grow: true });
  const foot = use("Provider", { Tone: "Pass" });
  foot.name = "provider";
  foot.isExposedInstance = true;
  add(rail, foot, { fill: true });

  single(
    sec,
    "NavRail",
    rail,
    "NavRail.jsx pinned open. Unpinned it takes no width and slides in from the window edge on hover. Glass over the desktop, tinted by the app-wide accent.",
  );

  // On the canvas the glass needs something behind it to be glass.
  const backdrop = figma.createFrame();
  backdrop.name = "NavRail on desktop";
  backdrop.resize(W + 64, H + 64);
  backdrop.fills = [rawSolid("#d9dcf1")];
  backdrop.clipsContent = true;
  const wp = use("Utility/Wallpaper");
  backdrop.appendChild(wp);
  wp.x = -200;
  wp.y = -60;
  backdrop.appendChild(rail);
  rail.x = 32;
  rail.y = 32;
  setMode(backdrop, "iris");
  return backdrop;
}

// -- conversation ----------------------------------------------------------------

async function buildUserMessage(sec) {
  const c = comp("", "HORIZONTAL", { pad: [10, 14], radius: "radius/square", fill: "surface/plate" });
  c.appendChild(await txt("hello", "Body/Bubble", "text/primary", { name: "content" }));
  single(sec, "Message/User", c, ".bubble -- a quiet plate on the right. Caps at 70% of the reading column.");
  addText("Message/User", "Content", "hello");
  return c;
}

async function buildProvenance(sec) {
  const c = comp("", "HORIZONTAL", { gap: 8, align: "CENTER" });
  c.appendChild(await txt("Answered by", "Label/Micro", "text/tertiary", { name: "label" }));
  c.appendChild(await txt("gpt-oss:latest", "UI/XS", "text/provenance", { name: "model" }));
  single(sec, "Message/Provenance", c, ".margin -- which model produced the turn, one quiet line above the answer.");
  addText("Message/Provenance", "Model", "gpt-oss:latest");
  return c;
}

// The hollow (or live) step marker shared by reasoning and skill traces, and
// the rule that joins the steps.
function stepMarks(c, live, dotY) {
  const rule = rect("rule", 1, Math.max(1, c.height - dotY - 2), "border/default");
  absolute(c, rule, 5, dotY + 2, true);
  rule.constraints = { horizontal: "MIN", vertical: "STRETCH" };
  const d = dot(7, live ? "accent/default" : "surface/raised", "step");
  d.strokes = [paint(live ? "accent/default" : "border/strong")];
  d.strokeWeight = 1.5;
  d.strokeAlign = "OUTSIDE";
  absolute(c, d, 2, dotY);
}

async function buildReasoning(sec) {
  const cs = await variantSet(
    sec,
    "Message/Reasoning",
    { State: ["Live", "Folded", "Open"] },
    async ({ State }) => {
      const live = State === "Live";
      const c = comp("", "VERTICAL", { gap: 9, pad: [0, 0, 0, 22] });
      fixW(c, 600);
      add(c, await txt(live ? "Thinking…" : "Thought before answering", "UI/SM", live ? "text/accent" : "text/tertiary", { name: "toggle" }), {
        wrap: true,
      });
      if (State !== "Folded") {
        const body = al("body", "VERTICAL", { pad: [0, 0, 0, 13] });
        strokeSides(body, "border/soft", { left: true }, 2);
        add(c, body, { fill: true });
        add(
          body,
          await txt("A greeting, nothing to look up. Answer briefly and ask what they need.", "UI/SM", "text/reasoning", { name: "reasoning" }),
          { wrap: true },
        );
      }
      stepMarks(c, live, 6);
      return c;
    },
    "Reasoning.jsx -- open while it is the only thing happening, folded the moment the answer starts.",
  );
  addText("Message/Reasoning", "Reasoning", "A greeting, nothing to look up. Answer briefly and ask what they need.");
  return cs;
}

async function buildSkillStep(sec) {
  const cs = await variantSet(
    sec,
    "Message/Skill step",
    { State: ["Running", "Done", "Open"] },
    async ({ State }) => {
      const running = State === "Running";
      const c = comp("", "VERTICAL", { pad: [0, 0, 0, 22] });
      fixW(c, 600);
      const head = al("head", "HORIZONTAL", { gap: 8, pad: [4, 0], align: "CENTER" });
      add(c, head, { fill: true });
      head.appendChild(await txt("current_time", "UI/SM", "text/secondary", { name: "name" }));
      head.appendChild(await txt("zone: Asia/Tokyo", "UI/XS", "text/tertiary", { name: "args" }));
      add(head, spacer(), { grow: true });
      head.appendChild(await txt(running ? "running" : State === "Open" ? "hide" : "show", "Label/Micro", "text/tertiary", { name: "state" }));
      if (State === "Open") {
        const wrap = al("body", "VERTICAL", { pad: [4, 0, 6, 15] });
        add(c, wrap, { fill: true });
        const inner = al("result-rule", "VERTICAL", { pad: [0, 0, 0, 11] });
        strokeSides(inner, "border/default", { left: true }, 2);
        add(wrap, inner, { fill: true });
        add(inner, await txt("Saturday 12 September 2026, 09:02 JST", "UI/SM", "text/secondary", { name: "result" }), { wrap: true });
      }
      stepMarks(c, running, 11);
      return c;
    },
    "One row of SkillTrace.jsx. A row with no result yet is still running -- the difference between a slow skill and a hung turn.",
  );
  addText("Message/Skill step", "Name", "current_time");
  addText("Message/Skill step", "Args", "zone: Asia/Tokyo");
  addText("Message/Skill step", "Result", "Saturday 12 September 2026, 09:02 JST");
  return cs;
}

async function buildSkillTrace(sec) {
  const cs = await variantSet(
    sec,
    "Message/Skill trace",
    { State: ["Running", "Done"] },
    async ({ State }) => {
      const running = State === "Running";
      const c = comp("", "VERTICAL", { gap: 4 });
      fixW(c, 600);
      c.appendChild(await txt(running ? "Using list_directory…" : "Used 2 skills", "Label/Micro", running ? "text/accent" : "text/tertiary", { name: "label" }));
      add(c, use("Message/Skill step", { State: "Done" }, { Name: "current_time", Args: "" }), { fill: true });
      add(c, use("Message/Skill step", { State: running ? "Running" : "Done" }, { Name: "list_directory", Args: "path: ~/Documents" }), { fill: true });
      return c;
    },
    "SkillTrace.jsx -- what the model reached for, above the answer it produced.",
  );
  return cs;
}

async function buildApproval(sec) {
  const cs = await variantSet(
    sec,
    "Message/Approval",
    { State: ["Pending", "Answered", "Expired"] },
    async ({ State }) => {
      const pending = State === "Pending";
      const c = comp("", "VERTICAL", { gap: 10, pad: [14, 16], radius: "radius/list", fill: "surface/raised", stroke: "border/default", clip: true });
      fixW(c, 600);
      const head = al("head", "HORIZONTAL", { gap: 8, align: "CENTER" });
      c.appendChild(head);
      head.appendChild(await txt("Wants to run", "Label/Micro", pending ? "text/accent" : "text/tertiary", { name: "label" }));
      head.appendChild(await txt("list_directory", "UI/SM Strong", "text/primary", { name: "skill" }));
      const args = al("args", "VERTICAL", { gap: 4 });
      add(c, args, { fill: true });
      for (const [k, v] of [
        ["path", "~/Documents"],
        ["depth", "1"],
      ]) {
        const row = al("arg", "HORIZONTAL", { gap: 10 });
        add(args, row, { fill: true });
        const dt = await txt(k, "UI/XS", "text/tertiary", { name: "key" });
        row.appendChild(dt);
        dt.resize(64, dt.height);
        dt.textAutoResize = "HEIGHT";
        add(row, await txt(v, "UI/SM", "text/primary", { name: "value" }), { grow: true });
      }
      if (pending) {
        const actions = al("actions", "HORIZONTAL", { gap: 8 });
        actions.layoutWrap = "WRAP";
        actions.counterAxisSpacing = 8;
        add(c, actions, { fill: true });
        for (const label of ["Allow once", "Allow in this chat", "Always allow", "Deny"]) actions.appendChild(use("Approval button", {}, { Label: label }));
      } else {
        const note =
          State === "Answered"
            ? "Allowed — running it now…"
            : "That prompt is no longer waiting — the turn was stopped, or it stood long enough to be refused for you.";
        add(c, await txt(note, "UI/SM", "text/secondary", { name: "note" }), { wrap: true });
      }
      const bar = rect("accent-edge", 2, c.height, pending ? "accent/default" : "border/default");
      absolute(c, bar, 0, 0);
      bar.constraints = { horizontal: "MIN", vertical: "STRETCH" };
      if (!pending) c.opacity = State === "Answered" ? 0.7 : 1;
      return c;
    },
    "SkillApproval.jsx -- the turn is stopped on the server while this is on screen, so it sits in the thread where the waiting is.",
  );
  addText("Message/Approval", "Skill", "list_directory");
  return cs;
}

async function buildAnswer(sec) {
  const c = comp("", "VERTICAL", { gap: 10, pad: [0, 0, 0, 34] });
  fixW(c, 780);
  const prov = use("Message/Provenance");
  prov.name = "provenance";
  prov.isExposedInstance = true;
  c.appendChild(prov);
  const answer = al("answer", "VERTICAL", { gap: 15 });
  add(c, answer, { fill: true });
  for (const [name, inst] of [
    ["reasoning", use("Message/Reasoning", { State: "Folded" })],
    ["approval", use("Message/Approval", { State: "Pending" })],
    ["skill-trace", use("Message/Skill trace", { State: "Done" })],
  ]) {
    inst.name = name;
    inst.isExposedInstance = true;
    add(answer, inst, { fill: true });
  }
  add(answer, await txt("Hello! How can I help you today?", "Body/Prose", "text/primary", { name: "body" }), { wrap: true });
  const disc = dot(22, "accent/default", "answer-disc");
  absolute(c, disc, 0, answer.y + 2);

  single(sec, "Message/Answer", c, "One answer (Message.jsx): provenance, the accent disc, then reasoning, anything blocked on approval, the trace, and the prose.");
  addText("Message/Answer", "Body", "Hello! How can I help you today?");
  addBool("Message/Answer", "Reasoning", true, "reasoning");
  addBool("Message/Answer", "Approval", false, "approval");
  addBool("Message/Answer", "Skill trace", false, "skill-trace");
  addBool("Message/Answer", "Show body", true, "body");
  return c;
}

async function buildStarter(sec) {
  const cs = await variantSet(
    sec,
    "Starter",
    { State: ["Default", "Hover"] },
    async ({ State }) => {
      const hover = State === "Hover";
      const c = comp("", "VERTICAL", { gap: 5, pad: [14, 16], radius: "radius/card", fill: hover ? "surface/plate" : "surface/raised" });
      stroke(c, hover ? "border/strong" : "border/default");
      fixW(c, 385);
      add(c, await txt("Check a time zone", "UI/MD Strong", "text/primary", { name: "title" }), { wrap: true });
      const body = add(c, await txt("What time is it in Tokyo right now, and how far ahead of me is that?", "UI/SM", "text/tertiary", { name: "body" }), {
        wrap: true,
      });
      body.maxLines = 2;
      body.textTruncation = "ENDING";
      return c;
    },
    "Starters.jsx -- an opener written as the sentence that gets sent.",
  );
  addText("Starter", "Title", "Check a time zone");
  addText("Starter", "Body", "What time is it in Tokyo right now, and how far ahead of me is that?");
  return cs;
}

async function buildStartersHead(sec) {
  const c = comp("", "VERTICAL", { gap: 8 });
  fixW(c, 780);
  c.appendChild(markRect(21, 68));
  add(c, await txt("What are we working on?", "Heading/Page", "text/primary", { name: "heading" }), { wrap: true });
  const p = await txt(
    "Everything here runs on your own hardware. Nothing leaves the machine unless you send it to the cloud provider on purpose.",
    "UI/MD Prose",
    "text/secondary",
    { name: "intro" },
  );
  c.appendChild(p);
  p.resize(540, p.height);
  p.textAutoResize = "HEIGHT";
  single(sec, "Starters header", c, "StartersHead -- the one place the mark gets to be itself.");
  return c;
}

async function buildCallout(sec) {
  const cs = await variantSet(
    sec,
    "Callout",
    { Tint: ["Pass", "Warn", "Accent"] },
    async ({ Tint }) => {
      const c = comp("", "HORIZONTAL", { gap: 14, pad: [17, 18], align: "CENTER", radius: "radius/square" });
      c.fills = [paint(Tint === "Pass" ? "surface/pass" : Tint === "Warn" ? "surface/warn" : "surface/wash")];
      fixW(c, 600);
      add(c, await txt("Connected to the local model.", "UI/MD Prose", "text/primary", { name: "text" }), { wrap: true });
      return c;
    },
    ".callout -- a field, not a border.",
  );
  addText("Callout", "Text", "Connected to the local model.");
  return cs;
}

async function buildError(sec) {
  const c = comp("", "HORIZONTAL", { pad: [15, 18], radius: "radius/square", fill: "surface/warn" });
  fixW(c, 600);
  add(c, await txt("The model stopped answering. Try again, or pick another provider.", "UI/MD Prose", "text/primary", { name: "text" }), { wrap: true });
  single(sec, "Message/Error", c, ".turn-error");
  addText("Message/Error", "Text", "The model stopped answering. Try again, or pick another provider.");
  return c;
}

// -- composer -------------------------------------------------------------------

async function buildComposer(sec) {
  const cs = await variantSet(
    sec,
    "Composer",
    { Control: ["Effort", "Switch", "Budget", "None"], State: ["Idle", "Busy"] },
    async ({ Control, State }) => {
      const busy = State === "Busy";
      const c = comp("", "VERTICAL", { gap: 17, pad: [17, 20, 14, 20], radius: "radius/composer", fill: "surface/raised", stroke: "border/composer" });
      fixW(c, 780);
      await c.setEffectStyleIdAsync(ES["Elevation/Composer raised"].id);
      add(c, await txt("Ask me. Task me.", "Body/Input", "text/placeholder", { name: "placeholder" }), { wrap: true });
      const row = al("row", "HORIZONTAL", { gap: 9, align: "CENTER" });
      add(c, row, { fill: true });
      const attach = use("Chip/Icon");
      attach.name = "attach";
      if (busy) attach.opacity = 0.45;
      row.appendChild(attach);
      const chip = use("Chip", { State: "Default" }, { Label: "New conversation" });
      chip.name = "session";
      chip.isExposedInstance = true;
      row.appendChild(chip);
      add(row, spacer(), { grow: true });
      let control = null;
      if (Control === "Effort") control = use("Effort control", { Value: "Medium" });
      if (Control === "Switch") control = use("Chip", { State: "On" }, { Label: "Think first" });
      if (Control === "Budget") control = use("Budget control");
      if (control) {
        control.name = "control";
        if (busy) control.opacity = 0.45;
        row.appendChild(control);
      }
      const send = use("Send button", { State: busy ? "Stop" : "Send" });
      send.name = "send";
      row.appendChild(send);
      return c;
    },
    "Composer.jsx, raised. Withdraws 80% below the sheet's edge until the pointer is within 130px or it has focus; held present on an empty conversation. The control follows what the model takes -- an effort word, a switch, a token budget, or nothing.",
  );
  addText("Composer", "Placeholder", "Ask me. Task me.");
  addBool("Composer", "Session chip", true, "session");
  return cs;
}

async function buildQvButton(sec) {
  const cs = await variantSet(
    sec,
    "QuickView/Round button",
    { Kind: ["Attach", "Send"], State: ["Enabled", "Disabled"] },
    async ({ Kind, State }) => {
      const attach = Kind === "Attach";
      const c = comp("", "HORIZONTAL", { align: "CENTER", justify: "CENTER", radius: "radius/full", fill: attach ? "qv/pill" : "qv/accent" });
      fixed(c, 28, 28);
      if (attach) stroke(c, "qv/edge");
      c.appendChild(icon(attach ? "clip" : "up", 15, attach ? "qv/ink" : "icon/on-accent"));
      if (State === "Disabled") c.opacity = 0.4;
      return c;
    },
    ".qv-round -- QuickView's two buttons. Send is disabled until there is something to send.",
  );
  return cs;
}

async function buildQvComposer(sec) {
  const cs = await variantSet(
    sec,
    "QuickView/Composer",
    { State: ["Empty", "Typed", "Busy"] },
    async ({ State }) => {
      const typed = State === "Typed";
      const c = comp("", "VERTICAL", { gap: 10, pad: [13, 14, 11, 14], radius: "radius/quickview", fill: "qv/composer", stroke: "qv/edge" });
      fixW(c, 552);
      add(c, await txt(typed ? "what's on my calendar tomorrow?" : "Ask me. Task me.", "QuickView/Input", typed ? "qv/ink" : "qv/text-faint", { name: "input" }), {
        wrap: true,
      });
      const row = al("row", "HORIZONTAL", { gap: 8, align: "CENTER" });
      add(c, row, { fill: true });
      row.appendChild(use("QuickView/Round button", { Kind: "Attach", State: "Enabled" }));
      add(row, spacer(), { grow: true });
      const send = use("QuickView/Round button", { Kind: "Send", State: typed ? "Enabled" : "Disabled" });
      send.name = "send";
      row.appendChild(send);
      return c;
    },
    "QuickView's composer. The whole panel when nothing has been said; on a thread it withdraws to a 36px lip.",
  );
  return cs;
}

async function buildQvTurn(sec) {
  const cs = await variantSet(
    sec,
    "QuickView/Turn",
    { Role: ["User", "Assistant"] },
    async ({ Role }) => {
      const user = Role === "User";
      const c = comp("", "HORIZONTAL", { justify: user ? "MAX" : "MIN" });
      fixW(c, 516);
      const t = await txt(
        user ? "what's on my calendar tomorrow?" : "Two things: the dentist at 9:30, and the design review at 2:00.",
        "QuickView/Thread",
        user ? "qv/text-dim" : "qv/ink",
        { name: "content", align: user ? "RIGHT" : "LEFT" },
      );
      if (user) c.appendChild(t);
      else add(c, t, { wrap: true });
      return c;
    },
    ".qv-turn -- no bubbles: your words dimmed on the right, the answer in ink.",
  );
  return cs;
}

async function buildTopBar(sec) {
  const c = comp("", "HORIZONTAL", { gap: 16, pad: [0, 22, 0, 34], align: "CENTER" });
  fixed(c, 928, 64);
  strokeSides(c, "border/soft", { bottom: true });
  c.appendChild(await txt("New conversation", "Heading/Section", "text/primary", { name: "title" }));
  const state = use("State indicator", { Tone: "Accent" });
  state.name = "state";
  state.isExposedInstance = true;
  c.appendChild(state);
  add(c, spacer(), { grow: true });
  const filing = al("filing", "HORIZONTAL", { gap: 16, align: "CENTER" });
  c.appendChild(filing);
  const project = al("project", "HORIZONTAL", { gap: 7, align: "CENTER" });
  filing.appendChild(project);
  project.appendChild(await txt("Project", "Label/Micro", "text/tertiary", { name: "label" }));
  const select = use("Select");
  select.name = "select";
  select.isExposedInstance = true;
  project.appendChild(select);
  const accentBtn = al("accent", "HORIZONTAL", { align: "CENTER", justify: "CENTER", radius: "radius/full" });
  fixed(accentBtn, 34, 34);
  accentBtn.appendChild(use("Accent bead"));
  filing.appendChild(accentBtn);
  const plus = use("Icon button", { State: "Default" });
  plus.name = "new";
  c.appendChild(plus);
  single(sec, "Top bar", c, "TopBar.jsx. Filing and the accent only appear once the conversation has an id -- an unsent chat has nothing to file.");
  addText("Top bar", "Title", "New conversation");
  addBool("Top bar", "Can file", true, "filing");
  return c;
}

// -- utilities ------------------------------------------------------------------

async function buildUtilities(sec) {
  const holder = al("Utilities", "HORIZONTAL", { gap: 40, align: "MIN" });

  const lights = comp("", "HORIZONTAL", { gap: 8 });
  for (const [n, v] of [
    ["close", "utility/close"],
    ["minimise", "utility/minimise"],
    ["zoom", "utility/zoom"],
  ]) {
    const d = dot(12, v, n);
    d.strokes = [paint("alpha/black-14")];
    d.strokeWeight = 0.5;
    lights.appendChild(d);
  }
  single(holder, "Utility/Traffic lights", lights, "macOS window controls, for mockups.");

  const W = 928;
  const H = 820;
  const grid = figma.createComponent();
  grid.resize(W, H);
  grid.fills = [];
  grid.clipsContent = true;
  for (let x = 0; x < W; x += 22) {
    const r = rect("v", 1, H, "grid/line");
    r.x = x;
    r.constraints = { horizontal: "MIN", vertical: "STRETCH" };
    grid.appendChild(r);
  }
  for (let y = 0; y < H; y += 22) {
    const r = rect("h", W, 1, "grid/line");
    r.y = y;
    r.constraints = { horizontal: "STRETCH", vertical: "MIN" };
    grid.appendChild(r);
  }
  single(holder, "Utility/Grid", grid, "The 22px drafting grid under the sheet (.screen background).");

  const wp = figma.createComponent();
  wp.resize(1300, 940);
  wp.clipsContent = true;
  wp.fills = [
    {
      type: "GRADIENT_LINEAR",
      gradientTransform: [
        [0, 1, 0],
        [-1, 0, 1],
      ],
      gradientStops: [
        { position: 0, color: rgba("#eceef7") },
        { position: 1, color: rgba("#d3d6ec") },
      ],
    },
  ];
  for (const [x, y, c1] of [
    [-160, -80, "#b9bde3"],
    [160, -160, "#c9c6e8"],
    [480, -60, "#aeb4e0"],
    [800, -180, "#c4c8ea"],
    [1080, -40, "#b6bbe2"],
  ]) {
    const r = figma.createRectangle();
    r.name = "stroke";
    r.resize(220, 1500);
    r.cornerRadius = 110;
    r.fills = [
      {
        type: "GRADIENT_LINEAR",
        gradientTransform: [
          [0, 1, 0],
          [-1, 0, 1],
        ],
        gradientStops: [
          { position: 0, color: rgba(c1) },
          { position: 1, color: rgba("#eef0f8") },
        ],
      },
    ];
    r.effects = [{ type: "LAYER_BLUR", radius: 30, visible: true }];
    wp.appendChild(r);
    r.x = x;
    r.y = y;
    r.rotation = -18;
    r.constraints = { horizontal: "SCALE", vertical: "SCALE" };
  }
  single(holder, "Utility/Wallpaper", wp, "A stand-in desktop, so glass has something to be glass over. Decorative -- not a token.");
  return holder;
}

async function buildComponents(page) {
  // Utilities first: the rail needs the wallpaper and the aura.
  await family(page, "Utilities", "Canvas helpers the screens are assembled on. Not part of the app.", [], [buildUtilities]);
  await family(
    page,
    "Icons",
    "Seventeen glyphs. Filled Material silhouettes for destinations and files, stroked paths for controls. Instances take an icon colour from the Color collection.",
    ["Swap with the Icon property on any component that has one -- never a variant per icon."],
    [buildIcons],
  );
  await family(
    page,
    "Controls",
    "The small parts every screen is made of. Nearly square (3px) everywhere except the round send and icon buttons.",
    ["Accent is for acting: send, links, the current reasoning step. Buttons are ink.", "Disabled is opacity (0.35–0.45), never a new colour."],
    [buildButton, buildChip, buildChipIcon, buildEffortOption, buildEffortControl, buildBudget, buildSend, buildIconButton, buildSelect, buildBead, buildStateIndicator, buildApprovalButton],
  );
  await family(
    page,
    "Navigation",
    "The sidebar. Pinned it takes 252px beside the sheet; unpinned it takes none and slides in from the window edge.",
    ["The rail wears the app-wide accent; a conversation can wear a different one on the sheet.", "Set the NavRail instance's Color mode independently of its window."],
    [buildNavRow, buildSessionRow, buildNewConversation, buildProvider, buildAura, buildNavRail],
  );
  await family(
    page,
    "Conversation",
    "A turn. The user's words are a plate on the right; an answer is a column of what the model did, then what it said.",
    ["Reasoning, approvals and skill steps share one shape: a marker on a rule.", "Exposed nested instances on Message/Answer let you change states without detaching."],
    [buildUserMessage, buildProvenance, buildReasoning, buildSkillStep, buildSkillTrace, buildApproval, buildAnswer, buildStarter, buildStartersHead, buildCallout, buildError],
  );
  await family(
    page,
    "Composer",
    "Where you type. The main composer's reasoning control changes shape with the model; QuickView's is a composer and nothing else.",
    ["Raised uses Elevation/Composer raised (the accent glow). Withdrawn is a position, not a variant: slide it 80% below the sheet edge."],
    [buildComposer, buildQvButton, buildQvComposer, buildQvTurn],
  );
  await family(page, "Top bar", "The 64px header: the conversation's name, what is answering, and the controls that belong to the thread.", [], [buildTopBar]);
}
