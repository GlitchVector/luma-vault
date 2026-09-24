"""Light a character like the place she stands in.

A character LoRA carries the light of its training sheets: evenly lit, bright,
on plain backgrounds. Drawn into a warm night scene she stays studio-lit, and
viewers read it as pasted in (2026-09-24). This moves each masked figure's
colour and lightness toward the ring of scene right around her, in Lab space,
lightness more gently than colour, and blends it back with a soft edge.

    python grade.py <image> <out> <mask> [<mask> ...] [--l 0.45] [--ab 0.7]

Masks are white-on-black PNGs of any size; they are scaled to the image.
"""

import sys

import cv2
import numpy as np


def grade(image, mask, strength_l, strength_ab):
    inside = mask > 127
    if inside.sum() < 100:
        return image
    ring_size = max(31, int(0.08 * max(image.shape[:2])) | 1)
    ring = (cv2.dilate(mask, np.ones((ring_size, ring_size), np.uint8)) > 127) & ~inside
    if ring.sum() < 100:
        return image
    lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB).astype(np.float32)
    out = lab.copy()
    for channel, strength in ((0, strength_l), (1, strength_ab), (2, strength_ab)):
        values = lab[..., channel]
        mean_in, std_in = values[inside].mean(), values[inside].std() + 1e-6
        mean_ring, std_ring = values[ring].mean(), values[ring].std() + 1e-6
        target = (values - mean_in) * (0.5 + 0.5 * std_ring / std_in) + mean_ring
        out[..., channel] = values + strength * (target - values)
    graded = cv2.cvtColor(np.clip(out, 0, 255).astype(np.uint8), cv2.COLOR_LAB2BGR)
    feather = max(3.0, 0.012 * max(image.shape[:2]))
    alpha = cv2.GaussianBlur(inside.astype(np.float32), (0, 0), feather)[..., None]
    return (graded * alpha + image * (1 - alpha)).astype(np.uint8)


def main():
    args = sys.argv[1:]
    strength_l, strength_ab, positional = 0.45, 0.7, []
    while args:
        arg = args.pop(0)
        if arg == "--l":
            strength_l = float(args.pop(0))
        elif arg == "--ab":
            strength_ab = float(args.pop(0))
        else:
            positional.append(arg)
    if len(positional) < 3:
        print("usage: grade.py <image> <out> <mask> [<mask> ...] [--l F] [--ab F]", file=sys.stderr)
        raise SystemExit(2)
    image = cv2.imread(positional[0], cv2.IMREAD_COLOR)
    height, width = image.shape[:2]
    for path in positional[2:]:
        mask = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
        mask = cv2.resize(mask, (width, height), interpolation=cv2.INTER_NEAREST)
        image = grade(image, mask, strength_l, strength_ab)
    cv2.imwrite(positional[1], image)
    print("ok", flush=True)


if __name__ == "__main__":
    main()
