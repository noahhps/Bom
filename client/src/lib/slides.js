/* A deck: parsed, themed, styled and exported. No React here.
 *
 * The server stores a deck as JSON -- a theme and a list of slides, each with a
 * layout and that layout's fields -- and this is everything the panel needs to
 * draw one that is not a component: reading it back, turning the theme into
 * CSS custom properties, and the stylesheet itself.
 *
 * The stylesheet is a string rather than rules in styles.css because the same
 * rules go out with an exported deck. A deck saved as HTML has to look exactly
 * like the one in the panel, and the only way to be sure of that is for there
 * to be one copy of the CSS.
 *
 * Every size is in container-query units against the slide's own frame, so a
 * slide is the same drawing at 180px in the filmstrip, 460px in the panel and
 * full screen when presenting -- nothing reflows, it only scales. The numbers
 * are designed at 1280 wide, where 1cqw is 12.8px.
 */

export const LAYOUTS = [
  "title", "section", "bullets", "content", "two_column",
  "stat", "quote", "image", "table", "closing",
];

/* What a deck with no theme -- and no standard behind it -- looks like. Quiet
   and legible: white, near-black ink, the app's own cobalt, one sans. */
export const DEFAULT_THEME = {
  background: "#FFFFFF",
  surface: "#F4F6FA",
  text: "#14171F",
  muted: "#5F6B7D",
  accent: "#1F4FD8",
  line: "#E1E6EE",
  heading_font: "Inter, 'Helvetica Neue', Arial, system-ui, sans-serif",
  body_font: "Inter, 'Helvetica Neue', Arial, system-ui, sans-serif",
  heading_weight: 650,
  heading_case: "none",
  radius: 10,
};

const COLOUR = /^(#[0-9a-fA-F]{3,8}|(?:rgb|rgba|hsl|hsla)\([0-9.,%\s/+-]{3,60}\)|[a-zA-Z]{3,24})$/;
const FONT = /^[\w\s,'"-]{1,160}$/;

/** The same checks the server makes, again at the point of drawing. */
export function cleanTheme(raw) {
  const theme = {};
  if (!raw || typeof raw !== "object") return theme;
  for (const key of ["background", "surface", "text", "muted", "accent", "accent_2", "line"]) {
    const v = String(raw[key] ?? "").trim();
    if (v && COLOUR.test(v)) theme[key] = v;
  }
  for (const key of ["heading_font", "body_font"]) {
    const v = String(raw[key] ?? "").replace(/\s+/g, " ").trim();
    if (v && FONT.test(v)) theme[key] = v;
  }
  const weight = Number(raw.heading_weight);
  if (Number.isFinite(weight) && weight > 0) {
    theme.heading_weight = Math.max(300, Math.min(900, Math.round(weight / 100) * 100));
  }
  if (raw.heading_case) theme.heading_case = raw.heading_case === "upper" ? "upper" : "none";
  const radius = Number(raw.radius);
  if (raw.radius !== undefined && raw.radius !== "" && Number.isFinite(radius)) {
    theme.radius = Math.max(0, Math.min(48, Math.round(radius)));
  }
  return theme;
}

/** Layered: the default, the conversation's standard, then the deck's own. */
export function resolveTheme(own, fallback) {
  return { ...DEFAULT_THEME, ...cleanTheme(fallback), ...cleanTheme(own) };
}

/** Black or white, whichever reads on a fill -- for text on the accent. */
export function inkOn(colour) {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})/i.exec(colour || "");
  if (!hex) return "#FFFFFF";
  let h = hex[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.45 ? "#111111" : "#FFFFFF";
}

/** The theme as the custom properties the stylesheet reads. */
export function themeVars(theme) {
  return {
    "--d-bg": theme.background,
    "--d-surface": theme.surface,
    "--d-text": theme.text,
    "--d-muted": theme.muted,
    "--d-accent": theme.accent,
    "--d-accent-2": theme.accent_2 || theme.accent,
    "--d-on-accent": inkOn(theme.accent),
    "--d-line": theme.line,
    "--d-head-font": theme.heading_font,
    "--d-body-font": theme.body_font,
    "--d-head-weight": String(theme.heading_weight),
    "--d-head-case": theme.heading_case === "upper" ? "uppercase" : "none",
    "--d-radius": String(theme.radius),
  };
}

/** A stored deck, or null when the text is not one. */
export function parseDeck(content) {
  let data;
  try {
    data = JSON.parse(content || "");
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || !Array.isArray(data.slides)) return null;
  const slides = data.slides
    .filter((s) => s && typeof s === "object")
    .map((s) => ({ ...s, layout: LAYOUTS.includes(s.layout) ? s.layout : "bullets" }));
  return { version: 1, theme: data.theme && typeof data.theme === "object" ? data.theme : {}, slides };
}

export function serializeDeck(deck) {
  return JSON.stringify({ version: 1, theme: deck.theme || {}, slides: deck.slides }, null, 1);
}

export function blankDeck(title = "Untitled deck") {
  return {
    version: 1,
    theme: {},
    slides: [
      { layout: "title", kicker: "Draft", title, subtitle: "Click any text to edit it, or ask for the deck to be written." },
    ],
  };
}

/** An inline SVG as an image address. As an <img> it can draw but never run a
 *  script or fetch anything, whatever the model put inside it. */
export function svgSource(svg) {
  let markup = String(svg || "").trim();
  if (!/^<svg[\s>]/i.test(markup)) return null;
  if (!/xmlns=/.test(markup)) markup = markup.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
}

/* The slide stylesheet. Scoped under .deck-frame so none of it reaches the app,
   and none of the app's rules are needed to draw a slide. */
export const SLIDE_CSS = `
.deck-frame { display: block; container-type: inline-size; width: 100%; }
.deck-slide {
  position: relative; box-sizing: border-box; width: 100%; aspect-ratio: 16 / 9;
  overflow: hidden; display: flex; flex-direction: column;
  padding: 6cqw 7cqw; background: var(--d-bg); color: var(--d-text);
  font-family: var(--d-body-font); font-size: 2.15cqw; line-height: 1.42;
  -webkit-font-smoothing: antialiased; font-variant-numeric: tabular-nums;
}
.deck-slide *, .deck-slide *::before { box-sizing: border-box; }
.deck-h {
  margin: 0; font-family: var(--d-head-font); font-weight: var(--d-head-weight);
  text-transform: var(--d-head-case); letter-spacing: -0.02em; line-height: 1.08;
  text-wrap: balance;
}
.deck-title-top { font-size: 3.5cqw; margin-bottom: 3.4cqw; max-width: 88%; }
.deck-kicker {
  font-size: 1.35cqw; font-weight: 600; letter-spacing: 0.16em; text-transform: uppercase;
  color: var(--d-accent); margin-bottom: 2.2cqw;
}
.deck-sub { margin-top: 2.2cqw; font-size: 2.2cqw; line-height: 1.35; color: var(--d-muted); max-width: 72%; }
.deck-rule { width: 6.5cqw; height: 0.55cqw; background: var(--d-accent); border-radius: 0.3cqw; }
.deck-num {
  position: absolute; right: 4cqw; bottom: 3cqw; font-size: 1.15cqw; color: var(--d-muted);
  letter-spacing: 0.08em;
}
.deck-brand { position: absolute; left: 7cqw; bottom: 3cqw; width: 2.4cqw; height: 0.35cqw; background: var(--d-accent); }

.deck-slide[data-layout="title"] { justify-content: flex-end; padding-bottom: 8.5cqw; }
.deck-slide[data-layout="title"] .deck-rule { position: absolute; left: 7cqw; top: 6.5cqw; }
.deck-slide[data-layout="title"] .deck-h { font-size: 6.4cqw; max-width: 84%; }

.deck-slide[data-layout="section"] {
  justify-content: center; background: var(--d-accent); color: var(--d-on-accent);
}
.deck-slide[data-layout="section"] .deck-h { font-size: 5.4cqw; max-width: 80%; }
.deck-slide[data-layout="section"] .deck-sub { color: var(--d-on-accent); opacity: 0.8; }
.deck-slide[data-layout="section"] .deck-num { color: var(--d-on-accent); opacity: 0.7; }
.deck-slide[data-layout="section"] .deck-kicker { color: var(--d-on-accent); opacity: 0.85; }

.deck-bullets { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 1.7cqw; max-width: 86%; }
.deck-bullets li { position: relative; padding-left: 2.6cqw; font-size: 2.35cqw; line-height: 1.32; }
.deck-bullets li::before {
  content: ""; position: absolute; left: 0; top: 0.62em; width: 0.8cqw; height: 0.8cqw;
  background: var(--d-accent); border-radius: calc(var(--d-radius) * 0.02cqw);
}
.deck-body { max-width: 76%; font-size: 2.25cqw; color: var(--d-text); }
.deck-md p { margin: 0 0 1.4cqw; }
.deck-md ul, .deck-md ol { margin: 0 0 1.4cqw; padding-left: 1.2em; }
.deck-md li { margin-bottom: 0.7cqw; }
.deck-md li::marker { color: var(--d-accent); }
.deck-md strong { font-weight: 700; }
.deck-md a { color: var(--d-accent); }
.deck-md code { font-size: 0.9em; background: var(--d-surface); padding: 0.1em 0.3em; border-radius: 0.3cqw; }

.deck-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 5cqw; flex: 1; min-height: 0; }
.deck-col { font-size: 2cqw; min-width: 0; }
.deck-col + .deck-col { border-left: 0.12cqw solid var(--d-line); padding-left: 5cqw; }
.deck-col-title {
  font-size: 1.35cqw; font-weight: 600; letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--d-accent); margin: 0 0 1.6cqw;
}

.deck-stats { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: 3cqw; margin-top: auto; margin-bottom: auto; }
.deck-stat { border-top: 0.35cqw solid var(--d-accent); padding-top: 2cqw; min-width: 0; }
.deck-stat-value {
  font-family: var(--d-head-font); font-weight: var(--d-head-weight); font-size: 6.2cqw;
  line-height: 1; letter-spacing: -0.03em; color: var(--d-text);
}
.deck-stats[data-count="1"] .deck-stat-value { font-size: 13cqw; color: var(--d-accent); }
.deck-stats[data-count="1"] .deck-stat { border-top: none; padding-top: 0; }
.deck-stat-label { margin-top: 1.4cqw; font-size: 1.8cqw; color: var(--d-muted); line-height: 1.3; }

.deck-slide[data-layout="quote"] { justify-content: center; }
.deck-quote-mark {
  font-family: var(--d-head-font); font-size: 14cqw; line-height: 0.6; height: 6cqw;
  color: var(--d-accent); margin-bottom: 1cqw;
}
.deck-quote {
  margin: 0; font-family: var(--d-head-font); font-weight: var(--d-head-weight);
  font-size: 3.9cqw; line-height: 1.2; letter-spacing: -0.015em; max-width: 86%; text-wrap: balance;
}
.deck-attribution { margin-top: 2.6cqw; font-size: 1.8cqw; color: var(--d-muted); }
.deck-attribution::before { content: "— "; }

.deck-visual { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; }
.deck-visual img { max-width: 100%; max-height: 100%; object-fit: contain; }
.deck-caption { margin-top: 1.6cqw; font-size: 1.45cqw; color: var(--d-muted); text-align: center; }

.deck-table { width: 100%; border-collapse: collapse; font-size: 1.75cqw; }
.deck-table th {
  text-align: left; font-size: 1.25cqw; font-weight: 600; letter-spacing: 0.12em;
  text-transform: uppercase; color: var(--d-muted); padding: 0 1.4cqw 1.2cqw 0;
  border-bottom: 0.3cqw solid var(--d-accent);
}
.deck-table td { padding: 1.15cqw 1.4cqw 1.15cqw 0; border-bottom: 0.12cqw solid var(--d-line); }
.deck-table [data-num] { text-align: right; }

.deck-slide[data-layout="closing"] { align-items: center; justify-content: center; text-align: center; }
.deck-slide[data-layout="closing"] .deck-rule { margin-bottom: 3cqw; }
.deck-slide[data-layout="closing"] .deck-h { font-size: 5.6cqw; max-width: 80%; }
.deck-slide[data-layout="closing"] .deck-sub { max-width: 64%; }

.deck-slide [data-edit] { border-radius: 0.3cqw; outline: 0.14cqw dashed transparent; outline-offset: 0.5cqw; cursor: text; }
.deck-slide [data-edit]:hover { outline-color: color-mix(in srgb, var(--d-accent) 45%, transparent); }
.deck-slide [data-edit]:focus { outline: 0.18cqw solid var(--d-accent); }
.deck-slide [data-edit]:empty::before { content: attr(data-placeholder); color: var(--d-muted); opacity: 0.6; }
`;

/* Around the slides in an exported file: a dark desk to lay them on, one slide
   per page when printed, and a present mode on P / the arrow keys. */
const EXPORT_CSS = `
html, body { margin: 0; background: #16181d; }
body { padding: 40px 20px; }
.deck-frame { max-width: 1100px; margin: 0 auto 32px; box-shadow: 0 18px 40px -18px rgba(0,0,0,.6); }
.deck-hint { color: #9aa3b2; font: 13px/1.4 system-ui, sans-serif; text-align: center; margin: 0 0 28px; }
body.presenting { padding: 0; overflow: hidden; background: #000; }
body.presenting .deck-hint { display: none; }
body.presenting .deck-frame { display: none; margin: 0; box-shadow: none; }
body.presenting .deck-frame.on {
  display: block; position: fixed; inset: 0; margin: auto; max-width: none;
  width: min(100vw, 177.78vh); height: fit-content;
}
@page { size: 13.333in 7.5in; margin: 0; }
@media print {
  html, body { background: none; padding: 0; }
  .deck-hint { display: none; }
  .deck-frame { max-width: none; width: 13.333in; margin: 0; box-shadow: none; break-after: page; }
}
`;

const EXPORT_JS = `
(function () {
  var frames = [].slice.call(document.querySelectorAll('.deck-frame'));
  var at = 0;
  function show(i) {
    at = Math.max(0, Math.min(frames.length - 1, i));
    frames.forEach(function (f, n) { f.classList.toggle('on', n === at); });
  }
  document.addEventListener('keydown', function (e) {
    var on = document.body.classList.contains('presenting');
    if (e.key === 'p' || e.key === 'P' || e.key === 'F5') {
      e.preventDefault(); document.body.classList.toggle('presenting'); show(at); return;
    }
    if (!on) return;
    if (e.key === 'Escape') document.body.classList.remove('presenting');
    else if (['ArrowRight', 'ArrowDown', 'PageDown', ' '].indexOf(e.key) >= 0) { e.preventDefault(); show(at + 1); }
    else if (['ArrowLeft', 'ArrowUp', 'PageUp'].indexOf(e.key) >= 0) { e.preventDefault(); show(at - 1); }
    else if (e.key === 'Home') show(0);
    else if (e.key === 'End') show(frames.length - 1);
  });
  document.addEventListener('click', function (e) {
    if (!document.body.classList.contains('presenting')) return;
    show(e.clientX < window.innerWidth / 3 ? at - 1 : at + 1);
  });
})();
`;

const escapeHtml = (text) =>
  String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** A standalone HTML file of the deck, from already-rendered slide markup. */
export function deckDocument(title, framesHtml) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title || "Deck")}</title>
<style>${SLIDE_CSS}${EXPORT_CSS}</style>
</head>
<body>
<p class="deck-hint">Press P to present · arrow keys to move · Esc to stop · print for a PDF</p>
${framesHtml}
<script>${EXPORT_JS}</script>
</body>
</html>
`;
}
