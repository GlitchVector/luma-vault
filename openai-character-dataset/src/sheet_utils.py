"""Cutting a generated model sheet into its figures.

The moderation gate lets a three-view model sheet through far more readily than a single
standing figure of the same character (owner, 2026-09-23: a single view of the space-leotard
sheet took ten or more attempts, a sheet usually passes), so ``generate --sheet`` asks for
three figures in one wide image and keeps the middle and right ones as two views. The sheet
is rendered large enough that each figure holds about as many pixels as a single view would,
because a figure trained at half size is how ari_gen_v1 lost its shorts.

The cut is made at the two narrowest VALLEYS of the column occupancy, one in each third
boundary's neighbourhood, not at empty gaps: figures on a sheet touch each other more often
than not (a cowboy's elbow, a glove), and a cut at equal thirds went through the neighbour's
arm on the first run (owner spotted it in the vault, 2026-09-23). A valley cut still leaves a
sliver of a neighbour when they overlap outright; the crop is then narrowed to the columns the
figure itself occupies on either side of the valleys.
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


def _valley(occ: np.ndarray, lo: int, hi: int) -> int:
    """The emptiest column between lo and hi; the middle of the emptiest run when it is a plateau."""
    window = occ[lo:hi]
    floor = window.min()
    empties = np.where(window <= floor + 0.002)[0]
    return lo + int(empties[len(empties) // 2])


def split_sheet(data: bytes, figures: int = 3, pad: float = 0.02) -> list[Image.Image]:
    """The figures of a sheet, left to right, each cut at the valleys beside it and trimmed to its own columns."""
    im = Image.open(BytesIO(data)).convert("RGB")
    occ = _occupancy(im)
    w = im.width
    # Smooth a little so a single stray column does not pose as a valley.
    kernel = np.ones(9) / 9
    smooth = np.convolve(occ, kernel, mode="same")
    third = w / figures
    cuts = [0]
    for i in range(1, figures):
        centre = int(i * third)
        cuts.append(_valley(smooth, int(centre - third * 0.35), int(centre + third * 0.35)))
    cuts.append(w)
    out = []
    for s, e in zip(cuts[:-1], cuts[1:]):
        # Trim to the columns this figure occupies, so a neighbour's sliver past the valley drops out.
        cols = np.where(occ[s:e] > 0.004)[0]
        if len(cols):
            s2, e2 = s + int(cols[0]), s + int(cols[-1]) + 1
        else:
            s2, e2 = s, e
        margin = int((e2 - s2) * pad)
        out.append(im.crop((max(s, s2 - margin), 0, min(e, e2 + margin), im.height)))
    return out


def to_png_bytes(im: Image.Image) -> bytes:
    buf = BytesIO()
    im.save(buf, format="PNG")
    return buf.getvalue()
