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

    {"type": "ready", "pid": 4242, "labels": [...], "model": "320n.onnx",
     "inferenceResolutions": [320, 640]}

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

import errno
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

# The detector is run once per resolution and the results merged.
#
# Neither pass dominates the other, which is the whole reason there are two.
# Measured over 500 thumbnails from a real library, using the current rules:
#
#     flagged by 320 only    15
#     flagged by 640 only    26
#     flagged by both       108
#     flagged by neither    351
#
# 640 finds more overall (134 vs 123), but 320 finds 15 files it misses
# entirely — typically extreme close-ups where the subject fills the frame and
# the downscale is what makes the shape legible. One reported file detected
# `BUTTOCKS_COVERED` at 0.26 under 320 and *nothing at all* under 640.
#
# The union flags 149 of 500 against 134 for the best single pass: ~11% better
# recall for ~1.25x the compute, because a 320 pass costs a quarter of a 640
# one. Adding a third scale was not worth measuring against that curve.
INFERENCE_RESOLUTIONS = (320, 640)

# Boxes of the same label overlapping by more than this are the same finding
# seen twice, once per pass. Without merging, every object detected at both
# scales would be drawn twice in the lightbox and counted twice in a verdict.
MERGE_IOU = 0.5

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


class ParentGone(Exception):
    """
    The host closed our pipe.

    Not a failure — it is what every normal shutdown looks like from in here,
    and the only correct response is to stop quietly.
    """


def emit(payload: dict) -> None:
    """Write one protocol line. The flush is mandatory — the reader blocks."""
    try:
        _PROTOCOL_OUT.write(json.dumps(payload, separators=(",", ":")) + "\n")
        _PROTOCOL_OUT.flush()
    except ValueError as exc:
        # The stream was closed underneath us mid-write.
        raise ParentGone from exc
    except OSError as exc:
        # BrokenPipeError is a subclass of OSError and covers POSIX. Windows
        # does not raise it: a pipe whose read end has closed surfaces as
        # EINVAL, so a handler written only for BrokenPipeError never fires
        # there. Without this the pool leaves a double traceback on stderr
        # every time the app exits — one from the write, one from `main`
        # trying to report the write.
        if isinstance(exc, BrokenPipeError) or exc.errno in (errno.EPIPE, errno.EINVAL):
            raise ParentGone from exc
        raise


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


class AnimeTagger:
    """
    A second opinion for drawn content, from a Danbooru-trained tagger.

    NudeNet is trained on photographs. On an illustrated library it under-fires
    badly: measured over 150 images from this library's adult folders that
    NudeNet rated SFW, this model rates 21% of them questionable or explicit.
    On a control group NudeNet *had* already flagged it agrees 84% of the time,
    so it is a second opinion rather than noise.

    It is a whole-image classifier, not a detector — there are no boxes. Only
    its four rating tags are used, emitted as findings covering the frame so
    they flow through the same verdict path as everything else. The UI does not
    draw them; see the `ANIME_` skip in Lightbox.tsx.

    Optional by design. The model is ~378MB against NudeNet's 12MB, so it is
    downloaded by `pnpm setup:python` rather than vendored, and a worker that
    cannot find it simply reports no anime opinion instead of refusing to run.
    """

    # Danbooru's four rating tags. `general` and `sensitive` are deliberately
    # not emitted: `sensitive` covers swimwear and cleavage, which this app
    # already reaches through NudeNet's covered-anatomy labels, and emitting it
    # would flag most of a beach holiday.
    RATINGS = ("questionable", "explicit")

    def __init__(self, model_path: str, tags_path: str):
        import csv as _csv

        import onnxruntime

        self.session = onnxruntime.InferenceSession(
            model_path, providers=["CPUExecutionProvider"]
        )
        _, self.height, self.width, _ = self.session.get_inputs()[0].shape
        self.input_name = self.session.get_inputs()[0].name

        with open(tags_path, encoding="utf-8") as handle:
            rows = list(_csv.DictReader(handle))
        self.indices = {
            row["name"]: i for i, row in enumerate(rows) if row["name"] in self.RATINGS
        }
        if len(self.indices) != len(self.RATINGS):
            raise ValueError("selected_tags.csv is missing the rating tags")

    def _prepare(self, img):
        """Pad to square on white, resize, keep BGR at 0-255 — SmilingWolf's."""
        import cv2
        import numpy as np

        height, width = img.shape[:2]
        side = max(height, width)
        square = np.full((side, side, 3), 255, dtype=np.uint8)
        square[(side - height) // 2 : (side - height) // 2 + height,
               (side - width) // 2 : (side - width) // 2 + width] = img
        resized = cv2.resize(square, (self.width, self.height), interpolation=cv2.INTER_CUBIC)
        return np.expand_dims(resized.astype("float32"), 0)

    def detect(self, img) -> list:
        """Rating tags as whole-frame findings, shaped like NudeNet's output."""
        # No sigmoid: this ONNX export already applies one. Squashing twice pins
        # every class near 0.5, which reads as "every photo is explicit".
        scores = self.session.run(None, {self.input_name: self._prepare(img)})[0][0]
        height, width = img.shape[:2]
        return [
            {
                "class": f"ANIME_{name.upper()}",
                "score": float(scores[index]),
                "box": [0, 0, width, height],
            }
            for name, index in self.indices.items()
        ]


def load_anime_tagger():
    """The tagger, or `None` when its model has not been downloaded."""
    root = os.environ.get("LUMA_ANIME_MODEL") or os.path.join(
        os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
        "models",
        "anime-tagger",
    )
    model = os.path.join(root, "model.onnx")
    tags = os.path.join(root, "selected_tags.csv")
    if not (os.path.isfile(model) and os.path.isfile(tags)):
        return None
    try:
        return AnimeTagger(model, tags)
    except Exception as exc:  # noqa: BLE001 — an absent second opinion is not fatal
        log(f"anime tagger unavailable: {type(exc).__name__}: {exc}")
        return None


def looks_like_a_document(img) -> bool:
    """Is this a scan, a screenshot of text, or a photo?

    No model — a page of type has a shape that arithmetic can see. Every
    threshold here was measured against 4,000 real thumbnails from a live
    library rather than picked by eye, and the two rules that matter were each
    added to kill a specific false positive that the previous version produced:

    - **Glyph geometry, not whiteness.** Keying on "mostly white with some
      ink" scored about 50% precision: it flagged shampoo bottles on studio
      backdrops, a photograph of snow, and a manga page. Whiteness is the
      *background* of a document, not the document. Counting small dark marks
      of consistent height that line up into rows took it to ~72%.
    - **Periodicity.** The survivors were all seamless tile patterns — a motif
      stamped on a grid reads as hundreds of evenly spaced marks, which is
      exactly what text looks like to a glyph counter. Autocorrelating the
      ink-per-row profile separated the two groups completely: patterns ring
      at 0.75-0.89, prose sits at 0.20-0.61. Nothing landed in between.

    Tuned for precision over recall, because the point of the label is to hide
    things: a photo wrongly hidden is worse than a document left visible. It
    misses documents on dark backgrounds, coloured forms, and photographs of
    paper taken at an angle.
    """
    import cv2
    import numpy as np

    height, width = img.shape[:2]
    area = float(height * width)
    if area < 1024:
        return False

    saturation = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)[:, :, 1].astype("float32") / 255.0
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    luminance = gray.astype("float32") / 255.0

    paper = float(np.mean((luminance > 0.80) & (saturation < 0.20)))
    if paper < 0.45 or float(np.mean(saturation)) > 0.15:
        return False

    # Adaptive, not a global cutoff: it finds ink against paper whatever the
    # scan's exposure, which is the difference between reading a bright phone
    # photo of a letter and reading a dim one.
    binary = cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY_INV, 15, 10
    )
    count, _, stats, centroids = cv2.connectedComponentsWithStats(binary, connectivity=8)

    rows, heights = [], []
    biggest = 0.0
    for i in range(1, count):
        _, _, box_w, box_h, blob = stats[i]
        biggest = max(biggest, blob / area)
        if 3 <= box_h <= 28 and 1 <= box_w <= 40 and 4 <= blob <= 500 \
                and blob >= 0.12 * box_w * box_h:
            rows.append(centroids[i][1])
            heights.append(box_h)

    if len(rows) < 120 or biggest > 0.05:
        return False

    heights = np.asarray(heights, dtype="float32")
    if float(heights.std() / max(heights.mean(), 1e-6)) > 0.55:
        return False

    # Do the marks stack into lines of type?
    histogram, _ = np.histogram(np.asarray(rows), bins=max(8, height // 8), range=(0, height))
    if int(np.sum(histogram >= 4)) < 6:
        return False

    ink = (binary > 0).astype("float32").mean(axis=1)
    signal = ink - ink.mean()
    correlation = np.correlate(signal, signal, mode="full")[len(signal) - 1:]
    correlation = correlation / max(correlation[0], 1e-9)
    low = max(4, height // 64)
    peak = float(correlation[low:max(low + 1, height // 2)].max()) if height > 8 else 0.0
    return peak <= 0.68


def _iou(a, b) -> float:
    """Intersection over union of two `[x, y, w, h]` pixel boxes."""
    ax2, ay2 = a[0] + a[2], a[1] + a[3]
    bx2, by2 = b[0] + b[2], b[1] + b[3]
    ix = max(0.0, min(ax2, bx2) - max(a[0], b[0]))
    iy = max(0.0, min(ay2, by2) - max(a[1], b[1]))
    overlap = ix * iy
    union = a[2] * a[3] + b[2] * b[3] - overlap
    return overlap / union if union > 0 else 0.0


def merge_passes(runs: list) -> list:
    """
    Fold several resolutions' detections into one set.

    Greedy, highest score first: a detection is kept unless something already
    kept has the same label and overlaps it. That keeps the more confident of
    the two views of one object rather than averaging them into a box that
    matches neither.
    """
    everything = [d for run in runs for d in run]
    everything.sort(key=lambda d: -float(d.get("score", 0.0)))

    kept: list = []
    for candidate in everything:
        label = candidate.get("class") or candidate.get("label")
        box = candidate.get("box") or [0, 0, 0, 0]
        duplicate = False
        for existing in kept:
            same_label = (existing.get("class") or existing.get("label")) == label
            if same_label and _iou(box, existing.get("box") or [0, 0, 0, 0]) >= MERGE_IOU:
                duplicate = True
                break
        if not duplicate:
            kept.append(candidate)
    return kept


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

        detector = NudeDetector(inference_resolution=INFERENCE_RESOLUTIONS[-1])
        report["libraries"]["nudenet"] = True
        report["inferenceResolutions"] = list(INFERENCE_RESOLUTIONS)
        report["providers"] = list(getattr(detector, "onnx_session", None).get_providers()) if getattr(
            detector, "onnx_session", None
        ) else []
        report["ok"] = True
    except Exception as exc:  # noqa: BLE001 — the point is to report any failure
        report["error"] = f"{type(exc).__name__}: {exc}"

    _PROTOCOL_OUT.write(json.dumps(report) + "\n")
    _PROTOCOL_OUT.flush()
    return 0 if report["ok"] else 1


def limit_worker_threads() -> None:
    """Hold this worker to `LUMA_ORT_THREADS` threads of real parallelism.

    Two libraries have to be told separately, and missing either one makes the
    app's CPU throttle nearly useless:

    - **OpenCV** keeps its own thread pool sized to the core count. It is the
      dominant cost of the structural label pass — `adaptiveThreshold` and
      `connectedComponentsWithStats` both parallelise — so leaving it alone was
      measured holding 35% of a 16-core machine from a *single* worker that was
      supposed to be using 5%.
    - **ONNX Runtime** sizes its intra-op pool per session, and a worker holds
      three of them.

    Both matter because the throttle's arithmetic assumes a unit of work costs
    one thread. When the work is internally parallel, pacing it by sleeping
    between units throttles almost nothing.
    """
    limit = os.environ.get("LUMA_ORT_THREADS")
    if not limit:
        return
    try:
        threads = max(1, int(limit))
    except ValueError:
        return

    try:
        import cv2

        cv2.setNumThreads(threads)
        log(f"OpenCV limited to {threads} thread(s)")
    except Exception as exc:  # noqa: BLE001 — a throttle that cannot be applied
        log(f"could not limit OpenCV threads: {type(exc).__name__}: {exc}")

    limit_onnx_threads(threads)


def limit_onnx_threads(threads: int) -> None:
    """Hold ONNX Runtime to `threads` per session.

    Set by the app when CPU throttling is on. It has to be done by patching the
    session constructor because the thread budget is a *session option*, and the
    sessions that matter are not ours: `NudeDetector` builds its own internally
    and takes no options argument. The environment variables ONNX honours
    (`OMP_NUM_THREADS` and friends) only apply to OpenMP builds, which the
    wheels on PyPI are not.

    Without this the throttle would be pacing something far larger than it
    thinks: ONNX sizes its intra-op pool from the core count *per session*, and
    a worker holds three. Eight workers were measured holding ~77 threads each
    on a 16-core machine.
    """
    import onnxruntime

    original = onnxruntime.InferenceSession

    class SingleThreaded(original):
        def __init__(self, *args, **kwargs):
            options = kwargs.get("sess_options") or onnxruntime.SessionOptions()
            options.intra_op_num_threads = threads
            options.inter_op_num_threads = threads
            # Sequential, or ORT still runs independent branches of the graph
            # concurrently on top of the intra-op budget.
            options.execution_mode = onnxruntime.ExecutionMode.ORT_SEQUENTIAL
            kwargs["sess_options"] = options
            super().__init__(*args, **kwargs)

    onnxruntime.InferenceSession = SingleThreaded
    log(f"ONNX limited to {threads} thread(s) per session")


def serve() -> int:
    # Before anything constructs a session, including the import below.
    try:
        limit_worker_threads()
    except Exception as exc:  # noqa: BLE001 — a throttle that cannot be applied
        log(f"could not limit worker threads: {type(exc).__name__}: {exc}")

    try:
        from nudenet import NudeDetector
    except Exception as exc:  # noqa: BLE001
        emit({"type": "fatal", "error": f"cannot import nudenet: {exc}"})
        return 1

    try:
        # One session per resolution. They share the same 12MB model file, so
        # the second costs an ONNX session and little else.
        detectors = [NudeDetector(inference_resolution=r) for r in INFERENCE_RESOLUTIONS]
    except Exception as exc:  # noqa: BLE001
        emit({"type": "fatal", "error": f"cannot load model: {exc}"})
        return 1

    anime = load_anime_tagger()
    log("anime tagger " + ("loaded" if anime else "not installed"))

    emit({
        "type": "ready",
        "pid": os.getpid(),
        "labels": LABELS,
        "model": MODEL_NAME,
        "inferenceResolutions": list(INFERENCE_RESOLUTIONS),
        "animeTagger": anime is not None,
    })
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
        # Which models to run. The caller decides, because the two are worth
        # very different amounts per file: NudeNet is ~12MB and decides most of
        # the library, while the tagger is ~378MB and only earns its cost on
        # drawn content. Splitting them lets the pipeline get every file rated
        # first and revisit the ones worth a second opinion afterwards.
        #
        # "full" stays the default so an older caller keeps working.
        mode = request.get("mode") or "full"
        results = []
        for path in paths:
            try:
                img = load_image(path)
                if img is None:
                    results.append({"ok": False, "error": "cannot decode image"})
                    continue
                height, width = img.shape[:2]
                if mode == "label":
                    # Structural, not sexual: these describe what kind of
                    # picture this is, so they travel as tags rather than as
                    # detections and never reach the rating rules.
                    tags = ["document"] if looks_like_a_document(img) else []
                    results.append({"ok": True, "detections": [], "tags": tags})
                    continue
                if mode == "anime":
                    # A second opinion on its own. The caller already holds this
                    # file's NudeNet detections and merges these into them.
                    detections = anime.detect(img) if anime is not None else []
                else:
                    detections = merge_passes([d.detect(img) for d in detectors])
                    # Appended, not merged: these cover the whole frame and would
                    # suppress every real box under an IoU test.
                    if mode == "full" and anime is not None:
                        detections = detections + anime.detect(img)
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
    except (KeyboardInterrupt, ParentGone):
        # The host went away. Exiting 0 keeps a normal shutdown out of the
        # log; the pool is already tearing us down and has nobody left to
        # tell.
        log("host closed the pipe, exiting")
        return 0
    except Exception:  # noqa: BLE001
        traceback.print_exc(file=sys.stderr)
        try:
            emit({"type": "fatal", "error": "unhandled worker exception"})
        except ParentGone:
            # Reporting the failure failed because the pipe is gone too. The
            # traceback above already went to stderr, which is where anyone
            # would look; raising again here would only bury it.
            pass
        return 1


if __name__ == "__main__":
    sys.exit(main())
