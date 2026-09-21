"""A thin wrapper over the official ``openai`` SDK's Images API.

Verified against the installed SDK (openai 3.15.0): ``client.images.generate`` and
``client.images.edit`` take ``model``, ``prompt``, ``size``, ``quality``,
``output_format`` and ``n``; ``edit`` takes ``image`` as one file or a sequence of
files, plus ``input_fidelity`` ("low" | "high"). GPT image models answer with
``b64_json``. The SDK is imported lazily so a dry run needs neither the package nor
the key.

The client never sees the key: ``OpenAI()`` reads ``OPENAI_API_KEY`` from the
environment (``python-dotenv`` loads ``.env`` in the CLIs before this is built).
"""

from __future__ import annotations

import base64
import os
from contextlib import ExitStack
from pathlib import Path
from typing import Any

DEFAULT_TIMEOUT_SECONDS = 180.0


class ImageClientError(Exception):
    """An API problem, classified so the caller can say something useful.

    ``kind`` is one of: auth, billing, moderation, rate_limit, bad_request, invalid_output, api.
    """

    def __init__(self, kind: str, message: str):
        super().__init__(message)
        self.kind = kind


def classify_error(exc: BaseException) -> ImageClientError:
    """Map an SDK exception to a readable, key-free ``ImageClientError``."""
    text = str(exc)
    status = getattr(exc, "status_code", None)
    code = ""
    body = getattr(exc, "body", None)
    if isinstance(body, dict):
        err = body.get("error") if isinstance(body.get("error"), dict) else body
        code = str(err.get("code") or err.get("type") or "") if isinstance(err, dict) else ""
    lowered = f"{text} {code}".lower()

    if status == 401 or "invalid_api_key" in lowered or "incorrect api key" in lowered:
        return ImageClientError("auth", "OpenAI rejected the API key (401). Check OPENAI_API_KEY in .env.")
    if status == 429 and ("quota" in lowered or "billing" in lowered or "insufficient" in lowered):
        return ImageClientError("billing", "OpenAI reports a billing or quota problem (429). Fix the payment method on the OpenAI account, then retry.")
    if "billing" in lowered or "payment" in lowered or "insufficient_quota" in lowered:
        return ImageClientError("billing", "OpenAI reports a billing problem. Fix the payment method on the OpenAI account, then retry.")
    if status == 429:
        return ImageClientError("rate_limit", "OpenAI rate limit (429). Wait a moment and retry.")
    if "moderation" in lowered or "safety" in lowered or "content_policy" in lowered or "rejected by" in lowered:
        return ImageClientError("moderation", f"OpenAI's moderation refused this request: {text[:300]}")
    if status == 400 or "invalid_request" in lowered:
        return ImageClientError("bad_request", f"OpenAI refused the request as invalid (400): {text[:300]}")
    return ImageClientError("api", f"OpenAI SDK error ({type(exc).__name__}): {text[:300]}")


class OpenAIImageClient:
    # Set when a model rejects `input_fidelity` (gpt-image-2.5-* does); the parameter is then
    # dropped for the rest of the session instead of failing every view.
    _no_input_fidelity: set[str]

    def __init__(self, *, timeout: float = DEFAULT_TIMEOUT_SECONDS):
        self._no_input_fidelity = set()
        if not os.environ.get("OPENAI_API_KEY"):
            raise ImageClientError("auth", "OPENAI_API_KEY is not set. Copy .env.example to .env and put the key there (never commit .env).")
        try:
            from openai import OpenAI
        except ImportError as exc:  # pragma: no cover - environment problem
            raise ImageClientError("api", "the openai package is not installed: pip install -r requirements.txt") from exc
        self._client = OpenAI(timeout=timeout)

    # -------------------------------------------------------------- calls

    def generate_from_prompt(self, prompt: str, *, model: str, size: str, quality: str, output_format: str) -> bytes:
        """``client.images.generate`` -> decoded image bytes."""
        try:
            response = self._client.images.generate(
                model=model,
                prompt=prompt,
                n=1,
                size=size,  # type: ignore[arg-type]  (the SDK also accepts plain strings)
                quality=quality,  # type: ignore[arg-type]
                output_format=output_format,  # type: ignore[arg-type]
            )
        except Exception as exc:  # noqa: BLE001 - every SDK error is re-raised classified
            raise classify_error(exc) from exc
        return _decode(response)

    def edit_with_references(
        self,
        prompt: str,
        references: list[Path],
        *,
        model: str,
        size: str,
        quality: str,
        output_format: str,
        input_fidelity: str = "high",
    ) -> bytes:
        """``client.images.edit`` with one or several reference files -> decoded image bytes."""
        if not references:
            raise ImageClientError("bad_request", "edit_with_references needs at least one reference image")
        missing = [path for path in references if not path.is_file()]
        if missing:
            raise ImageClientError("bad_request", f"reference image not found: {', '.join(str(p) for p in missing)}")
        for attempt in (1, 2):
            extra: dict[str, Any] = {}
            if input_fidelity and model not in self._no_input_fidelity:
                extra["input_fidelity"] = input_fidelity
            with ExitStack() as stack:
                handles = [stack.enter_context(path.open("rb")) for path in references]
                image: Any = handles[0] if len(handles) == 1 else handles
                try:
                    response = self._client.images.edit(
                        model=model,
                        image=image,
                        prompt=prompt,
                        n=1,
                        size=size,  # type: ignore[arg-type]
                        quality=quality,  # type: ignore[arg-type]
                        output_format=output_format,  # type: ignore[arg-type]
                        **extra,
                    )
                except Exception as exc:  # noqa: BLE001
                    error = classify_error(exc)
                    # "The model '…' does not support the 'input_fidelity' parameter": drop it and retry once.
                    if attempt == 1 and "input_fidelity" in str(exc) and "input_fidelity" in extra:
                        self._no_input_fidelity.add(model)
                        continue
                    raise error from exc
            return _decode(response)
        raise ImageClientError("api", "unreachable")


def _decode(response: Any) -> bytes:
    data = getattr(response, "data", None) or []
    first = data[0] if data else None
    b64 = getattr(first, "b64_json", None) if first is not None else None
    if not b64:
        raise ImageClientError("invalid_output", "OpenAI answered without image data (no b64_json in the response)")
    try:
        raw = base64.b64decode(b64, validate=True)
    except (ValueError, TypeError) as exc:
        raise ImageClientError("invalid_output", "OpenAI returned image data that is not valid base64") from exc
    if len(raw) < 100:
        raise ImageClientError("invalid_output", f"OpenAI returned suspiciously little image data ({len(raw)} bytes)")
    return raw
