/* The flower's eight petals -- the app's palette.
 *
 * The logo is the one place the app was ever sure of its colour, so the rest
 * of the sheet takes its colour from the logo rather than the other way round.
 * Each petal is kept three ways: the hex the logo is drawn in (bom-logo.svg,
 * `.flower-petal` in styles.css), and the OKLCH hue and chroma measured off
 * that hex, which is what theme.js needs to build a ladder from it.
 *
 * Order is the flower's: clockwise from the top petal. The accent swatches,
 * the bloom behind an empty conversation and the areas of the rail all read
 * this list, so a petal changed here changes everywhere it appears. The CSS
 * copies (`--petal-*` in styles.css) have to be changed with it -- the
 * stylesheet cannot import a module.
 *
 * Petals are fills. At lightness 0.62-0.85 most of them fail as text on white
 * (the yellow is 1.6:1), so anything that carries words goes through
 * `readable()` in theme.js, which walks the same hue down until it clears. */
export const PETALS = [
  { id: "poppy", name: "Poppy", hex: "#ef5b5b", hue: 23, chroma: 0.183 },
  { id: "marigold", name: "Marigold", hex: "#f59a3d", hue: 62, chroma: 0.15 },
  { id: "buttercup", name: "Buttercup", hex: "#f2c94c", hue: 90, chroma: 0.146 },
  { id: "fern", name: "Fern", hex: "#6cc04a", hue: 138, chroma: 0.175 },
  { id: "lagoon", name: "Lagoon", hex: "#2fb8a6", hue: 182, chroma: 0.116 },
  { id: "cornflower", name: "Cornflower", hex: "#4a90e2", hue: 254, chroma: 0.142 },
  { id: "violet", name: "Violet", hex: "#8b6ce0", hue: 293, chroma: 0.17 },
  { id: "orchid", name: "Orchid", hex: "#e564a8", hue: 350, chroma: 0.176 },
];

export const PETAL_BY_ID = new Map(PETALS.map((petal) => [petal.id, petal]));

/** The petal nearest a hue, for anything that arrives as a bare hue. */
export function nearestPetal(hue) {
  let best = PETALS[0];
  let gap = 360;
  for (const petal of PETALS) {
    const d = Math.abs(((hue - petal.hue + 540) % 360) - 180);
    if (d < gap) {
      gap = d;
      best = petal;
    }
  }
  return best;
}

/** The petals either side of one on the flower -- the bloom's neighbours. */
export function neighbours(hue) {
  const at = PETALS.indexOf(nearestPetal(hue));
  return [
    PETALS[(at + PETALS.length - 1) % PETALS.length],
    PETALS[(at + 1) % PETALS.length],
  ];
}
