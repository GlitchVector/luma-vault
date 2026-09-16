"""Tag panel PNGs with the vault's wd-vit-tagger-v3, one JSON line per image.

usage: python tagger.py --model-dir <dir with model.onnx + selected_tags.csv>
                        [--threshold 0.35] [--watch tag,tag,...] <image> [<image> ...]

Prints {"path": ..., "tags": {name: confidence}} per image: every general tag at
or above the threshold, plus every watched tag at whatever confidence it has,
so the caller can compare `solo` against `2girls` rather than against a cut.
CPU only, deliberately: this runs while the GPU may be training.
"""
import argparse
import csv
import json
import sys
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image

ap = argparse.ArgumentParser()
ap.add_argument("--model-dir", required=True)
ap.add_argument("--threshold", type=float, default=0.35)
ap.add_argument("--watch", default="")
ap.add_argument("images", nargs="+")
args = ap.parse_args()

model_dir = Path(args.model_dir)
with open(model_dir / "selected_tags.csv", newline="", encoding="utf-8") as f:
    rows = list(csv.DictReader(f))
names = [r["name"].replace("_", " ") for r in rows]
categories = [int(r["category"]) for r in rows]  # 0 general, 4 character, 9 rating
watch = {t.strip() for t in args.watch.split(",") if t.strip()}

sess = ort.InferenceSession(str(model_dir / "model.onnx"), providers=["CPUExecutionProvider"])
inp = sess.get_inputs()[0]
size = inp.shape[1] if isinstance(inp.shape[1], int) else 448


def prep(path):
    im = Image.open(path).convert("RGBA")
    bg = Image.new("RGBA", im.size, (255, 255, 255, 255))
    im = Image.alpha_composite(bg, im).convert("RGB")
    w, h = im.size
    side = max(w, h)
    canvas = Image.new("RGB", (side, side), (255, 255, 255))
    canvas.paste(im, ((side - w) // 2, (side - h) // 2))
    canvas = canvas.resize((size, size), Image.BICUBIC)
    arr = np.asarray(canvas, dtype=np.float32)[:, :, ::-1]  # RGB -> BGR, as the tagger was trained
    return arr[None, ...]


for path in args.images:
    probs = sess.run(None, {inp.name: prep(path)})[0][0]
    tags = {}
    for name, category, p in zip(names, categories, probs):
        if category != 0:
            continue
        p = float(p)
        if p >= args.threshold or name in watch:
            tags[name] = round(p, 4)
    sys.stdout.write(json.dumps({"path": path, "tags": tags}) + "\n")
    sys.stdout.flush()
