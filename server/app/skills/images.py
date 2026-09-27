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


def generated_ids(store: Store, session: str) -> set[str]:
    return {image.id for image in store.session_images(session) if image.generated}


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
            + (" (AI-generated)" if image.generated else "")
            + (f" -- {image.alt}" if image.alt else "")
            for image in images
        ]
        return (
            f"{len(images)} image{'' if len(images) == 1 else 's'} in this conversation:\n"
            + "\n".join(lines)
            + "\nPut a landscape image in a 'photo' slide; a portrait one reads "
            "better in 'split'."
        )


class GenerateImage(Skill):
    """Make a picture on the configured generator and add it to the library."""

    wants_session = True

    def __init__(self, store: Store, generator) -> None:
        super().__init__(
            name="generate_image",
            description=(
                "Generate a picture and add it to this conversation's images, for "
                "use in a deck or a page by the id this returns. Use it when a "
                "slide or page needs a picture the user has not given you -- a "
                "hero image, a background, an illustration. Describe the "
                "subject, the composition and the mood in one or two plain "
                "sentences; the conversation's design standard is added "
                "automatically. Leave space in the composition where a title "
                "will sit. Never ask for text in the image (it comes out "
                "garbled -- put words on the slide instead), and never for real, "
                "identifiable people, brand logos, or anything sexual. A "
                "generated picture is not a photograph of something real: do "
                "not present it as one."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "prompt": {"type": "string", "description": "What the picture shows."},
                    "shape": {
                        "type": "string",
                        "enum": ["landscape", "portrait", "square"],
                        "description": "Landscape for a full-bleed slide; portrait for a split.",
                    },
                    "alt": {"type": "string", "description": "Alt text: what it shows, in a sentence."},
                },
                "required": ["prompt"],
            },
            requires="an image generator (set IMAGE_GEN_URL)",
        )
        self.store = store
        self.generator = generator

    @property
    def available(self) -> bool:
        return self.generator.configured

    @property
    def must_ask(self) -> bool:
        """A generator off this machine is sent the prompt: always ask first."""
        return self.generator.remote

    async def use(self, session: str, prompt=None, shape=None, alt=None, **extra) -> str:
        from ..imagegen import GenerationError, create
        from .args import plain_text

        text = plain_text(prompt or extra.get("description") or extra.get("subject"))
        try:
            image = await create(
                self.store, self.generator, session, text,
                shape=plain_text(shape) or "landscape", alt=plain_text(alt) or None,
            )
        except GenerationError as exc:
            return f"No picture was made: {exc}"
        return (
            f"Generated {image.id} ({image.orientation} {image.width}×{image.height}) and "
            "added it to this conversation's images. Use it by that id -- as a slide's "
            "`image`, or <img src=\"bom-image:" + image.id + "\"> in a page. It is "
            "AI-generated and is labelled so on the slide; do not describe it as a photo "
            "of something real."
        )
