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
                "Ask the user which design standard to follow, and get back a "
                "design.md: the type, colour, spacing, components and voice the "
                "result should use. Call this BEFORE you start writing anything "
                "whose look matters -- a document, a report, a web page, a "
                "canvas, a slide deck, a diagram, a styled artifact of any kind "
                "-- unless the user has already told you the style to use or "
                "pointed you at one. The user picks from a set of presets and "
                "their own saved standards, or declines. It costs one prompt "
                "and stops you inventing a look they then have to correct. "
                "Follow the document you get back closely, and do not ask twice "
                "in one turn."
            ),
            # No arguments the model supplies: what it is for is the whole of
            # the call, and the reader's pick is injected by the turn loop.
            parameters={"type": "object", "properties": {}},
        )
        self.store = store

    async def use(self, session: str | None = None, choice: str = NO_DESIGN) -> str:
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
        return (
            f"The user chose the {name!r} design standard. Follow it for "
            f"everything you produce in this turn:\n\n{markdown}"
        )
