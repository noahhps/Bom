/* Foundations: variables and styles.
 *
 *   Primitives  (Value)          raw colours -- :root neutrals, the no-accent
 *                                cobalt, and every preset's full palette as
 *                                lib/theme.js computes it. Hidden from pickers.
 *   Color       (Default + one   what components bind to. Each accent preset is
 *                mode per accent) a mode, so switching a frame's mode is the
 *                                Figma equivalent of theme.js applyPalette().
 *   QuickView   (Light)          quickview.css's own --qv-* tokens.
 *   Dimension   (Value)          spacing, radii, sizes and the seven-step type
 *                                scale.
 */

const FILL = ["FRAME_FILL", "SHAPE_FILL"];
const TEXT_S = ["TEXT_FILL"];
const STROKE_S = ["STROKE_COLOR"];
const BORDER = ["STROKE_COLOR", "FRAME_FILL", "SHAPE_FILL"];
const ICON_S = ["SHAPE_FILL", "STROKE_COLOR"];
const EFFECT_S = ["EFFECT_COLOR"];
const ACCENT_S = ["FRAME_FILL", "SHAPE_FILL", "STROKE_COLOR"];

// styles.css :root (and the sheet's opaque overrides in `.screen`).
const NEUTRALS = [
  ["neutral/white", "#ffffff"],
  ["neutral/paper", "#f8f9fa"],
  ["neutral/ink", "#0f172a"],
  ["neutral/dim", "#5b677a"],
  ["neutral/faint", "#5f6b7d"],
  ["neutral/line", "#d3dae6"],
  ["neutral/line-soft", "#dce2ec"],
  ["neutral/line-firm", "#c9d2e1"],
  ["neutral/line-strong", "#a9b5c8"],
  ["neutral/grid", "#f1f4f9"],
  ["neutral/plate", "#f4f6fa"],
  ["neutral/inverse-hover", "#2c313c"],
  ["root/accent", "#1f4fd8"],
  ["root/accent-hover", "#173da8"],
  ["root/accent-soft", "#5a7fe6"],
  ["root/field", "#e2e8f8"],
  ["root/wash", "#e7ecf9"],
  ["root/glow-ring", "#1f4fd8", 0.22],
  ["root/glow", "#1f4fd8", 0.34],
  ["status/green", "#0e7c66"],
  ["status/green-field", "#d8ece7"],
  ["status/ochre", "#9a6b12"],
  ["status/ochre-field", "#f3e8d2"],
  ["alpha/black-04", "#14171d", 0.04],
  ["alpha/black-06", "#14171d", 0.06],
  ["alpha/black-07", "#14171d", 0.07],
  ["alpha/black-08", "#14171d", 0.08],
  ["alpha/black-14", "#14171d", 0.14],
  ["alpha/black-30", "#14171d", 0.3],
  ["alpha/black-40", "#14171d", 0.4],
  ["alpha/black-55", "#14171d", 0.55],
  ["alpha/black-64", "#14171d", 0.64],
  ["alpha/black-66", "#14171d", 0.66],
  ["alpha/shadow-18", "#000000", 0.18],
  ["alpha/white-55", "#ffffff", 0.55],
  ["alpha/clear", "#ffffff", 0],
  ["quickview/ink", "#0e1420"],
  ["quickview/dim", "#0e1420", 0.62],
  ["quickview/faint", "#0e1420", 0.42],
  ["quickview/pill", "#14171d", 0.06],
  ["quickview/edge", "#14171d", 0.1],
  ["quickview/accent", "#4d7dfa"],
  ["utility/close", "#ff5f57"],
  ["utility/minimise", "#febc2e"],
  ["utility/zoom", "#28c840"],
];

// Which palette() keys each preset contributes.
const PRESET_TOKENS = [
  ["accent", "--accent"],
  ["accent-hover", "--accent-hover"],
  ["accent-soft", "--violet-soft"],
  ["accent-pure", "--accent-pure"],
  ["field", "--violet-field"],
  ["wash", "--blue-wash"],
  ["ink", "--ink"],
  ["text-dim", "--text-dim"],
  ["text-faint", "--text-faint"],
  ["line", "--line"],
  ["line-soft", "--line-soft"],
  ["line-firm", "--line-firm"],
  ["line-strong", "--line-strong"],
  ["grid-line", "--grid-line"],
  ["aura-1", "--aura-1"],
  ["aura-2", "--aura-2"],
  ["aura-3", "--aura-3"],
];

// Mode order: the accents the Patterns page uses first, so a plan capped at
// four modes (Default + three) still themes every reference screen.
const MODE_ORDER = ["teal", "iris", "fern", "cobalt", "rose", "ember", "brass", "mauve", "midnight", "slate"];

const acc = (tok, fallback) => (m) => (m === "default" ? fallback : `preset/${m}/${tok}`);
const same = (name) => () => name;

// [name, css custom property, scopes, primitive for a mode]
const SEMANTIC = [
  ["surface/sheet", "--ground", FILL, same("neutral/white")],
  ["surface/raised", "--surface", FILL, same("neutral/white")],
  ["surface/plate", "--rail", FILL, same("neutral/plate")],
  ["surface/inverse", "--ink", FILL, acc("ink", "neutral/ink")],
  ["surface/inverse-hover", null, FILL, same("neutral/inverse-hover")],
  ["surface/hover", null, FILL, same("alpha/black-07")],
  ["surface/hover-strong", null, FILL, same("alpha/black-08")],
  ["surface/hover-soft", null, FILL, same("alpha/black-06")],
  ["surface/wash", "--blue-wash", FILL, acc("wash", "root/wash")],
  ["surface/field", "--violet-field", FILL, acc("field", "root/field")],
  ["surface/pass", "--green-field", FILL, same("status/green-field")],
  ["surface/warn", "--ochre-field", FILL, same("status/ochre-field")],
  ["grid/line", "--grid-line", FILL, acc("grid-line", "neutral/grid")],

  ["text/primary", "--ink", TEXT_S, acc("ink", "neutral/ink")],
  ["text/secondary", "--text-dim", TEXT_S, acc("text-dim", "neutral/dim")],
  ["text/tertiary", "--text-faint", TEXT_S, acc("text-faint", "neutral/faint")],
  ["text/accent", "--accent", TEXT_S, acc("accent", "root/accent")],
  ["text/on-accent", null, TEXT_S, same("neutral/white")],
  ["text/on-inverse", null, TEXT_S, same("neutral/paper")],
  ["text/placeholder", null, TEXT_S, same("alpha/black-40")],
  ["text/quiet", null, TEXT_S, same("alpha/black-55")],
  ["text/provenance", null, TEXT_S, same("alpha/black-64")],
  ["text/reasoning", null, TEXT_S, same("alpha/black-66")],
  ["text/warn", "--ochre", TEXT_S, same("status/ochre")],

  ["border/default", "--line", BORDER, acc("line", "neutral/line")],
  ["border/soft", "--line-soft", BORDER, acc("line-soft", "neutral/line-soft")],
  ["border/firm", "--line-firm", BORDER, acc("line-firm", "neutral/line-firm")],
  ["border/strong", "--line-strong", BORDER, acc("line-strong", "neutral/line-strong")],
  ["border/composer", null, BORDER, same("alpha/black-14")],
  ["border/glass", null, BORDER, same("alpha/white-55")],

  ["accent/default", "--accent", ACCENT_S, acc("accent", "root/accent")],
  ["accent/hover", "--accent-hover", ACCENT_S, acc("accent-hover", "root/accent-hover")],
  ["accent/soft", "--violet-soft", ACCENT_S, acc("accent-soft", "root/accent-soft")],
  ["accent/pure", "--accent-pure", FILL, acc("accent-pure", "root/accent")],
  ["accent/send", "--send", FILL, acc("accent", "root/accent")],
  ["accent/glow-ring", null, EFFECT_S, acc("glow-ring", "root/glow-ring")],
  ["accent/glow", null, EFFECT_S, acc("glow", "root/glow")],

  ["aura/1", "--aura-1", ["SHAPE_FILL"], acc("aura-1", "alpha/clear")],
  ["aura/2", "--aura-2", ["SHAPE_FILL"], acc("aura-2", "alpha/clear")],
  ["aura/3", "--aura-3", ["SHAPE_FILL"], acc("aura-3", "alpha/clear")],

  ["icon/default", "--ink", ICON_S, acc("ink", "neutral/ink")],
  ["icon/secondary", "--text-dim", ICON_S, acc("text-dim", "neutral/dim")],
  ["icon/muted", "--text-faint", ICON_S, acc("text-faint", "neutral/faint")],
  ["icon/accent", "--accent", ICON_S, acc("accent", "root/accent")],
  ["icon/on-accent", null, ICON_S, same("neutral/white")],

  ["status/pass", "--green", FILL, same("status/green")],
  ["status/warn", "--ochre", FILL, same("status/ochre")],
  ["status/down", null, FILL, same("alpha/black-30")],

  ["shadow/soft", null, EFFECT_S, same("alpha/black-04")],
  ["shadow/composer", null, EFFECT_S, same("alpha/black-40")],
  ["shadow/window", null, EFFECT_S, same("alpha/shadow-18")],
];

const QUICKVIEW = [
  ["qv/ink", "--qv-ink", ["TEXT_FILL", "SHAPE_FILL", "STROKE_COLOR"], "quickview/ink"],
  ["qv/text-dim", "--qv-dim", TEXT_S, "quickview/dim"],
  ["qv/text-faint", "--qv-faint", TEXT_S, "quickview/faint"],
  ["qv/pill", "--qv-pill", FILL, "quickview/pill"],
  ["qv/edge", "--qv-edge", STROKE_S, "quickview/edge"],
  ["qv/accent", "--qv-accent", FILL, "quickview/accent"],
  ["qv/composer", null, FILL, "neutral/white"],
];

const SPACE = [2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 22, 26, 28, 34];
const RADII = [
  ["radius/square", 3, "--r-surface"],
  ["radius/row", 8, null],
  ["radius/list", 10, null],
  ["radius/card", 14, null],
  ["radius/composer", 16, null],
  ["radius/quickview", 18, "--qv-radius"],
  ["radius/full", 999, null],
];
const SIZES = [
  ["size/rail", 252, "--rail-open"],
  ["size/read", 780, "--read-w"],
  ["size/topbar", 64, null],
  ["size/grid", 22, "--grid-step"],
  ["size/icon", 18, null],
  ["size/icon-sm", 14, null],
  ["size/control", 32, null],
  ["size/icon-button", 34, null],
  ["size/provider", 24, null],
  ["size/disc", 22, null],
  ["size/dot", 7, null],
  ["size/qv-button", 28, null],
];
const TYPE_SCALE = [
  ["type/micro", 9.5, "--t-micro"],
  ["type/xs", 11.5, "--t-xs"],
  ["type/sm", 12.5, "--t-sm"],
  ["type/md", 13.5, "--t-md"],
  ["type/body", 15, "--t-body"],
  ["type/lg", 19, "--t-lg"],
  ["type/xl", 27, "--t-xl"],
];

// [name, weight, size, line height %, tracking %, uppercase, size variable, what it is]
const TEXT_STYLES = [
  ["Label/Micro", "Medium", 9.5, 100, 16, true, "type/micro", ".mi -- the tracked-out machine label, and nothing else"],
  ["Control/XS", "Regular", 11.5, 100, 0, false, "type/xs", "chips and effort options"],
  ["Control/SM", "Regular", 12.5, 100, 0, false, "type/sm", "buttons, the project select"],
  ["Control/SM Strong", "Medium", 12.5, 100, 0, false, "type/sm", "approval buttons"],
  ["UI/XS", "Regular", 11.5, 140, 0, false, "type/xs", "captions and metadata under a control"],
  ["UI/SM", "Regular", 12.5, 150, 0, false, "type/sm", "secondary text: hints, args, timestamps, conversation rows"],
  ["UI/SM Strong", "Medium", 12.5, 130, 0, false, "type/sm", "a skill name being asked about"],
  ["UI/MD", "Regular", 13.5, 130, 0, false, "type/md", "primary UI text: rows, list items"],
  ["UI/MD Strong", "Medium", 13.5, 130, 0, false, "type/md", "the current destination, a starter title"],
  ["UI/MD Prose", "Regular", 13.5, 160, 0, false, "type/md", "callouts and descriptions"],
  ["Body/Prose", "Regular", 15, 172, 0, false, "type/body", "an answer -- the one long read in the app"],
  ["Body/Prose Strong", "Medium", 15, 172, 0, false, "type/body", "emphasis inside an answer"],
  ["Body/Bubble", "Regular", 15, 165, 0, false, "type/body", "what the user typed"],
  ["Body/Input", "Regular", 15, 150, 0, false, "type/body", "the composer"],
  ["Heading/Section", "Regular", 19, 130, 0, false, "type/lg", "the top bar title"],
  ["Heading/Page", "Medium", 27, 120, 0, false, "type/xl", "a page heading"],
  ["QuickView/Thread", "Regular", 12.5, 165, 0, false, "type/sm", "QuickView's conversation"],
  ["QuickView/Input", "Regular", 13, 155, 0, false, null, "QuickView's composer"],
  ["Display/Cover", "Medium", 96, 100, 0, false, null, "documentation only"],
];

async function buildTokens() {
  const newColl = (name, modeName) => {
    const c = figma.variables.createVariableCollection(name);
    c.renameMode(c.modes[0].modeId, modeName);
    return c;
  };
  const mk = (coll, name, type, value, scopes, css) => {
    const v = figma.variables.createVariable(name, coll, type);
    v.setValueForMode(coll.modes[0].modeId, value);
    v.scopes = scopes;
    if (css) v.setVariableCodeSyntax("WEB", `var(${css})`);
    V[name] = v;
    return v;
  };
  const alias = (name) => {
    if (!V[name]) throw new Error("No primitive " + name);
    return figma.variables.createVariableAlias(V[name]);
  };

  // Primitives.
  const prim = newColl("Primitives", "Value");
  for (const [name, h, a] of NEUTRALS) {
    mk(prim, name, "COLOR", rgba(h, a == null ? 1 : a), name.startsWith("alpha/") ? EFFECT_S : []);
  }
  for (const p of DATA.presets) {
    const pal = DATA.palettes[p.id];
    for (const [tok, css] of PRESET_TOKENS) mk(prim, `preset/${p.id}/${tok}`, "COLOR", rgba(pal[css]), []);
    mk(prim, `preset/${p.id}/glow-ring`, "COLOR", rgba(pal["--accent"], 0.22), []);
    mk(prim, `preset/${p.id}/glow`, "COLOR", rgba(pal["--accent"], 0.34), []);
  }

  // Color, one mode per accent -- as many as the plan allows.
  COLOR_COLL = newColl("Color", "Default");
  MODES = [{ key: "default", id: COLOR_COLL.modes[0].modeId, name: "Default" }];
  for (const id of MODE_ORDER) {
    const preset = DATA.presets.find((p) => p.id === id);
    if (!preset) continue;
    try {
      MODES.push({ key: id, id: COLOR_COLL.addMode(preset.name), name: preset.name });
    } catch (e) {
      NOTES.push(
        `Color has ${MODES.length} mode(s): this plan caps modes per collection, so ${MODE_ORDER.length + 1 - MODES.length} accent presets are primitives only.`,
      );
      break;
    }
  }
  for (const [name, css, scopes, pick] of SEMANTIC) {
    const v = figma.variables.createVariable(name, COLOR_COLL, "COLOR");
    for (const m of MODES) v.setValueForMode(m.id, alias(pick(m.key)));
    v.scopes = scopes;
    if (css) v.setVariableCodeSyntax("WEB", `var(${css})`);
    V[name] = v;
  }

  const qv = newColl("QuickView", "Light");
  for (const [name, css, scopes, prim] of QUICKVIEW) mk(qv, name, "COLOR", alias(prim), scopes, css);

  const dim = newColl("Dimension", "Value");
  for (const n of SPACE) mk(dim, `space/${n}`, "FLOAT", n, ["GAP"], null);
  for (const [name, value, css] of RADII) mk(dim, name, "FLOAT", value, ["CORNER_RADIUS"], css);
  for (const [name, value, css] of SIZES) mk(dim, name, "FLOAT", value, ["WIDTH_HEIGHT"], css);
  for (const [name, value, css] of TYPE_SCALE) mk(dim, name, "FLOAT", value, ["FONT_SIZE"], css);
}

async function buildStyles() {
  for (const [name, weight, size, lh, track, upper, sizeVar, what] of TEXT_STYLES) {
    const s = figma.createTextStyle();
    s.name = name;
    s.fontName = { family: "DM Mono", style: weight };
    s.fontSize = size;
    s.lineHeight = { unit: "PERCENT", value: lh };
    s.letterSpacing = { unit: "PERCENT", value: track };
    if (upper) s.textCase = "UPPER";
    s.description = what;
    if (sizeVar && V[sizeVar]) {
      try {
        s.setBoundVariable("fontSize", V[sizeVar]);
      } catch (e) {
        // Older runtimes cannot bind a style's size; the value is already set.
      }
    }
    TS[name] = s;
  }

  const shadow = (colourVar, x, y, r, spread = 0) =>
    figma.variables.setBoundVariableForEffect(
      { type: "DROP_SHADOW", color: { r: 0, g: 0, b: 0, a: 1 }, offset: { x, y }, radius: r, spread, visible: true, blendMode: "NORMAL" },
      "color",
      V[colourVar],
    );
  const blur = (type, r) => ({ type, radius: r, visible: true });
  const effect = (name, effects, what) => {
    const s = figma.createEffectStyle();
    s.name = name;
    s.effects = effects;
    s.description = what;
    ES[name] = s;
  };
  const rest = [shadow("shadow/soft", 0, 1, 2), shadow("shadow/composer", 0, 8, 24, -18)];
  effect("Elevation/Composer", rest, "The composer at rest: .composer-box box-shadow.");
  effect(
    "Elevation/Composer raised",
    rest.concat([shadow("accent/glow-ring", 0, 0, 0, 1), shadow("accent/glow", 0, 8, 34, -10)]),
    "Raised (--near: 1): the accent glow from .composer-box::before joins the rest shadow.",
  );
  effect("Elevation/Window", [shadow("shadow/window", 0, 22, 50)], "A window over the desktop.");
  effect("Glass/Rail", [blur("BACKGROUND_BLUR", 30)], "The pinned sidebar over the HudWindow material.");
  effect("Glass/QuickView", [blur("BACKGROUND_BLUR", 50), shadow("shadow/window", 0, 22, 50)], "QuickView's frosted window.");
}
