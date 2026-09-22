"""Export ADetailer's detectors to ONNX, for the comic letterer.

The assembler needs to know where a face is and where a body is, so a caption
lands on the wall beside her rather than across her. It asks the same two
models ADetailer repaints with, but through `onnxruntime` in the classifier
venv rather than torch — the vault has no business carrying a 2 GB CUDA
dependency to find a rectangle.

`models/` is gitignored, so a fresh machine has to run this once:

    python scripts/export-face-detectors.py

It needs Forge's Python, which already has ultralytics and torch because
ADetailer runs there. The source `.pt` files are in the Hugging Face cache
ADetailer downloaded them into. Nothing here touches the GPU: an export is a
trace, so it is safe to run while a training is going.

Without the ONNX files the letterer still works — it falls back to the energy
map alone and says so in a note — but captions land on faces again, which is
what the whole thing was built to stop.
"""

import shutil
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
OUT = REPO / "models" / "face-detector"

# Where ADetailer keeps what it downloaded, and the Python that can read it.
CACHE = Path.home() / ".cache" / "huggingface" / "hub"
FORGE_PYTHON = Path(r"D:\AI\Stable Diffusion\system\python\python.exe")

# The `s` models rather than the `n` ones: this runs once per panel on the CPU
# and a better detector is worth the tenth of a second.
WANTED = ["face_yolov8s.pt", "person_yolov8s-seg.pt"]

EXPORT = """
import shutil, sys
from ultralytics import YOLO
src, dest = sys.argv[1], sys.argv[2]
out = YOLO(src).export(format="onnx", imgsz=640, opset=17, simplify=False)
shutil.copy(out, dest)
print(dest)
"""


def find(name: str) -> Path | None:
    hits = sorted(CACHE.glob(f"models--Bingsu--adetailer/snapshots/*/{name}"))
    return hits[-1] if hits else None


def main() -> int:
    python = FORGE_PYTHON if FORGE_PYTHON.exists() else Path(sys.executable)
    if not python.exists():
        print(f"no Python with ultralytics: {python}", file=sys.stderr)
        return 1
    OUT.mkdir(parents=True, exist_ok=True)

    failed = False
    for name in WANTED:
        dest = OUT / name.replace(".pt", ".onnx")
        if dest.exists():
            print(f"  have  {dest.name}")
            continue
        source = find(name)
        if source is None:
            print(f"  MISS  {name} is not in {CACHE} — run ADetailer once so it downloads", file=sys.stderr)
            failed = True
            continue
        print(f"  build {dest.name} from {source.name}")
        result = subprocess.run([str(python), "-c", EXPORT, str(source), str(dest)], capture_output=True, text=True)
        if result.returncode != 0 or not dest.exists():
            print(result.stderr.strip()[-600:], file=sys.stderr)
            failed = True
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
