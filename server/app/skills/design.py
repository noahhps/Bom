"""Asking the reader what a result should look like.

A design.md is the styling brief a result is held to -- type, colour, spacing,
components, and the voice the words are written in. Without one, every document
a model writes invents its own look, and eight results that should have been a
set are eight strangers.

`ask_for_design` is how the model gets one. It is unusual among skills in that
the turn stops on it: the orchestrator sees `asks = "design"`, streams the
choices to the client, waits for the reader to pick, and passes the chosen id
back in as an argument. The skill itself is then ordinary -- it looks the
choice up and returns the document.

The reader's own designs and the presets that ship with the server are offered
together and picked the same way; `choice` is a preset id, a stored design's
id, or the sentinel for "no standard, use your judgement".
"""

from __future__ import annotations

from ..design_presets import PRESETS
from ..store import Store
from .skill import Skill

#: What the client sends back when the reader declines a standard, and what the
#: turn falls back to if nobody answers. A real answer rather than a refusal:
#: the model should carry on and write the thing, just without a brief.
NO_DESIGN = "none"

_BY_ID = {preset["id"]: preset for preset in PRESETS}


def options(store: Store) -> list[dict]:
    """Everything the reader may pick from, presets first then their own.

    The markdown is left out: this is the list the chooser renders, and sending
    eight full documents to draw eight rows would be most of a megabyte for
    eight names.
    """
    listed = [
        {
            "id": preset["id"],
            "name": preset["name"],
            "summary": preset["summary"],
            "tags": preset.get("tags", []),
            "source": "preset",
        }
        for preset in PRESETS
    ]
    listed.extend(
        {
            "id": design.id,
            "name": design.name,
            "summary": design.summary,
            "tags": [],
            "source": "custom",
        }
        for design in store.list_designs()
    )
    return listed


#: The shortest key that may match as a substring rather than outright. Four
#: of the preset ids are common English words -- "soft", "memo", "zine" -- and
#: letting a four-letter key match anywhere inside a phrase turns "a software
#: design" into the Soft product UI standard. Short ids still match exactly.
_MIN_LOOSE = 5


def _norm(text: str) -> str:
    """A name reduced to the part worth comparing.

    Case, punctuation and spacing all vary with how the user happened to type
    it, and a trailing ".md" is how half of them will refer to these at all --
    the page calls them design.md files, so "brutalist web design.md" is the
    expected spelling rather than a mistake.
    """
    text = text.strip().lower()
    for suffix in (".md", ".markdown", ".txt"):
        if text.endswith(suffix):
            text = text[: -len(suffix)]
    # "design" and "style" are what someone appends to name the *kind* of
    # thing, not which one. Dropped so "brutalist web design" reaches
    # "brutalist web" rather than missing it by one word.
    for filler in ("design", "standard", "style", "theme", "template"):
        text = text.replace(filler, "")
    return "".join(ch for ch in text if ch.isalnum())


def match(store: Store, named: str) -> str | None:
    """The id of the standard `named` refers to, or None if nothing fits.

    This is what keeps a named standard from becoming a filesystem search. The
    user says "use the brutalist web design.md"; the model passes that string
    through, and it has to arrive at the preset called "Brutalist web" without
    anyone going near a disk -- these documents have never been files.

    The reader's own are tried before the presets: if someone has saved a
    standard of their own called "Editorial", they meant theirs.
    """
    query = _norm(named)
    if not query:
        return None

    # (id, every string that may stand for it). Custom first so it wins.
    candidates: list[tuple[str, list[str]]] = [
        (design.id, [design.name]) for design in store.list_designs()
    ]
    candidates += [(preset["id"], [preset["id"], preset["name"]]) for preset in PRESETS]

    for design_id, names in candidates:
        if any(_norm(name) == query for name in names):
            return design_id

    # Nothing matched outright. Longest key first, so "Brutalist web" is
    # preferred over a bare "brutalist" if both were ever on the list.
    loose = sorted(
        ((_norm(name), design_id) for design_id, names in candidates for name in names),
        key=lambda pair: len(pair[0]),
        reverse=True,
    )
    for key, design_id in loose:
        if len(key) >= _MIN_LOOSE and (key in query or query in key):
            return design_id

    # Last resort, and exact only: the words the presets are tagged with, so
    # "minimal" or "mono" land somewhere sensible rather than nowhere.
    for preset in PRESETS:
        if any(_norm(tag) == query for tag in preset.get("tags", ())):
            return preset["id"]
    return None


def resolve(store: Store, choice: str) -> tuple[str, str] | None:
    """The chosen standard as (name, markdown), or None if there is no such id.

    A stored design wins over a preset of the same id, which cannot happen with
    generated ids but would be the right way round if it ever did: the reader's
    own is more specific than the one that shipped.
    """
    design = store.get_design(choice)
    if design is not None:
        return design.name, design.markdown
    preset = _BY_ID.get(choice)
    if preset is not None:
        return preset["name"], preset["markdown"]
    return None


class AskForDesign(Skill):
    #: The orchestrator reads this and stops the turn to ask, the way it stops
    #: for an approval. See `run_turn`.
    asks = "design"
    wants_session = True

    def __init__(self, store: Store) -> None:
        super().__init__(
            name="ask_for_design",
            description=(
                "Get a design.md: the type, colour, spacing, components and "
                "voice a result should use. Call this BEFORE you start writing "
                "anything whose look matters -- a document, a report, a web "
                "page, a canvas, a slide deck, a diagram, a styled artifact of "
                "any kind. "
                "If the user named a standard ('use the brutalist web "
                "design.md', 'do it in the Swiss style', 'use my house "
                "style'), pass that name as `name` and you get that document "
                "straight back, with nothing asked of them. If you leave "
                "`name` out, they are shown the list and pick one. "
                "IMPORTANT: design standards are stored inside Courier, not on "
                "disk. A design.md is NEVER a file. Never use read_file, "
                "list_directory or any other file tool to go looking for one, "
                "and never tell the user you could not find their design.md -- "
                "call this instead, which is the only thing that can reach "
                "them. "
                "Follow the document you get back closely, and do not call "
                "this twice in one turn."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": (
                            "The standard the user named, in their own words "
                            "-- 'brutalist web design.md', 'Swiss', 'my house "
                            "style'. Leave out to show them the list instead. "
                            "A name that matches nothing falls back to the "
                            "list, so a guess costs nothing."
                        ),
                    },
                },
            },
        )
        self.store = store

    async def use(
        self,
        session: str | None = None,
        name: str = "",
        choice: str = NO_DESIGN,
    ) -> str:
        """`choice` is the turn loop's word on this, and it is the last word.

        The loop has already turned whatever the model passed as `name` into a
        `choice` -- either by matching it or by putting the list to the reader
        -- so by the time this runs, `name` is only of interest when the skill
        is driven directly. Resolving it here as a fallback keeps `use()`
        honest on its own, and costs nothing in the path that matters.
        """
        if (not choice or choice == NO_DESIGN) and name:
            choice = match(self.store, name) or NO_DESIGN

        if not choice or choice == NO_DESIGN:
            return (
                "The user did not choose a design standard. Use your own "
                "judgement, keep the styling simple and internally consistent, "
                "and do not ask again this turn."
            )

        found = resolve(self.store, choice)
        if found is None:
            return (
                "That design standard is no longer available. Carry on with "
                "your own judgement rather than asking again."
            )

        name, markdown = found
        # The closing instruction is repeated after the document, not just
        # before it. A standard is the better part of two thousand characters,
        # and whatever was said ahead of it is that far behind the cursor by
        # the time the model writes its next token -- which is where a small
        # model stops being an agent and starts being a summariser, answering
        # "here is the standard I would use" instead of using it. The last
        # thing in the window is the thing it acts on, so the last thing in
        # the window says what to do.
        return (
            f"The user chose the {name!r} design standard. Follow it closely "
            f"for everything you produce in this turn.\n\n{markdown}\n\n"
            "---\n"
            "That was the standard, not the work. Now produce the actual "
            "result, in this same turn, styled to it. If it belongs in a "
            "canvas -- a document, a report, a page, a deck, anything the "
            "user will keep -- call write_canvas now with the finished "
            "content. If you are restyling something that already exists, "
            "call write_canvas with that canvas's exact existing title, so it "
            "is replaced rather than left as it was. Do not reply describing "
            "what you would do, and do not ask for a standard again."
        )
