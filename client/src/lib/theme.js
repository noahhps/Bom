/* Accents: one hue in, BoardUI's accent ramp out.
 *
 * An accent is a petal (lib/petals.js) or a custom hue: the hues the logo is
 * drawn in are the hues the app can wear. What it produces is the eleven-step
 * `--color-accent-*` ramp BoardUI re-tints itself through, written onto
 * <html> by hooks/useTheme.js, plus the ambient glow behind the sheet (the
 * `--aura-*` tokens, painted by `.app::before` in styles.css).
 *
 * Before the BoardUI overhaul this module also tinted every surface, line and
 * grey in the accent's hue. Those are BoardUI's neutrals now, in every chat;
 * the ladder that drew them is in the `.ui-revert` snapshot taken before the
 * change.
 */

import { oklch } from "./color";
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

/* The ramp. BoardUI re-tints its whole system -- the primary button's
 * gradient, focus rings, the selected nav row, switches, checkboxes, tabs,
 * ghost buttons -- through eleven `--color-accent-*` variables, and Bom's own
 * accent tokens (`--accent`, `--accent-field`, ...) are pointed at the same
 * steps in styles/bom-boardui.css. So an accent is no longer a ladder of
 * tinted surfaces: the surfaces are BoardUI's neutrals in every chat, and the
 * hue lands only on what you act on and what is selected, which is how
 * BoardUI uses colour.
 *
 * Each step is [OKLCH lightness, chroma as a fraction of the seed's], read off
 * Tailwind v4's blue ramp -- BoardUI's default accent -- so a petal's ramp has
 * the same rhythm as the one it replaces, at every hue. `oklch()` gamut-maps,
 * so a fraction above 1 at a mid lightness simply takes all the chroma sRGB
 * has there. */
const RAMP = {
  50: [0.97, 0.07],
  100: [0.932, 0.15],
  200: [0.882, 0.28],
  300: [0.809, 0.49],
  400: [0.707, 0.77],
  500: [0.623, 1.0],
  600: [0.546, 1.05],
  700: [0.488, 0.95],
  800: [0.424, 0.8],
  900: [0.379, 0.67],
  950: [0.282, 0.5],
};

/**
 * Every custom property an accent sets, as a plain object ready to be written
 * onto an element's style: the eleven-step BoardUI accent ramp, and the
 * ambient field behind the sheet.
 *
 * Returns null for "off", which the caller reads as "clear what you set and
 * let the stylesheet stand" -- BoardUI's default blue.
 *
 * `mode` still selects the glow's depth; the ramp itself is the same in light
 * and dark, as BoardUI's is -- the dark theme simply reads it from the light
 * end (see the dark block in styles/bom-boardui.css).
 */
export function palette(accent, fallbackSeed = null, mode = "light") {
  const seed = seedOf(accent, fallbackSeed);
  if (!seed) return null;
  const { hue, chroma } = seed;
  const strength = clampStrength(accent?.strength);
  const dark = mode === "dark";

  const tokens = {};
  for (const [step, [lightness, fraction]] of Object.entries(RAMP)) {
    tokens[`--color-accent-${step}`] = oklch(lightness, chroma * fraction, hue);
  }

  /* The ambient field: three soft discs of colour behind everything, and
   * they are petals -- the accent's own in the middle and the petal either
   * side of it on the flower in the other two. `strength` now sets only how
   * much of it shows: BoardUI's surfaces stay neutral whatever it is. */
  const reach = Math.min(1, chroma / 0.1);
  const [before, after] = neighbours(hue);
  if (dark) {
    tokens["--aura-1"] = oklch(0.5, chroma, hue);
    tokens["--aura-2"] = oklch(0.46, before.chroma * reach * 1.05, before.hue);
    tokens["--aura-3"] = oklch(0.54, after.chroma * reach * 0.9, after.hue);
    tokens["--aura-opacity"] = (0.08 + 0.24 * strength).toFixed(3);
  } else {
    tokens["--aura-1"] = oklch(0.845, chroma * 0.95, hue);
    tokens["--aura-2"] = oklch(0.8, before.chroma * reach * 1.05, before.hue);
    tokens["--aura-3"] = oklch(0.88, after.chroma * reach * 0.85, after.hue);
    tokens["--aura-opacity"] = (0.08 + 0.32 * strength).toFixed(3);
  }
  return tokens;
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
