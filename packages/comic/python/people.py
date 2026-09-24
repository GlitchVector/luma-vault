"""One mask per person in a panel, for the sketch route's second pass.

The first pass draws the whole panel with nobody's LoRA; the second repaints
each cast character inside her own figure with her own LoRA. This finds those
figures. Same person-segmentation model the letterer uses (figures.py), but
here each detection keeps its own mask instead of being merged into a grid.

    python people.py <person-seg.onnx> <image> <outdir> [--grow 0.08] [--hair ari=#eef2f3,#3fc5c8 ...]

writes <outdir>/person-<n>.png (white = that person, grown by --grow times the
figure's own height so a curvier repaint still fits) and prints one JSON line:
    {"people": [{"mask": ..., "box": [x0,y0,x1,y1], "area": fraction,
                 "match": {"ari": fraction}}, ...]}
`match` is the share of the figure's head region (its top quarter) whose
colour is near one of that character's hair colours: how a mirror image of
her is found as well as her, and a guest with brown hair is not. People are
ordered left to right by the figure's centre, because the sketch prompt
names the cast left to right. Boxes are fractions of the image.
"""

import json
import os
import sys

import cv2
import numpy as np
import onnxruntime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from figures import PERSON_CONFIDENCE, SIDE, blob_of, letterbox, rows_of, suppress  # noqa: E402

# A person smaller than this share of the panel is a crowd member, not the
# character the panel is about.
MIN_AREA = 0.01
# RGB distance under which a pixel counts as that hair colour.
HAIR_DISTANCE = 60


def hex_rgb(value):
    value = value.lstrip("#")
    return np.array([int(value[i : i + 2], 16) for i in (4, 2, 0)], dtype=np.float32)  # BGR, as cv2 reads


def hair_match(image, mask, colours):
    ys, xs = np.nonzero(mask)
    if len(ys) == 0 or not colours:
        return 0.0
    top, bottom = ys.min(), ys.max()
    head = (ys <= top + (bottom - top) * 0.25)
    pixels = image[ys[head], xs[head]].astype(np.float32)
    if len(pixels) == 0:
        return 0.0
    near = np.zeros(len(pixels), dtype=bool)
    for colour in colours:
        near |= np.linalg.norm(pixels - colour, axis=1) < HAIR_DISTANCE
    return round(float(near.mean()), 4)


def people_in(session, image, grow_share, hair):
    height, width = image.shape[:2]
    canvas, scale, pad_x, pad_y = letterbox(image)
    outputs = session.run(None, {session.get_inputs()[0].name: blob_of(canvas)})
    detections = rows_of(outputs[0])
    protos = outputs[1][0] if len(outputs) > 1 else None
    if protos is None:
        return []
    boxes, scores, coeffs = [], [], []
    for row in detections:
        confidence = float(row[4])
        if confidence < PERSON_CONFIDENCE:
            continue
        cx, cy, bw, bh = (float(v) for v in row[:4])
        boxes.append((cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2))
        scores.append(confidence)
        coeffs.append(row[5:])
    channels, mh, mw = protos.shape
    flat = protos.reshape(channels, -1)
    found = []
    for i in suppress(boxes, scores):
        mask = 1.0 / (1.0 + np.exp(-(np.asarray(coeffs[i][:channels], dtype=np.float32) @ flat)))
        mask = cv2.resize(mask.reshape(mh, mw), (SIDE, SIDE), interpolation=cv2.INTER_LINEAR)
        x0, y0, x1, y1 = (int(round(v)) for v in boxes[i])
        window = np.zeros_like(mask)
        window[max(0, y0) : max(0, y1), max(0, x0) : max(0, x1)] = 1.0
        binary = ((mask > 0.5) * window).astype(np.uint8) * 255
        inner = binary[pad_y : SIDE - pad_y or SIDE, pad_x : SIDE - pad_x or SIDE]
        full = cv2.resize(inner if inner.size else binary, (width, height), interpolation=cv2.INTER_NEAREST)
        area = float((full > 0).mean())
        if area < MIN_AREA:
            continue
        ys, xs = np.nonzero(full)
        match = {name: hair_match(image, full, colours) for name, colours in hair.items()}
        grow = max(3, int(grow_share * (ys.max() - ys.min())))
        full = cv2.dilate(full, np.ones((grow, grow), np.uint8))
        ys, xs = np.nonzero(full)
        box = [round(xs.min() / width, 4), round(ys.min() / height, 4), round(xs.max() / width, 4), round(ys.max() / height, 4)]
        found.append({"mask": full, "box": box, "area": round(area, 4), "cx": float(xs.mean()), "match": match})
    return sorted(found, key=lambda p: p["cx"])


def main():
    args = sys.argv[1:]
    grow, hair, positional = 0.08, {}, []
    while args:
        arg = args.pop(0)
        if arg == "--grow":
            grow = float(args.pop(0))
        elif arg == "--hair":
            name, _, colours = args.pop(0).partition("=")
            hair[name] = [hex_rgb(c) for c in colours.split(",") if c]
        else:
            positional.append(arg)
    if len(positional) != 3:
        print("usage: people.py <person-seg.onnx> <image> <outdir> [--grow F] [--hair name=#hex,#hex]", file=sys.stderr)
        raise SystemExit(2)
    model, path, outdir = positional
    image = cv2.imread(path, cv2.IMREAD_COLOR)
    if image is None:
        raise SystemExit(f"{path} could not be read")
    session = onnxruntime.InferenceSession(model, providers=["CPUExecutionProvider"])
    os.makedirs(outdir, exist_ok=True)
    rows = []
    for n, person in enumerate(people_in(session, image, grow, hair)):
        target = os.path.join(outdir, f"person-{n}.png")
        cv2.imwrite(target, person["mask"])
        rows.append({"mask": target, "box": person["box"], "area": person["area"], "match": person["match"]})
    print(json.dumps({"people": rows}), flush=True)


if __name__ == "__main__":
    main()
