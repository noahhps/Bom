"""Pictures a deck or a page can use, cleaned on the way in.

Every image that enters a conversation's library -- uploaded in the canvas
panel, or attached in the chat and imported from there -- goes through
`prepare`, which is the whole of the safety story for the bytes themselves:

* **decoded and re-encoded.** Nothing is stored as it arrived. A file Pillow
  cannot open is refused, and one that opens is written out fresh as a JPEG
  (or a PNG, when it has transparency) -- so whatever else was in the file,
  crafted or accidental, does not survive the trip;

* **metadata dropped.** Re-encoding without passing `exif` strips it, GPS
  included. The camera's orientation is applied to the pixels first, so a
  portrait photo does not come out sideways once the tag that said so is gone;

* **bounded.** A file over `MAX_BYTES`, or one whose header claims more than
  `MAX_PIXELS` -- the shape of a decompression bomb, a small file that inflates
  to gigabytes -- is refused before its pixels are decoded. What is kept is
  scaled so its long side is at most `MAX_SIDE`: large enough to fill a screen
  when presenting, small enough that a deck with ten photos exports as a file
  someone can email.

Raster only. SVG is a document that can carry script, and slides already draw
their diagrams as SVG shown through <img>; a user's photos have no need of it.
"""

from __future__ import annotations

import io
from dataclasses import dataclass
from pathlib import Path

from .store import Store

MAX_BYTES = 25 * 1024 * 1024
MAX_PIXELS = 60_000_000
MAX_SIDE = 2400
JPEG_QUALITY = 86

#: What may come in. GIF is accepted and kept as its first frame.
ACCEPTED = {"image/png", "image/jpeg", "image/webp", "image/gif"}


class ImageError(ValueError):
    """An image that cannot go in the library, with a sentence saying why."""


@dataclass
class Prepared:
    name: str
    mime: str
    width: int
    height: int
    data: bytes


def prepare(name: str, data: bytes) -> Prepared:
    """Decode, bound, strip and re-encode one image. Raises ImageError."""
    from PIL import Image, ImageOps  # local: only an image path pays the import

    if not data:
        raise ImageError(f"{name} is empty.")
    if len(data) > MAX_BYTES:
        raise ImageError(f"{name} is larger than {MAX_BYTES // (1024 * 1024)} MB.")

    try:
        image = Image.open(io.BytesIO(data))
    except Image.DecompressionBombError as exc:
        # Pillow's own guard, for headers far past ours.
        raise ImageError(f"{name} claims dimensions too large to use.") from exc
    except Exception as exc:
        raise ImageError(f"{name} is not an image this can read.") from exc
    if image.format not in {"PNG", "JPEG", "WEBP", "GIF", "MPO"}:
        raise ImageError(f"{name} is a {image.format or 'unknown'} file; use PNG, JPEG, WebP or GIF.")
    # From the header, before any pixels are decoded.
    width, height = image.size
    if width * height > MAX_PIXELS:
        raise ImageError(f"{name} is {width}×{height}, which is too large to use.")

    try:
        image.seek(0)
        image.load()
        image = ImageOps.exif_transpose(image)
    except Exception as exc:
        raise ImageError(f"{name} could not be decoded.") from exc

    alpha = image.mode in ("RGBA", "LA") or (image.mode == "P" and "transparency" in image.info)
    image = image.convert("RGBA" if alpha else "RGB")
    image.thumbnail((MAX_SIDE, MAX_SIDE), Image.Resampling.LANCZOS)

    buffer = io.BytesIO()
    stem = Path(name).stem or "image"
    if alpha:
        image.save(buffer, format="PNG", optimize=True)
        mime, suffix = "image/png", "png"
    else:
        image.save(buffer, format="JPEG", quality=JPEG_QUALITY, optimize=True, progressive=True)
        mime, suffix = "image/jpeg", "jpg"
    return Prepared(f"{stem}.{suffix}"[:200], mime, image.width, image.height, buffer.getvalue())


def sync_from_chat(store: Store, session_id: str) -> int:
    """Bring the chat's image attachments into the library. Returns how many.

    Imported once each -- `attachment_id` remembers which -- and cleaned the
    same way an upload is. One that will not decode is skipped rather than
    failing the listing: it is still in the chat, just not usable in a deck.
    """
    seen = store.imported_attachments(session_id)
    added = 0
    # Listed without their bytes, and only the new ones fetched whole: this
    # runs at the start of every turn, and a conversation with a dozen photos
    # in it should not read them all off disk to find that none are new.
    for attachments in store.attachments_for_session(session_id).values():
        for listed in attachments:
            if listed.kind != "image" or listed.id in seen:
                continue
            attachment = store.get_attachment(listed.id)
            if attachment is None or not attachment.data:
                continue
            try:
                ready = prepare(attachment.name, attachment.data)
            except ImageError:
                continue
            store.add_image(
                session_id,
                name=ready.name,
                mime=ready.mime,
                width=ready.width,
                height=ready.height,
                data=ready.data,
                attachment_id=attachment.id,
            )
            added += 1
    return added
