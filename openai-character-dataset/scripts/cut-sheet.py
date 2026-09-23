"""Cut the figure panels out of a character sheet into one composite reference.

    python scripts/cut-sheet.py <sheet.png> <out.png> [--cuts 0.117,0.342,0.501,0.638,0.812]
                                [--keep 0,2,3] [--bottom 0.955] [--blank x,y[,x,y...]] [--views <dir>]

The generator takes the whole reference, so a sheet's title, labels, palette and detail panels
would go in with the figures - and so would a wrong panel. Two of the owner's sheets (2026-09-23)
had one bad view each: a 3/4 with the thigh strap on the wrong leg, a back view with a stripe the
boots do not have. Mirroring the bad 3/4 to fix the strap moved the badge to the wrong breast for a
day of renders, so nothing here mirrors; a panel that is wrong is left out (`--keep`), and the text
carries what it would have shown.

`--cuts` are the column lines between panels as fractions of the width (N+1 values for N panels);
`--keep` the panel indices to use, left to right; `--bottom` where the view labels start; `--blank`
top-left rectangles (fractions of the sheet) painted background colour where the title overlaps the
first panel. Crops and background-coloured blanking only - no colour or content edits. The single
panels are saved beside the composite under `--views` when given, for the owner to check one by one.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("sheet")
    ap.add_argument("out")
    ap.add_argument("--cuts", default="0.117,0.342,0.501,0.638,0.812")
    ap.add_argument("--keep", default="0,2,3", help="panel indices to keep, left to right (default: front, side, back of a 4-view sheet)")
    ap.add_argument("--bottom", type=float, default=0.955, help="fraction of the height where the view labels start")
    ap.add_argument("--blank", default="", help="x,y[,x,y...]: top-left rectangles (fractions) to paint background colour in the first kept panel")
    ap.add_argument("--views", default="", help="folder for the single panels")
    args = ap.parse_args()

    im = Image.open(args.sheet).convert("RGB")
    a = np.asarray(im).astype(int)
    bg = tuple(int(c) for c in np.median(a[5:25, 5:25].reshape(-1, 3), axis=0))
    mask = np.abs(a - np.array(bg)).sum(axis=2) > 60
    cuts = [float(c) for c in args.cuts.split(",")]
    keep = [int(k) for k in args.keep.split(",")]
    blanks = [float(v) for v in args.blank.split(",")] if args.blank else []
    y_bot = int(im.height * args.bottom)

    panels: list[Image.Image] = []
    for n, i in enumerate(keep):
        s, e = int(im.width * cuts[i]), int(im.width * cuts[i + 1])
        sub = mask[:y_bot, s:e]
        rows = np.where(sub.sum(axis=1) > 3)[0]
        if len(rows) == 0:
            raise SystemExit(f"panel {i} between {cuts[i]} and {cuts[i + 1]} holds nothing")
        top = max(0, int(rows.min()) - 20)
        crop = im.crop((s, top, e, min(y_bot, int(rows.max()) + 8)))
        if n == 0 and blanks:
            d = ImageDraw.Draw(crop)
            for bx, by in zip(blanks[0::2], blanks[1::2]):
                d.rectangle((0, 0, int(im.width * bx) - s, int(im.height * by) - top), fill=bg)
        panels.append(crop)

    h = max(p.height for p in panels)
    gap = 40
    sheet = Image.new("RGB", (sum(p.width for p in panels) + gap * (len(panels) + 1), h + 2 * gap), bg)
    x = gap
    for p in panels:
        sheet.paste(p, (x, gap + (h - p.height) // 2))
        x += p.width + gap
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    sheet.save(args.out)
    print(args.out, sheet.size, [p.size for p in panels])
    if args.views:
        views = Path(args.views)
        views.mkdir(parents=True, exist_ok=True)
        for i, p in zip(keep, panels):
            p.save(views / f"panel-{i}.png")
        print(views)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
