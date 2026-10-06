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
from .skill import STUDIO, Skill

#: How an image is written into an HTML page or a markdown document.
SCHEME = "bom-image:"
ID = re.compile(r"^img_[A-Za-z0-9]+$")
REFERENCE = re.compile(r"bom-image:(img_[A-Za-z0-9]+)")


def known_ids(store: Store, session: str) -> set[str]:
    return {image.id for image in store.session_images(session)}


def generated_ids(store: Store, session: str) -> set[str]:
    return {image.id for image in store.session_images(session) if image.generated}


#: What a model writes when it means "no picture here, draw the placeholder".
_NOT_A_PICTURE = {"", "none", "null", "placeholder", "empty", "blank", "x", "tbd", "-"}
#: Words that point at the picture the user most recently gave.
_LATEST = ("attached", "attachment", "uploaded", "latest", "last", "user", "their", "my ", "your ")
_ORDINALS = {"first": 1, "second": 2, "third": 3, "fourth": 4, "fifth": 5}
#: The argument names a picture arrives under, in any of the canvas tools.
IMAGE_KEYS = ("image", "src", "imageId", "image_id", "photo", "picture")


def resolve_image(images, value) -> str | None:
    """The library id `value` refers to, or None when it names no picture.

    Models name a picture however it was put to them. The one in front of
    them arrived as an image in the chat, not as an id, so what comes back is
    its file name, "the attached photo", "image 2" -- all of which used to be
    dropped as images that do not exist, and the wireframe drew an empty box
    where the user's own picture should have been. In order: an id; a file
    name, with or without its extension; an ordinal; a word that points at
    the latest one; and, when the conversation holds exactly one picture, that
    picture, since there is no other it could mean.
    """
    text = str(value or "").strip()
    if isinstance(value, dict):
        text = str(next((value[k] for k in ("id", *IMAGE_KEYS, "name") if value.get(k)), "")).strip()
    if not images:
        return None
    by_id = {image.id: image for image in images}
    hit = re.search(r"img_[A-Za-z0-9]+", text)
    if hit and hit.group(0) in by_id:
        return hit.group(0)
    low = text.lower().removeprefix("bom-image:").strip()
    if low in _NOT_A_PICTURE:
        return None
    # A web address names a picture somewhere else, not one of the user's --
    # it is dropped downstream, as it always was, rather than guessed at.
    if re.match(r"^(?:[a-z][a-z0-9+.-]*:)?//|^data:", low):
        return None
    for image in images:
        name = (image.name or "").lower()
        stem = name.rsplit(".", 1)[0]
        if low and (low == name or low == stem or (len(stem) > 3 and stem in low)):
            return image.id
    ordinal = re.search(r"(?:^|\b)(?:image|img|picture|photo|attachment|#)?\s*#?(\d{1,2})\b", low)
    if ordinal and not hit:
        n = int(ordinal.group(1))
        if 1 <= n <= len(images):
            return images[n - 1].id
    for word, n in _ORDINALS.items():
        if word in low and n <= len(images):
            return images[n - 1].id
    if any(word in low for word in _LATEST):
        return images[-1].id
    if len(images) == 1:
        return images[0].id
    return None


def resolve_images_in(store: Store, session: str, value) -> list[str]:
    """Rewrite, in place, every picture reference inside a tool's arguments to
    a library id where one can be found. Returns what was resolved, as
    "name -> id" lines for the result, so the model learns the ids."""
    sync_from_chat(store, session)
    images = store.session_images(session)
    if not images:
        return []
    said: list[str] = []

    def walk(node) -> None:
        if isinstance(node, list):
            for item in node:
                walk(item)
            return
        if not isinstance(node, dict):
            return
        for key in list(node):
            child = node[key]
            if key in IMAGE_KEYS and isinstance(child, (str, dict)) and child:
                current = child.get("id") if isinstance(child, dict) else child
                if isinstance(current, str) and ID.match(current.removeprefix("bom-image:")):
                    continue
                found = resolve_image(images, child)
                if found is None:
                    continue
                if isinstance(child, dict):
                    child["id"] = found
                else:
                    node[key] = found
                said.append(f"{str(current)[:40]!r} -> {found}")
            else:
                walk(child)

    walk(value)
    return said


class ListImages(Skill):
    # A canvas, design or device tool: not offered in a code conversation.
    modes = STUDIO
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
    # A canvas, design or device tool: not offered in a code conversation.
    modes = STUDIO

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


_PAGE_REF = re.compile(r"bom-image:([^\"'\s)>]+)")


def resolve_images_in_text(store: Store, session: str, text: str) -> tuple[str, list[str]]:
    """`bom-image:` references in a page or a document, turned into ids where
    they name a picture some other way -- a file name, most often."""
    if "bom-image:" not in (text or ""):
        return text, []
    sync_from_chat(store, session)
    images = store.session_images(session)
    ids = {image.id for image in images}
    said: list[str] = []

    def swap(match) -> str:
        ref = match.group(1)
        if ref in ids:
            return match.group(0)
        found = resolve_image(images, ref)
        if found is None:
            return match.group(0)
        said.append(f"{ref[:40]!r} -> {found}")
        return f"bom-image:{found}"

    return _PAGE_REF.sub(swap, text), said


def resolution_note(said: list[str]) -> str:
    """The line a result carries when references were turned into ids."""
    if not said:
        return ""
    unique = list(dict.fromkeys(said))
    return " Pictures matched to the conversation's images: " + ", ".join(unique[:6]) + "."
