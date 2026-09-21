"""Where the faces are in a panel, as boxes.

The letterer needs this and cannot work it out for itself. An energy map
measures how busy the art is, and a head against a bright sky is as flat as
the sky, so the quietest place on the panel is often her face. Colour does
not save it either: her top is as flat as both, and a skin-tone guess invents
a face in a lit window.

So this runs the same detector ADetailer uses, `face_yolov8s`, exported to
ONNX so it needs onnxruntime rather than torch. The box it returns is roughly
the box ADetailer repaints, which is the one the owner asked for: hair is
fair game, the face is not.

    python faces.py <model.onnx> <image.png> [<image.png> ...]

prints one JSON object per line: {"path": ..., "faces": [[x0,y0,x1,y1], ...]}
with every coordinate a fraction of the image's own width or height.
"""

import json
import sys

import cv2
import numpy as np
import onnxruntime

# What the exported model was traced at. Anything else needs a re-export.
SIDE = 640
# Below this the detector is guessing. ADetailer's own default is 0.3; this
# is the same call, and a missed face only means a caption may sit on one.
CONFIDENCE = 0.3
# Two boxes overlapping by more than this are the same face seen twice.
OVERLAP = 0.45


def letterbox(image):
    """Fit the image into a square without distorting it, as YOLO expects."""
    height, width = image.shape[:2]
    scale = min(SIDE / width, SIDE / height)
    resized = cv2.resize(image, (int(round(width * scale)), int(round(height * scale))))
    canvas = np.full((SIDE, SIDE, 3), 114, dtype=np.uint8)
    top = (SIDE - resized.shape[0]) // 2
    left = (SIDE - resized.shape[1]) // 2
    canvas[top : top + resized.shape[0], left : left + resized.shape[1]] = resized
    return canvas, scale, left, top


def suppress(boxes, scores):
    """Keep the most confident box of each overlapping cluster."""
    order = sorted(range(len(boxes)), key=lambda i: scores[i], reverse=True)
    kept = []
    for i in order:
        x0, y0, x1, y1 = boxes[i]
        clash = False
        for j in kept:
            a0, b0, a1, b1 = boxes[j]
            iw = max(0.0, min(x1, a1) - max(x0, a0))
            ih = max(0.0, min(y1, b1) - max(y0, b0))
            inter = iw * ih
            union = (x1 - x0) * (y1 - y0) + (a1 - a0) * (b1 - b0) - inter
            if union > 0 and inter / union > OVERLAP:
                clash = True
                break
        if not clash:
            kept.append(i)
    return kept


def detect(session, path):
    image = cv2.imread(path, cv2.IMREAD_COLOR)
    if image is None:
        return []
    height, width = image.shape[:2]
    canvas, scale, pad_x, pad_y = letterbox(image)
    blob = canvas[:, :, ::-1].transpose(2, 0, 1)[None].astype(np.float32) / 255.0
    raw = session.run(None, {session.get_inputs()[0].name: blob})[0]

    # (1, 5, N): cx, cy, w, h, confidence — one class, so no class scores.
    predictions = raw[0].T if raw.shape[1] < raw.shape[2] else raw[0]
    boxes = []
    scores = []
    for row in predictions:
        confidence = float(row[4])
        if confidence < CONFIDENCE:
            continue
        cx, cy, bw, bh = (float(v) for v in row[:4])
        # Back out of the letterbox, into the image's own pixels.
        x0 = (cx - bw / 2 - pad_x) / scale
        y0 = (cy - bh / 2 - pad_y) / scale
        x1 = (cx + bw / 2 - pad_x) / scale
        y1 = (cy + bh / 2 - pad_y) / scale
        boxes.append((x0, y0, x1, y1))
        scores.append(confidence)

    faces = []
    for i in suppress(boxes, scores):
        x0, y0, x1, y1 = boxes[i]
        faces.append(
            [
                round(max(0.0, x0 / width), 4),
                round(max(0.0, y0 / height), 4),
                round(min(1.0, x1 / width), 4),
                round(min(1.0, y1 / height), 4),
            ]
        )
    return faces


def main():
    if len(sys.argv) < 3:
        print("usage: faces.py <model.onnx> <image> [...]", file=sys.stderr)
        raise SystemExit(2)
    model = sys.argv[1]
    session = onnxruntime.InferenceSession(model, providers=["CPUExecutionProvider"])
    for path in sys.argv[2:]:
        try:
            faces = detect(session, path)
        except Exception as error:  # one bad panel is a row, not a crash
            print(json.dumps({"path": path, "faces": [], "error": str(error)}), flush=True)
            continue
        print(json.dumps({"path": path, "faces": faces}), flush=True)


if __name__ == "__main__":
    main()
