"""The HTTP surface for the browsers: what Settings → Browser reads and sets."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from .service import Browsers


class BrowserPatch(BaseModel):
    # "" clears the pick; "default" follows macOS; otherwise a bundle id.
    mine: str | None = Field(default=None, max_length=200)
    show_window: bool | None = None


def build_browser_router(browsers: Browsers, auth) -> APIRouter:
    router = APIRouter(dependencies=[Depends(auth)])

    @router.get("/browser")
    def get_browser() -> dict:
        return browsers.status()

    @router.patch("/browser")
    async def set_browser(body: BrowserPatch) -> dict:
        if body.mine is not None:
            browsers.set_mine(body.mine)
        if body.show_window is not None:
            await browsers.set_show_window(body.show_window)
        return browsers.status()

    @router.post("/browser/install")
    def install_browser() -> dict:
        """Fetch Chrome for Testing into data/browser. Asked for from the
        page, never started on its own: it is a large download."""
        browsers.installer.start()
        return browsers.status()

    @router.post("/browser/close")
    async def close_browser() -> dict:
        await browsers.close_own()
        return browsers.status()

    @router.get("/browser/view/{session_id}")
    def browser_view(session_id: str) -> dict:
        """The latest picture of a conversation's tab, for a panel that was
        opened after the step that drew it."""
        return {"view": browsers.view(session_id)}

    return router
