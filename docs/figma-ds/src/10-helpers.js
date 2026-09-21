/* Shared state and the small vocabulary every builder is written in.
 *
 * Every colour, padding, gap and radius a builder sets goes through `paint`,
 * `pad`, `gap` or `radius`, which bind to a variable rather than writing a
 * number -- so a component follows the tokens, and switching a frame's Color
 * mode re-themes everything inside it the way `theme.js` re-themes the app. */

const V = {}; // variable name -> Variable
const TS = {}; // text style name -> TextStyle
const ES = {}; // effect style name -> EffectStyle
const REG = {}; // component name -> { node, props: { Label: "Label#1:2" } }
const NOTES = []; // anything the run had to degrade, reported on the cover
let MODES = []; // [{ key, id, name }] for the Color collection
let COLOR_COLL = null;
let MARK = null; // image hash of the brush-stroke mark

const hex = (h) => {
  h = h.replace("#", "");
  return {
    r: parseInt(h.slice(0, 2), 16) / 255,
    g: parseInt(h.slice(2, 4), 16) / 255,
    b: parseInt(h.slice(4, 6), 16) / 255,
  };
};
const rgba = (h, a = 1) => Object.assign(hex(h), { a });
const rawSolid = (h, opacity = 1) => ({ type: "SOLID", color: hex(h), opacity });

function paint(name) {
  const v = V[name];
  if (!v) throw new Error("No variable " + name);
  return figma.variables.setBoundVariableForPaint({ type: "SOLID", color: { r: 0, g: 0, b: 0 } }, "color", v);
}

function bindNum(node, field, value, prefix = "space/") {
  if (value === 0) {
    node[field] = 0;
    return;
  }
  const v = V[prefix + value];
  if (v) node.setBoundVariable(field, v);
  else node[field] = value;
}

function pad(node, p) {
  const [t, r, b, l] = p.length === 2 ? [p[0], p[1], p[0], p[1]] : p;
  bindNum(node, "paddingTop", t);
  bindNum(node, "paddingRight", r);
  bindNum(node, "paddingBottom", b);
  bindNum(node, "paddingLeft", l);
}

function radius(node, token) {
  if (typeof token === "number") {
    node.cornerRadius = token;
    return;
  }
  const v = V[token];
  if (!v) throw new Error("No radius " + token);
  for (const f of ["topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius"]) node.setBoundVariable(f, v);
}

function stroke(node, name, weight = 1) {
  node.strokes = [paint(name)];
  node.strokeAlign = "INSIDE";
  node.strokeWeight = weight;
}

function strokeSides(node, name, sides, weight = 1) {
  node.strokes = [paint(name)];
  node.strokeAlign = "INSIDE";
  node.strokeTopWeight = sides.top ? weight : 0;
  node.strokeRightWeight = sides.right ? weight : 0;
  node.strokeBottomWeight = sides.bottom ? weight : 0;
  node.strokeLeftWeight = sides.left ? weight : 0;
}

// An auto-layout frame (or component) with bound spacing.
function al(name, dir, o = {}, component = false) {
  const f = component ? figma.createComponent() : figma.createFrame();
  f.name = name;
  f.fills = [];
  f.clipsContent = !!o.clip;
  if (dir) {
    f.layoutMode = dir;
    f.primaryAxisSizingMode = "AUTO";
    f.counterAxisSizingMode = "AUTO";
  }
  if (o.gap != null) bindNum(f, "itemSpacing", o.gap);
  if (o.pad) pad(f, o.pad);
  if (o.align) f.counterAxisAlignItems = o.align;
  if (o.justify) f.primaryAxisAlignItems = o.justify;
  if (o.fill) f.fills = [paint(o.fill)];
  if (o.stroke) stroke(f, o.stroke, o.strokeWeight || 1);
  if (o.radius != null) radius(f, o.radius);
  return f;
}
const comp = (name, dir, o) => al(name, dir, o, true);

function fixed(f, w, h) {
  f.resize(w, h);
  if (f.layoutMode && f.layoutMode !== "NONE") {
    f.primaryAxisSizingMode = "FIXED";
    f.counterAxisSizingMode = "FIXED";
  }
  return f;
}

// Fixed width, height hugging.
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

function add(parent, child, o = {}) {
  parent.appendChild(child);
  if (o.fill) child.layoutSizingHorizontal = "FILL";
  if (o.grow) child.layoutGrow = 1;
  if (o.wrap) {
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
  const s = figma.createFrame();
  s.name = "spacer";
  s.fills = [];
  s.resize(1, 1);
  return s;
}

function dot(size, fillVar, name = "dot") {
  const e = figma.createEllipse();
  e.name = name;
  e.resize(size, size);
  e.fills = [paint(fillVar)];
  return e;
}

function rect(name, w, h, fillVar) {
  const r = figma.createRectangle();
  r.name = name;
  r.resize(w, h);
  if (fillVar) r.fills = [paint(fillVar)];
  return r;
}

function markRect(w, h) {
  const r = figma.createRectangle();
  r.name = "bom-mark";
  r.resize(w, h);
  r.fills = MARK ? [{ type: "IMAGE", imageHash: MARK, scaleMode: "FIT" }] : [rawSolid("#2c4fd6")];
  return r;
}

async function txt(str, style, colour, o = {}) {
  const t = figma.createText();
  const st = TS[style];
  if (!st) throw new Error("No text style " + style);
  t.fontName = st.fontName;
  t.characters = str;
  await t.setTextStyleIdAsync(st.id);
  t.fills = [paint(colour)];
  t.name = o.name || "text";
  if (o.align) t.textAlignHorizontal = o.align;
  return t;
}

function recolour(node, colour) {
  node.findAll((n) => n.type === "VECTOR").forEach((v) => {
    if (v.fills.length) v.fills = [paint(colour)];
    if (v.strokes.length) v.strokes = [paint(colour)];
  });
}

function icon(name, size, colour) {
  const entry = REG["Icon/" + name];
  if (!entry) throw new Error("No icon " + name);
  const inst = entry.node.createInstance();
  inst.name = "icon";
  inst.resize(size, size);
  if (colour) recolour(inst, colour);
  return inst;
}

// An instance of a registered component, with variant and named properties.
function use(name, variant = {}, props = {}) {
  const r = REG[name];
  if (!r) throw new Error("No component " + name);
  const main = r.node.type === "COMPONENT_SET" ? r.node.defaultVariant : r.node;
  const inst = main.createInstance();
  const set = Object.assign({}, variant);
  for (const [k, v] of Object.entries(props)) {
    const key = r.props[k];
    if (!key) throw new Error(`${name} has no property ${k}`);
    set[key] = v;
  }
  if (Object.keys(set).length) inst.setProperties(set);
  return inst;
}

// Visit a component's own layers -- never inside a nested instance, whose
// layers belong to another component and cannot carry this one's properties.
function walkOwn(node, fn) {
  fn(node);
  if (node.type === "INSTANCE") return;
  if ("children" in node) for (const c of node.children) walkOwn(c, fn);
}

function targets(name) {
  const r = REG[name];
  return r.node.type === "COMPONENT_SET" ? r.node.children : [r.node];
}

function linkProp(name, label, type, def, nodeName, field) {
  const r = REG[name];
  const key = r.node.addComponentProperty(label, type, def);
  r.props[label] = key;
  for (const v of targets(name)) {
    walkOwn(v, (n) => {
      if (n === v || n.name !== nodeName) return;
      if (type === "TEXT" && n.type !== "TEXT") return;
      if (type === "INSTANCE_SWAP" && n.type !== "INSTANCE") return;
      n.componentPropertyReferences = Object.assign({}, n.componentPropertyReferences || {}, { [field]: key });
    });
  }
  return key;
}
const addText = (name, label, def, nodeName) => linkProp(name, label, "TEXT", def, nodeName || label.toLowerCase(), "characters");
const addBool = (name, label, def, nodeName) => linkProp(name, label, "BOOLEAN", def, nodeName, "visible");
function addSwap(name, label, defIcon, nodeName = "icon") {
  const key = linkProp(name, label, "INSTANCE_SWAP", REG["Icon/" + defIcon].node.id, nodeName, "mainComponent");
  try {
    REG[name].node.editComponentProperty(key, {
      preferredValues: Object.keys(REG)
        .filter((k) => k.startsWith("Icon/"))
        .map((k) => ({ type: "COMPONENT", key: REG[k].node.key })),
    });
  } catch (e) {
    // Preferred values are a convenience; the swap works without them.
  }
  return key;
}

const parseVariant = (name) => Object.fromEntries(name.split(", ").map((p) => p.split("=")));

// Build every combination, combine, and lay the set out as a grid: the last
// axis runs across, the others down.
async function variantSet(parent, name, axes, build, description) {
  const keys = Object.keys(axes);
  let combos = [{}];
  for (const k of keys) combos = combos.flatMap((c) => axes[k].map((v) => Object.assign({}, c, { [k]: v })));
  const comps = [];
  for (const combo of combos) {
    const c = await build(combo);
    c.name = keys.map((k) => `${k}=${combo[k]}`).join(", ");
    comps.push(c);
  }
  const cs = figma.combineAsVariants(comps, parent);
  cs.name = name;
  if (description) cs.description = description;

  const GAP = 24;
  const PAD = 32;
  const colKey = keys[keys.length - 1];
  const rowKeys = keys.slice(0, -1);
  const colOf = (c) => axes[colKey].indexOf(parseVariant(c.name)[colKey]);
  const rowOf = (c) => {
    const p = parseVariant(c.name);
    let i = 0;
    for (const k of rowKeys) i = i * axes[k].length + axes[k].indexOf(p[k]);
    return i;
  };
  const cols = axes[colKey].length;
  const rows = rowKeys.reduce((n, k) => n * axes[k].length, 1);
  const colW = new Array(cols).fill(0);
  const rowH = new Array(rows).fill(0);
  for (const c of cs.children) {
    colW[colOf(c)] = Math.max(colW[colOf(c)], c.width);
    rowH[rowOf(c)] = Math.max(rowH[rowOf(c)], c.height);
  }
  const colX = [];
  const rowY = [];
  let acc = PAD;
  for (let i = 0; i < cols; i++) {
    colX.push(acc);
    acc += colW[i] + GAP;
  }
  acc = PAD;
  for (let j = 0; j < rows; j++) {
    rowY.push(acc);
    acc += rowH[j] + GAP;
  }
  for (const c of cs.children) {
    c.x = colX[colOf(c)];
    c.y = rowY[rowOf(c)];
  }
  let maxX = 0;
  let maxY = 0;
  for (const c of cs.children) {
    maxX = Math.max(maxX, c.x + c.width);
    maxY = Math.max(maxY, c.y + c.height);
  }
  cs.resizeWithoutConstraints(maxX + PAD, maxY + PAD);
  cs.fills = [rawSolid("#f7f8fb")];
  cs.strokes = [rawSolid("#9747ff")];
  cs.dashPattern = [6, 4];
  cs.cornerRadius = 8;

  REG[name] = { node: cs, props: {} };
  return cs;
}

function single(parent, name, component, description) {
  component.name = name;
  parent.appendChild(component);
  if (description) component.description = description;
  REG[name] = { node: component, props: {} };
  return component;
}

function setMode(node, key) {
  if (!COLOR_COLL) return;
  const m = MODES.find((x) => x.key === key);
  if (!m) return;
  try {
    node.setExplicitVariableModeForCollection(COLOR_COLL, m.id);
  } catch (e) {
    node.setExplicitVariableModeForCollection(COLOR_COLL.id, m.id);
  }
}

// Sections stack down each page.
const PAGE_Y = new Map();
function nextY(page, h) {
  const y = PAGE_Y.get(page.id) || 0;
  PAGE_Y.set(page.id, y + h + 200);
  return y;
}

async function docFrame(title, description, notes = []) {
  const d = al(title + " / Documentation", "VERTICAL", { gap: 14 });
  fixW(d, 380);
  add(d, await txt(title, "Heading/Page", "text/primary", { name: "title" }), { wrap: true });
  add(d, await txt(description, "UI/MD Prose", "text/secondary", { name: "description" }), { wrap: true });
  for (const n of notes) add(d, await txt("• " + n, "UI/SM", "text/tertiary", { name: "note" }), { wrap: true });
  return d;
}

// One section per family: documentation on the left, components to its right.
async function family(page, title, description, notes, builders) {
  const sec = figma.createSection();
  sec.name = title;
  page.appendChild(sec);
  const doc = await docFrame(title, description, notes);
  sec.appendChild(doc);
  doc.x = 48;
  doc.y = 72;
  let y = 72;
  let right = 0;
  for (const build of builders) {
    const node = await build(sec);
    if (node.parent !== sec) sec.appendChild(node);
    node.x = 500;
    node.y = y;
    y += node.height + 72;
    right = Math.max(right, node.x + node.width);
  }
  const h = Math.max(y, doc.y + doc.height + 72);
  sec.resizeWithoutConstraints(Math.max(right + 72, 1200), h);
  sec.x = 0;
  sec.y = nextY(page, h);
  return sec;
}
