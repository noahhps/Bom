"""Ready-made design standards, as design.md documents.

A design.md is the styling brief a result is held to: type, colour, spacing,
components, and the voice the words are written in. Handed to the model before
it writes a document, a page or a deck, it is the difference between eight
results that each invented their own look and eight that belong together.

These presets are written for this project rather than lifted from anyone's
brand book: each one describes a well-known design *tradition* in its own
words, with concrete numbers a model can actually follow. They are a starting
point, not a rule -- the reader's own design.md, uploaded on the Design page,
sits beside these and is picked the same way.

Every document follows the same six headings, so the model reads the same shape
whichever is chosen and a reader writing their own has a template to copy.
"""

from __future__ import annotations

import json
import re

SWISS = """# Swiss / International Typographic

Order before ornament. The grid is the design; everything else is restraint.

## Principles
- The page is built on a visible, consistent grid. Alignment is the only
  decoration that earns its place.
- Asymmetry over centring. A left-aligned column with generous space to its
  right is more confident than anything centred.
- White space is structure, not leftover. Doubling a margin is a design
  decision; filling it is a failure of nerve.

## Type
- One grotesque sans for everything: Helvetica, Inter, Neue Haas, or the
  nearest available. Never pair two sans faces.
- Scale, in a strict ratio: 12 / 16 / 24 / 36 / 56 px. Nothing between.
- Headings: weight 600, tight tracking (-0.02em), never italic, never centred.
- Body: 16px, line-height 1.5, measure capped at 65 characters.
- Set headings flush left, ragged right. No justification, no hyphenation.

## Colour
- Black, white, and one accent. That is the whole palette.
- Accent is a pure, saturated red (#E3000F) used for at most 5% of the page:
  a rule, a number, a single word.
- Greys are the accent's absence, not a third colour: #111, #767676, #E5E5E5.
- Never use colour to decorate. Use it to mark one thing as the most important.

## Layout
- 12-column grid, 24px gutters, 48px outer margin.
- Spacing scale: 8 / 16 / 24 / 48 / 96. Multiples of 8, no exceptions.
- Rules (hairlines) divide sections: 1px, #E5E5E5, full column width.
- Images sit flush to the grid and are never given rounded corners or shadows.

## Components
- Tables: no vertical rules, 1px horizontal rules only, numbers right-aligned
  and tabular-figured.
- Buttons: rectangular, no radius, black fill with white text, no shadow.
- Captions: 12px, grey, directly beneath the thing, never italic.

## Voice
Factual and unhedged. State the thing and stop. No exclamation marks, no
rhetorical questions, no words like "simply" or "just".
"""

EDITORIAL = """# Editorial

A magazine feature: a strong opening, a readable column, and typography doing
the emotional work.

## Principles
- The opening has to earn the rest. A large, confident headline and a standfirst
  before any body copy.
- Rhythm over uniformity. Long passages of body text broken by pull quotes,
  subheads and images at irregular but deliberate intervals.
- The reading column is sacred: never let furniture crowd it.

## Type
- A serif for body, a sans for furniture (labels, captions, decks). Two faces,
  no more.
- Body serif: 18-19px, line-height 1.65, measure 62-68 characters.
- Headline: 44-72px, weight 700, tracking -0.03em, line-height 1.05.
- Standfirst: 22px, weight 400, grey, line-height 1.4, max 2 lines.
- Pull quote: 28px italic serif, no quotation marks, hairline rule above.
- Small caps and old-style figures wherever the face has them.

## Colour
- Paper and ink first: #FBFAF8 ground, #1A1A1A text.
- One editorial accent, muted rather than bright: oxblood #7B2D26, or ink blue
  #1F3A5F. Used on rules, drop caps, and links.
- Never more than two greys: #6B6B6B for secondary, #DDD9D2 for rules.

## Layout
- Single column, centred in the page, 680px maximum.
- Vertical rhythm on a 4px baseline; paragraph spacing 0, first-line indent
  1.5em after the first paragraph.
- Images run full-bleed or exactly column width -- never in between.
- Generous section breaks: 64px, optionally marked with a centred ornament.

## Components
- Drop cap on the first paragraph: 3 lines tall, accent coloured.
- Captions: sans, 13px, grey, one line where possible.
- Bylines: sans, uppercase, 12px, letterspaced 0.08em.

## Voice
Written, not assembled. Full sentences, varied length, a point of view. Prefer
the concrete noun to the abstract one. No bullet lists where a paragraph works.
"""

BRUTALIST = """# Brutalist Web

The structure is the style. Nothing is hidden, softened, or apologised for.

## Principles
- Show the material. Default borders, visible boxes, unstyled focus rings kept
  rather than replaced.
- Contrast is loud and deliberate. Hierarchy comes from size and weight, never
  from subtlety.
- Asymmetry, overlap and density are welcome. Tidiness is not the goal;
  legibility is.

## Type
- One monospace or one heavy grotesque. Bom, Departure Mono, Arial Black,
  Helvetica Bold.
- Headings are enormous: 64-120px, weight 800-900, line-height 0.95, often
  uppercase, often overflowing their container.
- Body: 16-18px, line-height 1.45, measure up to 80 characters (wide is fine).
- Underline every link, always, with a 2px underline. No hover-only affordance.

## Colour
- High contrast only. Pure black #000 on pure white #FFF, or inverted.
- One alarming accent used at full saturation: #FF3B00, #00FF66 or #FFFF00.
- No gradients, no tints, no transparency. A colour is either on or it is not.

## Layout
- Hard 2-4px black borders on every container. Boxes inside boxes are fine.
- No border radius anywhere. No shadows except hard offset ones (4px 4px 0 #000).
- Spacing is coarse: 0 / 8 / 32 / 64. Cramped next to spacious is the point.
- Let content overflow deliberately; do not hide it.

## Components
- Buttons: black border, white fill, hard offset shadow, invert on hover,
  shadow removed and translated 4px on press.
- Tables: every cell bordered. Header row inverted.
- Inputs: 2px border, square, no placeholder styling tricks.

## Voice
Blunt and declarative. Short sentences. Say what a thing is. Avoid marketing
verbs entirely -- nothing "empowers", "unlocks" or "delights".
"""

TERMINAL = """# Terminal

Monospace, dense, and honest about being a machine. Everything on a character
grid.

## Principles
- One typeface, one rhythm. Every glyph the same width means every column lines
  up for free -- use that rather than fighting it.
- Density is a feature. Information per screen matters more than breathing room.
- Decoration is drawn with characters, not graphics: rules from dashes, boxes
  from pipes, emphasis from brackets.

## Type
- A single monospace: JetBrains Mono, IBM Plex Mono, SF Mono, ui-monospace.
- Body: 13-14px, line-height 1.5. Everything is body; there is barely a scale.
- Headings: same size, uppercase, letterspaced 0.1em, often prefixed (`## `,
  `>> `, `[ ]`).
- Never bold more than one word in a line. Italics not at all.

## Colour
- A terminal palette on a near-black ground: #0D1117 background, #C9D1D9 text.
- Six accents, used semantically and never decoratively: green #3FB950 (ok),
  red #F85149 (error), yellow #D29922 (warning), blue #58A6FF (link),
  magenta #BC8CFF (value), grey #8B949E (comment).
- Light variant: #FAFAFA ground, #24292F text, the same six darkened.

## Layout
- Fixed measure of 80 characters. Wrap, never expand.
- Spacing in line units: 1 line, 2 lines. No pixel values.
- Rules are full-width runs of `─` or `-`.
- Indentation is two spaces, always, and carries structure.

## Components
- Tables: space-padded columns, a single `─` rule under the header. Numbers
  right-aligned.
- Status: a bracketed token at line start -- `[ok]`, `[warn]`, `[fail]`.
- Code: no box, no background; it is all code already.
- Prompts and commands prefixed with `$ `.

## Voice
Terse and imperative. Lowercase is fine. Report state, not feelings: "3 failed"
rather than "unfortunately 3 tests failed".
"""

SOFT = """# Soft Product UI

Friendly, rounded, and calm. The look of a well-made consumer app.

## Principles
- Nothing sharp, nothing harsh. Corners are rounded, contrast is moderate, and
  motion is gentle.
- Depth is suggested with a single soft shadow and a tint, never with heavy
  borders or hard edges.
- Generous padding everywhere: a cramped card reads as cheap.

## Type
- One humanist sans: Inter, SF Pro, Geist, Figtree.
- Scale: 13 / 15 / 17 / 20 / 28 / 40px.
- Headings: weight 600, tracking -0.01em, line-height 1.25.
- Body: 15-17px, line-height 1.6, measure 60-70 characters.
- Numbers tabular wherever they are compared.

## Colour
- A light, slightly warm ground: #FBFBFD. Surfaces sit above it in pure white.
- Text: #16181D primary, #6E7481 secondary. Never pure black.
- One brand hue with a full tint ramp -- 50 / 100 / 500 / 600 / 900. Use 500
  for actions, 50 for washes, 900 only for text on a tint.
- Semantic: green #10B981, amber #F59E0B, red #EF4444. Each with a 50-level
  wash for backgrounds.
- Every text colour checked to 4.5:1 against the ground it sits on.

## Layout
- Radius scale: 8px (controls), 14px (cards), 24px (sheets), 999px (pills).
- Shadow: one soft elevation, `0 1px 2px rgba(16,24,40,.06), 0 8px 24px
  rgba(16,24,40,.08)`. Never stack two.
- Spacing: 4 / 8 / 12 / 16 / 24 / 32 / 48.
- Cards: 24px padding, 1px #ECEDF1 border *and* the soft shadow.

## Components
- Primary button: brand-500 fill, white text, 10px radius, 10px/18px padding,
  darkens to 600 on hover.
- Secondary: white fill, 1px #E4E6EB border, same geometry.
- Inputs: 1px border, 10px radius, brand-500 ring at 3px on focus.
- Empty states get an illustration or a large glyph, a line of explanation and
  exactly one action.

## Voice
Warm, plain, second person. Short sentences. Explain what happened and what to
do next. Never blame the reader; never use "oops".
"""

ACADEMIC = """# Academic Paper

Built to be read closely, cited, and printed. Authority through restraint.

## Principles
- The argument is the design. Structure, numbering and references carry the
  weight; nothing decorative competes with them.
- Every claim is attributable. Figures, tables and sections are numbered so they
  can be referred to precisely.
- It must survive being printed in black and white.

## Type
- A text serif: Computer Modern, Charter, Source Serif, Libertinus.
- Body: 11-12pt (16px on screen), line-height 1.45, measure 65-72 characters.
- Headings numbered and modest: 1., 1.1, 1.1.1 -- bold, same family, at most
  1.4x body size.
- Footnotes 9pt. Captions 9-10pt. Monospace only for code and identifiers.
- Italics for emphasis and terms of art; bold almost never in running text.

## Colour
- Black on white. That is the design.
- One restrained accent for links and cross-references only: #0B5394.
- Figures may use colour, but must remain legible converted to greyscale --
  differentiate by shape, hatch or label as well as hue.

## Layout
- Single column at 6.5in measure, or two columns at 3.2in for dense work.
- First line indented 1.5em; no blank line between paragraphs.
- Abstract set narrower than the body, italic or smaller, above the first
  section.
- Figures and tables float to the top of a page and are always referenced in
  the text before they appear.

## Components
- Tables: booktabs style -- a thick rule above, a thin rule under the header, a
  thick rule below. No vertical rules ever.
- Figure captions below the figure; table captions above the table.
- Equations centred and numbered on the right.
- References in a consistent style, alphabetical, hanging indent.

## Voice
Precise, impersonal, hedged where the evidence is. Define terms on first use.
Prefer "we observe" to "it is obvious". State limitations explicitly.
"""

MEMO = """# Business Memo

A document that survives being forwarded. Scannable in thirty seconds, complete
in five minutes.

## Principles
- Answer first. The recommendation goes in the first three lines, before any
  background.
- Every section must be skimmable from its heading alone.
- One page if it can be. Appendices carry the detail.

## Type
- One neutral sans, or the house face: Arial, Helvetica, Calibri, Inter.
- Body: 11pt / 15px, line-height 1.5, measure 80-90 characters.
- Headings: bold, same family, 1.15x body. Sentence case, not title case.
- No italics except for document titles. No decorative faces anywhere.

## Colour
- Black text on white. Grey #595959 for secondary and captions.
- One corporate accent for headings, rules and chart series: navy #1F3864 or
  teal #0F6E6E.
- Status colours used sparingly and always labelled as well as coloured:
  green #227A3D, amber #B36B00, red #B3261E.

## Layout
- Header block: TO / FROM / DATE / SUBJECT, label column left-aligned and
  bolded, 12px gap between rows, hairline rule beneath.
- Sections in fixed order: Recommendation, Context, Options, Risks, Next steps.
- Spacing: 12 / 18 / 28. Paragraph spacing 10px, no first-line indent.
- Page numbers and a short running title on every page after the first.

## Components
- Bullets: one line each where possible, parallel grammar, no sub-bullets past
  one level.
- Decisions called out in a bordered box with the decision, the owner and the
  date.
- Tables for options comparison: criteria down the left, options across.
- Charts labelled directly rather than with a legend.

## Voice
Direct, unhedged, and owned. Name who does what by when. Use numbers rather
than adjectives -- "down 12% since March", not "significantly down". Cut every
sentence that does not change a decision.
"""

ZINE = """# Zine

Cut, pasted and photocopied. Energetic, handmade, and a little wrong on
purpose.

## Principles
- Imperfection is the point: slight rotations, uneven margins, visible seams.
- Collage over composition. Elements overlap, tape and torn edges are welcome.
- Loud, direct and fast to read. This is a poster that happens to have pages.

## Type
- Mix deliberately: one heavy display face, one typewriter, one handwriting.
  Three is the maximum and all three should be obvious.
- Headlines 48-96px, often rotated 1-3 degrees, sometimes set in a photocopied
  block of inverted colour.
- Body: typewriter face, 15-16px, line-height 1.5. Ragged right always.
- Uppercase for shouting, and shout often. Letterspacing wide (0.06em) on
  uppercase runs.

## Colour
- Risograph duotone: one fluorescent and one dark. Fluoro pink #FF48B0 with
  ink blue #2A3ABF, or safety orange #FF5C00 with black.
- Paper is never white: newsprint #F2EDE3 or manila #EADFC4.
- Colours misregister on purpose -- offset a fill 2-3px from its outline.

## Layout
- No grid. Place by eye, then push one element out of alignment.
- Elements rotated between -4 and +4 degrees; never more, or it reads as an
  accident rather than a choice.
- Hard photocopy edges: 3px black borders, halftone or dither fills.
- Margins uneven by design: tight on one side, generous on another.

## Components
- Images: high-contrast threshold or halftone, never smooth greyscale.
- Callouts: a rotated rectangle of flat fluoro with text knocked out.
- Rules: torn-paper edges or repeated glyphs (`✂︎ - - - - -`).
- Page numbers hand-drawn or stamped in a corner, inconsistently placed.

## Voice
First person, urgent, funny. Fragments are fine. Exclamation marks allowed --
sparingly enough that they still land. Say the unpolished true thing rather
than the smooth one.
"""

# The list the API serves and the chooser shows. Ordered roughly from most
# restrained to most expressive, because that is the axis a reader is actually
# choosing along.
PRESETS: list[dict] = [
    {
        "id": "swiss",
        "name": "Swiss",
        "summary": "Grid, one grotesque, black and one red. Order before ornament.",
        "tags": ["minimal", "grid", "typographic"],
        "markdown": SWISS,
        "tokens": {
            "background": "#FFFFFF", "surface": "#F4F4F4", "text": "#111111",
            "muted": "#767676", "accent": "#E3000F", "line": "#E5E5E5",
            "heading_font": "'Helvetica Neue', Helvetica, Inter, Arial, sans-serif",
            "body_font": "'Helvetica Neue', Helvetica, Inter, Arial, sans-serif",
            "heading_weight": 600, "heading_case": "none", "radius": 0,
        },
    },
    {
        "id": "academic",
        "name": "Academic paper",
        "summary": "Numbered sections, a text serif, black on white, survives printing.",
        "tags": ["formal", "print", "cited"],
        "markdown": ACADEMIC,
        "tokens": {
            "background": "#FFFFFF", "surface": "#F6F6F4", "text": "#111111",
            "muted": "#555555", "accent": "#0B5394", "line": "#CFCFCF",
            "heading_font": "Charter, 'Source Serif 4', 'Iowan Old Style', Georgia, serif",
            "body_font": "Charter, 'Source Serif 4', 'Iowan Old Style', Georgia, serif",
            "heading_weight": 700, "heading_case": "none", "radius": 0,
        },
    },
    {
        "id": "memo",
        "name": "Business memo",
        "summary": "Answer first, skimmable headings, one page where possible.",
        "tags": ["business", "concise", "decision"],
        "markdown": MEMO,
        "tokens": {
            "background": "#FFFFFF", "surface": "#F3F5F8", "text": "#1A1A1A",
            "muted": "#595959", "accent": "#1F3864", "line": "#D9D9D9",
            "heading_font": "Inter, Calibri, Arial, Helvetica, sans-serif",
            "body_font": "Inter, Calibri, Arial, Helvetica, sans-serif",
            "heading_weight": 700, "heading_case": "none", "radius": 2,
        },
    },
    {
        "id": "editorial",
        "name": "Editorial",
        "summary": "Magazine feature: serif body, big headline, pull quotes, one column.",
        "tags": ["longform", "serif", "magazine"],
        "markdown": EDITORIAL,
        "tokens": {
            "background": "#FBFAF8", "surface": "#F2EFEA", "text": "#1A1A1A",
            "muted": "#6B6B6B", "accent": "#7B2D26", "line": "#DDD9D2",
            "heading_font": "'Playfair Display', 'Iowan Old Style', Georgia, serif",
            "body_font": "Georgia, 'Source Serif 4', 'Iowan Old Style', serif",
            "heading_weight": 700, "heading_case": "none", "radius": 0,
        },
    },
    {
        "id": "soft",
        "name": "Soft product UI",
        "summary": "Rounded, calm, one brand ramp and a single soft shadow.",
        "tags": ["product", "ui", "friendly"],
        "markdown": SOFT,
        "tokens": {
            "background": "#FBFBFD", "surface": "#FFFFFF", "text": "#16181D",
            "muted": "#6E7481", "accent": "#5B5BD6", "accent_2": "#10B981",
            "line": "#ECEDF1",
            "heading_font": "Inter, 'SF Pro Display', Figtree, system-ui, sans-serif",
            "body_font": "Inter, 'SF Pro Text', Figtree, system-ui, sans-serif",
            "heading_weight": 600, "heading_case": "none", "radius": 14,
        },
    },
    {
        "id": "terminal",
        "name": "Terminal",
        "summary": "Monospace on a character grid, six semantic colours, dense.",
        "tags": ["mono", "dense", "technical"],
        "markdown": TERMINAL,
        "tokens": {
            "background": "#0D1117", "surface": "#161B22", "text": "#C9D1D9",
            "muted": "#8B949E", "accent": "#3FB950", "accent_2": "#58A6FF",
            "line": "#30363D",
            "heading_font": "'JetBrains Mono', 'IBM Plex Mono', 'SF Mono', ui-monospace, monospace",
            "body_font": "'JetBrains Mono', 'IBM Plex Mono', 'SF Mono', ui-monospace, monospace",
            "heading_weight": 600, "heading_case": "upper", "radius": 0,
        },
    },
    {
        "id": "brutalist",
        "name": "Brutalist web",
        "summary": "Hard borders, no radius, enormous type, one alarming accent.",
        "tags": ["loud", "high-contrast", "raw"],
        "markdown": BRUTALIST,
        "tokens": {
            "background": "#FFFFFF", "surface": "#FFFFFF", "text": "#000000",
            "muted": "#222222", "accent": "#FF3B00", "line": "#000000",
            "heading_font": "'Arial Black', 'Helvetica Neue', Arial, sans-serif",
            "body_font": "'Helvetica Neue', Helvetica, Arial, sans-serif",
            "heading_weight": 900, "heading_case": "upper", "radius": 0,
        },
    },
    {
        "id": "zine",
        "name": "Zine",
        "summary": "Riso duotone, mixed faces, rotated collage, handmade and loud.",
        "tags": ["expressive", "handmade", "poster"],
        "markdown": ZINE,
        "tokens": {
            "background": "#F2EDE3", "surface": "#EADFC4", "text": "#1B1B1B",
            "muted": "#4A4A4A", "accent": "#FF48B0", "accent_2": "#2A3ABF",
            "line": "#1B1B1B",
            "heading_font": "'Arial Black', Impact, 'Helvetica Neue', sans-serif",
            "body_font": "'Courier New', 'Courier Prime', Courier, monospace",
            "heading_weight": 900, "heading_case": "upper", "radius": 0,
        },
    },
]


# -- theme tokens --------------------------------------------------------------
#
# The markdown is for the model to read; these are for the tools to apply. A
# deck or a sheet is drawn by the client from structured data, so its look is a
# handful of named values rather than a stylesheet -- and a preset carries the
# values its own document describes, so choosing "Swiss" can colour a deck the
# model already wrote without asking it to write the deck again.
#
# The same keys are what write_slides and write_sheet accept as `theme`, so a
# model styling to a custom design.md fills in the same shape by hand.

THEME_KEYS = (
    "background",      # the page / slide ground
    "surface",         # a card, a table stripe, a callout
    "text",            # body text
    "muted",           # captions, labels, secondary text
    "accent",          # the one colour that means "look here"
    "accent_2",        # an optional second, for a duotone or a chart series
    "line",            # rules and borders
    "heading_font",    # a CSS font stack
    "body_font",
    "heading_weight",  # 300-900
    "heading_case",    # "upper" or "none"
    "radius",          # px, 0-48
)

_COLOUR_KEYS = {"background", "surface", "text", "muted", "accent", "accent_2", "line"}
_FONT_KEYS = {"heading_font", "body_font"}

# A colour the client can put in a style attribute without it becoming a second
# declaration: hex, rgb()/hsl() with plain numbers, or a bare CSS keyword. The
# client checks again before it draws -- this is so a stored deck is clean.
_COLOUR = re.compile(
    r"^(#[0-9a-fA-F]{3,8}|(?:rgb|rgba|hsl|hsla)\([0-9.,%\s/+-]{3,60}\)|[a-zA-Z]{3,24})$"
)
# A font stack: names, quotes, commas and spaces. No semicolons, no url().
_FONT = re.compile(r"^[\w\s,'\"-]{1,160}$")

_BY_ID_TOKENS = {preset["id"]: preset.get("tokens") for preset in PRESETS}


def tokens_for(design_id: str | None) -> dict | None:
    """A preset's theme tokens, or None for a custom standard or no standard.

    Only presets carry them. A reader's own design.md is prose the model reads;
    turning it into numbers is the model's job, done in the `theme` it passes.
    """
    if not design_id:
        return None
    tokens = _BY_ID_TOKENS.get(design_id)
    return dict(tokens) if tokens else None


def clean_theme(raw) -> dict:
    """A theme as it may be stored: known keys, plausible values, nothing else.

    Accepts a dict or a JSON string -- some backends hand an object argument
    over as its serialised text. Anything unrecognised is dropped rather than
    refused: a model that invents `"shadow": "lots"` should still get its deck.
    """
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            return {}
    if not isinstance(raw, dict):
        return {}
    theme: dict = {}
    for key in THEME_KEYS:
        value = raw.get(key)
        if value is None or value == "":
            continue
        if key in _COLOUR_KEYS:
            text = str(value).strip()
            if _COLOUR.match(text):
                theme[key] = text
        elif key in _FONT_KEYS:
            text = " ".join(str(value).split())
            if _FONT.match(text):
                theme[key] = text
        elif key == "heading_weight":
            try:
                weight = int(value)
            except (TypeError, ValueError):
                continue
            theme[key] = max(300, min(900, round(weight / 100) * 100))
        elif key == "heading_case":
            text = str(value).strip().lower()
            theme[key] = "upper" if text in ("upper", "uppercase", "caps") else "none"
        elif key == "radius":
            try:
                theme[key] = max(0, min(48, int(float(value))))
            except (TypeError, ValueError):
                continue
    return theme


def swatch(design_id: str) -> list[str] | None:
    """Three colours that say what a preset looks like: ground, ink, accent.

    Drawn beside its name in the chooser, so picking a look is a matter of
    seeing it rather than reading a summary of it.
    """
    tokens = _BY_ID_TOKENS.get(design_id)
    if not tokens:
        return None
    return [tokens["background"], tokens["text"], tokens["accent"]]
