/* Accents: one hue in, a whole stylesheet's worth of tints out.
 *
 * The shipped palette is a ladder -- a sheet at OKLCH lightness 0.995, a shell
 * at 0.957, four line weights between 0.77 and 0.91, two text greys, and a
 * cobalt accent at 0.49 -- and every rung of it is the *same hue* at a
 * different lightness and a fraction of the accent's chroma. That is what
 * makes it a system rather than sixteen chosen colours, and it is also what
 * makes it swappable: hold the ladder, change the hue, and the app is dressed
 * in something else without a single rule in styles.css knowing about it.
 *
 * The ratios below were read back off the hand-picked hexes in styles.css.
 * What goes into the ladder is a petal (lib/petals.js): the hues the logo is
 * drawn in are the hues the app can wear, and the static fallback tokens in
 * styles.css are the cornflower petal run through this same ladder.
 *
 * What the generator does *not* do is the theatrical part. Apple Music's
 * colour is mostly one enormous soft field behind everything, and that is a
 * separate layer here -- the `--aura-*` tokens at the bottom, painted by
 * `.app::before` in styles.css. Surfaces stay nearly white and legible; the
 * drama sits behind them.
 */

import { oklch, readable } from "./color";
import { PETALS, PETAL_BY_ID, neighbours } from "./petals";

// The accents on the swatch row: the flower's eight petals, in the flower's
// order, and one quiet grey for a chat that should not wear a colour but
// should not be the bare sheet either. Hue in OKLCH degrees, chroma in OKLCH
// units -- roughly 0.03 is a tinted grey, 0.22 is about as saturated as sRGB
// goes at these lightnesses.
//
// Picking an accent is picking a petal. The row used to be ten muted cousins
// of these hues at two thirds of their chroma, which is why the logo looked
// pasted onto the app beside it.
export const PRESETS = [
  ...PETALS.map(({ id, name, hue, chroma, hex }) => ({ id, name, hue, chroma, hex })),
  { id: "slate", name: "Slate", hue: 250, chroma: 0.032 },
];

const BY_ID = new Map(PRESETS.map((preset) => [preset.id, preset]));

// The ids the old swatch row saved, pointed at the petal each one was a muted
// copy of, so an accent someone chose before the palette changed still
// resolves -- to the petal on the same side of the wheel -- instead of
// silently falling to "no colour".
const LEGACY = {
  cobalt: "cornflower",
  midnight: "cornflower",
  iris: "violet",
  mauve: "orchid",
  rose: "poppy",
  ember: "marigold",
  brass: "buttercup",
  teal: "lagoon",
};

const presetOf = (id) => BY_ID.get(id) || BY_ID.get(LEGACY[id]);

/** A saved preset id as it reads today -- "cobalt" is "cornflower" now. */
export const canonicalPreset = (id) => presetOf(id)?.id ?? id;

// How much colour, from a hairline to the full wash. The shipped palette sits
// at about 0.31 on this scale; the default is deliberately above it, because
// an accent nobody can see is not one they chose.
export const DEFAULT_STRENGTH = 0.55;

/** The app-wide accent when nothing has ever been chosen. */
export const DEFAULT_ACCENT = { mode: "auto", strength: DEFAULT_STRENGTH };

/** Resolve an accent to its hue and chroma, or null for "wear no colour". */
export function seedOf(accent, fallback = null) {
  if (!accent || accent.mode === "off") return null;
  if (accent.mode === "custom") {
    const fallbackPetal = PETAL_BY_ID.get("cornflower");
    return {
      hue: accent.hue ?? fallbackPetal.hue,
      chroma: accent.chroma ?? fallbackPetal.chroma,
    };
  }
  if (accent.mode === "preset") {
    const preset = presetOf(accent.preset);
    return preset ? { hue: preset.hue, chroma: preset.chroma } : null;
  }
  // auto: the caller works the hue out from the conversation and hands it in.
  return fallback;
}

/* The ladder. Each rung is [lightness, chroma as a fraction of the accent's].
 *
 * Read off styles.css rather than designed here, which is the point: this
 * table is a description of a palette that already worked, not a new opinion
 * about one. The lightnesses are held at every hue -- that is what OKLab buys
 * -- and only the chroma fractions are scaled by how strong an accent is
 * asked for. */
const LADDER = {
  ground: [0.995, 0.012],
  surface: [1.0, 0.0],
  shell: [0.9573, 0.034],
  menu: [0.9451, 0.048],
  "menu-well": [0.9451, 0.048],
  rail: [0.9728, 0.026],
  "grid-line": [0.9663, 0.034],
  line: [0.8866, 0.084],
  "line-soft": [0.9058, 0.069],
  "line-firm": [0.8614, 0.107],
  "line-strong": [0.7698, 0.141],
  ink: [0.1915, 0.122],
  "accent-soft": [0.6197, 0.746],
  field: [0.9312, 0.105],
  wash: [0.9431, 0.085],
};

/* The same rungs for dark mode: a deep, tinted night rather than black.
 *
 * This used to be Vercel's dark language -- #000 behind, #0a0a0a and #111 on
 * top, greys that are greys -- which is the one setting the flower looks most
 * like a sticker on. The petals need somewhere to glow, so the ground is
 * lifted off black to about L 0.23 and every surface carries a trace of the
 * accent's hue: a cornflower chat is a blue-violet dusk, a marigold one a warm
 * dark. Text still goes through `readable()`, so the lift costs no contrast. */
const LADDER_DARK = {
  ground: [0.235, 0.1],
  surface: [0.27, 0.1],
  shell: [0.205, 0.11],
  menu: [0.27, 0.1],
  "menu-well": [0.31, 0.11],
  rail: [0.235, 0.1],
  "grid-line": [0.29, 0.11],
  line: [0.37, 0.11],
  "line-soft": [0.33, 0.1],
  "line-firm": [0.41, 0.12],
  "line-strong": [0.48, 0.13],
  ink: [0.955, 0.015],
  "accent-soft": [0.74, 0.85],
  field: [0.33, 0.2],
  wash: [0.3, 0.15],
};

/**
 * Every custom property an accent sets, as a plain object ready to be written
 * onto an element's style.
 *
 * Returns null for "off", which the caller reads as "clear what you set and
 * let styles.css stand" -- an empty object would mean the same thing, but a
 * null makes the two cases impossible to confuse at the call site.
 */
export function palette(accent, fallbackSeed = null, mode = "light") {
  const seed = seedOf(accent, fallbackSeed);
  if (!seed) return null;
  if (mode === "dark") return darkPalette(seed, accent);

  const { hue } = seed;
  const strength = clampStrength(accent?.strength);
  // The surface tints scale with strength; the accent's own chroma does not.
  // Turning the wash down should leave the links the colour they were, not
  // fade the one thing on the sheet that has to stay visible.
  const spread = 0.5 + 1.6 * strength;
  const chroma = seed.chroma;
  const tone = (rung) => {
    const [lightness, fraction] = LADDER[rung];
    return oklch(lightness, chroma * fraction * spread, hue);
  };

  // A grey accent keeps grey neighbours: slate should not bloom.
  const reach = Math.min(1, chroma / 0.1);
  const [before, after] = neighbours(hue);
  const ground = tone("ground");
  // Three colours that carry text, and therefore the three that get checked
  // rather than chosen. 5.5:1 for the accent because it is also a link and a
  // 12px label; 4.5 for the greys, which is what the stylesheet's own comments
  // settled on after two rounds of darkening them by hand.
  const accentColour = readable(hue, chroma, ground, 5.5, 0.56);
  const accentHover = readable(hue, chroma, ground, 8, 0.42);
  // A fill that carries white text. On the light sheet that is the accent
  // itself -- it already clears 5.5:1 against a near-white ground, so white
  // on it clears too -- and only dark mode needs the two to differ.
  const accentFill = accentColour;
  const dim = readable(hue, chroma * 0.156 * spread, ground, 6, 0.56);
  const faint = readable(hue, chroma * 0.148 * spread, ground, 4.6, 0.58);

  return {
    "--shell": tone("shell"),
    "--menu": tone("menu"),
    "--menu-well": tone("menu-well"),
    "--ground": ground,
    "--rail": tone("rail"),
    "--surface": tone("surface"),
    "--ink": tone("ink"),
    "--grid-line": tone("grid-line"),

    // One accent and three derivatives of it. The stylesheet's old --violet /
    // --blue / --send were all this same cobalt and have been removed; what a
    // header, callout, spark or user turn used to reach for by those names now
    // reads --accent-field / --accent-wash / --accent-soft. Green and ochre are
    // deliberately not derived here: they mean pass and warning, and a warning
    // that turns blue because the reader likes blue is a bug.
    "--accent": accentColour,
    "--accent-hover": accentHover,
    "--accent-fill": accentFill,
    "--accent-soft": tone("accent-soft"),
    "--accent-field": tone("field"),
    "--accent-wash": tone("wash"),

    "--line": tone("line"),
    "--line-soft": tone("line-soft"),
    "--line-firm": tone("line-firm"),
    "--line-strong": tone("line-strong"),

    "--text-dim": dim,
    "--text-faint": faint,

    /* The ambient field: three soft discs of colour behind everything, and
     * they are petals. The accent's own in the middle, and the petal either
     * side of it on the flower in the other two -- so a cornflower chat has
     * lagoon and violet at its edges, the way the logo's blue petal sits
     * between its teal and its violet. A single-hue blur reads as a cast
     * over the screen; neighbouring petals read as the flower's light. */
    "--aura-1": oklch(0.845, chroma * 0.95, hue),
    "--aura-2": oklch(0.8, before.chroma * reach * 1.05, before.hue),
    "--aura-3": oklch(0.88, after.chroma * reach * 0.85, after.hue),
    // Kept under two thirds even at full strength. The fields sit behind the
    // thread, and past that they stop being light on a sheet and start being
    // a background the text has to fight.
    "--aura-opacity": (0.12 + 0.5 * strength).toFixed(3),
    // A saturated form of the accent for the one place that wants the hue
    // undiluted -- the swatch a chat wears in the rail.
    "--accent-pure": oklch(0.62, chroma, hue),
  };
}

/* The dark ladder. Same tokens, same checks, a different ground: every colour
 * that carries text is searched for against the dark sheet, upwards, and the
 * glow behind it is the flower's petals seen at night -- the accent and its
 * two neighbours, deep enough to read as light from somewhere off screen
 * rather than as a coloured fog over the conversation. */
function darkPalette(seed, accent) {
  const { hue, chroma } = seed;
  const strength = clampStrength(accent?.strength);
  const spread = 0.5 + 1.6 * strength;
  const tone = (rung) => {
    const [lightness, fraction] = LADDER_DARK[rung];
    return oklch(lightness, chroma * fraction * spread, hue);
  };

  const reach = Math.min(1, chroma / 0.1);
  const [before, after] = neighbours(hue);
  const ground = tone("ground");
  // Links and marks: light enough to read on the dark ground at 5.5:1.
  const accentColour = readable(hue, chroma, ground, 5.5, 0.6);
  const accentHover = readable(hue, chroma, ground, 8, 0.7);
  // Buttons and the send control: the darkest step that still carries white
  // text at 4.5:1.
  const accentFill = readable(hue, chroma, "#ffffff", 4.5, 0.62);
  const dim = readable(hue, chroma * 0.03 * spread, ground, 7, 0.62);
  const faint = readable(hue, chroma * 0.03 * spread, ground, 5, 0.55);

  return {
    "--shell": tone("shell"),
    "--menu": tone("menu"),
    "--menu-well": tone("menu-well"),
    "--ground": ground,
    "--rail": tone("rail"),
    "--surface": tone("surface"),
    "--ink": tone("ink"),
    "--grid-line": tone("grid-line"),
    "--accent": accentColour,
    "--accent-hover": accentHover,
    "--accent-fill": accentFill,
    "--accent-soft": tone("accent-soft"),
    "--accent-field": tone("field"),
    "--accent-wash": tone("wash"),
    "--line": tone("line"),
    "--line-soft": tone("line-soft"),
    "--line-firm": tone("line-firm"),
    "--line-strong": tone("line-strong"),
    "--text-dim": dim,
    "--text-faint": faint,
    "--aura-1": oklch(0.5, chroma * 1.0, hue),
    "--aura-2": oklch(0.46, before.chroma * reach * 1.05, before.hue),
    "--aura-3": oklch(0.54, after.chroma * reach * 0.9, after.hue),
    // Lower than the light sheet's: a glow on a dark ground carries further
    // than a tint on white, and past this it stops being a glow.
    "--aura-opacity": (0.12 + 0.36 * strength).toFixed(3),
    "--accent-pure": oklch(0.66, chroma, hue),
  };
}

function clampStrength(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return DEFAULT_STRENGTH;
  return Math.min(1, Math.max(0, value));
}

/** The one colour that stands for an accent: a rail dot, a swatch, a preview. */
export function swatchOf(accent, fallbackSeed = null) {
  const seed = seedOf(accent, fallbackSeed);
  if (!seed) return "var(--line-strong)";
  return oklch(0.62, seed.chroma, seed.hue);
}

/**
 * Write a palette onto an element, and take the previous one off.
 *
 * The removal half matters more than it looks: switching from an accent that
 * sets sixteen properties to one that sets none has to leave the element
 * clean, or the sheet keeps whichever tokens the new palette happens not to
 * mention. Every key this module can emit is in `ALL_TOKENS` for exactly that.
 */
export const ALL_TOKENS = Object.keys(palette({ mode: "preset", preset: "cornflower" }));

export function applyPalette(element, tokens) {
  if (!element) return;
  for (const name of ALL_TOKENS) element.style.removeProperty(name);
  if (!tokens) return;
  for (const [name, value] of Object.entries(tokens)) {
    element.style.setProperty(name, value);
  }
}
