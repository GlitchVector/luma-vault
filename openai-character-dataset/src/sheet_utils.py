"""Cutting a generated model sheet into its figures.

The moderation gate lets a three-view model sheet through far more readily than a single
standing figure of the same character (owner, 2026-09-23: a single view of the space-leotard
sheet took ten or more attempts, a sheet usually passes), so ``generate --sheet`` asks for
three figures in one wide image and keeps the middle and right ones as two views. The sheet
is rendered large enough that each figure holds about as many pixels as a single view would,
because a figure trained at half size is how ari_gen_v1 lost its shorts.

The split is by content: the columns that hold nothing but background separate the figures.
When that does not give exactly three runs (a hand touching the next figure, a shadow), the
image is cut into equal thirds, which the layout instruction makes a fair fallback.
"""

from __future__ import annotations

from io import BytesIO

import numpy as np
from PIL import Image


def _occupancy(im: Image.Image) -> np.ndarray:
    a = np.asarray(im.convert("RGB"), dtype=np.int16)
    border = np.concatenate([a[:8].reshape(-1, 3), a[-8:].reshape(-1, 3), a[:, :8].reshape(-1, 3), a[:, -8:].reshape(-1, 3)])
    bg = np.median(border, axis=0)
    diff = np.abs(a - bg).max(axis=2) > 28
    return diff.mean(axis=0)


def split_sheet(data: bytes, figures: int = 3, pad: float = 0.03) -> list[Image.Image]:
    """The figures of a sheet, left to right, each trimmed to its own columns plus a small margin."""
    im = Image.open(BytesIO(data)).convert("RGB")
    cols = _occupancy(im) > 0.004
    runs: list[tuple[int, int]] = []
    start = None
    for x, on in enumerate(cols):
        if on and start is None:
            start = x
        elif not on and start is not None:
            runs.append((start, x))
            start = None
    if start is not None:
        runs.append((start, len(cols)))
    # Drop slivers (a stray mark) and merge runs closer than a finger's width.
    runs = [r for r in runs if r[1] - r[0] > im.width * 0.04]
    merged: list[tuple[int, int]] = []
    for r in runs:
        if merged and r[0] - merged[-1][1] < im.width * 0.02:
            merged[-1] = (merged[-1][0], r[1])
        else:
            merged.append(r)
    if len(merged) != figures:
        third = im.width / figures
        merged = [(int(i * third), int((i + 1) * third)) for i in range(figures)]
    out = []
    for (s, e) in merged:
        margin = int((e - s) * pad)
        out.append(im.crop((max(0, s - margin), 0, min(im.width, e + margin), im.height)))
    return out


def to_png_bytes(im: Image.Image) -> bytes:
    buf = BytesIO()
    im.save(buf, format="PNG")
    return buf.getvalue()
