"""What is a person in a panel, so the letterer can stay off her.

Two answers, because the letterer needs both and they are not the same thing:

- FACES, as boxes. A caption over her hair is fine; over her face it is not.
- THE FIGURE, as a coarse occupancy grid. Her box is useless here — a
  standing figure's bounding box covers most of the panel while the figure
  itself is a narrow column of it, so a box says "nowhere is free" when the
  brick wall beside her is free. The mask says which parts.

Both come from the detectors ADetailer ships, exported to ONNX so this needs
onnxruntime rather than torch.

    python figures.py <face.onnx> <person-seg.onnx> <image> [...]

prints one JSON object per line:
    {"path": ..., "faces": [[x0,y0,x1,y1], ...], "figure": "cols,rows,digits"}
Face coordinates are fractions of the image. The grid is row-major, one digit
per cell, 0 for empty and 9 for entirely covered by a person.
"""

import json
import sys

import cv2
import numpy as np
import onnxruntime

SIDE = 640
FACE_CONFIDENCE = 0.3
PERSON_CONFIDENCE = 0.35
OVERLAP = 0.45
# The same shape as the energy map, so the two read the same way in the page.
COLS = 16
ROWS = 24


def letterbox(image):
    height, width = image.shape[:2]
    scale = min(SIDE / width, SIDE / height)
    resized = cv2.resize(image, (int(round(width * scale)), int(round(height * scale))))
    canvas = np.full((SIDE, SIDE, 3), 114, dtype=np.uint8)
    top = (SIDE - resized.shape[0]) // 2
    left = (SIDE - resized.shape[1]) // 2
    canvas[top : top + resized.shape[0], left : left + resized.shape[1]] = resized
    return canvas, scale, left, top


def blob_of(canvas):
    return canvas[:, :, ::-1].transpose(2, 0, 1)[None].astype(np.float32) / 255.0


def suppress(boxes, scores):
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


def rows_of(raw):
    """(1, channels, N) or (1, N, channels) — take it as one row per detection."""
    out = raw[0]
    return out.T if out.shape[0] < out.shape[1] else out


def faces_in(session, image):
    height, width = image.shape[:2]
    canvas, scale, pad_x, pad_y = letterbox(image)
    raw = session.run(None, {session.get_inputs()[0].name: blob_of(canvas)})[0]
    boxes, scores = [], []
    for row in rows_of(raw):
        confidence = float(row[4])
        if confidence < FACE_CONFIDENCE:
            continue
        cx, cy, bw, bh = (float(v) for v in row[:4])
        boxes.append(
            (
                (cx - bw / 2 - pad_x) / scale,
                (cy - bh / 2 - pad_y) / scale,
                (cx + bw / 2 - pad_x) / scale,
                (cy + bh / 2 - pad_y) / scale,
            )
        )
        scores.append(confidence)
    out = []
    for i in suppress(boxes, scores):
        x0, y0, x1, y1 = boxes[i]
        out.append(
            [
                round(max(0.0, x0 / width), 4),
                round(max(0.0, y0 / height), 4),
                round(min(1.0, x1 / width), 4),
                round(min(1.0, y1 / height), 4),
            ]
        )
    return out


def figure_grid(session, image):
    """A coarse map of which cells a person covers, from the segmentation mask.

    The mask, not the box: a standing figure's box is most of the panel while
    the figure is a column down the middle of it, and the whole point is to
    find the wall beside her.
    """
    height, width = image.shape[:2]
    canvas, scale, pad_x, pad_y = letterbox(image)
    outputs = session.run(None, {session.get_inputs()[0].name: blob_of(canvas)})
    detections = rows_of(outputs[0])
    protos = outputs[1][0] if len(outputs) > 1 else None
    if protos is None:
        return "0,0,"

    boxes, scores, coeffs = [], [], []
    for row in detections:
        confidence = float(row[4])
        if confidence < PERSON_CONFIDENCE:
            continue
        cx, cy, bw, bh = (float(v) for v in row[:4])
        boxes.append((cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2))
        scores.append(confidence)
        coeffs.append(row[5:])
    if not boxes:
        return f"{COLS},{ROWS}," + "0" * (COLS * ROWS)

    channels, mh, mw = protos.shape
    flat = protos.reshape(channels, -1)
    covered = np.zeros((SIDE, SIDE), dtype=np.float32)
    for i in suppress(boxes, scores):
        mask = 1.0 / (1.0 + np.exp(-(np.asarray(coeffs[i][:channels], dtype=np.float32) @ flat)))
        mask = mask.reshape(mh, mw)
        mask = cv2.resize(mask, (SIDE, SIDE), interpolation=cv2.INTER_LINEAR)
        # A mask is only meaningful inside its own detection.
        x0, y0, x1, y1 = (int(round(v)) for v in boxes[i])
        window = np.zeros_like(mask)
        window[max(0, y0) : max(0, y1), max(0, x0) : max(0, x1)] = 1.0
        covered = np.maximum(covered, (mask > 0.5).astype(np.float32) * window)

    # Back out of the letterbox into the image's own pixels.
    inner = covered[pad_y : SIDE - pad_y or SIDE, pad_x : SIDE - pad_x or SIDE]
    if inner.size == 0:
        inner = covered
    full = cv2.resize(inner, (width, height), interpolation=cv2.INTER_NEAREST)

    digits = []
    for row_index in range(ROWS):
        y0 = row_index * height // ROWS
        y1 = max(y0 + 1, (row_index + 1) * height // ROWS)
        for col in range(COLS):
            x0 = col * width // COLS
            x1 = max(x0 + 1, (col + 1) * width // COLS)
            share = float(full[y0:y1, x0:x1].mean())
            digits.append(str(min(9, int(round(share * 9)))))
    return f"{COLS},{ROWS}," + "".join(digits)


def main():
    if len(sys.argv) < 4:
        print("usage: figures.py <face.onnx> <person-seg.onnx> <image> [...]", file=sys.stderr)
        raise SystemExit(2)
    face_model, person_model = sys.argv[1], sys.argv[2]
    faces = onnxruntime.InferenceSession(face_model, providers=["CPUExecutionProvider"])
    people = onnxruntime.InferenceSession(person_model, providers=["CPUExecutionProvider"])
    for path in sys.argv[3:]:
        try:
            image = cv2.imread(path, cv2.IMREAD_COLOR)
            if image is None:
                raise ValueError("could not be read")
            row = {"path": path, "faces": faces_in(faces, image), "figure": figure_grid(people, image)}
        except Exception as error:  # one bad panel is a row, not a crash
            row = {"path": path, "faces": [], "figure": "", "error": str(error)}
        print(json.dumps(row), flush=True)


if __name__ == "__main__":
    main()
