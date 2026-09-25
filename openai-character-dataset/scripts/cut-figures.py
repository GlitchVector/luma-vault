"""Usage: venv-classifier/Scripts/python.exe openai-character-dataset/scripts/cut-figures.py <sheet.png> <character folder>

Cut the four turnaround figures out of a studio sheet with the person-segmentation masks
(people.py). Each figure keeps its own (slightly grown) mask minus its neighbours' masks, so a
neighbour's arm is gone; small blue marks that sit on the background (letters of the title and
captions) are painted out, while a blue iris, surrounded by skin, stays. Background fill only."""
import json, subprocess, sys
from pathlib import Path
import cv2
import numpy as np

REPO = Path("D:/Development/luma-vault")
sheet, out_dir = Path(sys.argv[1]), Path(sys.argv[2])
im = cv2.imread(str(sheet))
h, w = im.shape[:2]
area = im.copy(); area[:, int(w * 0.812):] = 0
tmp = out_dir / "_seg"; tmp.mkdir(parents=True, exist_ok=True)
cv2.imwrite(str(tmp / "area.png"), area)
def seg(grow):
    d = tmp / f"g{grow}"; d.mkdir(exist_ok=True)
    r = subprocess.run([str(REPO / "venv-classifier/Scripts/python.exe"), str(REPO / "packages/comic/python/people.py"),
        str(REPO / "models/face-detector/person_yolov8s-seg.onnx"), str(tmp / "area.png"), str(d), "--grow", str(grow)],
        capture_output=True, text=True, check=True)
    ppl = [p for p in json.loads(r.stdout.strip().splitlines()[-1])["people"] if (p["box"][3] - p["box"][1]) > 0.6]
    if len(ppl) != 4: raise SystemExit(f"{sheet.name}: {len(ppl)} figures at grow {grow}")
    ppl.sort(key=lambda p: p["box"][0])
    return [cv2.resize(cv2.imread(p["mask"], cv2.IMREAD_GRAYSCALE), (w, h), interpolation=cv2.INTER_NEAREST) > 127 for p in ppl]
grown, tight = seg(0.015), seg(0.0)
bg = np.median(np.concatenate([im[:8, int(w*0.3):int(w*0.7)].reshape(-1, 3), im[int(h*0.96):, int(w*0.3):int(w*0.7)].reshape(-1, 3)]), axis=0).astype(np.uint8)
views = out_dir / "views"; views.mkdir(exist_ok=True)
panels = []
for i in range(4):
    others = np.zeros((h, w), bool)
    for j in range(4):
        if j != i: others |= cv2.dilate(tight[j].astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
    m = grown[i] & ~(others & ~tight[i])
    ys, xs = np.where(m)
    y0, y1, x0, x1 = max(0, ys.min() - 10), min(h, ys.max() + 10), max(0, xs.min() - 10), min(w, xs.max() + 10)
    crop = im[y0:y1, x0:x1].copy()
    crop[~m[y0:y1, x0:x1]] = bg
    b, g, r = [crop[..., k].astype(int) for k in range(3)]
    blue = ((b > r + 40) & (b > g + 5)).astype(np.uint8)
    near_bg = (np.abs(crop.astype(int) - bg.astype(int)).sum(axis=2) < 30)
    n, lab, st, _ = cv2.connectedComponentsWithStats(blue)
    for k in range(1, n):
        if st[k, cv2.CC_STAT_AREA] > 1500: continue
        comp = (lab == k).astype(np.uint8)
        ring = (cv2.dilate(comp, np.ones((7, 7), np.uint8)) > 0) & (comp == 0)
        if ring.sum() and near_bg[ring].mean() > 0.5:
            crop[cv2.dilate(comp, np.ones((5, 5), np.uint8)) > 0] = bg
    cv2.imwrite(str(views / f"panel-{i}.png"), crop)
    panels.append(crop)
import shutil; shutil.rmtree(tmp)
H = max(p.shape[0] for p in panels)
row = []
for p in panels:
    pad = np.full((H, p.shape[1], 3), bg, np.uint8); pad[H - p.shape[0]:, :] = p
    row += [pad, np.full((H, 24, 3), bg, np.uint8)]
cv2.imwrite(str(out_dir / "reference-cut.png"), np.hstack(row[:-1]))
print("ok", out_dir.name)
