"""Looking at a canvas: the render as a picture, for a model that can see.

The design check reads the source; this shows the result. What a vision model
can judge from a picture that it cannot from text -- whether the page has a
focal point, whether the spacing breathes, whether the screen looks finished
-- is most of what makes design good rather than merely correct.

Offered only where there is an engine to draw with (see render.py) and only to
a model that can see, which the turn loop checks per backend.
"""

from __future__ import annotations

import json
import re

from ..providers.base import Image
from ..render import Renderer, data_uri, page_stage, wireframe_stage
from ..store import Store
from .args import plain_text
from .images import REFERENCE
from .skill import STUDIO, Pictured, Skill

#: How many wireframe frames fit one picture before each is too small to read.
MAX_FRAMES = 4


class ViewCanvas(Skill):
    # A canvas, design or device tool: not offered in a code conversation.
    modes = STUDIO
    wants_session = True

    def __init__(self, store: Store, renderer: Renderer | None = None) -> None:
        super().__init__(
            name="view_canvas",
            description=(
                "Look at a canvas as it renders: a picture of a web page or of "
                "a wireframe's screens, returned to you as an image. Use it after "
                "making or changing something whose look matters, to judge "
                "hierarchy, spacing, alignment and colour with your own eyes -- "
                "then fix what you see with edit_canvas or edit_wireframe, and "
                "look again. For a page, `device` is 'desktop' (1280px wide) or "
                "'mobile' (two phone screens, the top and the next one down), and "
                "`scroll` starts that many pixels down the page. For a wireframe, "
                "`frames` picks up to four screens by id or name; by default the "
                "first four are shown. Scripts do not run in the picture and "
                "nothing is fetched from the internet."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "Which canvas to look at."},
                    "device": {"type": "string", "enum": ["desktop", "mobile"]},
                    "scroll": {"type": "integer", "description": "Pixels down the page to start."},
                    "frames": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "For a wireframe: frame ids or names.",
                    },
                },
                "required": ["title"],
            },
        )
        self.store = store
        self.renderer = renderer if renderer is not None else Renderer()

    @property
    def available(self) -> bool:
        return self.renderer.available

    def _pictures(self, session: str, ids) -> dict[str, str]:
        """Library pictures by id, as data URIs, for the render to draw."""
        known = {image.id for image in self.store.session_images(session)}
        found: dict[str, str] = {}
        for image_id in set(ids) & known:
            image = self.store.get_image(image_id, with_data=True)
            data = getattr(image, "data", None) if image else None
            if data:
                found[image_id] = data_uri(image.mime, data)
        return found

    async def use(self, session: str, title=None, device="desktop", scroll=0,
                  frames=None, **extra) -> str:
        name = plain_text(title or extra.get("name"))
        canvas = self.store.find_canvas_by_title(session, name) if name else None
        if canvas is None:
            here = [c.title for c in self.store.session_canvases(session)
                    if c.kind in ("html", "wireframe")]
            listed = ", ".join(repr(t) for t in here) or "none yet"
            return f"There is no canvas called {name!r}. Pages and wireframes here: {listed}."

        if canvas.kind == "html":
            view = "mobile" if plain_text(device).lower() in ("mobile", "phone") else "desktop"
            try:
                offset = max(0, int(plain_text(scroll) or 0))
            except ValueError:
                offset = 0
            page = canvas.content or ""
            # The user's pictures, drawn from the library as the panel does.
            pictures = self._pictures(session, REFERENCE.findall(page))
            page = REFERENCE.sub(lambda m: pictures.get(m.group(1), m.group(0)), page)
            png = await self.renderer.draw(page_stage(page, view, offset))
            if png is None:
                return f"{canvas.title!r} could not be drawn this time. Use check_design instead."
            where = f", from {offset}px down" if offset else ", the top of the page"
            said = (
                f"This is {canvas.title!r} at {'phone' if view == 'mobile' else 'desktop'} width"
                f"{where}. Look at it as the user will: the focal point, the spacing, "
                "the alignment, the contrast. Fix what is off with edit_canvas."
            )
            if re.search(r"<script\b", page, re.I):
                said += " Scripts do not run in this picture, so anything they draw is missing."
            return Pictured(said, [Image(name=f"{canvas.title}.png", mime="image/png", data=png)])

        if canvas.kind == "wireframe":
            try:
                doc = json.loads(canvas.content or "{}")
            except ValueError:
                return f"{canvas.title!r} could not be read as a wireframe."
            every = doc.get("frames") or []
            wanted = [plain_text(f).lower() for f in (frames or []) if plain_text(f)]
            if wanted:
                chosen = [f for f in every if f.get("id", "").lower() in wanted
                          or f.get("name", "").lower() in wanted][:MAX_FRAMES]
                if not chosen:
                    listed = ", ".join(f"{f['id']} {f['name']!r}" for f in every)
                    return f"None of those frames are in {canvas.title!r}: {listed}."
            else:
                chosen = every[:MAX_FRAMES]
            if not chosen:
                return f"{canvas.title!r} has no frames to look at."
            ids = [l.get("image") for f in chosen for l in f.get("layers", []) if l.get("image")]
            png = await self.renderer.draw(wireframe_stage(doc, chosen, self._pictures(session, ids)))
            if png is None:
                return f"{canvas.title!r} could not be drawn this time. Use check_design instead."
            shown = ", ".join(f"{f['id']} {f['name']!r}" for f in chosen)
            more = len(every) - len(chosen)
            said = (
                f"This is {canvas.title!r}: {shown}"
                + (f" ({more} more frame{'' if more == 1 else 's'} not shown -- pass `frames`)" if more > 0 else "")
                + ". Drawn by the server from the layers, so type and small details may "
                "differ slightly from the panel. Check the hierarchy, spacing and "
                "alignment, then fix what is off with edit_wireframe."
            )
            return Pictured(said, [Image(name=f"{canvas.title}.png", mime="image/png", data=png)])

        return (
            f"{canvas.title!r} is {canvas.kind}; only web pages and wireframes can be "
            "looked at. check_design reviews the rest."
        )
