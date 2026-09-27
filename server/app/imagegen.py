"""Generating pictures, on a generator the operator points Bom at.

Off unless IMAGE_GEN_URL is set. Two request shapes are spoken, because they
cover nearly everything that runs locally:

* ``a1111`` -- the Stable Diffusion WebUI API (AUTOMATIC1111, Forge, SD.Next):
  ``POST /sdapi/v1/txt2img``, answering with base64 images;
* ``openai`` -- ``POST /v1/images/generations`` with ``b64_json``, which LocalAI
  and similar servers speak locally and cloud services speak remotely.

Whatever comes back is treated like any upload: it goes through
``images.prepare`` -- decoded, bounded, re-encoded -- before it is stored, and
it is stored marked ``generated`` so it is labelled wherever it is shown.

Three risks are handled here rather than left to the model:

* **where prompts go.** The address comes from configuration, never from the
  model, so this cannot be pointed at other hosts. A generator that is not on
  this machine or its local network is ``remote``: every call to it is asked
  about first, the way a skill is when "ask first" is on, because it sends
  what the user is working on to someone else;
* **what is asked for.** ``check_prompt`` refuses the requests no personal
  tool should fulfil -- sexual content, and anything sexual involving minors
  above all. Local diffusion models ship with no filter of their own, so this
  is the only one there is. It is a floor, not a moderation system;
* **the GPU.** One generation at a time. A diffusion model sharing a card with
  the chat model is slow at best, and two at once is how it runs out of memory.
"""

from __future__ import annotations

import asyncio
import base64
import ipaddress
import re
from urllib.parse import urlparse

import httpx

from .design_presets import PRESETS, tokens_for
from .images import ImageError, prepare
from .store import Store

BACKENDS = ("a1111", "openai")

#: Output sizes by shape. Multiples of 64, which diffusion models want, and
#: close to what SDXL-class models were trained on.
SIZES = {
    "landscape": (1216, 832),
    "portrait": (832, 1216),
    "square": (1024, 1024),
}
#: The nearest size an OpenAI-shaped API accepts for each shape.
OPENAI_SIZES = {"landscape": "1536x1024", "portrait": "1024x1536", "square": "1024x1024"}

#: Steered away from by default. The first four are about what comes out --
#: unwanted content -- and the rest about what looks unfinished on a slide.
NEGATIVE = "nsfw, nude, naked, gore, text, watermark, signature, logo, blurry, lowres"

MAX_RESPONSE = 60 * 1024 * 1024

_SEXUAL = re.compile(
    r"\b(nsfw|nude|nudity|naked|porn\w*|sex|sexual\w*|explicit|erotic\w*|hentai|"
    r"lingerie|topless|genitals?|fetish\w*|onlyfans)\b",
    re.IGNORECASE,
)
_MINOR = re.compile(
    r"\b(child|children|kid|kids|minor|minors|teen|teens|teenage\w*|underage|"
    r"schoolgirl|schoolboy|loli\w*|shota\w*|toddler|infant|baby|young girl|young boy)\b",
    re.IGNORECASE,
)


class GenerationError(RuntimeError):
    """A generation that did not produce a picture, with a sentence saying why."""


def check_prompt(prompt: str) -> str | None:
    """Why this prompt is refused, or None if it may be generated."""
    if _SEXUAL.search(prompt) and _MINOR.search(prompt):
        return "That request is refused: no sexual content involving minors, ever."
    if _SEXUAL.search(prompt):
        return "Bom does not generate sexual or explicit images."
    return None


def _is_local_host(host: str) -> bool:
    """This machine or its own network -- not somewhere else on the internet."""
    host = (host or "").strip("[]").lower()
    if host in ("localhost",) or host.endswith((".local", ".lan", ".home", ".internal")):
        return True
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return False
    return address.is_loopback or address.is_private or address.is_link_local


class Generator:
    """The configured generator, or an unconfigured one that says so."""

    def __init__(
        self,
        url: str = "",
        *,
        backend: str = "a1111",
        model: str = "",
        key: str = "",
        timeout: float = 240,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.url = (url or "").rstrip("/")
        self.backend = backend if backend in BACKENDS else "a1111"
        self.model = model
        self.key = key
        self.timeout = timeout
        self._transport = transport
        self._lock = asyncio.Lock()

    @classmethod
    def from_settings(cls, settings) -> "Generator":
        return cls(
            getattr(settings, "image_gen_url", ""),
            backend=getattr(settings, "image_gen_backend", "a1111"),
            model=getattr(settings, "image_gen_model", ""),
            key=getattr(settings, "image_gen_key", ""),
            timeout=getattr(settings, "image_gen_timeout", 240),
        )

    @property
    def configured(self) -> bool:
        return bool(self.url)

    @property
    def host(self) -> str:
        return urlparse(self.url).hostname or ""

    @property
    def remote(self) -> bool:
        """Whether a prompt sent here leaves this machine and its network."""
        return self.configured and not _is_local_host(self.host)

    def describe(self) -> dict:
        return {
            "available": self.configured,
            "backend": self.backend if self.configured else None,
            "host": self.host or None,
            "remote": self.remote,
        }

    async def generate(self, prompt: str, *, shape: str = "landscape") -> bytes:
        """One picture's bytes. Raises GenerationError."""
        if not self.configured:
            raise GenerationError("No image generator is set up. Set IMAGE_GEN_URL to one.")
        shape = shape if shape in SIZES else "landscape"
        async with self._lock:
            try:
                async with httpx.AsyncClient(
                    timeout=httpx.Timeout(self.timeout, connect=10),
                    transport=self._transport,
                    follow_redirects=False,
                ) as client:
                    if self.backend == "openai":
                        return await self._openai(client, prompt, shape)
                    return await self._a1111(client, prompt, shape)
            except httpx.TimeoutException as exc:
                raise GenerationError(
                    f"The image generator took longer than {int(self.timeout)}s. It may be "
                    "sharing the GPU with the chat model; try again, or a smaller request."
                ) from exc
            except httpx.HTTPError as exc:
                raise GenerationError(f"Could not reach the image generator at {self.host}: {exc}") from exc

    async def _a1111(self, client: httpx.AsyncClient, prompt: str, shape: str) -> bytes:
        width, height = SIZES[shape]
        payload: dict = {
            "prompt": prompt,
            "negative_prompt": NEGATIVE,
            "width": width,
            "height": height,
            "steps": 28,
            "cfg_scale": 6,
            "batch_size": 1,
            "n_iter": 1,
        }
        if self.model:
            payload["override_settings"] = {"sd_model_checkpoint": self.model}
        response = await client.post(f"{self.url}/sdapi/v1/txt2img", json=payload)
        data = self._json(response)
        images = data.get("images") or []
        if not images:
            raise GenerationError("The image generator answered without a picture.")
        return self._decode(images[0])

    async def _openai(self, client: httpx.AsyncClient, prompt: str, shape: str) -> bytes:
        base = self.url if self.url.endswith("/v1") else f"{self.url}/v1"
        payload = {
            "prompt": prompt,
            "n": 1,
            "size": OPENAI_SIZES[shape],
            "response_format": "b64_json",
        }
        if self.model:
            payload["model"] = self.model
        headers = {"Authorization": f"Bearer {self.key}"} if self.key else {}
        response = await client.post(f"{base}/images/generations", json=payload, headers=headers)
        data = self._json(response)
        items = data.get("data") or []
        encoded = items[0].get("b64_json") if items and isinstance(items[0], dict) else None
        if not encoded:
            # A URL instead of bytes would mean fetching from wherever it says;
            # refused rather than followed.
            raise GenerationError(
                "The image generator answered with a link rather than the picture. "
                "Configure it to return b64_json."
            )
        return self._decode(encoded)

    @staticmethod
    def _json(response: httpx.Response) -> dict:
        if len(response.content) > MAX_RESPONSE:
            raise GenerationError("The image generator's answer was too large.")
        if response.status_code >= 400:
            detail = response.text[:200].strip()
            raise GenerationError(f"The image generator refused ({response.status_code}): {detail}")
        try:
            data = response.json()
        except ValueError as exc:
            raise GenerationError("The image generator answered with something that is not JSON.") from exc
        return data if isinstance(data, dict) else {}

    @staticmethod
    def _decode(encoded: str) -> bytes:
        if "," in encoded[:100] and encoded.startswith("data:"):
            encoded = encoded.split(",", 1)[1]
        try:
            return base64.b64decode(encoded, validate=False)
        except (ValueError, TypeError) as exc:
            raise GenerationError("The image generator's picture did not decode.") from exc


def styled_prompt(store: Store, session_id: str | None, prompt: str) -> str:
    """The prompt, with the conversation's design standard folded in.

    A picture made for a Swiss deck should look like it belongs in one, so the
    standard's name, its one-line summary and its palette ride along. Hex
    values mean little to a diffusion model on their own; next to the name of
    the look they help, and to an OpenAI-shaped model they help directly.
    """
    if not session_id:
        return prompt
    chosen = store.session_design(session_id)
    if not chosen or chosen == "none":
        return prompt
    preset = next((p for p in PRESETS if p["id"] == chosen), None)
    design = store.get_design(chosen) if preset is None else None
    if preset is None and design is None:
        return prompt
    name = preset["name"] if preset else design.name
    summary = preset["summary"] if preset else (design.summary or "")
    tokens = tokens_for(chosen) or {}
    palette = ", ".join(
        tokens[k] for k in ("background", "accent", "accent_2", "text") if tokens.get(k)
    )
    parts = [prompt.rstrip(". "), f"In a {name} visual style"]
    if summary:
        parts.append(summary.rstrip("."))
    if palette:
        parts.append(f"colour palette {palette}")
    return ". ".join(parts) + "."


async def create(
    store: Store,
    generator: Generator,
    session_id: str,
    prompt: str,
    *,
    shape: str = "landscape",
    alt: str | None = None,
    match_style: bool = True,
):
    """Generate, clean and store one picture. Returns the StoredImage.

    Raises GenerationError for anything a person should be told -- a refused
    prompt, an unreachable generator, a picture that would not decode.
    """
    prompt = " ".join((prompt or "").split())[:1000]
    if not prompt:
        raise GenerationError("Say what the picture should show.")
    refusal = check_prompt(prompt)
    if refusal:
        raise GenerationError(refusal)
    final = styled_prompt(store, session_id, prompt) if match_style else prompt
    raw = await generator.generate(final, shape=shape)
    try:
        ready = prepare("generated.png", raw)
    except ImageError as exc:
        raise GenerationError(f"The generator's picture could not be used: {exc}") from exc
    slug = re.sub(r"[^a-z0-9]+", "-", prompt.lower()).strip("-")[:40] or "image"
    suffix = ready.name.rsplit(".", 1)[-1]
    return store.add_image(
        session_id,
        name=f"generated-{slug}.{suffix}",
        mime=ready.mime,
        width=ready.width,
        height=ready.height,
        data=ready.data,
        alt=(alt or "").strip()[:300] or prompt[:300],
        source="generated",
        prompt=final,
    )
