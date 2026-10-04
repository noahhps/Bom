"""Browsers the model can work in.

Two of them, for two different jobs. Bom's own (chromium.py) is a private
Chromium with its own profile: for anything that is about a page. The user's
own (mine.py) is the browser they are signed in to, driven through the system
rather than copied: for the few things that need their account, each step
approved by them. service.py holds both; skills/browser.py is what the model
is offered; api.py is what Settings → Browser talks to.
"""

from __future__ import annotations

from .api import build_browser_router
from .service import BROWSER_DEFAULTS, MINE_KEY, Browsers

__all__ = ["BROWSER_DEFAULTS", "MINE_KEY", "Browsers", "build_browser_router"]
