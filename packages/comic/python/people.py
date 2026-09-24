"""One mask per person in a panel, for the sketch route's second pass.

The first pass draws the whole panel with nobody's LoRA; the second repaints
each cast character inside her own figure with her own LoRA. This finds those
figures. Same person-segmentation model the letterer uses (figures.py), but
here each detection keeps its own mask instead of being merged into a grid.

    python people.py <person-seg.onnx> <image> <outdir>

writes <outdir>/person-<n>.png (white = that person, grown a little so the
repaint covers the outline) and prints one JSON line:
    {"people": [{"mask": ..., "box": [x0,y0,x1,y1], "area": fraction}, ...]}
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
GROW = 0.02


def people_in(session, image):
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
        grow = max(3, int(GROW * max(width, height)))
        full = cv2.dilate(full, np.ones((grow, grow), np.uint8))
        ys, xs = np.nonzero(full)
        box = [round(xs.min() / width, 4), round(ys.min() / height, 4), round(xs.max() / width, 4), round(ys.max() / height, 4)]
        found.append({"mask": full, "box": box, "area": round(area, 4), "cx": float(xs.mean())})
    return sorted(found, key=lambda p: p["cx"])


def main():
    if len(sys.argv) != 4:
        print("usage: people.py <person-seg.onnx> <image> <outdir>", file=sys.stderr)
        raise SystemExit(2)
    model, path, outdir = sys.argv[1:]
    image = cv2.imread(path, cv2.IMREAD_COLOR)
    if image is None:
        raise SystemExit(f"{path} could not be read")
    session = onnxruntime.InferenceSession(model, providers=["CPUExecutionProvider"])
    os.makedirs(outdir, exist_ok=True)
    rows = []
    for n, person in enumerate(people_in(session, image)):
        target = os.path.join(outdir, f"person-{n}.png")
        cv2.imwrite(target, person["mask"])
        rows.append({"mask": target, "box": person["box"], "area": person["area"]})
    print(json.dumps({"people": rows}), flush=True)


if __name__ == "__main__":
    main()
