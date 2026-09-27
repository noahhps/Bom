/* Wireframes: one model of a screen, drawn four ways.
 *
 * A wireframe is frames of layers (see server/app/skills/wireframe.py). Every
 * layer -- a rectangle, a line of text, or a component like a button or a nav
 * bar -- is expanded here into a handful of **nodes**: boxes, ellipses, lines,
 * text and images, positioned inside the layer. Everything downstream draws
 * nodes, never layers, which is what keeps the four outputs identical:
 *
 *   - the editor and the slide "board" layout render them as HTML + CSS;
 *   - the HTML + CSS export renders them the same way, with classes and a
 *     stylesheet instead of inline styles, and real <button>/<input>/<img>;
 *   - PNG and PDF draw them on a <canvas>. Not by rasterising the HTML: the
 *     usual trick (an SVG foreignObject drawn to a canvas) taints the canvas in
 *     WebKit -- the webview Bom runs in on a Mac -- so it could never be read
 *     back. Drawing the same nodes directly works everywhere.
 *
 * Everything that reaches markup is escaped or validated here: text is
 * escaped, colours must look like colours, numbers must be numbers, and an
 * image is only ever an address the caller resolved from the library.
 */

import { cleanTheme, inkOn, resolveTheme } from "./slides.js";

export const LAYER_TYPES = [
  "rect", "ellipse", "line", "text", "image", "button", "input", "checkbox",
  "toggle", "avatar", "icon", "nav", "card", "lines",
];

export const FRAME_PRESETS = [
  { id: "iphone", name: "iPhone 15", w: 393, h: 852 },
  { id: "android", name: "Android", w: 360, h: 800 },
  { id: "tablet", name: "iPad", w: 834, h: 1194 },
  { id: "laptop", name: "Laptop", w: 1280, h: 832 },
  { id: "desktop", name: "Desktop", w: 1440, h: 1024 },
  { id: "slide", name: "Slide 16:9", w: 1280, h: 720 },
];

const COLOUR = /^(#[0-9a-fA-F]{3,8}|(?:rgb|rgba|hsl|hsla)\([0-9.,%\s/+-]{3,60}\)|[a-zA-Z]{3,24}|transparent)$/;
const FONT = /^[\w\s,'"-]{1,160}$/;

const colour = (value, fallback) => {
  const text = String(value ?? "").trim();
  return text && COLOUR.test(text) ? text : fallback;
};
const num = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

/* The greyscale kit a wireframe is drawn in: the look of every wireframing
   tool, which says "structure, not styling" at a glance. */
const WIRE = {
  bg: "#FFFFFF",
  surface: "#F0F0F0",
  line: "#C7C7C7",
  strong: "#9B9B9B",
  text: "#242424",
  muted: "#8A8A8A",
  accent: "#4A4A4A",
  onAccent: "#FFFFFF",
  radius: 6,
  head: "Inter, 'Helvetica Neue', Arial, system-ui, sans-serif",
  body: "Inter, 'Helvetica Neue', Arial, system-ui, sans-serif",
  mono: "'IBM Plex Mono', ui-monospace, Menlo, monospace",
  headWeight: 700,
  headCase: "none",
};

/** The colours and faces a document draws in: greyscale, or its standard. */
export function palette(doc, fallbackTheme) {
  if (doc?.fidelity !== "styled") return WIRE;
  const t = resolveTheme(doc.theme, fallbackTheme);
  return {
    bg: t.background,
    surface: t.surface,
    line: t.line,
    strong: t.muted,
    text: t.text,
    muted: t.muted,
    accent: t.accent,
    onAccent: inkOn(t.accent),
    radius: t.radius,
    head: t.heading_font,
    body: t.body_font,
    mono: WIRE.mono,
    headWeight: t.heading_weight,
    headCase: t.heading_case === "upper" ? "uppercase" : "none",
  };
}

/* -- the document ------------------------------------------------------------ */

let counter = 0;
/** A fresh id for a layer or a frame, unique within a session of editing. */
export const newId = (prefix) =>
  `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}`;

/** One frame, with every number a number and every layer a known type. */
export function cleanFrame(f, i = 0) {
  return {
    id: String(f.id || `f${i + 1}`),
    name: String(f.name || `Frame ${i + 1}`).slice(0, 80),
    x: num(f.x, i * 520),
    y: num(f.y, 0),
    w: Math.max(40, num(f.w, 393)),
    h: Math.max(40, num(f.h, 852)),
    ...(f.fill ? { fill: String(f.fill) } : null),
    layers: (Array.isArray(f.layers) ? f.layers : [])
      .filter((l) => l && typeof l === "object")
      .map((l, n) => ({
        ...l,
        id: String(l.id || `${f.id || i}_l${n}`),
        type: LAYER_TYPES.includes(l.type) ? l.type : "rect",
        x: num(l.x),
        y: num(l.y),
        w: Math.max(1, num(l.w, 100)),
        h: Math.max(1, num(l.h, 40)),
        ...(l.text != null ? { text: String(l.text) } : null),
      })),
  };
}

/** A stored wireframe, cleaned, or null when the text is not one. */
export function parseWireframe(content) {
  let data;
  try {
    data = JSON.parse(content || "");
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || !Array.isArray(data.frames)) return null;
  const frames = data.frames.filter((f) => f && typeof f === "object").map(cleanFrame);
  return {
    version: 1,
    fidelity: data.fidelity === "styled" ? "styled" : "wireframe",
    theme: cleanTheme(data.theme || {}),
    frames,
  };
}

export const serializeWireframe = (doc) => JSON.stringify(doc);

export function blankWireframe() {
  return {
    version: 1,
    fidelity: "wireframe",
    theme: {},
    frames: [
      {
        id: "f1",
        name: "iPhone 15",
        x: 0,
        y: 0,
        w: 393,
        h: 852,
        layers: [
          { id: "f1_l1", type: "nav", x: 0, y: 0, w: 393, h: 64, text: "App", items: ["Menu"] },
          { id: "f1_l2", type: "text", x: 24, y: 96, w: 345, h: 49, text: "Screen title", size: 36, weight: 700, font: "heading" },
          { id: "f1_l3", type: "lines", x: 24, y: 164, w: 345, h: 44, count: 3 },
          { id: "f1_l4", type: "button", x: 24, y: 760, w: 345, h: 48, text: "Continue", variant: "primary" },
        ],
      },
    ],
  };
}

/** What a new layer of each type starts as, drawn at a point in a frame. */
export function newLayer(type, x, y, w, h) {
  const base = { id: newId("l"), type, x: Math.round(x), y: Math.round(y) };
  const sized = (dw, dh, extra = {}) => ({ ...base, w: Math.round(w || dw), h: Math.round(h || dh), ...extra });
  switch (type) {
    case "text": return sized(200, 24, { text: "Text", size: 16 });
    case "button": return sized(160, 48, { text: "Button", variant: "primary" });
    case "input": return sized(280, 48, { text: "Placeholder" });
    case "checkbox": return sized(200, 28, { text: "Remember me" });
    case "toggle": return sized(200, 28, { text: "Notifications", checked: true });
    case "avatar": return sized(48, 48, { text: "AB" });
    case "icon": return sized(24, 24, { icon: "star" });
    case "nav": return sized(393, 64, { text: "Brand", items: ["Home", "About"] });
    case "card": return sized(280, 220, { text: "Card title" });
    case "lines": return sized(280, 44, { count: 3 });
    case "image": return sized(280, 160);
    case "ellipse": return sized(80, 80);
    case "line": return sized(200, 1);
    default: return sized(160, 100);
  }
}

/** Every library image id a document or a frame uses. */
export function wireframeImageIds(docOrFrame) {
  const frames = docOrFrame?.frames || (docOrFrame ? [docOrFrame] : []);
  const ids = new Set();
  for (const frame of frames) {
    for (const layer of frame.layers || []) {
      if (/^img_[A-Za-z0-9]+$/.test(layer.image || "")) ids.add(layer.image);
    }
  }
  return [...ids];
}

/* -- layers into nodes --------------------------------------------------------- */

const ICONS = {
  menu: "☰", search: "⌕", heart: "♥", star: "★", user: "◉", bell: "◔", cart: "⊕",
  home: "⌂", settings: "⚙", close: "✕", plus: "+", arrow: "→", back: "←", check: "✓",
  mail: "✉", play: "▶", share: "⤴", more: "⋯", filter: "⧩", calendar: "▦",
};

const textNode = (x, y, w, h, text, P, opts = {}) => ({
  k: "text",
  x, y, w, h,
  text: String(text ?? ""),
  size: opts.size ?? 16,
  weight: opts.weight ?? 400,
  color: opts.color ?? P.text,
  align: opts.align ?? "left",
  valign: opts.valign ?? "top",
  font: opts.font ?? P.body,
  lh: opts.lh ?? 1.35,
  pad: opts.pad ?? 0,
  upper: Boolean(opts.upper),
  tag: opts.tag,
});

/**
 * A layer as nodes, in the layer's own coordinates (0,0 at its top-left).
 * The one place each component's look is decided.
 */
export function expand(layer, P) {
  const w = Math.max(1, num(layer.w, 1));
  const h = Math.max(1, num(layer.h, 1));
  const r = layer.radius != null ? Math.max(0, num(layer.radius)) : null;
  const fill = (fallback) => colour(layer.fill, fallback);
  const stroke = (fallback) => (layer.stroke === "none" ? null : colour(layer.stroke, fallback));
  const sw = layer.strokeWidth != null ? Math.max(0, num(layer.strokeWidth)) : 1;
  const text = layer.text ?? "";
  switch (layer.type) {
    case "ellipse":
      return [{ k: "ellipse", x: 0, y: 0, w, h, fill: fill(P.surface), stroke: stroke(P.line), sw }];
    case "line":
      return [{ k: "line", x1: 0, y1: 0, x2: w, y2: h <= 2 ? 0 : h, stroke: colour(layer.stroke, P.strong), sw: Math.max(1, sw) }];
    case "text": {
      const heading = layer.font === "heading";
      return [
        textNode(0, 0, w, h, text, P, {
          size: num(layer.size, 16),
          weight: num(layer.weight, heading ? P.headWeight : 400),
          color: colour(layer.color, P.text),
          align: layer.align,
          font: heading ? P.head : layer.font === "mono" ? P.mono : P.body,
          upper: heading && P.headCase === "uppercase",
          tag: num(layer.size, 16) >= 30 ? "h1" : num(layer.size, 16) >= 21 ? "h2" : "p",
        }),
      ];
    }
    case "image":
      if (layer.image) {
        return [{ k: "image", x: 0, y: 0, w, h, id: layer.image, fit: layer.fit === "contain" ? "contain" : "cover", r: r ?? 0 }];
      }
      // The wireframe convention for "a picture goes here": a box with a cross.
      return [
        { k: "box", x: 0, y: 0, w, h, fill: fill(P.surface), stroke: stroke(P.line), sw, r: r ?? 0 },
        { k: "line", x1: 0, y1: 0, x2: w, y2: h, stroke: P.line, sw: 1 },
        { k: "line", x1: w, y1: 0, x2: 0, y2: h, stroke: P.line, sw: 1 },
      ];
    case "button": {
      const variant = layer.variant || "primary";
      const primary = variant === "primary";
      return [
        {
          k: "box", x: 0, y: 0, w, h, tag: "button",
          fill: primary ? fill(P.accent) : variant === "ghost" ? "transparent" : fill(P.bg),
          stroke: variant === "secondary" ? stroke(P.strong) : null, sw, r: r ?? P.radius,
        },
        textNode(0, 0, w, h, text || "Button", P, {
          size: num(layer.size, 15), weight: 600, align: "center", valign: "center", pad: 12,
          color: colour(layer.color, primary ? P.onAccent : P.text),
        }),
      ];
    }
    case "input":
      return [
        { k: "box", x: 0, y: 0, w, h, fill: fill(P.bg), stroke: stroke(P.line), sw, r: r ?? P.radius },
        textNode(0, 0, w, h, text || "Placeholder", P, {
          size: num(layer.size, 15), color: colour(layer.color, P.muted), valign: "center", pad: 14,
          tag: "input",
        }),
      ];
    case "checkbox": {
      const on = Boolean(layer.checked);
      const s = Math.min(20, h);
      const y = (h - s) / 2;
      return [
        { k: "box", x: 0, y, w: s, h: s, fill: on ? P.accent : P.bg, stroke: on ? null : P.strong, sw: 1.5, r: 4 },
        ...(on ? [textNode(0, y, s, s, "✓", P, { size: 13, weight: 700, color: P.onAccent, align: "center", valign: "center", lh: 1 })] : []),
        textNode(s + 10, 0, Math.max(1, w - s - 10), h, text, P, { size: num(layer.size, 15), valign: "center" }),
      ];
    }
    case "toggle": {
      const on = Boolean(layer.checked);
      const th = Math.min(24, h);
      const tw = th * 1.7;
      const y = (h - th) / 2;
      const knob = th - 6;
      return [
        { k: "box", x: 0, y, w: tw, h: th, fill: on ? P.accent : P.line, stroke: null, sw: 0, r: th / 2 },
        { k: "ellipse", x: on ? tw - knob - 3 : 3, y: y + 3, w: knob, h: knob, fill: "#FFFFFF", stroke: null, sw: 0 },
        textNode(tw + 12, 0, Math.max(1, w - tw - 12), h, text, P, { size: num(layer.size, 15), valign: "center" }),
      ];
    }
    case "avatar":
      if (layer.image) return [{ k: "image", x: 0, y: 0, w, h, id: layer.image, fit: "cover", r: Math.min(w, h) / 2 }];
      return [
        { k: "ellipse", x: 0, y: 0, w, h, fill: fill(P.surface), stroke: stroke(P.line), sw },
        textNode(0, 0, w, h, (text || "").slice(0, 2).toUpperCase(), P, {
          size: Math.max(9, Math.min(w, h) * 0.36), weight: 600, color: P.muted, align: "center", valign: "center", lh: 1,
        }),
      ];
    case "icon":
      return [
        textNode(0, 0, w, h, ICONS[layer.icon] || "◇", P, {
          size: Math.min(w, h) * 0.8, color: colour(layer.color, P.strong), align: "center", valign: "center", lh: 1,
        }),
      ];
    case "nav": {
      const items = Array.isArray(layer.items) ? layer.items.slice(0, 6) : [];
      const pad = Math.min(24, w * 0.05);
      const logo = Math.min(28, h - 16);
      const nodes = [
        { k: "box", x: 0, y: 0, w, h, fill: fill(P.bg), stroke: null, sw: 0, r: 0 },
        { k: "line", x1: 0, y1: h - 0.5, x2: w, y2: h - 0.5, stroke: P.line, sw: 1 },
        { k: "box", x: pad, y: (h - logo) / 2, w: logo, h: logo, fill: P.accent, stroke: null, sw: 0, r: 6 },
        textNode(pad + logo + 10, 0, Math.max(1, w * 0.4), h, text || "Brand", P, {
          size: 17, weight: 700, valign: "center", font: P.head,
        }),
      ];
      let right = w - pad;
      for (const item of [...items].reverse()) {
        const iw = Math.ceil(String(item).length * 15 * 0.56) + 6;
        right -= iw;
        nodes.push(textNode(right, 0, iw, h, item, P, { size: 15, color: P.muted, valign: "center", align: "right" }));
        right -= 20;
      }
      return nodes;
    }
    case "card": {
      const media = layer.image
        ? [{ k: "image", x: 0, y: 0, w, h: h * 0.5, id: layer.image, fit: "cover", r: 0 }]
        : [
            { k: "box", x: 0, y: 0, w, h: h * 0.5, fill: P.surface, stroke: null, sw: 0, r: 0 },
            { k: "line", x1: 0, y1: 0, x2: w, y2: h * 0.5, stroke: P.line, sw: 1 },
            { k: "line", x1: w, y1: 0, x2: 0, y2: h * 0.5, stroke: P.line, sw: 1 },
          ];
      const top = h * 0.5 + 16;
      return [
        { k: "box", x: 0, y: 0, w, h, fill: fill(P.bg), stroke: stroke(P.line), sw, r: r ?? P.radius * 1.5, clip: true },
        ...media,
        textNode(16, top, Math.max(1, w - 32), 24, text || "Card title", P, { size: 17, weight: 600, font: P.head }),
        { k: "box", x: 16, y: top + 34, w: (w - 32) * 0.92, h: 8, fill: P.line, stroke: null, sw: 0, r: 4 },
        { k: "box", x: 16, y: top + 52, w: (w - 32) * 0.64, h: 8, fill: P.line, stroke: null, sw: 0, r: 4 },
      ];
    }
    case "lines": {
      // Placeholder copy: grey bars of uneven length, the last one short.
      const count = Math.max(1, Math.min(12, Math.round(num(layer.count, 3))));
      const widths = [1, 0.94, 0.98, 0.88, 0.96, 0.9];
      return Array.from({ length: count }, (_, i) => ({
        k: "box", x: 0, y: i * 18, w: w * (i === count - 1 && count > 1 ? 0.62 : widths[i % widths.length]), h: 8,
        fill: colour(layer.fill, P.line), stroke: null, sw: 0, r: 4,
      }));
    }
    default:
      return [{ k: "box", x: 0, y: 0, w, h, fill: fill(P.surface), stroke: stroke(P.line), sw, r: r ?? 0 }];
  }
}

/* -- nodes into HTML ----------------------------------------------------------- */

const escapeHtml = (text) =>
  String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const px = (n) => `${Math.round(n * 100) / 100}px`;
const kebab = (key) => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const cssBody = (style) =>
  Object.entries(style)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${kebab(k)}:${v}`)
    .join(";");

function nodeStyle(node, P) {
  switch (node.k) {
    case "box":
    case "ellipse":
      return {
        position: "absolute", left: px(node.x), top: px(node.y), width: px(node.w), height: px(node.h),
        boxSizing: "border-box", background: node.fill || "transparent",
        border: node.stroke && node.sw > 0 ? `${px(node.sw)} solid ${node.stroke}` : "none",
        borderRadius: node.k === "ellipse" ? "50%" : node.r ? px(node.r) : undefined,
        overflow: node.clip ? "hidden" : undefined,
        margin: node.tag === "button" ? "0" : undefined,
        padding: node.tag === "button" ? "0" : undefined,
      };
    case "line": {
      const dx = node.x2 - node.x1;
      const dy = node.y2 - node.y1;
      const length = Math.max(1, Math.hypot(dx, dy));
      return {
        position: "absolute", left: px(node.x1), top: px(node.y1 - node.sw / 2), width: px(length), height: px(node.sw),
        background: node.stroke, transformOrigin: "0 50%",
        transform: dx === 0 && dy === 0 ? undefined : `rotate(${Math.atan2(dy, dx)}rad)`,
      };
    }
    case "text":
      return {
        position: "absolute", left: px(node.x), top: px(node.y), width: px(node.w), height: px(node.h),
        boxSizing: "border-box", margin: "0", padding: node.pad ? `0 ${px(node.pad)}` : "0",
        display: "flex", alignItems: node.valign === "center" ? "center" : node.valign === "bottom" ? "flex-end" : "flex-start",
        justifyContent: node.align === "center" ? "center" : node.align === "right" ? "flex-end" : "flex-start",
        textAlign: node.align, color: node.color, fontFamily: FONT.test(node.font) ? node.font : P.body,
        fontSize: px(node.size), fontWeight: String(node.weight), lineHeight: String(node.lh),
        textTransform: node.upper ? "uppercase" : undefined,
        whiteSpace: "pre-wrap", overflowWrap: "anywhere", overflow: "hidden",
        background: node.tag === "input" ? "transparent" : undefined,
        border: node.tag === "input" ? "0" : undefined,
      };
    case "image":
      return {
        position: "absolute", left: px(node.x), top: px(node.y), width: px(node.w), height: px(node.h),
        objectFit: node.fit, borderRadius: node.r ? px(node.r) : undefined, display: "block",
      };
    default:
      return {};
  }
}

/**
 * One frame as HTML. `images` maps a library id to an address -- a blob: URL
 * in the app, a data: URI in an export -- and nothing else is ever used as a
 * picture's source.
 *
 * `mode` "inline" puts styles on the elements (the editor, slides); "classed"
 * gives each element a class and collects the rules into `css` (the export),
 * and uses real form elements and anchors for prototype links.
 */
export function renderFrame(frame, P, images = {}, mode = "inline", css = null, slugs = null) {
  const classed = mode === "classed";
  const frameClass = classed ? slugs.frame(frame) : "";
  const attrStyle = (cls, style) => {
    if (!classed) return ` style="${escapeHtml(cssBody(style))}"`;
    css.push(`.${cls}{${cssBody(style)}}`);
    return ` class="${cls}"`;
  };
  const parts = [];
  frame.layers.forEach((layer, index) => {
    if (layer.hidden) return;
    const layerClass = classed ? `${frameClass}__${slugs.layer(layer, index)}` : "";
    const wrap = {
      position: "absolute", left: px(num(layer.x)), top: px(num(layer.y)),
      width: px(num(layer.w, 1)), height: px(num(layer.h, 1)),
      opacity: layer.opacity != null && num(layer.opacity, 1) < 1 ? String(num(layer.opacity, 1)) : undefined,
    };
    const link = layer.link && typeof layer.link === "string" ? layer.link : null;
    const inner = expand(layer, P)
      .map((node, n) => {
        const style = nodeStyle(node, P);
        const cls = `${layerClass}-${n}`;
        if (node.k === "image") {
          const src = images[node.id];
          if (!src || !/^(blob:|data:image\/)/.test(src)) {
            return `<div${attrStyle(cls, { ...style, background: P.surface })}></div>`;
          }
          if (classed) {
            return `<img${attrStyle(cls, style)} src="${escapeHtml(src)}" alt="${escapeHtml(layer.name || "")}">`;
          }
          return `<div${attrStyle(cls, {
            ...style, objectFit: undefined, backgroundImage: `url("${src}")`,
            backgroundSize: node.fit, backgroundPosition: "center",
          })}></div>`;
        }
        if (node.k === "text") {
          if (classed && node.tag === "input") {
            return `<input${attrStyle(cls, style)} placeholder="${escapeHtml(node.text)}" aria-label="${escapeHtml(node.text)}">`;
          }
          const tag = classed && node.tag && node.tag !== "input" ? node.tag : "div";
          return `<${tag}${attrStyle(cls, style)}>${escapeHtml(node.text)}</${tag}>`;
        }
        const tag = classed && node.tag === "button" ? "button" : "div";
        return `<${tag}${attrStyle(cls, style)}${tag === "button" ? ' type="button"' : ""}></${tag}>`;
      })
      .join("");
    if (classed) {
      const tag = link ? "a" : "div";
      const href = link ? ` href="#${escapeHtml(link)}"` : "";
      parts.push(`<${tag}${attrStyle(layerClass, { ...wrap, display: "block" })}${href}>${inner}</${tag}>`);
    } else {
      parts.push(
        `<div class="wf-l" data-layer="${escapeHtml(layer.id)}"${link ? ` data-link="${escapeHtml(link)}"` : ""}${attrStyle("", wrap)}>${inner}</div>`,
      );
    }
  });
  const frameStyle = {
    position: "relative", width: px(frame.w), height: px(frame.h), overflow: "hidden",
    background: colour(frame.fill, P.bg), fontFamily: P.body,
  };
  return classed
    ? `<section id="${escapeHtml(frame.id)}"${attrStyle(frameClass, frameStyle)} aria-label="${escapeHtml(frame.name)}">${parts.join("")}</section>`
    : `<div class="wf-frame" data-frame="${escapeHtml(frame.id)}"${attrStyle("", frameStyle)}>${parts.join("")}</div>`;
}

/* -- export: HTML + CSS -------------------------------------------------------- */

function slugger() {
  const used = new Set();
  const make = (text) => {
    const base = String(text || "x").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 28) || "x";
    let slug = /^[a-z]/.test(base) ? base : `n-${base}`;
    let n = 2;
    while (used.has(slug)) slug = `${base}-${n++}`;
    used.add(slug);
    return slug;
  };
  const frames = new Map();
  return {
    frame: (f) => {
      if (!frames.has(f.id)) frames.set(f.id, make(f.name));
      return frames.get(f.id);
    },
    layer: (l, i) => `${l.type}${i + 1}`,
  };
}

/**
 * The whole document as a web page and its stylesheet. Each frame is a
 * section; a prototype link is an anchor to the section it goes to, so the
 * exported page clicks through the way the prototype does.
 */
export function toHtmlCss(doc, P, images, title = "Wireframe") {
  const css = [];
  const slugs = slugger();
  const sections = doc.frames
    .map(
      (frame) =>
        `<figure class="wf-screen"><figcaption>${escapeHtml(frame.name)}</figcaption>${renderFrame(frame, P, images, "classed", css, slugs)}</figure>`,
    )
    .join("\n");
  const base = [
    "*,*::before,*::after{box-sizing:border-box}",
    `body{margin:0;padding:48px 24px;background:#E6E6E6;font-family:${P.body};color:${P.text}}`,
    ".wf-screen{margin:0 auto 64px;width:max-content;max-width:100%}",
    ".wf-screen figcaption{font:600 13px/1.4 system-ui,sans-serif;color:#555;margin:0 0 10px}",
    "section{box-shadow:0 1px 3px rgba(0,0,0,.12),0 12px 32px -12px rgba(0,0,0,.25)}",
    "a{color:inherit;text-decoration:none}",
    "button{font:inherit;cursor:pointer}",
    "input{font:inherit;outline:none}",
    "input::placeholder{color:inherit;opacity:1}",
  ];
  const stylesheet = `/* ${title} -- exported from Bom */\n${base.join("\n")}\n${css.join("\n")}\n`;
  const page = (styleTag) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
${styleTag}
</head>
<body>
${sections}
</body>
</html>
`;
  return {
    html: page('<link rel="stylesheet" href="styles.css">'),
    css: stylesheet,
    single: page(`<style>\n${stylesheet}</style>`),
  };
}

/* -- export: canvas, PNG, PDF --------------------------------------------------- */

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.max(0, Math.min(r || 0, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function wrap(ctx, text, width) {
  const lines = [];
  for (const paragraph of String(text).split("\n")) {
    const words = paragraph.split(/(\s+)/);
    let line = "";
    for (const word of words) {
      const trial = line + word;
      if (ctx.measureText(trial).width > width && line.trim()) {
        lines.push(line.trimEnd());
        line = word.trimStart();
      } else {
        line = trial;
      }
    }
    lines.push(line);
  }
  return lines;
}

function drawNode(ctx, node, ox, oy, P, pictures) {
  ctx.save();
  if (node.k === "box" || node.k === "ellipse") {
    const x = ox + node.x;
    const y = oy + node.y;
    if (node.k === "ellipse") {
      ctx.beginPath();
      ctx.ellipse(x + node.w / 2, y + node.h / 2, node.w / 2, node.h / 2, 0, 0, Math.PI * 2);
    } else {
      roundRect(ctx, x, y, node.w, node.h, node.r);
    }
    if (node.fill && node.fill !== "transparent") {
      ctx.fillStyle = node.fill;
      ctx.fill();
    }
    if (node.stroke && node.sw > 0) {
      // Inside the edge, as CSS border-box draws it.
      ctx.save();
      ctx.clip();
      ctx.lineWidth = node.sw * 2;
      ctx.strokeStyle = node.stroke;
      ctx.stroke();
      ctx.restore();
    }
  } else if (node.k === "line") {
    ctx.beginPath();
    ctx.moveTo(ox + node.x1, oy + node.y1);
    ctx.lineTo(ox + node.x2, oy + node.y2);
    ctx.lineWidth = node.sw;
    ctx.strokeStyle = node.stroke;
    ctx.stroke();
  } else if (node.k === "text") {
    const x = ox + node.x + node.pad;
    const width = Math.max(1, node.w - node.pad * 2);
    ctx.beginPath();
    ctx.rect(ox + node.x, oy + node.y, node.w, node.h);
    ctx.clip();
    ctx.font = `${node.weight} ${node.size}px ${node.font}`;
    ctx.fillStyle = node.color;
    ctx.textBaseline = "middle";
    ctx.textAlign = node.align === "center" ? "center" : node.align === "right" ? "right" : "left";
    const lines = wrap(ctx, node.upper ? node.text.toUpperCase() : node.text, width);
    const step = node.size * node.lh;
    const total = lines.length * step;
    let top = oy + node.y;
    if (node.valign === "center") top += (node.h - total) / 2;
    else if (node.valign === "bottom") top += node.h - total;
    const ax = node.align === "center" ? x + width / 2 : node.align === "right" ? x + width : x;
    lines.forEach((line, i) => ctx.fillText(line, ax, top + step * i + step / 2));
  } else if (node.k === "image") {
    const x = ox + node.x;
    const y = oy + node.y;
    roundRect(ctx, x, y, node.w, node.h, node.r);
    ctx.clip();
    const picture = pictures[node.id];
    if (picture?.naturalWidth) {
      const scale = node.fit === "contain"
        ? Math.min(node.w / picture.naturalWidth, node.h / picture.naturalHeight)
        : Math.max(node.w / picture.naturalWidth, node.h / picture.naturalHeight);
      const dw = picture.naturalWidth * scale;
      const dh = picture.naturalHeight * scale;
      ctx.drawImage(picture, x + (node.w - dw) / 2, y + (node.h - dh) / 2, dw, dh);
    } else {
      ctx.fillStyle = P.surface;
      ctx.fillRect(x, y, node.w, node.h);
    }
  }
  ctx.restore();
}

/** One frame drawn on a new canvas at `scale` device pixels per CSS pixel. */
export function frameToCanvas(frame, P, pictures = {}, scale = 2) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(frame.w * scale);
  canvas.height = Math.round(frame.h * scale);
  const ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);
  ctx.fillStyle = colour(frame.fill, P.bg);
  ctx.fillRect(0, 0, frame.w, frame.h);
  for (const layer of frame.layers) {
    if (layer.hidden) continue;
    ctx.save();
    ctx.globalAlpha = layer.opacity != null ? Math.max(0, Math.min(1, num(layer.opacity, 1))) : 1;
    for (const node of expand(layer, P)) drawNode(ctx, node, num(layer.x), num(layer.y), P, pictures);
    ctx.restore();
  }
  return canvas;
}

export const canvasBlob = (canvas, type = "image/png", quality = 0.92) =>
  new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Could not draw that frame."))), type, quality),
  );

/** Load library pictures as <img> elements, for drawing on a canvas. */
export async function loadPictures(dataUris) {
  const entries = await Promise.all(
    Object.entries(dataUris).map(
      ([id, src]) =>
        new Promise((resolve) => {
          const img = new Image();
          img.onload = () => resolve([id, img]);
          img.onerror = () => resolve(null);
          img.src = src;
        }),
    ),
  );
  return Object.fromEntries(entries.filter(Boolean));
}

const encoder = new TextEncoder();
const bytes = (value) => (typeof value === "string" ? encoder.encode(value) : value);

/**
 * A PDF with one page per frame, each page the frame's JPEG at its own size.
 * Written by hand -- the format needs a dozen objects for this and a library
 * would be most of the bundle.
 */
export function buildPdf(pages) {
  const chunks = [];
  const offsets = [];
  let length = 0;
  const push = (part) => {
    const b = bytes(part);
    chunks.push(b);
    length += b.length;
  };
  const object = (id, body) => {
    offsets[id] = length;
    push(`${id} 0 obj\n`);
    for (const part of [].concat(body)) push(part);
    push("\nendobj\n");
  };
  push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
  const kids = pages.map((_, i) => `${3 + i * 3} 0 R`).join(" ");
  object(1, "<< /Type /Catalog /Pages 2 0 R >>");
  object(2, `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  pages.forEach((page, i) => {
    const pageId = 3 + i * 3;
    const w = (page.w * 0.75).toFixed(2);
    const h = (page.h * 0.75).toFixed(2);
    object(pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${pageId + 1} 0 R >> >> /Contents ${pageId + 2} 0 R >>`);
    object(pageId + 1, [
      `<< /Type /XObject /Subtype /Image /Width ${page.pw} /Height ${page.ph} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >>\nstream\n`,
      page.jpeg,
      "\nendstream",
    ]);
    const content = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
    object(pageId + 2, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });
  const count = 3 + pages.length * 3;
  const xref = length;
  push(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let id = 1; id < count; id += 1) push(`${String(offsets[id]).padStart(10, "0")} 00000 n \n`);
  push(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(chunks, { type: "application/pdf" });
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data) {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A .zip of the given files, stored uncompressed -- small files, no library. */
export function buildZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const data = bytes(file.data);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(8, 0, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    chunks.push(new Uint8Array(local.buffer), name, data);
    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, data.length, true);
    entry.setUint32(24, data.length, true);
    entry.setUint16(28, name.length, true);
    entry.setUint32(42, offset, true);
    central.push(new Uint8Array(entry.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const size = central.reduce((n, part) => n + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  return new Blob([...chunks, ...central, new Uint8Array(end.buffer)], { type: "application/zip" });
}

/** A deck with one board slide per frame -- the same thing wireframe_to_slides makes. */
export function toDeck(doc) {
  return {
    version: 1,
    theme: doc.theme || {},
    slides: doc.frames.map((frame) => ({
      layout: "board",
      title: frame.name,
      board: { fidelity: doc.fidelity, frame },
    })),
  };
}
