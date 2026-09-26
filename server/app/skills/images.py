"""The conversation's pictures, as the model sees them: names, not pixels.

`list_images` is how a model finds out what it can put on a slide or a page.
It returns one line per image -- id, name, shape, and the description the user
gave it -- and never the image itself. Handing back pixels would cost the
window over a thousand tokens a picture, and a small model shown several at
once confuses them; a vision model that needs to look has already seen the
ones attached in the chat.

Images are referenced by id everywhere, never by address. The id is checked
wherever it is used (write_slides, write_canvas), so an invented one is a
sentence back to the model rather than a broken picture on screen.
"""

from __future__ import annotations

import re

from ..images import sync_from_chat
from ..store import Store
from .skill import Skill

#: How an image is written into an HTML page or a markdown document.
SCHEME = "bom-image:"
ID = re.compile(r"^img_[A-Za-z0-9]+$")
REFERENCE = re.compile(r"bom-image:(img_[A-Za-z0-9]+)")


def known_ids(store: Store, session: str) -> set[str]:
    return {image.id for image in store.session_images(session)}


class ListImages(Skill):
    wants_session = True

    def __init__(self, store: Store) -> None:
        super().__init__(
            name="list_images",
            description=(
                "List the images the user has given this conversation -- ones "
                "attached in the chat and ones uploaded in the canvas panel -- "
                "with the id to use for each. Call this before making a deck or "
                "a page with pictures in it. Use an image by its id: in "
                "write_slides as a slide's `image` (layout 'photo' for a "
                "full-bleed picture with the title over it, 'split' for a "
                "picture beside text, 'image' for a picture with a caption); in "
                "an HTML page as <img src=\"bom-image:ID\" alt=\"…\">. Only use "
                "ids this returns -- never invent one and never use a web "
                "address. If there are none, ask the user to attach or upload "
                "the pictures, or draw the visual as inline SVG instead."
            ),
            parameters={"type": "object", "properties": {}},
        )
        self.store = store

    async def use(self, session: str, **_ignored) -> str:
        sync_from_chat(self.store, session)
        images = self.store.session_images(session)
        if not images:
            return (
                "There are no images in this conversation yet. The user can attach "
                "them in the chat or upload them in the canvas panel. Until then, "
                "draw any visual as inline SVG."
            )
        lines = [
            f"- {image.id}: {image.name}, {image.orientation} {image.width}×{image.height}"
            + (f" -- {image.alt}" if image.alt else "")
            for image in images
        ]
        return (
            f"{len(images)} image{'' if len(images) == 1 else 's'} in this conversation:\n"
            + "\n".join(lines)
            + "\nPut a landscape image in a 'photo' slide; a portrait one reads "
            "better in 'split'."
        )
