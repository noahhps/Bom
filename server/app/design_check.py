"""What a designer would catch before anyone else saw it.

The model cannot see what it made. It writes a page or a wireframe as text
and the panel draws it, so a heading that runs off the frame, grey text on a
grey card or a `</div>` lost in an edit all go unnoticed until the reader
finds them. These checks read the document the way a reviewer would and say
what they found, in words a model can act on in the same turn.

Two levels, because a note that fires on everything is a note that gets
skipped:

* **fix** -- something is plainly broken: markup that no longer balances,
  text that fails contrast, a layer off the edge of its screen. These ride
  along on every write and edit, so the model hears about them while it can
  still do something.
* **consider** -- a judgement call: a third typeface, a missing alt text, a
  near-miss alignment. Only reported when the model asks, through
  check_design.

Everything here is a heuristic over text, not a renderer. It errs towards
silence: a check that cannot tell -- a gradient background, a colour it cannot
parse -- says nothing rather than guessing.
"""

from __future__ import annotations

import colorsys
import math
import re
from dataclasses import dataclass
from html.parser import HTMLParser

FIX = "fix"
CONSIDER = "consider"

# WCAG 2.1 AA. Large text (24px, or 18.66px bold) may go down to 3:1.
AA_TEXT = 4.5
AA_LARGE = 3.0


@dataclass(frozen=True)
class Finding:
    level: str
    text: str


def summary(findings: list[Finding], *, levels=(FIX,), limit: int = 5) -> str:
    """The findings at `levels`, as one sentence to append to a result."""
    picked = [f.text for f in findings if f.level in levels]
    if not picked:
        return ""
    more = len(picked) - limit
    listed = "; ".join(picked[:limit]) + (f"; and {more} more" if more > 0 else "")
    return f" Design check: {listed}."


def report(findings: list[Finding]) -> str:
    """Every finding, fixes first, as the lines check_design returns."""
    if not findings:
        return "No problems found."
    fixes = [f.text for f in findings if f.level == FIX]
    ideas = [f.text for f in findings if f.level != FIX]
    lines: list[str] = []
    if fixes:
        lines.append("Fix:")
        lines.extend(f"- {text}" for text in fixes)
    if ideas:
        lines.append("Consider:")
        lines.extend(f"- {text}" for text in ideas)
    return "\n".join(lines)


# -- colour --------------------------------------------------------------------

_NAMED = {
    "black": (0, 0, 0), "white": (255, 255, 255), "red": (255, 0, 0),
    "green": (0, 128, 0), "blue": (0, 0, 255), "gray": (128, 128, 128),
    "grey": (128, 128, 128), "silver": (192, 192, 192), "navy": (0, 0, 128),
    "yellow": (255, 255, 0), "orange": (255, 165, 0), "purple": (128, 0, 128),
    "teal": (0, 128, 128), "maroon": (128, 0, 0), "olive": (128, 128, 0),
    "lime": (0, 255, 0), "aqua": (0, 255, 255), "cyan": (0, 255, 255),
    "fuchsia": (255, 0, 255), "magenta": (255, 0, 255),
    "whitesmoke": (245, 245, 245), "gainsboro": (220, 220, 220),
    "lightgray": (211, 211, 211), "lightgrey": (211, 211, 211),
    "darkgray": (169, 169, 169), "darkgrey": (169, 169, 169),
    "dimgray": (105, 105, 105), "dimgrey": (105, 105, 105),
    "ivory": (255, 255, 240), "beige": (245, 245, 220), "linen": (250, 240, 230),
    "snow": (255, 250, 250), "ghostwhite": (248, 248, 255),
    "slategray": (112, 128, 144), "slategrey": (112, 128, 144),
    "darkslategray": (47, 79, 79), "midnightblue": (25, 25, 112),
    "crimson": (220, 20, 60), "tomato": (255, 99, 71), "gold": (255, 215, 0),
    "coral": (255, 127, 80), "salmon": (250, 128, 114), "indigo": (75, 0, 130),
}

_COLOUR_TOKEN = re.compile(
    r"#[0-9a-fA-F]{3,8}\b|(?:rgba?|hsla?)\([^)]*\)|\b(?:%s|transparent)\b"
    % "|".join(sorted(_NAMED, key=len, reverse=True)),
    re.IGNORECASE,
)


def _channel(text: str, scale: float = 255.0) -> float:
    text = text.strip()
    if text.endswith("%"):
        return float(text[:-1]) / 100.0 * scale
    return float(text)


def parse_colour(value) -> tuple[float, float, float, float] | None:
    """(r, g, b, alpha) in 0-255 and 0-1, or None for anything unreadable."""
    if not isinstance(value, str):
        return None
    text = value.strip().lower()
    if not text:
        return None
    if text == "transparent":
        return (0.0, 0.0, 0.0, 0.0)
    if text in _NAMED:
        r, g, b = _NAMED[text]
        return (float(r), float(g), float(b), 1.0)
    if text.startswith("#"):
        digits = text[1:]
        if len(digits) in (3, 4):
            digits = "".join(ch * 2 for ch in digits)
        if len(digits) not in (6, 8) or not re.fullmatch(r"[0-9a-f]+", digits):
            return None
        r, g, b = (int(digits[i:i + 2], 16) for i in (0, 2, 4))
        alpha = int(digits[6:8], 16) / 255.0 if len(digits) == 8 else 1.0
        return (float(r), float(g), float(b), alpha)
    hit = re.fullmatch(r"(rgba?|hsla?)\((.*)\)", text)
    if not hit:
        return None
    kind, body = hit.groups()
    parts = [p for p in re.split(r"[\s,/]+", body.strip()) if p]
    if len(parts) < 3:
        return None
    try:
        alpha = _channel(parts[3], 1.0) if len(parts) > 3 else 1.0
        if kind.startswith("rgb"):
            r, g, b = (_channel(p) for p in parts[:3])
        else:
            h = float(parts[0].replace("deg", "")) / 360.0 % 1.0
            s = _channel(parts[1], 1.0)
            lum = _channel(parts[2], 1.0)
            fr, fg, fb = colorsys.hls_to_rgb(h, lum, s)
            r, g, b = fr * 255, fg * 255, fb * 255
    except ValueError:
        return None
    clamp = lambda v: max(0.0, min(255.0, v))  # noqa: E731
    return (clamp(r), clamp(g), clamp(b), max(0.0, min(1.0, alpha)))


def _over(top, bottom):
    """`top` composited over an opaque `bottom`."""
    a = top[3]
    return tuple(top[i] * a + bottom[i] * (1 - a) for i in range(3)) + (1.0,)


def _luminance(colour) -> float:
    def lin(c: float) -> float:
        c /= 255.0
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

    r, g, b = colour[:3]
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)


def contrast(foreground, background, page=(255.0, 255.0, 255.0, 1.0)) -> float | None:
    """The WCAG contrast ratio of two colours (strings or tuples), or None."""
    fg = parse_colour(foreground) if isinstance(foreground, str) else foreground
    bg = parse_colour(background) if isinstance(background, str) else background
    if fg is None or bg is None or bg[3] == 0:
        return None
    if bg[3] < 1:
        bg = _over(bg, page)
    if fg[3] < 1:
        fg = _over(fg, bg)
    lighter, darker = sorted((_luminance(fg), _luminance(bg)), reverse=True)
    return (lighter + 0.05) / (darker + 0.05)


def _ratio(value: float) -> str:
    return f"{math.floor(value * 10) / 10:g}:1"


# -- HTML ----------------------------------------------------------------------

_VOID = {
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
    "param", "source", "track", "wbr",
}
# Elements whose end tag HTML lets you leave out. An unclosed <li> is not a
# mistake, and reporting it would teach the model to ignore the report.
_OPTIONAL_END = {
    "p", "li", "dt", "dd", "tr", "td", "th", "thead", "tbody", "tfoot",
    "option", "optgroup", "colgroup", "caption", "rt", "rp", "html", "head",
    "body",
}


class _Balance(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.stack: list[str] = []
        self.unclosed: dict[str, int] = {}
        self.stray: dict[str, int] = {}

    def handle_starttag(self, tag, attrs):
        if tag not in _VOID:
            self.stack.append(tag)

    def handle_startendtag(self, tag, attrs):
        pass  # <circle ... /> opens and closes itself

    def handle_endtag(self, tag):
        if tag in _VOID:
            return
        if tag not in self.stack:
            if tag not in _OPTIONAL_END:
                self.stray[tag] = self.stray.get(tag, 0) + 1
            return
        while self.stack:
            top = self.stack.pop()
            if top == tag:
                return
            if top not in _OPTIONAL_END:
                self.unclosed[top] = self.unclosed.get(top, 0) + 1

    def finish(self) -> tuple[dict[str, int], dict[str, int]]:
        self.close()
        for tag in self.stack:
            if tag not in _OPTIONAL_END:
                self.unclosed[tag] = self.unclosed.get(tag, 0) + 1
        self.stack = []
        return self.unclosed, self.stray


def balance(html: str) -> tuple[dict[str, int], dict[str, int]]:
    """Tags left open, and closing tags with nothing to close, by name."""
    parser = _Balance()
    try:
        parser.feed(html or "")
    except Exception:  # noqa: BLE001 -- a parser that gives up has no opinion
        return {}, {}
    return parser.finish()


def balance_problems(html: str) -> int:
    unclosed, stray = balance(html)
    return sum(unclosed.values()) + sum(stray.values())


def _balance_text(unclosed: dict[str, int], stray: dict[str, int]) -> str:
    parts = [f"{n} unclosed <{tag}>" for tag, n in sorted(unclosed.items())]
    parts += [f"{n} stray </{tag}>" for tag, n in sorted(stray.items())]
    return ", ".join(parts[:4]) + (" and more" if len(parts) > 4 else "")


_COMMENT = re.compile(r"/\*.*?\*/", re.S)
_STYLE = re.compile(r"<style[^>]*>(.*?)</style\s*>", re.S | re.I)
_INLINE = re.compile(r"""\sstyle\s*=\s*("([^"]*)"|'([^']*)')""", re.I)
_RULE = re.compile(r"([^{}]+)\{([^{}]*)\}")
_VAR = re.compile(r"var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*\)[^()]*)*))?\)")
_TAGS = re.compile(r"<[^>]+>")
_SCRIPT_BODY = re.compile(r"<(script|style)[^>]*>.*?</\1\s*>", re.S | re.I)


def _strip_dark(css: str) -> str:
    """The stylesheet without its dark-mode blocks, so the light look is what
    gets checked -- otherwise a dark `:root` redefines the tokens and every
    pairing is judged against the wrong ground."""
    out: list[str] = []
    i = 0
    pattern = re.compile(r"@media[^{]*prefers-color-scheme\s*:\s*dark[^{]*\{", re.I)
    while True:
        hit = pattern.search(css, i)
        if not hit:
            out.append(css[i:])
            break
        out.append(css[i:hit.start()])
        depth, j = 1, hit.end()
        while j < len(css) and depth:
            depth += {"{": 1, "}": -1}.get(css[j], 0)
            j += 1
        i = j
    return "".join(out)


def _declarations(block: str) -> dict[str, str]:
    found: dict[str, str] = {}
    for part in block.split(";"):
        if ":" not in part:
            continue
        name, value = part.split(":", 1)
        name = name.strip().lower()
        value = re.sub(r"!\s*important", "", value, flags=re.I).strip()
        if name and value:
            found[name] = value
    return found


def _rules(html: str) -> list[tuple[str, dict[str, str]]]:
    rules: list[tuple[str, dict[str, str]]] = []
    for sheet in _STYLE.findall(html or ""):
        css = _strip_dark(_COMMENT.sub("", sheet))
        for selector, block in _RULE.findall(css):
            selector = " ".join(selector.split())
            if selector.startswith("@") or "dark" in selector.lower():
                continue
            rules.append((selector, _declarations(block)))
    for hit in _INLINE.finditer(html or ""):
        rules.append(("[style]", _declarations(hit.group(2) or hit.group(3) or "")))
    return rules


def _variables(rules) -> dict[str, str]:
    """Custom properties, :root's winning over anyone else's."""
    found: dict[str, str] = {}
    rooted: dict[str, str] = {}
    for selector, decls in rules:
        target = rooted if ":root" in selector or selector == "html" else found
        for name, value in decls.items():
            if name.startswith("--"):
                target.setdefault(name, value)
    return {**found, **rooted}


def _resolve(value: str, variables: dict[str, str]) -> str:
    for _ in range(8):
        hit = _VAR.search(value)
        if not hit:
            break
        replacement = variables.get(hit.group(1)) or (hit.group(2) or "")
        value = value[:hit.start()] + replacement + value[hit.end():]
    return value.strip()


def _colour_of(value: str | None, variables: dict[str, str]) -> str | None:
    """A declaration's colour, or None when it is not one colour."""
    if not value:
        return None
    resolved = _resolve(value, variables)
    if "gradient" in resolved or "url(" in resolved:
        return None
    hit = _COLOUR_TOKEN.search(resolved)
    return hit.group(0) if hit and parse_colour(hit.group(0)) else None


_BODY_SELECTORS = {"body", "html", ":root", "main", "p", "li", "article", "body, html", "html, body"}
_TEXT_VAR = re.compile(r"^--(?:colou?r-)?(?:text|ink|fg|foreground|copy|body-text|content)(?:-1|-primary)?$")
_MUTED_VAR = re.compile(r"^--(?:colou?r-)?(?:text-)?(?:muted|subtle|secondary|dim|text-2|ink-2|fg-2)(?:-text)?$")
_GROUND_VAR = re.compile(r"^--(?:colou?r-)?(?:bg|background|paper|ground|page|base|canvas)(?:-1|-primary)?$")
_SURFACE_VAR = re.compile(r"^--(?:colou?r-)?(?:surface|card|panel|bg-2|background-2)(?:-1)?$")


def _families(value: str) -> str | None:
    first = value.split(",")[0].strip().strip("'\"").lower()
    generic = {
        "serif", "sans-serif", "monospace", "system-ui", "cursive", "fantasy",
        "ui-sans-serif", "ui-serif", "ui-monospace", "ui-rounded", "inherit",
        "initial", "unset", "-apple-system", "blinkmacsystemfont", "emoji",
    }
    if not first or first.startswith("var(") or first in generic:
        return None
    return first


def check_html(html: str) -> list[Finding]:
    """A page as a reviewer would read its source."""
    findings: list[Finding] = []
    text = html or ""

    unclosed, stray = balance(text)
    if unclosed or stray:
        findings.append(Finding(
            FIX,
            f"the markup does not balance ({_balance_text(unclosed, stray)}), so "
            "the layout after that point may be broken",
        ))

    rules = _rules(text)
    variables = _variables(rules)

    # Pairings the stylesheet actually makes: a rule that sets both a colour
    # and the ground it sits on.
    seen: set[str] = set()
    failing: list[tuple[str, float, bool]] = []
    for selector, decls in rules:
        fg = _colour_of(decls.get("color"), variables)
        bg = _colour_of(decls.get("background-color") or decls.get("background"), variables)
        if not fg or not bg:
            continue
        ratio = contrast(fg, bg)
        if ratio is None or ratio >= AA_TEXT:
            continue
        key = selector[:60]
        if key in seen:
            continue
        seen.add(key)
        failing.append((key, ratio, selector.lower() in _BODY_SELECTORS))

    # The page's own text on the page's own ground, when they are set in
    # different rules -- the usual shape, body's colour and html's background.
    page_fg = page_bg = None
    for selector, decls in rules:
        if selector.lower() in ("body", "html", ":root", "html, body", "body, html"):
            page_fg = page_fg or _colour_of(decls.get("color"), variables)
            page_bg = page_bg or _colour_of(
                decls.get("background-color") or decls.get("background"), variables
            )
    if page_fg and page_bg and "body" not in seen:
        ratio = contrast(page_fg, page_bg)
        if ratio is not None and ratio < AA_TEXT:
            failing.append(("body text on the page background", ratio, True))

    # The tokens themselves: text and muted text against the ground and the
    # surface, since a card's paragraph is often only coloured by a variable.
    grounds = [(n, v) for n, v in variables.items() if _GROUND_VAR.match(n) or _SURFACE_VAR.match(n)]
    inks = [(n, v) for n, v in variables.items() if _TEXT_VAR.match(n) or _MUTED_VAR.match(n)]
    for ink_name, ink in inks:
        for ground_name, ground in grounds:
            fg = _colour_of(ink, variables)
            bg = _colour_of(ground, variables)
            ratio = contrast(fg, bg) if fg and bg else None
            if ratio is not None and ratio < AA_TEXT:
                failing.append((f"{ink_name} on {ground_name}", ratio, _TEXT_VAR.match(ink_name) is not None))

    for where, ratio, is_body in failing[:4]:
        if ratio < AA_LARGE or is_body:
            findings.append(Finding(
                FIX,
                f"{where} has {_ratio(ratio)} contrast, under the 4.5:1 body text "
                "needs -- darken the text or lighten the ground",
            ))
        else:
            findings.append(Finding(
                CONSIDER,
                f"{where} has {_ratio(ratio)} contrast: enough only for large "
                "text (24px+), not for body copy",
            ))

    lowered = text.lower()
    remote_sheets = re.findall(
        r"""<link[^>]+href\s*=\s*["']?\s*(?:https?:)?//([^/"'\s>]+)""", text, re.I
    ) + re.findall(r"""@import\s+(?:url\()?\s*["']?(?:https?:)?//([^/"'\s)]+)""", text, re.I)
    if remote_sheets:
        findings.append(Finding(
            FIX,
            f"it loads a stylesheet or font from {remote_sheets[0]}, which will not "
            "load offline -- use a local font stack instead",
        ))
    remote_scripts = re.findall(
        r"""<script[^>]+src\s*=\s*["']?\s*(?:https?:)?//([^/"'\s>]+)""", text, re.I
    )
    if remote_scripts:
        findings.append(Finding(
            FIX,
            f"it loads a script from {remote_scripts[0]}, which will not load "
            "offline -- inline what it needs",
        ))

    words = " ".join(_TAGS.sub(" ", _SCRIPT_BODY.sub(" ", text)).split())
    placeholder = _placeholder(words)
    if placeholder:
        findings.append(Finding(
            FIX, f"it still has placeholder copy ({placeholder!r}) -- write the real words",
        ))

    # -- judgement calls, only when asked --------------------------------------
    families = []
    for _, decls in rules:
        value = decls.get("font-family") or ""
        family = _families(_resolve(value, variables)) if value else None
        if family and family not in families:
            families.append(family)
    if len(families) > 2:
        findings.append(Finding(
            CONSIDER,
            f"{len(families)} typefaces ({', '.join(families[:4])}) -- two is "
            "usually the most a page can hold together",
        ))

    sizes: set[float] = set()
    body_size = None
    for selector, decls in rules:
        value = _resolve(decls.get("font-size", ""), variables)
        hit = re.fullmatch(r"([\d.]+)(px|rem|em)", value)
        if not hit:
            continue
        px = float(hit.group(1)) * (16 if hit.group(2) != "px" else 1)
        sizes.add(round(px, 1))
        if selector.lower() in ("body", "html", "p"):
            body_size = body_size or px
    if len(sizes) > 8:
        findings.append(Finding(
            CONSIDER,
            f"{len(sizes)} different font sizes -- settle on a type scale of five or six",
        ))
    if body_size is not None and body_size < 14:
        findings.append(Finding(
            CONSIDER, f"body text is {body_size:g}px -- 16px or more reads comfortably",
        ))

    images = re.findall(r"<img\b[^>]*>", text, re.I)
    missing_alt = [tag for tag in images if not re.search(r"\balt\s*=", tag, re.I)]
    if missing_alt:
        findings.append(Finding(
            CONSIDER,
            f"{len(missing_alt)} image{'' if len(missing_alt) == 1 else 's'} without "
            "alt text",
        ))
    if ("<html" in lowered or "<head" in lowered) and 'name="viewport"' not in lowered \
            and "name='viewport'" not in lowered and "name=viewport" not in lowered:
        findings.append(Finding(
            CONSIDER,
            'no <meta name="viewport"> -- the page will render zoomed out on a phone',
        ))

    token_count = sum(1 for name in variables if parse_colour(_resolve(variables[name], variables)))
    if token_count >= 3:
        loose = 0
        for selector, decls in rules:
            if ":root" in selector:
                continue
            for name, value in decls.items():
                if name.startswith("--"):
                    continue
                loose += len([c for c in _COLOUR_TOKEN.findall(value)
                              if c.lower() not in ("transparent", "white", "black")])
        if loose > 6:
            findings.append(Finding(
                CONSIDER,
                f"{loose} colours are written out outside :root -- use the tokens, "
                "so a restyle reaches every part of the page",
            ))
    return findings


_PLACEHOLDER = re.compile(
    r"lorem ipsum|dolor sit amet|\b(?:title|heading|headline|text|content|image|logo)"
    r" (?:goes )?here\b|\byour (?:title|text|content|company|logo|name) here\b",
    re.I,
)


def _placeholder(words: str) -> str | None:
    hit = _PLACEHOLDER.search(words or "")
    return hit.group(0) if hit else None


def check_markdown(text: str) -> list[Finding]:
    placeholder = _placeholder(text)
    if placeholder:
        return [Finding(FIX, f"it still has placeholder copy ({placeholder!r}) -- write the real words")]
    return []


# -- themes, slides and wireframes ---------------------------------------------


def check_theme(theme: dict | None) -> list[Finding]:
    """The design tokens a deck or a styled wireframe is drawn from."""
    theme = theme or {}
    findings: list[Finding] = []
    pairs = (
        ("text", "background", AA_TEXT, FIX),
        ("text", "surface", AA_TEXT, FIX),
        ("muted", "background", AA_TEXT, CONSIDER),
        ("accent", "background", AA_LARGE, CONSIDER),
    )
    for ink, ground, needed, level in pairs:
        if not theme.get(ink) or not theme.get(ground):
            continue
        ratio = contrast(theme[ink], theme[ground])
        if ratio is not None and ratio < needed:
            findings.append(Finding(
                FIX if ratio < AA_LARGE else level,
                f"the theme's {ink} ({theme[ink]}) on {ground} ({theme[ground]}) has "
                f"{_ratio(ratio)} contrast, under {needed:g}:1",
            ))
    return findings


def check_deck(deck: dict) -> list[Finding]:
    from .skills.slides import advice  # local: slides imports this module

    findings = check_theme(deck.get("theme"))
    findings += [Finding(CONSIDER, note) for note in advice(deck)]
    for number, slide in enumerate(deck.get("slides", []), start=1):
        for key in ("title", "subtitle", "body"):
            placeholder = _placeholder(str(slide.get(key) or ""))
            if placeholder:
                findings.append(Finding(
                    FIX, f"slide {number} still has placeholder copy ({placeholder!r})",
                ))
                break
    return findings


# What a component is drawn as, for the overlap check: containers hold other
# layers on purpose, so only the things that carry content are compared.
_CONTENT = {"text", "button", "input", "checkbox", "toggle", "avatar", "icon", "image", "lines", "nav"}
_TOUCH = {"button", "input", "checkbox", "toggle"}


def _box(layer: dict) -> tuple[float, float, float, float]:
    return (
        float(layer.get("x", 0)), float(layer.get("y", 0)),
        float(layer.get("w", 0)), float(layer.get("h", 0)),
    )


def _label(layer: dict) -> str:
    words = f' "{layer["text"][:30]}"' if layer.get("text") else ""
    return f"{layer.get('id', '?')} ({layer.get('type', 'layer')}{words})"


def _text_height(text: str, size: float, width: float) -> float:
    # 0.55em a character is an average across the faces a wireframe is set in;
    # the flow pass uses a wider 0.62 for the monospace, so this errs towards
    # saying nothing.
    per_line = max(1, int(width / (size * 0.55)))
    lines = sum(max(1, math.ceil(len(part) / per_line)) for part in text.split("\n"))
    return lines * size * 1.3


def check_wireframe(doc: dict) -> list[Finding]:
    findings: list[Finding] = []
    frames = doc.get("frames") or []
    styled = doc.get("fidelity") == "styled"
    theme = doc.get("theme") or {}
    if styled:
        findings += check_theme(theme)

    linked: set[str] = set()
    for frame in frames:
        for layer in frame.get("layers", []):
            if layer.get("link"):
                linked.add(layer["link"])

    for frame in frames:
        name = frame.get("name", frame.get("id", "frame"))
        fw, fh = float(frame.get("w", 0)), float(frame.get("h", 0))
        layers = [l for l in frame.get("layers", []) if not l.get("hidden")]
        if not layers:
            findings.append(Finding(CONSIDER, f"{name!r} is empty"))
            continue

        off: list[str] = []
        for layer in layers:
            x, y, w, h = _box(layer)
            edges = []
            if x < -2:
                edges.append("left")
            if y < -2:
                edges.append("top")
            if x + w > fw + 2:
                edges.append("right")
            if y + h > fh + 2:
                edges.append("bottom")
            if edges:
                off.append(f"{_label(layer)} past the {' and '.join(edges)} edge")
        if off:
            findings.append(Finding(
                FIX,
                f"in {name!r}, " + "; ".join(off[:3]) + (f" and {len(off) - 3} more" if len(off) > 3 else "")
                + " -- move it in or make the frame taller",
            ))

        content = [l for l in layers if l.get("type") in _CONTENT]
        clashes: list[str] = []
        for i, a in enumerate(content):
            ax, ay, aw, ah = _box(a)
            for b in content[i + 1:]:
                bx, by, bw, bh = _box(b)
                ix = min(ax + aw, bx + bw) - max(ax, bx)
                iy = min(ay + ah, by + bh) - max(ay, by)
                if ix <= 2 or iy <= 2:
                    continue
                smaller = max(1.0, min(aw * ah, bw * bh))
                if ix * iy / smaller > 0.2:
                    clashes.append(f"{_label(a)} and {_label(b)}")
        if clashes:
            findings.append(Finding(
                FIX,
                f"in {name!r}, overlapping: " + "; ".join(clashes[:3])
                + (f" and {len(clashes) - 3} more" if len(clashes) > 3 else ""),
            ))

        crowded: list[str] = []
        for layer in layers:
            words = layer.get("text") or ""
            if not words:
                continue
            x, y, w, h = _box(layer)
            size = float(layer.get("size") or 16)
            if layer.get("type") == "text":
                if _text_height(words, size, max(1.0, w)) > h * 1.25 + 4:
                    crowded.append(f"{_label(layer)} is too long for its box")
            elif layer.get("type") == "button":
                if len(words) * size * 0.55 > max(1.0, w - 24):
                    crowded.append(f"{_label(layer)} has a label wider than the button")
        if crowded:
            findings.append(Finding(
                FIX,
                f"in {name!r}, " + "; ".join(crowded[:3])
                + " -- shorten the words or give the layer more room",
            ))

        if fw < 500:
            small = [
                _label(l) for l in layers
                if l.get("type") in _TOUCH and float(l.get("h", 0)) < 40
                and l.get("type") not in ("checkbox", "toggle")
            ]
            if small:
                findings.append(Finding(
                    CONSIDER,
                    f"in {name!r}, {', '.join(small[:3])} "
                    f"{'is' if len(small) == 1 else 'are'} under 44px tall -- hard to tap",
                ))

        # Contrast of text that sets its own colour, against whatever it sits on.
        page = frame.get("fill") or (theme.get("background") if styled else None) or "#ffffff"
        for index, layer in enumerate(layers):
            if layer.get("type") != "text" or not layer.get("color"):
                continue
            x, y, w, h = _box(layer)
            cx, cy = x + w / 2, y + h / 2
            ground = page
            for below in reversed(layers[:index]):
                bx, by, bw, bh = _box(below)
                if below.get("fill") and bx <= cx <= bx + bw and by <= cy <= by + bh:
                    ground = below["fill"]
                    break
            ratio = contrast(layer["color"], ground)
            size = float(layer.get("size") or 16)
            needed = AA_LARGE if size >= 24 else AA_TEXT
            if ratio is not None and ratio < needed:
                findings.append(Finding(
                    FIX,
                    f"in {name!r}, {_label(layer)} has {_ratio(ratio)} contrast on "
                    f"{ground}, under {needed:g}:1",
                ))

        edges = sorted({round(float(l.get("x", 0))) for l in layers if l.get("type") != "nav"})
        near = [(a, b) for a, b in zip(edges, edges[1:]) if 0 < b - a <= 4]
        if near:
            a, b = near[0]
            findings.append(Finding(
                CONSIDER,
                f"in {name!r}, left edges at x={a} and x={b} nearly line up -- snap "
                "them to one",
            ))

    if linked and len(frames) > 1:
        orphans = [f.get("name", f.get("id")) for f in frames[1:] if f.get("id") not in linked]
        if orphans:
            findings.append(Finding(
                CONSIDER,
                "nothing links to " + ", ".join(repr(o) for o in orphans[:4])
                + " -- the prototype cannot reach "
                + ("it" if len(orphans) == 1 else "them"),
            ))
    return findings
