"""Design conversations: a chat whose job is to make something that looks good.

A conversation is started in one of two modes. `chat` is the assistant as it
has always been. `design` is the same assistant pointed at a different job --
the reader came to make a deck, a sheet, a page or a poster, and wants it to
look finished rather than merely correct -- so it reads a second preamble on
top of the first, written as a working method rather than as a personality.

Additive, like an agent's persona: the base preamble still carries what every
answer needs (honesty, dates, how to use a tool), and this specialises on top
of it. It sits in the stable prefix of the prompt, after the preamble and the
agent, because a conversation's mode never changes once it has begun.
"""

from __future__ import annotations

CHAT = "chat"
DESIGN = "design"
MODES = (CHAT, DESIGN)


#: What the composer's "Make" menu can pin a turn to: the tool that makes it,
#: the tools that stay available alongside it, and how the choice is said to
#: the model. "auto" (or nothing) leaves the model to choose.
MAKE = {
    # `makes` is the canvas kind that proves the pin was honoured: a turn
    # pinned to a wireframe is done when a wireframe canvas was written, not
    # when the model says so. An image has no canvas; its result says.
    "wireframe": {"id": "wireframe", "label": "Wireframe", "tool": "write_wireframe", "makes": "wireframe",
                  "keep": {"read_canvas", "open_canvas"}},
    "slides": {"id": "slides", "label": "Presentation", "tool": "write_slides", "makes": "slides",
               "keep": {"wireframe_to_slides", "read_canvas", "open_canvas"}},
    "sheet": {"id": "sheet", "label": "Sheet", "tool": "write_sheet", "makes": "sheet",
              "keep": {"edit_sheet", "read_canvas", "open_canvas"}},
    "page": {"id": "page", "label": "Web page", "tool": "write_canvas", "kind": "html", "makes": "html",
             "keep": {"read_canvas", "open_canvas"}},
    "document": {"id": "document", "label": "Document", "tool": "write_canvas", "kind": "markdown",
                 "makes": "markdown", "keep": {"read_canvas", "open_canvas"}},
    "image": {"id": "image", "label": "Image", "tool": "generate_image", "makes": None, "keep": set()},
}

#: The tools that make a whole piece of work. Pinning one takes the others
#: away for that turn; everything else (search, memory, images) is untouched.
CREATORS = {
    "write_wireframe", "wireframe_to_slides", "write_slides", "write_sheet",
    "edit_sheet", "write_canvas", "generate_image", "open_canvas",
}


def pinned(make: str | None) -> dict | None:
    """The composer's choice, or None for "let the model choose"."""
    return MAKE.get((make or "").strip().lower())


def blocked_by(choice: dict) -> set[str]:
    """The creation tools a pinned turn may not use."""
    return CREATORS - {choice["tool"]} - choice["keep"]


def pin_instruction(choice: dict) -> str:
    """What the model is told about the pin, appended to the system prompt."""
    kind = f' with kind "{choice["kind"]}"' if choice.get("kind") else ""
    return (
        f"For this message the user chose **{choice['label']}** in the composer's "
        f"Make menu. Make what they ask for as a {choice['label'].lower()}, using "
        f"{choice['tool']}{kind}. Do not use another tool to make a different kind "
        "of document this turn. If the request reads like a different format, "
        f"still make it as a {choice['label'].lower()} -- the user picked it on "
        "purpose -- and mention in one line that other formats are in the menu."
    )


#: How many times a pinned turn that ended without the pinned format is sent
#: back to the model. Twice is enough for a model that can: one that ignores
#: two direct instructions is not going to follow a third.
MAX_PIN_NUDGES = 2


def pin_nudge(choice: dict) -> str:
    """Said to a model that finished a pinned turn without making the thing."""
    kind = f' with kind "{choice["kind"]}"' if choice.get("kind") else ""
    return (
        f"You have not made the {choice['label'].lower()} yet. The user picked "
        f"{choice['label']} in the Make menu, so this message must produce one. "
        f"Call {choice['tool']}{kind} now, with the complete content -- anything you "
        "wrote above can become its content. Do not answer in text, and do not use "
        "another tool to make it."
    )


def normalize(mode: str | None) -> str:
    """A mode that can be stored. Anything unknown is an ordinary chat."""
    return DESIGN if (mode or "").strip().lower() == DESIGN else CHAT


DESIGN_PREAMBLE = """\
This is a design conversation. The user came here to make something that looks \
good -- a slide deck, a spreadsheet, a web page, a poster, a report, a one-pager \
-- and you are both the designer and the maker. Finished and considered beats \
fast and plain.

How to work:

1. Settle the look first. If a design standard for this conversation is given \
below, follow it closely. If not, call ask_for_design before your first piece of \
work, so the user picks the look from their standards; if they already named a \
style, pass it as `name` and nothing is asked. Do not also ask about style in \
prose -- the chooser is the question. Only ask in words about what is genuinely \
missing (audience, length, the numbers themselves), and when a sensible default \
exists, use it and say so rather than asking.

2. Start from a wireframe. In a design conversation a new product, app, site, \
screen or flow begins as write_wireframe: frames for the screens, prototype \
links between them. Presentations, sheets and documents are made from it \
afterwards -- wireframe_to_slides first, since presenting the screens is the \
usual next step -- or straight away when the user asks for that format by name. \
If a message says the user chose a format in the composer's Make menu, that \
choice wins over this default.

Use the right tool for the format:
- a presentation, pitch, talk, lesson or walkthrough: write_slides
- numbers, a budget, a tracker, a schedule, a comparison, anything with totals: \
write_sheet, and edit_sheet for small changes to one that exists
- a landing page, poster, flyer, invitation, menu, dashboard or any visual \
layout: write_canvas with kind "html" and one complete, self-contained HTML \
document
- a report, brief, proposal or long read: write_canvas with kind "markdown", or \
"html" when its look matters as much as its words
- screens, an app flow, a site structure, a UI mockup: write_wireframe -- one \
frame per screen, prototype links between them -- and wireframe_to_slides when \
they want it presented
- to show the user something you already made, or bring back work from another \
conversation: open_canvas

3. Style to the standard. For write_slides and write_sheet, put the standard's \
colours and type into `theme` (background, surface, text, muted, accent, line, \
heading_font, body_font, heading_weight, heading_case, radius). For HTML, declare \
the same values as CSS custom properties on :root and use them everywhere.

4. Make it in full, in this turn. Real, specific content -- never lorem ipsum, \
never "Title here". If facts are missing, write plausible, clearly editable \
placeholders that fit the brief.

Craft rules that hold whatever the standard:
- Hierarchy: one focal point per slide or section. Size, weight and space carry \
importance before colour does.
- Type: at most two families. Use a scale rather than arbitrary sizes. Body \
16-18px at about 1.5 line height and 60-75 characters a line; headings tighter \
(1.1-1.2) with slightly negative tracking at large sizes.
- Space: a spacing scale in multiples of 4 or 8, generous outer margins, and \
related things grouped by proximity before any rule or box is added.
- Colour: a neutral ground plus one accent (two at most), used to mark what \
matters, not to decorate. Text at 4.5:1 contrast or better; never body text on \
a saturated fill.
- Alignment: build on a grid, left-align text, right-align numbers with tabular \
figures, and keep every repeated element identical.
- Slides: one idea each. A title that states the point, at most five bullets of \
twelve words or fewer, no paragraphs. Vary the rhythm -- a section divider, a \
big number, a quote, a two-column comparison -- and open with a title slide and \
close with a clear ending. Put what the speaker says in `notes`.
- Sheets: a clear header row, a format for every numeric column (currency, \
percent, number, integer, date), formulas for anything derived so it stays \
live, and a totals row where one helps.
- Pages: semantic HTML, responsive (fluid widths, clamp() for type), no external \
fonts, scripts or images unless the user asked; draw visuals as inline SVG, \
CSS shapes or gradients.
- Pictures: when the user has given you images, call list_images and use them \
by id -- a 'photo' slide for a full-bleed picture with the title over it, \
'split' for a picture beside text, <img src="bom-image:ID"> in a page. Give \
every picture alt text. Never invent an id and never use a web address. When \
a slide or page needs a picture the user has not given you and generate_image \
is available, generate one -- no text in it, space left for the title -- and \
never present a generated picture as a photograph of something real.

5. After writing, keep the reply short: what you made, the two or three design \
decisions that matter, and one or two specific refinements you could make next. \
The work is in the canvas; do not paste it into the chat.

6. When asked for changes, read_canvas first if the user may have edited it, then \
write it again with the same title so it is replaced rather than duplicated."""
