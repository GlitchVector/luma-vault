#!/usr/bin/env python3
"""
NudeNet classifier sidecar for luma-vault.

A *persistent* worker: it loads the ONNX model once and then serves requests
over stdin/stdout for the lifetime of the process. The Rust side starts a pool
of these (one per core, minus a couple) and round-robins work across them.

Why persistent rather than one process per batch (which is how the corn-dog
generation of this code worked): constructing `NudeDetector()` builds an
onnxruntime InferenceSession, which costs ~300-600ms. Paying that once per
process instead of once per batch is the difference between the model load
dominating a scan and it being a rounding error.

## Protocol

Line-delimited JSON both ways. One request per line, one response per line,
`id` echoed back so the caller can match them. stdout carries *only* protocol
lines; every diagnostic goes to stderr.

On startup, once the model is loaded, the worker emits exactly one line:

    {"type": "ready", "pid": 4242, "labels": [...], "model": "320n.onnx"}

Requests:

    {"id": 1, "cmd": "classify", "paths": ["/a.jpg", "/b.png"]}
    {"id": 2, "cmd": "ping"}
    {"id": 3, "cmd": "shutdown"}

Responses:

    {"id": 1, "type": "result", "results": [
        {"ok": true,  "detections": [{"label": "FACE_FEMALE", "score": 0.96,
                                      "box": [0.41, 0.08, 0.11, 0.14]}]},
        {"ok": false, "error": "cannot decode image"}
    ]}
    {"id": 2, "type": "pong"}

`results` is always the same length and order as `paths`: a file that fails
becomes an `ok: false` entry rather than shifting every later index by one.
That 1:1 alignment is load-bearing — the caller maps results back onto database
rows positionally.

## Boxes

Boxes are emitted as `[x, y, w, h]` **fractions of the image**, not pixels.
Normalising here — where the pixel dimensions are already in hand — means
nothing downstream has to remember which resolution a detection was computed
at. The UI multiplies by whatever size it renders the tile at.
"""

from __future__ import annotations

import json
import os
import sys
import traceback

# nudenet/onnxruntime print progress and provider warnings to stdout on some
# platforms. stdout is our protocol channel, so anything that is not a response
# line would corrupt it. Keep a private handle and point the public one at
# stderr for the duration of the imports and model load.
_PROTOCOL_OUT = sys.stdout
sys.stdout = sys.stderr

MODEL_NAME = "320n.onnx"

# Kept in lockstep with packages/core/src/labels.ts. The worker does not rate
# anything — it only reports raw detections — but it announces the label set on
# startup so a model upgrade that changes the classes is visible in the log.
LABELS = [
    "FEMALE_GENITALIA_COVERED",
    "FACE_FEMALE",
    "BUTTOCKS_EXPOSED",
    "FEMALE_BREAST_EXPOSED",
    "FEMALE_GENITALIA_EXPOSED",
    "MALE_BREAST_EXPOSED",
    "ANUS_EXPOSED",
    "FEET_EXPOSED",
    "BELLY_COVERED",
    "FEET_COVERED",
    "ARMPITS_COVERED",
    "ARMPITS_EXPOSED",
    "FACE_MALE",
    "BELLY_EXPOSED",
    "MALE_GENITALIA_EXPOSED",
    "ANUS_COVERED",
    "FEMALE_BREAST_COVERED",
    "BUTTOCKS_COVERED",
]


def log(message: str) -> None:
    print(f"[luma-classifier] {message}", file=sys.stderr, flush=True)


def emit(payload: dict) -> None:
    """Write one protocol line. The flush is mandatory — the reader blocks."""
    _PROTOCOL_OUT.write(json.dumps(payload, separators=(",", ":")) + "\n")
    _PROTOCOL_OUT.flush()


def load_image(path: str):
    """
    Decode an image to a BGR ndarray.

    OpenCV handles the common formats fastest, but it cannot read HEIC/AVIF and
    it decodes only the first frame of an animated GIF as a paletted mess. Pillow
    covers both cases, so it is the fallback rather than the primary.
    """
    import cv2
    import numpy as np

    ext = os.path.splitext(path)[1].lower()

    if ext not in (".gif", ".heic", ".heif", ".avif", ".tif", ".tiff"):
        img = cv2.imread(path, cv2.IMREAD_COLOR)
        if img is not None:
            return img

    from PIL import Image

    with Image.open(path) as pil:
        pil.seek(0)  # animated formats: classify the first frame
        rgb = pil.convert("RGB")
        return cv2.cvtColor(np.array(rgb), cv2.COLOR_RGB2BGR)


def normalise(detections, width: int, height: int) -> list[dict]:
    """Map NudeNet's pixel boxes onto 0..1 fractions and rename `class`->`label`."""
    if width <= 0 or height <= 0:
        return []

    out = []
    for raw in detections:
        label = raw.get("class") or raw.get("label")
        box = raw.get("box") or [0, 0, 0, 0]
        if label is None or len(box) < 4:
            continue
        x, y, w, h = box[0], box[1], box[2], box[3]
        out.append(
            {
                "label": str(label),
                "score": float(raw.get("score", 0.0)),
                # Clamped: the detector can return a box that runs a few pixels
                # off the edge, and a negative width breaks CSS positioning.
                "box": [
                    max(0.0, min(1.0, x / width)),
                    max(0.0, min(1.0, y / height)),
                    max(0.0, min(1.0, w / width)),
                    max(0.0, min(1.0, h / height)),
                ],
            }
        )
    return out


def check_environment() -> int:
    """`--check`: verify the venv can actually classify, and say so as JSON."""
    report = {"ok": False, "python": sys.version.split()[0], "libraries": {}}
    try:
        import cv2  # noqa: F401

        report["libraries"]["opencv"] = True
        import numpy  # noqa: F401

        report["libraries"]["numpy"] = True
        from PIL import Image  # noqa: F401

        report["libraries"]["pillow"] = True
        import onnxruntime

        report["libraries"]["onnxruntime"] = onnxruntime.__version__
        from nudenet import NudeDetector

        detector = NudeDetector()
        report["libraries"]["nudenet"] = True
        report["providers"] = list(getattr(detector, "onnx_session", None).get_providers()) if getattr(
            detector, "onnx_session", None
        ) else []
        report["ok"] = True
    except Exception as exc:  # noqa: BLE001 — the point is to report any failure
        report["error"] = f"{type(exc).__name__}: {exc}"

    _PROTOCOL_OUT.write(json.dumps(report) + "\n")
    _PROTOCOL_OUT.flush()
    return 0 if report["ok"] else 1


def serve() -> int:
    try:
        from nudenet import NudeDetector
    except Exception as exc:  # noqa: BLE001
        emit({"type": "fatal", "error": f"cannot import nudenet: {exc}"})
        return 1

    try:
        detector = NudeDetector()
    except Exception as exc:  # noqa: BLE001
        emit({"type": "fatal", "error": f"cannot load model: {exc}"})
        return 1

    emit({"type": "ready", "pid": os.getpid(), "labels": LABELS, "model": MODEL_NAME})
    log(f"ready (pid {os.getpid()})")

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            request = json.loads(line)
        except json.JSONDecodeError as exc:
            emit({"id": None, "type": "error", "error": f"malformed request: {exc}"})
            continue

        request_id = request.get("id")
        command = request.get("cmd", "classify")

        if command == "shutdown":
            log("shutting down")
            return 0

        if command == "ping":
            emit({"id": request_id, "type": "pong"})
            continue

        if command != "classify":
            emit({"id": request_id, "type": "error", "error": f"unknown cmd: {command}"})
            continue

        paths = request.get("paths") or []
        results = []
        for path in paths:
            try:
                img = load_image(path)
                if img is None:
                    results.append({"ok": False, "error": "cannot decode image"})
                    continue
                height, width = img.shape[:2]
                detections = detector.detect(img)
                results.append({"ok": True, "detections": normalise(detections, width, height)})
            except Exception as exc:  # noqa: BLE001 — one bad file never kills the worker
                log(f"failed on {path}: {type(exc).__name__}: {exc}")
                results.append({"ok": False, "error": f"{type(exc).__name__}: {exc}"})

        emit({"id": request_id, "type": "result", "results": results})

    log("stdin closed, exiting")
    return 0


def main() -> int:
    if "--check" in sys.argv:
        return check_environment()
    try:
        return serve()
    except KeyboardInterrupt:
        return 0
    except Exception:  # noqa: BLE001
        traceback.print_exc(file=sys.stderr)
        emit({"type": "fatal", "error": "unhandled worker exception"})
        return 1


if __name__ == "__main__":
    sys.exit(main())
