/* Bom UI Sync -- brings the "Bom" page of Design Mockups in line with
 * what client/src actually renders (Sep 2026).
 *
 * Run from Figma desktop: Plugins > Development > Import plugin from manifest,
 * pick docs/figma-sync/manifest.json, then run "Bom UI Sync" with the
 * Design Mockups file open.
 *
 * Non-destructive. It
 *   - retypes the Bom/* text styles to DM Mono (the app is one mono family),
 *   - updates the few variables that drifted and adds the new radii,
 *   - labels the old Screens section, Calendar, Tools and the old rail as legacy,
 *   - builds a fresh "Current UI" section: NavRail/Pinned, Composer/Main and
 *     Composer/QuickView components, two Chat screens and two QuickView screens.
 * Re-running replaces only the "Current UI" section it built last time.
 *
 * code.js is generated from code.template.js by build.sh, which inlines the
 * brush-stroke mark from client/public/bom-mark.png.
 */

const MARK_B64 = "__MARK_B64__";
const PAGE_ID = "145:8";
const SECTION_NAME = "Current UI — Sep 2026";

// -- colour --------------------------------------------------------------------

const hex = (h) => {
  h = h.replace("#", "");
  return {
    r: parseInt(h.slice(0, 2), 16) / 255,
    g: parseInt(h.slice(2, 4), 16) / 255,
    b: parseInt(h.slice(4, 6), 16) / 255,
  };
};
const rgba = (h, a = 1) => Object.assign(hex(h), { a });
const solid = (h, opacity = 1) => ({ type: "SOLID", color: hex(h), opacity });

// styles.css :root, with the sheet's opaque overrides from `.screen`.
const C = {
  ink: "#0f172a",
  faint: "#5f6b7d",
  dim: "#5b677a",
  black: "#14171d",
  line: "#d3dae6",
  lineSoft: "#dce2ec",
  lineFirm: "#c9d2e1",
  lineStrong: "#a9b5c8",
  grid: "#f1f4f9",
  rail: "#f4f6fa",
  green: "#0e7c66",
  white: "#ffffff",
  qvInk: "#0e1420",
  qvAccent: "#4d7dfa",
};

// Two accents as lib/theme.js resolves them for a conversation. The accent is
// per chat (auto from its context), per project, or app-wide -- cobalt in
// :root is only the fallback when nothing has chosen one.
const THEMES = {
  teal: { accent: "#127872", wash: "#e4f0ee", aura1: "#9ddcd3", aura2: "#86cfe0", aura3: "#c4ebd2" },
  violet: { accent: "#7a4fd6", wash: "#eee8f8", aura1: "#cdb8f5", aura2: "#eab3e8", aura3: "#bcc8f7" },
};
// The app-wide accent, which is what the rail and its pin wear.
const APP = THEMES.violet;
// 0.12 + 0.5 * DEFAULT_STRENGTH (0.55)
const AURA_OPACITY = 0.395;

// -- icons (client/public/*.svg and PATHS in Icon.jsx) -------------------------

const ICON = {
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
  settings: {
    d: "M4 8h16M4 16h16M10.5 5.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 1 0 0-4.8M15 13.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 1 0 0-4.8",
  },
  pinned: { d: "M8.5 4h7M12 4v5M7.5 9h9l2 5H5.5l2-5M12 14v6" },
  plus: { d: "M12 5v14M5 12h14" },
  send: { d: "M5 12h14M13 6l6 6-6 6" },
  chevrons: { d: "M8 9.5l4-4 4 4M8 14.5l4 4 4-4" },
  clip: { d: "M21 11.5l-8.6 8.6a5 5 0 01-7-7l8.6-8.6a3.3 3.3 0 014.7 4.7l-8.6 8.6a1.7 1.7 0 01-2.3-2.3l7.9-7.9" },
  up: { d: "M12 19V5M6 11l6-6 6 6" },
};

function icon(name, size, color, opts = {}) {
  const spec = ICON[name];
  const paint = spec.fill
    ? `fill="${color}"`
    : `fill="none" stroke="${color}" stroke-width="${opts.stroke || 1.6}" stroke-linecap="round" stroke-linejoin="round"`;
  const svg = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="${spec.d}" ${paint}/></svg>`;
  const node = figma.createNodeFromSvg(svg);
  node.name = "icon:" + name;
  node.fills = [];
  if (opts.opacity != null) node.opacity = opts.opacity;
  return node;
}

// -- nodes ---------------------------------------------------------------------

// DM Mono at every size -- `--font-mono` in styles.css and `--qv-mono` in
// quickview.css.
function text(str, o = {}) {
  const t = figma.createText();
  t.fontName = { family: "DM Mono", style: o.weight || "Regular" };
  t.characters = o.upper ? str.toUpperCase() : str;
  t.fontSize = o.size || 13.5;
  t.fills = [solid(o.color || C.ink, o.opacity == null ? 1 : o.opacity)];
  if (o.tracking) t.letterSpacing = { unit: "PERCENT", value: o.tracking * 100 };
  if (o.lh) t.lineHeight = { unit: "PERCENT", value: o.lh * 100 };
  if (o.align) t.textAlignHorizontal = o.align;
  t.name = o.name || str.slice(0, 40);
  return t;
}

// `.mi`: 500 9.5px, tracked 0.16em, uppercase.
const label = (str, color = C.faint) =>
  text(str, { size: 9.5, weight: "Medium", upper: true, tracking: 0.16, color, name: "label:" + str });

function frame(name, o = {}, component = false) {
  const f = component ? figma.createComponent() : figma.createFrame();
  f.name = name;
  f.fills = o.fill ? [].concat(o.fill) : [];
  f.clipsContent = !!o.clip;
  if (o.dir) {
    f.layoutMode = o.dir;
    f.primaryAxisSizingMode = "AUTO";
    f.counterAxisSizingMode = "AUTO";
  }
  if (o.gap != null) f.itemSpacing = o.gap;
  if (o.pad) {
    const [t, r, b, l] = o.pad;
    f.paddingTop = t;
    f.paddingRight = r;
    f.paddingBottom = b;
    f.paddingLeft = l;
  }
  if (o.align) f.counterAxisAlignItems = o.align;
  if (o.justify) f.primaryAxisAlignItems = o.justify;
  if (o.radius != null) f.cornerRadius = o.radius;
  if (o.stroke) {
    f.strokes = [o.stroke];
    f.strokeWeight = o.strokeWeight || 1;
    f.strokeAlign = "INSIDE";
  }
  if (o.w != null || o.h != null) f.resize(o.w || 1, o.h || 1);
  return f;
}

// Fixed width, height hugging -- for auto-layout frames.
function fixW(f, w) {
  f.resize(w, Math.max(1, f.height));
  if (f.layoutMode === "VERTICAL") {
    f.counterAxisSizingMode = "FIXED";
    f.primaryAxisSizingMode = "AUTO";
  } else {
    f.primaryAxisSizingMode = "FIXED";
    f.counterAxisSizingMode = "AUTO";
  }
  return f;
}

function fixWH(f, w, h) {
  f.resize(w, h);
  f.primaryAxisSizingMode = "FIXED";
  f.counterAxisSizingMode = "FIXED";
  return f;
}

function add(parent, child, o = {}) {
  parent.appendChild(child);
  if (o.fillW) child.layoutSizingHorizontal = "FILL";
  if (o.grow) child.layoutGrow = 1;
  if (o.wrap && child.type === "TEXT") {
    child.layoutSizingHorizontal = "FILL";
    child.textAutoResize = "HEIGHT";
  }
  return child;
}

function absolute(parent, child, x, y, below = false) {
  if (below) parent.insertChild(0, child);
  else parent.appendChild(child);
  if (parent.layoutMode && parent.layoutMode !== "NONE") child.layoutPositioning = "ABSOLUTE";
  child.x = x;
  child.y = y;
  return child;
}

function spacer() {
  const s = frame("spacer", { w: 1, h: 1 });
  return s;
}

function circle(size, fillHex, name = "dot") {
  const e = figma.createEllipse();
  e.name = name;
  e.resize(size, size);
  e.fills = [solid(fillHex)];
  return e;
}

// One radial disc of the ambient field. Figma's identity transform on a radial
// paint puts the centre in the middle of the node and the edge on its edge, so
// an ellipse sized to the CSS radii reproduces `radial-gradient(rx ry at x y,
// colour, transparent stop)` directly.
function auraDisc(name, colour, cx, cy, rx, ry, stop) {
  const e = figma.createEllipse();
  e.name = name;
  e.resize(rx * 2, ry * 2);
  e.x = cx - rx;
  e.y = cy - ry;
  e.fills = [
    {
      type: "GRADIENT_RADIAL",
      gradientTransform: [
        [1, 0, 0],
        [0, 1, 0],
      ],
      gradientStops: [
        { position: 0, color: rgba(colour, 1) },
        { position: stop, color: rgba(colour, 0) },
      ],
    },
  ];
  return e;
}

const shadow = (colour, a, x, y, radius, spread = 0) => ({
  type: "DROP_SHADOW",
  color: rgba(colour, a),
  offset: { x, y },
  radius,
  spread,
  visible: true,
  blendMode: "NORMAL",
});

const vGradient = (stops) => ({
  type: "GRADIENT_LINEAR",
  gradientTransform: [
    [0, 1, 0],
    [-1, 0, 1],
  ],
  gradientStops: stops.map(([position, h, a]) => ({ position, color: rgba(h, a == null ? 1 : a) })),
});

// -- the sidebar (NavRail.jsx, pinned and open) ---------------------------------

const SESSIONS = ["Untitled", "Cannot Edit Your Loca…", "Comparing Grok Claude…", "Another attempt at ti…", "Untitled"];

function navRow(name, iconName, active) {
  const colour = active ? C.ink : C.faint;
  const row = frame("nav:" + name, { dir: "HORIZONTAL", gap: 10, align: "CENTER", pad: [9, 10, 9, 10], radius: 8 });
  if (active) row.fills = [solid(C.black, 0.07)];
  row.appendChild(icon(iconName, 18, colour));
  row.appendChild(text(name, { size: 13.5, lh: 1.3, weight: active ? "Medium" : "Regular", color: colour, name: "label" }));
  return row;
}

function sessionRow(i, title, active) {
  const row = frame("session:" + i, { dir: "HORIZONTAL", align: "CENTER", pad: [8, 10, 8, 10], radius: 10 });
  if (active) row.fills = [solid(C.black, 0.07)];
  row.appendChild(text(title, { size: 12.5, lh: 1.4, name: "title" }));
  return row;
}

function buildRail(markHash) {
  const W = 252;
  const H = 820;
  const rail = frame("NavRail/Pinned", { dir: "VERTICAL", gap: 28, pad: [22, 10, 18, 10], clip: true }, true);
  fixWH(rail, W, H);
  // Glass over the desktop: no fill of its own, so this stands in for the
  // wallpaper coming through the HudWindow material.
  rail.fills = [vGradient([[0, "#dfe4f8"], [0.55, "#dcdcf4"], [1, "#efe2f1"]])];
  rail.strokes = [solid(C.white, 0.6)];
  rail.strokeAlign = "INSIDE";
  rail.strokeTopWeight = 0;
  rail.strokeBottomWeight = 0;
  rail.strokeLeftWeight = 0;
  rail.strokeRightWeight = 1;

  // `.navrail-inner::before`, inset -10% -40%, at the app accent.
  const aura = frame("aura", { w: W, h: H });
  aura.opacity = 1;
  aura.appendChild(auraDisc("aura-3", APP.aura3, W * 0.5, -0.172 * H, 1.26 * W, 0.312 * H, 0.76));
  aura.appendChild(auraDisc("aura-2", APP.aura2, W * 0.5, 1.196 * H, 1.08 * W, 0.36 * H, 0.74));
  absolute(rail, aura, 0, 0, true);
  aura.locked = true;

  // Head: mark, wordmark, pin.
  const top = frame("top", { dir: "HORIZONTAL", gap: 11, align: "CENTER" });
  add(rail, top, { fillW: true });
  const slot = frame("mark", { w: 24, h: 24 });
  const mark = figma.createRectangle();
  mark.name = "bom-mark";
  mark.resize(9.4, 30);
  mark.fills = markHash ? [{ type: "IMAGE", imageHash: markHash, scaleMode: "FILL" }] : [solid("#2c4fd6")];
  slot.appendChild(mark);
  mark.x = 7.3;
  mark.y = -3;
  top.appendChild(slot);
  add(top, label("Assistant", C.ink), { grow: true });
  const pin = frame("pin", { dir: "HORIZONTAL", align: "CENTER", justify: "CENTER", radius: 8 });
  fixWH(pin, 26, 26);
  pin.appendChild(icon("pinned", 15, APP.accent));
  top.appendChild(pin);

  // Destinations, with the conversation list folded open under Chat.
  const dest = frame("destinations", { dir: "VERTICAL", gap: 10 });
  add(rail, dest, { fillW: true });

  const group = frame("chat-group", { dir: "VERTICAL" });
  add(dest, group, { fillW: true });
  add(group, navRow("Chat", "chat", true), { fillW: true });

  const newConv = frame("new-conversation", { dir: "HORIZONTAL", pad: [9, 10, 11, 10] });
  newConv.appendChild(text("+ New conversation", { size: 13.5, lh: 1.3, color: APP.accent }));
  add(group, newConv, { fillW: true });

  const list = frame("sessions", { dir: "VERTICAL", pad: [6, 0, 2, 0] });
  list.strokes = [solid(C.lineSoft)];
  list.strokeAlign = "INSIDE";
  list.strokeTopWeight = 1;
  list.strokeBottomWeight = 0;
  list.strokeLeftWeight = 0;
  list.strokeRightWeight = 0;
  add(group, list, { fillW: true });
  SESSIONS.forEach((title, i) => add(list, sessionRow(i, title, i === 0), { fillW: true }));

  add(dest, navRow("Projects", "folder", false), { fillW: true });
  add(dest, navRow("Memory", "memory", false), { fillW: true });
  add(dest, navRow("Skills", "skills", false), { fillW: true });
  add(dest, navRow("Settings", "settings", false), { fillW: true });

  add(rail, spacer(), { grow: true });

  // Foot: the provider dot, which is also the model menu.
  const foot = frame("foot", { dir: "HORIZONTAL", gap: 11, align: "CENTER" });
  foot.appendChild(circle(24, C.green, "provider-dot"));
  foot.appendChild(label("gpt-oss:latest"));
  add(rail, foot, { fillW: true });

  rail.description =
    "The sidebar pinned open (NavRail.jsx). Unpinned it takes no width and slides in from the window edge on hover. Glass over the desktop, tinted by the app-wide accent wash.";
  return rail;
}

// -- the composer (Composer.jsx) ----------------------------------------------

function composerEffects(accent) {
  return [
    shadow(C.black, 0.04, 0, 1, 2),
    shadow(C.black, 0.4, 0, 8, 24, -18),
    // The proximity glow, at --near: 1.
    shadow(accent, 0.22, 0, 0, 0, 1),
    shadow(accent, 0.34, 0, 8, 34, -10),
  ];
}

function buildComposer(theme, sessionLabel) {
  const box = frame("Composer/Main", { dir: "VERTICAL", gap: 17, pad: [17, 20, 14, 20], radius: 16, fill: solid(C.white) }, true);
  fixW(box, 780);
  box.strokes = [solid(C.black, 0.14)];
  box.strokeAlign = "INSIDE";
  box.effects = composerEffects(theme.accent);

  add(box, text("Ask me. Task me.", { size: 15, lh: 1.5, color: C.black, opacity: 0.4, name: "placeholder" }), { wrap: true });

  const row = frame("row", { dir: "HORIZONTAL", gap: 9, align: "CENTER" });
  add(box, row, { fillW: true });

  const attach = frame("attach", { dir: "HORIZONTAL", align: "CENTER", pad: [7, 8, 7, 8], radius: 3, stroke: solid(C.lineFirm) });
  attach.appendChild(icon("attachments", 16, C.dim));
  row.appendChild(attach);

  const chip = frame("session-chip", { dir: "HORIZONTAL", align: "CENTER", pad: [8, 12, 8, 12], radius: 3, stroke: solid(C.lineFirm) });
  chip.appendChild(text(sessionLabel, { size: 11.5, color: C.dim, name: "label" }));
  row.appendChild(chip);

  add(row, spacer(), { grow: true });

  const effort = frame("effort", { dir: "HORIZONTAL", gap: 4, align: "CENTER" });
  for (const level of ["low", "medium", "high"]) {
    const on = level === "medium";
    const b = frame("effort:" + level, { dir: "HORIZONTAL", pad: [7, 11, 7, 11], radius: 3 });
    if (on) b.fills = [solid(theme.wash)];
    b.appendChild(text(level, { size: 11.5, color: on ? C.ink : C.black, opacity: on ? 1 : 0.55, name: "label" }));
    effort.appendChild(b);
  }
  row.appendChild(effort);

  const send = frame("send", { dir: "HORIZONTAL", align: "CENTER", justify: "CENTER", radius: 16, fill: solid(theme.accent) });
  fixWH(send, 32, 32);
  send.appendChild(icon("send", 15, C.white, { stroke: 1.8 }));
  row.appendChild(send);

  box.description =
    "Composer.jsx. Withdraws 80% below the sheet's edge until the pointer comes within 130px or it takes focus; held present on an empty conversation. The reasoning control follows the model: effort chips, a switch, a token budget, or nothing.";
  return box;
}

function restyleComposer(inst, theme) {
  inst.effects = composerEffects(theme.accent);
  inst.findOne((n) => n.name === "send").fills = [solid(theme.accent)];
  inst.findOne((n) => n.name === "effort:medium").fills = [solid(theme.wash)];
}

// -- QuickView (quickview.jsx / quickview.css, light scheme) --------------------

function roundButton(name, iconName, fillHex, fillA, iconColour, stroke) {
  const b = frame(name, { dir: "HORIZONTAL", align: "CENTER", justify: "CENTER", radius: 14, fill: solid(fillHex, fillA) });
  fixWH(b, 28, 28);
  if (stroke) {
    b.strokes = [solid(C.black, 0.1)];
    b.strokeAlign = "INSIDE";
  }
  b.appendChild(icon(iconName, 15, iconColour, { stroke: iconName === "up" ? 2 : 1.7 }));
  return b;
}

function buildQvComposer() {
  const box = frame("Composer/QuickView", { dir: "VERTICAL", gap: 10, pad: [13, 14, 11, 14], radius: 18, fill: solid(C.white) }, true);
  fixW(box, 552);
  box.strokes = [solid(C.black, 0.1)];
  box.strokeAlign = "INSIDE";
  add(box, text("Ask me. Task me.", { size: 13, lh: 1.55, color: C.qvInk, opacity: 0.42, name: "placeholder" }), { wrap: true });
  const row = frame("row", { dir: "HORIZONTAL", gap: 8, align: "CENTER" });
  add(box, row, { fillW: true });
  row.appendChild(roundButton("attach", "clip", C.black, 0.06, C.qvInk, true));
  add(row, spacer(), { grow: true });
  const send = roundButton("send", "up", C.qvAccent, 1, C.white, false);
  send.opacity = 0.4; // disabled until there is something to send
  row.appendChild(send);
  box.description =
    "QuickView's composer. The whole panel when nothing has been said; once there is a thread it withdraws to a 36px lip until the pointer approaches.";
  return box;
}

function trafficLights(parent, x, y) {
  const g = frame("traffic-lights", { dir: "HORIZONTAL", gap: 8 });
  for (const h of ["#ff5f57", "#febc2e", "#28c840"]) {
    const d = circle(12, h, "light");
    d.strokes = [solid(C.black, 0.12)];
    d.strokeWeight = 0.5;
    g.appendChild(d);
  }
  parent.appendChild(g);
  g.x = x;
  g.y = y;
  return g;
}

function desktop(name, w, h) {
  const d = frame(name, { w, h, clip: true, fill: vGradient([[0, "#eceef7"], [1, "#d3d6ec"]]) });
  const shapes = [
    [-120, -60, "#b9bde3"],
    [110, -120, "#c9c6e8"],
    [360, -40, "#aeb4e0"],
    [600, -140, "#c4c8ea"],
  ];
  for (const [x, y, colour] of shapes) {
    const r = figma.createRectangle();
    r.name = "wallpaper";
    r.resize(190, h * 1.5);
    r.cornerRadius = 95;
    r.fills = [vGradient([[0, colour], [1, "#eef0f8"]])];
    r.effects = [{ type: "LAYER_BLUR", radius: 28, visible: true }];
    d.appendChild(r);
    r.x = x;
    r.y = y;
    r.rotation = -18;
  }
  return d;
}

function buildQuickView(name, qvComposer, turns) {
  const W = 580;
  const H = 690;
  const scene = desktop(name, 860, 860);

  const win = frame("QuickView window", { w: W, h: H, radius: 14, clip: true });
  win.fills = [vGradient([[0, C.white, 0.5], [1, "#ebe9f7", 0.42]])];
  win.strokes = [solid(C.white, 0.55)];
  win.strokeAlign = "INSIDE";
  win.effects = [{ type: "BACKGROUND_BLUR", radius: 50, visible: true }, shadow("#000000", 0.18, 0, 22, 50)];
  scene.appendChild(win);
  win.x = (860 - W) / 2;
  win.y = (860 - H) / 2;
  trafficLights(win, 14, 12);

  // `#quickview` pads 30 14 14; `.qv` is the rounded box inside that.
  const inst = qvComposer.createInstance();
  const qvW = W - 28;

  if (!turns) {
    const qv = frame("qv", { w: qvW, h: inst.height, radius: 18, clip: true });
    qv.appendChild(inst);
    win.appendChild(qv);
    qv.x = 14;
    qv.y = H - 14 - inst.height;
    return scene;
  }

  const qvH = H - 30 - 14;
  const qv = frame("qv", { w: qvW, h: qvH, radius: 18, clip: true });
  win.appendChild(qv);
  qv.x = 14;
  qv.y = 30;

  const thread = frame("qv-thread", { dir: "VERTICAL", gap: 14 });
  fixW(thread, qvW - 36);
  for (const [role, body] of turns) {
    const user = role === "user";
    const t = text(body, {
      size: 12.5,
      lh: 1.65,
      color: C.qvInk,
      opacity: user ? 0.62 : 1,
      align: user ? "RIGHT" : "LEFT",
      name: role,
    });
    if (user) {
      const wrap = frame("turn:user", { dir: "HORIZONTAL", justify: "MAX" });
      add(thread, wrap, { fillW: true });
      wrap.appendChild(t);
      if (t.width > (qvW - 36) * 0.78) {
        t.resize((qvW - 36) * 0.78, t.height);
        t.textAutoResize = "HEIGHT";
      }
    } else {
      add(thread, t, { wrap: true });
    }
  }
  qv.appendChild(thread);
  thread.x = 18;
  thread.y = 16;

  // Withdrawn: everything below the 36px lip slides off, at 0.82 opacity.
  qv.appendChild(inst);
  inst.x = 0;
  inst.y = qvH - 36;
  inst.opacity = 0.82;
  return scene;
}

// -- the sheet (Chat) -----------------------------------------------------------

function drawGrid(parent, w, h) {
  const g = frame("grid", { w, h });
  for (let x = 0; x < w; x += 22) {
    const r = figma.createRectangle();
    r.resize(1, h);
    r.x = x;
    r.fills = [solid(C.grid)];
    g.appendChild(r);
  }
  for (let y = 0; y < h; y += 22) {
    const r = figma.createRectangle();
    r.resize(w, 1);
    r.y = y;
    r.fills = [solid(C.grid)];
    g.appendChild(r);
  }
  parent.appendChild(g);
  g.locked = true;
}

function drawAura(parent, w, h, theme) {
  // `.screen::before`: inset -30% -20% -35%, three discs.
  const a = frame("aura", { w, h });
  a.opacity = AURA_OPACITY;
  a.appendChild(auraDisc("aura-3", theme.aura3, 0.444 * w, -0.498 * h, 1.232 * w, 1.023 * h, 0.8));
  a.appendChild(auraDisc("aura-1", theme.aura1, 1.088 * w, 1.053 * h, 0.924 * w, 0.858 * h, 0.76));
  a.appendChild(auraDisc("aura-2", theme.aura2, 0.052 * w, 1.416 * h, 1.008 * w, 0.957 * h, 0.78));
  parent.appendChild(a);
  a.locked = true;
}

function topBar(w, title, model, theme) {
  const bar = frame("TopBar", { dir: "HORIZONTAL", gap: 16, align: "CENTER", pad: [0, 22, 0, 34] });
  fixWH(bar, w, 64);
  bar.strokes = [solid(C.lineSoft)];
  bar.strokeAlign = "INSIDE";
  bar.strokeTopWeight = 0;
  bar.strokeLeftWeight = 0;
  bar.strokeRightWeight = 0;
  bar.strokeBottomWeight = 1;

  bar.appendChild(text(title, { size: 19, name: "title" }));

  const state = frame("state", { dir: "HORIZONTAL", gap: 8, align: "CENTER" });
  state.appendChild(circle(7, theme.accent));
  state.appendChild(label(model));
  bar.appendChild(state);

  add(bar, spacer(), { grow: true });

  const project = frame("project", { dir: "HORIZONTAL", gap: 7, align: "CENTER" });
  project.appendChild(label("Project"));
  const select = frame("select", { dir: "HORIZONTAL", gap: 6, align: "CENTER", pad: [5, 6, 5, 8], radius: 3, fill: solid(C.white), stroke: solid(C.line) });
  select.appendChild(text("None", { size: 12.5, lh: 1.2 }));
  select.appendChild(icon("chevrons", 12, C.ink, { stroke: 1.8 }));
  project.appendChild(select);
  bar.appendChild(project);

  const bead = frame("accent", { dir: "HORIZONTAL", align: "CENTER", justify: "CENTER", radius: 17 });
  fixWH(bead, 34, 34);
  const dot = circle(14, theme.accent, "accent-bead");
  dot.strokes = [solid(C.ink, 0.14)];
  dot.strokeAlign = "INSIDE";
  bead.appendChild(dot);
  bar.appendChild(bead);

  const plus = frame("new", { dir: "HORIZONTAL", align: "CENTER", justify: "CENTER", radius: 17 });
  fixWH(plus, 34, 34);
  plus.appendChild(icon("plus", 18, C.ink));
  bar.appendChild(plus);
  return bar;
}

function userTurn(content) {
  const turn = frame("turn-user", { dir: "HORIZONTAL", justify: "MAX" });
  const bubble = frame("bubble", { dir: "HORIZONTAL", pad: [10, 14, 10, 14], radius: 3, fill: solid(C.rail) });
  const t = text(content, { size: 15, lh: 1.65, name: "content" });
  bubble.appendChild(t);
  turn.appendChild(bubble);
  if (t.width > 780 * 0.7 - 28) {
    t.resize(780 * 0.7 - 28, t.height);
    t.textAutoResize = "HEIGHT";
  }
  return turn;
}

// blocks: { p, italic? } | { h } | { ul: [] }
function answerTurn(model, blocks, theme) {
  const turn = frame("turn-answer", { dir: "VERTICAL", gap: 10, pad: [0, 0, 0, 34] });

  const margin = frame("provenance", { dir: "HORIZONTAL", gap: 8, align: "CENTER" });
  margin.appendChild(label("Answered by"));
  margin.appendChild(text(model, { size: 11.5, lh: 1.6, color: C.black, opacity: 0.64 }));
  turn.appendChild(margin);

  const answer = frame("answer", { dir: "VERTICAL", gap: 15 });
  turn.appendChild(answer);

  // Reasoning, folded once the answer began.
  const reasoning = frame("reasoning", { dir: "HORIZONTAL", pad: [0, 0, 0, 22] });
  const hollow = circle(7, C.white, "step");
  hollow.strokes = [solid(C.lineStrong)];
  hollow.strokeWeight = 1.5;
  hollow.strokeAlign = "OUTSIDE";
  reasoning.appendChild(text("Thought before answering", { size: 12.5, lh: 1.5, color: C.faint }));
  answer.appendChild(reasoning);
  absolute(reasoning, hollow, 2, 6);

  const body = frame("body", { dir: "VERTICAL", gap: 14 });
  answer.appendChild(body);
  return { turn, answer, body, fill: () => fillBody(body, blocks) };
}

function fillBody(body, blocks) {
  for (const b of blocks) {
    if (b.h) {
      add(body, text(b.h, { size: 15, lh: 1.72, weight: "Medium", name: "h" }), { wrap: true });
    } else if (b.ul) {
      const ul = frame("ul", { dir: "VERTICAL", gap: 6, pad: [0, 0, 0, 10] });
      add(body, ul, { fillW: true });
      for (const item of b.ul) {
        const li = frame("li", { dir: "HORIZONTAL", gap: 10 });
        add(ul, li, { fillW: true });
        li.appendChild(text("•", { size: 15, lh: 1.72 }));
        add(li, text(item, { size: 15, lh: 1.72, name: "li" }), { wrap: true });
      }
    } else {
      const t = add(body, text(b.p, { size: 15, lh: 1.72, name: "p" }), { wrap: true });
      if (b.italic) {
        const at = b.p.indexOf(b.italic);
        if (at >= 0) t.setRangeFontName(at, at + b.italic.length, { family: "DM Mono", style: "Italic" });
      }
    }
  }
}

function buildChat(name, o) {
  const W = 1180;
  const H = 820;
  const SW = W - 252;
  const screen = frame(name, { w: W, h: H, clip: true, fill: solid(C.white) });

  const rail = o.rail.createInstance();
  screen.appendChild(rail);
  rail.x = 0;
  rail.y = 0;

  const sheet = frame("Sheet", { w: SW, h: H, clip: true, fill: solid(C.white) });
  screen.appendChild(sheet);
  sheet.x = 252;
  sheet.y = 0;
  drawGrid(sheet, SW, H);
  drawAura(sheet, SW, H, o.theme);

  // The composer first, because the thread's reserve depends on how much of
  // it is on screen.
  const composer = o.composer.createInstance();
  if (o.theme !== THEMES.teal) restyleComposer(composer, o.theme);
  const boxH = composer.height;
  const restTop = H - 26 - boxH;
  const tucked = o.withdrawn ? 0.8 * boxH : 0;
  const peek = 16 + boxH + 26 - tucked;

  const messages = frame("messages", { w: SW, h: H - 65, clip: true });
  sheet.appendChild(messages);
  messages.x = 0;
  messages.y = 65;

  const thread = frame("thread", { dir: "VERTICAL", gap: 26 });
  fixW(thread, 780);
  messages.appendChild(thread);
  add(thread, userTurn(o.user), { fillW: true });
  const a = answerTurn(o.model, o.blocks, o.theme);
  add(thread, a.turn, { fillW: true });
  a.answer.layoutSizingHorizontal = "FILL";
  a.body.layoutSizingHorizontal = "FILL";
  a.fill();
  const disc = circle(22, o.theme.accent, "answer-disc");
  absolute(a.turn, disc, 0, a.answer.y + 2);

  thread.x = (SW - 780) / 2;
  const floor = H - 65 - peek - 12;
  thread.y = Math.min(28, floor - thread.height);

  sheet.appendChild(topBar(SW, o.title, o.model.toUpperCase(), o.theme));

  sheet.appendChild(composer);
  composer.x = (SW - 780) / 2;
  composer.y = restTop + tucked;

  // Which conversation is open, in the rail.
  if (o.active != null) {
    for (let i = 0; i < SESSIONS.length; i++) {
      const row = rail.findOne((n) => n.name === "session:" + i);
      if (row) row.fills = i === o.active ? [solid(C.black, 0.07)] : [];
    }
  }
  if (o.firstTitle) {
    const t = rail.findOne((n) => n.name === "session:0").findOne((n) => n.type === "TEXT");
    t.characters = o.firstTitle;
  }
  return screen;
}

// -- file housekeeping -----------------------------------------------------------

async function retypeStyles() {
  const styles = await figma.getLocalTextStylesAsync();
  const changed = [];
  for (const s of styles) {
    if (!s.name.startsWith("Bom/")) continue;
    const heavy = /Bold|Medium|Semi/.test(s.fontName.style);
    s.fontName = { family: "DM Mono", style: heavy ? "Medium" : "Regular" };
    if (!s.name.includes("label/machine")) s.letterSpacing = { unit: "PERCENT", value: 0 };
    changed.push(s.name);
  }
  return changed;
}

async function syncVariables() {
  const cols = await figma.variables.getLocalVariableCollectionsAsync();
  const col = cols.find((c) => c.name === "Bom");
  if (!col) return "no Bom collection";
  const mode = col.modes[0].modeId;
  const vars = [];
  for (const id of col.variableIds) vars.push(await figma.variables.getVariableByIdAsync(id));
  const byName = (n) => vars.find((v) => v && v.name === n);

  const ink = byName("Color/text/ink");
  if (ink) ink.setValueForMode(mode, rgba(C.ink));

  const accent = byName("Color/accent/base");
  if (accent) {
    accent.description =
      "Fallback only. The live accent is per conversation (auto from its context), per project, or app-wide -- lib/theme.js derives the whole palette and the aura from it.";
  }

  const railW = byName("Dimension/layout/rail-w");
  if (railW) {
    railW.setValueForMode(mode, 0);
    railW.description = "0 while unpinned: the rail is off-canvas and slides in from the window edge. Pinned it takes Dimension/layout/rail-open.";
  }

  const ensure = (name, type, value, scopes, description) => {
    let v = byName(name);
    if (!v) v = figma.variables.createVariable(name, col, type);
    v.setValueForMode(mode, value);
    v.scopes = scopes;
    if (description) v.description = description;
  };
  ensure("Dimension/radius/composer", "FLOAT", 16, ["CORNER_RADIUS"], "The composer box. The one rounded surface on the sheet.");
  ensure("Dimension/radius/quickview", "FLOAT", 18, ["CORNER_RADIUS"], "QuickView panel and its composer (--qv-radius).");
  ensure("Color/accent/quickview", "COLOR", rgba(C.qvAccent), ["FRAME_FILL", "SHAPE_FILL", "STROKE_COLOR"], "--qv-accent: QuickView's send button.");
  return "ok";
}

async function markLegacy() {
  const rename = async (id, suffix) => {
    const n = await figma.getNodeByIdAsync(id);
    if (n && !n.name.includes(suffix)) n.name = n.name + " " + suffix;
  };
  await rename("148:27", "(legacy — see “" + SECTION_NAME + "”)");
  await rename("157:11", "(removed from app)");
  await rename("145:140", "(removed from app)");
  await rename("264:148", "(legacy)");
}

// -- run ------------------------------------------------------------------------

async function main() {
  const page = await figma.getNodeByIdAsync(PAGE_ID);
  await figma.setCurrentPageAsync(page);

  await Promise.all(
    ["Regular", "Medium", "Italic"].map((style) => figma.loadFontAsync({ family: "DM Mono", style })),
  );

  const styles = await retypeStyles();
  const vars = await syncVariables();
  await markLegacy();

  // Replace our own section from a previous run, and nothing else.
  for (const old of page.children.filter((n) => n.type === "SECTION" && n.name === SECTION_NAME)) old.remove();

  let markHash = null;
  try {
    markHash = figma.createImage(figma.base64Decode(MARK_B64)).hash;
  } catch (e) {
    markHash = null;
  }

  const section = figma.createSection();
  section.name = SECTION_NAME;
  page.appendChild(section);
  section.x = 0;
  section.y = 6300;
  section.resizeWithoutConstraints(4520, 2080);

  const place = (node, x, y) => {
    section.appendChild(node);
    node.x = x;
    node.y = y;
    return node;
  };
  const caption = (str, x, y, size = 12.5, color = C.dim) => place(text(str, { size, color }), x, y);

  caption("Bom — current UI", 80, 56, 27, C.ink);
  caption("Synced from client/src on 12 Sep 2026. DM Mono everywhere; accent is per conversation; Calendar and Tools are gone.", 80, 100);

  // Components.
  caption("COMPONENTS", 80, 170, 9.5, C.faint);
  const rail = place(buildRail(markHash), 80, 200);
  const composer = place(buildComposer(THEMES.teal, "New conversation"), 400, 200);
  const qvComposer = place(buildQvComposer(), 400, 380);

  const notes = [
    "What changed since the legacy screens",
    "",
    "• One family: DM Mono at every size, 400 for text, 500 for labels and emphasis.",
    "• Sidebar: icon-only rail replaced by an open panel — mark + ASSISTANT + pin, Chat with",
    "  its conversation list folded underneath, then Projects, Memory, Skills, Settings, and",
    "  the provider dot with the model name at the foot. Unpinned it takes no width and slides",
    "  in from the window edge. Calendar and Tools destinations are removed.",
    "• Accent: chosen per chat (auto from context), per project, or app-wide. It drives the",
    "  send button, the answer disc, the state dot and a three-disc aura behind the sheet.",
    "  Cobalt survives only as the no-accent fallback.",
    "• Top bar: title, state dot + model, PROJECT select, accent bead, new conversation.",
    "• Answers: ANSWERED BY <model> above, the accent disc, a 'Thought before answering'",
    "  step, then the prose. Skill traces and approvals sit in the same column.",
    "• Composer: 16px-radius box, attach chip, session chip, effort chips (or a switch /",
    "  token budget / nothing, depending on the model), round send that becomes stop.",
    "  It withdraws 80% off the edge until the pointer approaches.",
    "• QuickView: a 36px-lip composer on frosted glass; empty it is only the composer.",
  ].join("\n");
  const n = text(notes, { size: 12.5, lh: 1.6, color: C.ink, name: "notes" });
  place(n, 1240, 200);

  // Screens.
  caption("CHAT — composer raised (focused / pointer near)", 80, 1090, 9.5, C.faint);
  place(
    buildChat("Chat — thread", {
      rail,
      composer,
      theme: THEMES.teal,
      title: "New conversation",
      model: "gpt-oss:latest",
      user: "hello",
      blocks: [{ p: "Hello! How can I help you today?" }],
      active: 0,
    }),
    80,
    1120,
  );

  caption("CHAT — composer withdrawn while reading, violet accent", 1340, 1090, 9.5, C.faint);
  place(
    buildChat("Chat — long answer", {
      rail,
      composer,
      theme: THEMES.violet,
      withdrawn: true,
      title: "Cannot Edit Your Local Code",
      model: "gpt-oss:latest",
      user: "can you edit code on my computer?",
      blocks: [
        { p: "No — I can't write or edit files on your computer directly. Here's the honest breakdown of what I can and can't do:" },
        { h: "What I can do:" },
        {
          ul: [
            "Read files from your folders (I can list directories and read text files to see your code)",
            "Search for files by name",
            "Search your past conversation history",
            "Control a web browser (for web-based code editors like GitHub, GitLab, or online IDEs)",
            "Look up documentation for libraries/frameworks",
          ],
        },
        { h: "What I can't do:" },
        { ul: ["Modify, save, or delete files on your local machine", "Run your code or tests for you"] },
        {
          p: "So I could open a code file, read it, and tell you exactly what to change — but the actual editing you'd have to do yourself, unless it's in a web-based editor I can reach through the browser.",
          italic: "tell you exactly what to change",
        },
        { p: "What are you working on? If you point me at the file, I can read it and walk you through the fix." },
      ],
      active: 1,
      firstTitle: "User says hello",
    }),
    1340,
    1120,
  );

  caption("QUICKVIEW — summoned, empty", 2600, 1090, 9.5, C.faint);
  place(buildQuickView("QuickView — empty", qvComposer, null), 2600, 1120);

  caption("QUICKVIEW — conversation, composer withdrawn to its lip", 3540, 1090, 9.5, C.faint);
  place(
    buildQuickView("QuickView — conversation", qvComposer, [
      ["user", "what's on my calendar tomorrow?"],
      ["assistant", "Two things: the dentist at 9:30, and the design review at 2:00. Nothing after 4."],
      ["user", "move the review to 3"],
      ["assistant", "Done — the design review is now 3:00–4:00 tomorrow."],
    ]),
    3540,
    1120,
  );

  figma.viewport.scrollAndZoomIntoView([section]);
  return `Bom UI synced: ${styles.length} text styles retyped, variables ${vars}, section “${SECTION_NAME}” built.`;
}

main()
  .then((message) => figma.closePlugin(message))
  .catch((error) => figma.closePlugin("Bom UI Sync failed: " + (error && error.message ? error.message : error)));
