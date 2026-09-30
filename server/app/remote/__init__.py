"""Remote access: reaching this machine from anywhere through a relay.

See host.py for how it works and who may use it, and docs/remote.md for
setting it up.
"""

from .api import build_remote_router
from .host import RELAY_HEADER, RemoteHost

__all__ = ["RELAY_HEADER", "RemoteHost", "build_remote_router"]
