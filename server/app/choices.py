"""A question the turn stops to ask, when the answer is a pick rather than a yes.

The approval gate next door asks "may this run?" and takes a yes or a no. This
asks "which of these?" and takes an id. The machinery is the same in the way
that matters: the turn holds open, the question travels as one more frame on
the SSE stream the answer is already arriving on, and the wait costs a pending
request rather than a second trip through the model.

Two differences from `Approvals` are deliberate:

* **the default is a real answer, not a refusal.** A design question nobody
  answers should let the turn carry on unstyled, not kill it -- so the timeout
  resolves to a caller-supplied value ("none") rather than to a deny;

* **nothing is remembered.** There is no "always use this one" here. A design
  standard is a per-result decision, and a standing grant would silently style
  a document nobody was looking at when the choice was made.
"""

from __future__ import annotations

import asyncio
import uuid

#: How long a question stands before the turn gives up and takes the default.
#: Shorter than an approval's five minutes: this one is not blocking anything
#: dangerous, and a turn that carries on unstyled is a recoverable outcome.
TIMEOUT_SECONDS = 180.0


class Choices:
    """The questions currently waiting for an answer, keyed by request id.

    In memory, and deliberately: a pending question belongs to a stream that is
    open right now. Persisting one would mean restoring, on boot, a question
    about a turn whose connection died with the previous process.
    """

    def __init__(self, timeout: float = TIMEOUT_SECONDS) -> None:
        self._pending: dict[str, asyncio.Future[str]] = {}
        self.timeout = timeout

    def open(self) -> tuple[str, asyncio.Future[str]]:
        """A new pending question, and the future its answer arrives on."""
        request_id = uuid.uuid4().hex
        future: asyncio.Future[str] = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future
        return request_id, future

    def resolve(self, request_id: str, chosen: str) -> bool:
        """Answer one question. False if nothing is waiting under that id.

        False rather than an exception for the ordinary races: the same option
        pressed twice, or an answer that arrives after the turn was abandoned.
        Neither is a fault worth a 500, and the route reports them as a 404.
        """
        future = self._pending.pop(request_id, None)
        if future is None or future.done():
            return False
        future.set_result(chosen)
        return True

    async def wait(self, request_id: str, future: asyncio.Future[str], default: str) -> str:
        """Block until the reader picks, or long enough to take the default.

        The `finally` matters more than the timeout. If the reader closes the
        tab mid-question the generator is cancelled here, and without this the
        entry would sit in the dict for the life of the process holding a
        future nobody can ever resolve.
        """
        try:
            return await asyncio.wait_for(asyncio.shield(future), self.timeout)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            return default
        finally:
            self._pending.pop(request_id, None)
