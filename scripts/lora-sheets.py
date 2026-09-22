"""Contact sheet for one epoch of a LoRA check: python lora-sheets.py <frames-dir> <file-prefix> <out.png>

Eight framings per row, weight 1.0 on the first row and 1.2 on the second, each tile labelled with
what the file name says after the prefix. The person judges these; nothing here decides anything.
"""

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

folder, prefix, out = Path(sys.argv[1]), sys.argv[2], Path(sys.argv[3])
PER_ROW = 8
HEIGHT = 420

files = sorted(p for p in folder.glob(f"{prefix}-*.png"))
if not files:
    print(f"no frames for {prefix} in {folder}", file=sys.stderr)
    sys.exit(1)

try:
    font = ImageFont.truetype("C:/Windows/Fonts/arialbd.ttf", 18)
except OSError:
    font = ImageFont.load_default()

tiles = []
for f in files:
    im = Image.open(f)
    im = im.resize((round(im.width * HEIGHT / im.height), HEIGHT))
    tile = Image.new("RGB", (im.width, HEIGHT + 24), "white")
    tile.paste(im, (0, 24))
    ImageDraw.Draw(tile).text((3, 2), f.stem[len(prefix):][:34], fill="black", font=font)
    tiles.append(tile)

rows = [tiles[i : i + PER_ROW] for i in range(0, len(tiles), PER_ROW)]
width = max(sum(t.width for t in row) + 6 * len(row) for row in rows)
sheet = Image.new("RGB", (width, (HEIGHT + 30) * len(rows)), (230, 230, 230))
y = 0
for row in rows:
    x = 0
    for tile in row:
        sheet.paste(tile, (x, y))
        x += tile.width + 6
    y += HEIGHT + 30
out.parent.mkdir(parents=True, exist_ok=True)
sheet.save(out)
print(f"{out} ({len(files)} frames, {sheet.size[0]}x{sheet.size[1]})")
