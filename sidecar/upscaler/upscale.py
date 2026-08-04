#!/usr/bin/env python
"""Batch upscaler for generated images, entirely local.

    upscale.py --input <file|dir> --output <dir> --model <path.pth>

# The pipeline, and why the last step is not optional

    load -> tiled model inference -> Lanczos downscale to a target long edge -> save

A 4x model on a 833x1217 generation produces 3332x4868. That is not the goal;
2630x3840 is. Running a super-resolution model well past the size you want and
*resampling back down* is what removes its artifacts: ESRGAN-family models leave
ringing at high-contrast edges and a characteristic over-sharpened texture, and
both are high-frequency detail that a Lanczos downscale averages away. Upscaling
straight to the target instead keeps every one of them.

So the downscale is a stage of the pipeline rather than a post-processing option,
and `--long-edge` is the size you actually asked for.

# Architecture detection

Models are loaded through `spandrel`, which reads the architecture out of the
state dict. Nothing here knows what an RRDBNet is. That is the only way a model
downloaded next year loads without editing this file: OpenModelDB ships ESRGAN,
DAT, SPAN, RealPLKSR and more, they have incompatible module layouts, and the
file extension says nothing about which one you have.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path

import torch
from PIL import Image, PngImagePlugin

try:
    import spandrel
except ImportError:  # pragma: no cover - a setup problem, not a runtime one
    sys.exit("spandrel is not installed. Run: pnpm setup:upscaler")


# Pillow refuses very large files by default as a decompression-bomb guard. A
# 4x upscale of a normal generation clears it, and everything here is a local
# file the user chose.
Image.MAX_IMAGE_PIXELS = None

IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}


# ---------------------------------------------------------------------------
# Model
# ---------------------------------------------------------------------------


def load_model(path: Path, device: torch.device, want_half: bool) -> spandrel.ImageModelDescriptor:
    """Load any supported architecture, and say which one it turned out to be."""
    descriptor = spandrel.ModelLoader().load_from_file(str(path))

    if not isinstance(descriptor, spandrel.ImageModelDescriptor):
        raise SystemExit(f"{path.name} is a {type(descriptor).__name__}, not an image-to-image model")

    descriptor = descriptor.eval().to(device)
    # `supports_half` is the model's own answer, not a guess from the arch name:
    # some architectures overflow fp16 in their attention blocks and spandrel
    # knows which.
    if want_half and device.type == "cuda" and descriptor.supports_half:
        descriptor = descriptor.half()
    return descriptor


# ---------------------------------------------------------------------------
# Tiled inference
# ---------------------------------------------------------------------------


def _ramp(length: int, rise: int, falling: bool, device: torch.device) -> torch.Tensor:
    """A 0->1 ramp over `rise` pixels at one end, flat 1 for the rest."""
    weight = torch.ones(length, device=device)
    if rise <= 0:
        return weight
    rise = min(rise, length)
    edge = torch.linspace(0.0, 1.0, steps=rise + 2, device=device)[1:-1]
    if falling:
        weight[length - rise :] = edge.flip(0)
    else:
        weight[:rise] = edge
    return weight


def _blend_mask(
    height: int,
    width: int,
    feather: int,
    *,
    top: bool,
    bottom: bool,
    left: bool,
    right: bool,
    device: torch.device,
) -> torch.Tensor:
    """A tile's contribution, fading in only on the sides that meet another tile.

    Fading at the image border too would darken the frame, because nothing else
    contributes there to make the weights sum to one.
    """
    rows = torch.ones(height, device=device)
    if top:
        rows *= _ramp(height, feather, falling=False, device=device)
    if bottom:
        rows *= _ramp(height, feather, falling=True, device=device)

    columns = torch.ones(width, device=device)
    if left:
        columns *= _ramp(width, feather, falling=False, device=device)
    if right:
        columns *= _ramp(width, feather, falling=True, device=device)

    return torch.outer(rows, columns)


def upscale_tiled(
    image: torch.Tensor,
    model: spandrel.ImageModelDescriptor,
    tile: int,
    overlap: int,
) -> torch.Tensor:
    """Run `model` over `image` (1,C,H,W in [0,1]) in overlapping tiles.

    Tiles rather than one pass because a 4x model on a full generation wants
    tens of gigabytes of activations; tiles bound that regardless of input size.

    The overlap is blended rather than butt-joined. Adjacent tiles see different
    context, so their outputs disagree slightly along the shared edge, and a
    hard cut turns that disagreement into a visible seam — a faint grid over the
    whole picture that survives the downscale. Cross-fading spreads the
    disagreement over `overlap` pixels, where it is invisible.
    """
    _, channels, height, width = image.shape
    scale = model.scale
    device = image.device

    out = torch.zeros(
        (1, channels, height * scale, width * scale), dtype=torch.float32, device="cpu"
    )
    weights = torch.zeros((1, 1, height * scale, width * scale), dtype=torch.float32, device="cpu")

    step = max(1, tile - overlap)
    ys = list(range(0, max(1, height - overlap), step)) or [0]
    xs = list(range(0, max(1, width - overlap), step)) or [0]

    for y in ys:
        for x in xs:
            y0, x0 = y, x
            y1, x1 = min(y + tile, height), min(x + tile, width)
            # A tile clipped by the far edge is grown backwards instead of left
            # short, so the model always sees a full-size window.
            y0 = max(0, y1 - tile)
            x0 = max(0, x1 - tile)

            patch = image[:, :, y0:y1, x0:x1]

            # Architectures have their own size rules — a minimum, a multiple,
            # sometimes square. Pad to satisfy them and cut the padding back off
            # the result rather than assuming any given tile size is legal.
            pad_w, pad_h = model.size_requirements.get_padding(patch.shape[3], patch.shape[2])
            if pad_w or pad_h:
                patch = torch.nn.functional.pad(patch, (0, pad_w, 0, pad_h), mode="reflect")

            with torch.no_grad():
                result = model(patch.to(model.dtype))
            result = result.float()
            if pad_w or pad_h:
                result = result[:, :, : (y1 - y0) * scale, : (x1 - x0) * scale]

            mask = _blend_mask(
                (y1 - y0) * scale,
                (x1 - x0) * scale,
                overlap * scale,
                top=y0 > 0,
                bottom=y1 < height,
                left=x0 > 0,
                right=x1 < width,
                device=device,
            ).cpu()

            out[:, :, y0 * scale : y1 * scale, x0 * scale : x1 * scale] += result.cpu() * mask
            weights[:, :, y0 * scale : y1 * scale, x0 * scale : x1 * scale] += mask

    # Every output pixel is covered by at least one tile, but clamp anyway: a
    # zero here would divide into infinity and poison the whole image.
    return out / weights.clamp(min=1e-8)


# ---------------------------------------------------------------------------
# One image
# ---------------------------------------------------------------------------


def to_tensor(image: Image.Image, device: torch.device) -> torch.Tensor:
    array = torch.frombuffer(bytearray(image.tobytes()), dtype=torch.uint8)
    channels = len(image.getbands())
    array = array.view(image.height, image.width, channels)
    return array.permute(2, 0, 1).unsqueeze(0).to(device=device, dtype=torch.float32) / 255.0


def to_image(tensor: torch.Tensor, mode: str) -> Image.Image:
    array = (tensor.squeeze(0).clamp(0, 1) * 255.0).round().to(torch.uint8)
    array = array.permute(1, 2, 0).contiguous()
    return Image.frombytes(mode, (array.shape[1], array.shape[0]), array.numpy().tobytes())


def text_chunks(image: Image.Image) -> PngImagePlugin.PngInfo:
    """Carry the source's PNG text across.

    Stable Diffusion writes the entire generation — prompt, seed, sampler, every
    ADetailer setting — into a `parameters` text chunk. An upscale that drops it
    produces a picture nobody can ever regenerate or trace, which is a worse
    outcome than not upscaling at all. `image.text` rather than `image.info`,
    because the latter also carries decoder state like `dpi` and `transparency`
    that is not text and must not be written back as though it were.
    """
    info = PngImagePlugin.PngInfo()
    for key, value in getattr(image, "text", {}).items():
        if isinstance(value, str):
            info.add_text(key, value)
    return info


def fit_long_edge(image: Image.Image, long_edge: int) -> Image.Image:
    """Resample so the longest side is `long_edge`. Down only."""
    longest = max(image.width, image.height)
    if longest <= long_edge:
        return image
    ratio = long_edge / longest
    size = (max(1, round(image.width * ratio)), max(1, round(image.height * ratio)))
    return image.resize(size, Image.LANCZOS)


def restore_matte_extremes(alpha: torch.Tensor, deadzone: float = 2.0 / 255.0) -> torch.Tensor:
    """Snap a near-transparent or near-opaque matte back to exactly that.

    Super-resolution models carry a small DC bias, so a region of alpha 0 comes
    back as 1/255 rather than 0 — measured, not assumed. That is invisible on
    any one pixel and wrong everywhere at once: the result is a file with no
    fully transparent pixels at all, which composites as a faint veil and stops
    the matte round-tripping through anything that tests for full transparency.

    Safe because a matte's extremes are authored rather than observed. Nothing
    meaningful lives in the bottom or top 0.8% of an alpha channel, so the
    deadzone cannot flatten a gradient anyone put there — while the soft edge
    between the extremes, which is the part that matters, is untouched.
    """
    return torch.where(
        alpha < deadzone,
        torch.zeros_like(alpha),
        torch.where(alpha > 1.0 - deadzone, torch.ones_like(alpha), alpha),
    )


@dataclass
class Result:
    source: Path
    destination: Path
    source_size: tuple[int, int]
    model_size: tuple[int, int]
    final_size: tuple[int, int]
    seconds: float
    peak_vram_mb: float
    fell_back_to_fp32: bool


def process(
    source: Path,
    destination: Path,
    model: spandrel.ImageModelDescriptor,
    device: torch.device,
    *,
    long_edge: int,
    tile: int,
    overlap: int,
    want_half: bool,
) -> Result:
    started = time.perf_counter()
    if device.type == "cuda":
        torch.cuda.reset_peak_memory_stats()

    with Image.open(source) as opened:
        opened.load()
        chunks = text_chunks(opened)
        has_alpha = "A" in opened.getbands()
        # RGB throughout. A palette or 16-bit source would otherwise reach the
        # model as something it was never trained on.
        rgb = opened.convert("RGBA" if has_alpha else "RGB")

    alpha = rgb.getchannel("A") if has_alpha else None
    colour = rgb.convert("RGB")

    def run(half: bool) -> tuple[torch.Tensor, torch.Tensor | None]:
        target = model.half() if half else model.float()
        upscaled = upscale_tiled(to_tensor(colour, device), target, tile, overlap)
        upscaled_alpha = None
        if alpha is not None:
            # Through the model rather than resized, so the matte gets the same
            # treatment as the colour and the two still line up at the edges.
            # Replicated to three channels because these models take RGB.
            grey = to_tensor(alpha.convert("RGB"), device)
            upscaled_alpha = upscale_tiled(grey, target, tile, overlap).mean(dim=1, keepdim=True)
            upscaled_alpha = restore_matte_extremes(upscaled_alpha)
        return upscaled, upscaled_alpha

    fell_back = False
    use_half = want_half and device.type == "cuda" and model.supports_half
    upscaled, upscaled_alpha = run(use_half)
    if use_half and not torch.isfinite(upscaled).all():
        # Checked per image rather than decided once at load: an architecture
        # that overflows fp16 usually does it on particular inputs, not on all
        # of them, so one NaN must not cost the rest of the batch its speed.
        fell_back = True
        upscaled, upscaled_alpha = run(False)
        model.half()

    image = to_image(upscaled, "RGB")
    if upscaled_alpha is not None:
        image.putalpha(to_image(upscaled_alpha, "L"))

    model_size = (image.width, image.height)
    image = fit_long_edge(image, long_edge)

    destination.parent.mkdir(parents=True, exist_ok=True)
    image.save(destination, format="PNG", pnginfo=chunks, compress_level=6)

    # The variant stands in for the original, including where it sorts. A
    # file written today would otherwise jump to the front of a newest-first
    # grid, so copying the timestamp keeps it in the run of pictures it
    # belongs to — and does so from the filesystem, which means it survives
    # the index being rebuilt from scratch.
    stat = source.stat()
    os.utime(destination, (stat.st_atime, stat.st_mtime))

    peak = torch.cuda.max_memory_allocated() / (1024**2) if device.type == "cuda" else 0.0
    return Result(
        source=source,
        destination=destination,
        source_size=(colour.width, colour.height),
        model_size=model_size,
        final_size=(image.width, image.height),
        seconds=time.perf_counter() - started,
        peak_vram_mb=peak,
        fell_back_to_fp32=fell_back,
    )


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def gather(root: Path, recursive: bool) -> list[Path]:
    if root.is_file():
        return [root]
    walk = root.rglob("*") if recursive else root.glob("*")
    return sorted(p for p in walk if p.is_file() and p.suffix.lower() in IMAGE_SUFFIXES)


def destination_for(source: Path, root: Path | None, output: Path | None, suffix: str) -> Path:
    """Where one result goes.

    `--in-place` writes beside the source. That is what the app asks for: a
    selection is an arbitrary set of files across folders, so there is no shared
    root to mirror, and a variant is only paired with its original by sitting
    next to it under the same stem.
    """
    if output is None or root is None:
        return source.with_name(f"{source.stem}{suffix}.png")
    relative = source.name if root.is_file() else str(source.relative_to(root))
    path = output / relative
    return path.with_name(f"{path.stem}{suffix}.png")


def read_list(path: Path) -> list[Path]:
    """Source paths, one per line.

    A file rather than a long argv: a selection can run to hundreds of paths and
    Windows caps a command line at 32,767 characters, which a few hundred UNC
    paths clear comfortably.
    """
    lines = path.read_text(encoding="utf-8").splitlines()
    return [Path(line) for line in (raw.strip() for raw in lines) if line]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="upscale",
        description="Upscale images with any spandrel-supported model, then resample to a target long edge.",
    )
    parser.add_argument("--input", type=Path, help="File or directory to read.")
    parser.add_argument(
        "--input-list",
        type=Path,
        help=(
            "A UTF-8 file of source paths, one per line. For a selection, which is "
            "an arbitrary set of files across folders rather than a tree."
        ),
    )
    parser.add_argument("--output", type=Path, help="Directory to write into.")
    parser.add_argument(
        "--in-place",
        action="store_true",
        help="Write each result beside its source instead of into --output.",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Emit one JSON object per line instead of human-readable text.",
    )
    parser.add_argument("--model", required=True, type=Path, help="A .pth or .safetensors upscale model.")
    parser.add_argument(
        "--long-edge",
        type=int,
        default=3840,
        help="Longest side of the saved image, after downsampling (default: 3840).",
    )
    parser.add_argument("--tile", type=int, default=512, help="Tile size for inference (default: 512).")
    parser.add_argument(
        "--overlap", type=int, default=32, help="Overlap between tiles, blended (default: 32)."
    )
    parser.add_argument("--recursive", action="store_true", help="Descend into subdirectories.")
    parser.add_argument("--force", action="store_true", help="Redo images whose output already exists.")
    parser.add_argument(
        "--fp16",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Half precision, with an automatic fp32 retry if it produces NaNs (default: on).",
    )
    parser.add_argument(
        "--suffix",
        default="",
        help='Appended to each output filename, e.g. "_upscaled_4k".',
    )
    args = parser.parse_args(argv)

    # NDJSON on stdout, one object per line, flushed as it goes. The app reads
    # this while it runs, so anything buffered until exit would leave a progress
    # bar sitting at zero for the whole batch.
    def emit(**event: object) -> None:
        if args.json:
            print(json.dumps(event), flush=True)

    def say(line: str) -> None:
        if not args.json:
            print(line)

    if (args.input is None) == (args.input_list is None):
        return _fail("give exactly one of --input or --input-list")
    if args.output is None and not args.in_place:
        return _fail("give --output, or --in-place to write beside each source")
    if args.input is not None and not args.input.exists():
        return _fail(f"--input does not exist: {args.input}")
    if args.input_list is not None and not args.input_list.exists():
        return _fail(f"--input-list does not exist: {args.input_list}")
    if not args.model.exists():
        return _fail(f"--model does not exist: {args.model}")
    if args.overlap >= args.tile:
        return _fail(f"--overlap ({args.overlap}) must be smaller than --tile ({args.tile})")

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model = load_model(args.model, device, args.fp16)

    sources = (
        read_list(args.input_list) if args.input_list is not None else gather(args.input, args.recursive)
    )
    # A path in the list that no longer exists is one file's problem, reported
    # per item below, not a reason to refuse the batch.
    if args.input is not None:
        sources = [s for s in sources if s.exists()]
    if not sources:
        return _fail("no images to upscale")

    say(f"model     {args.model.name}")
    say(f"          {model.architecture.name} x{model.scale}, {model.input_channels}ch")
    say(f"device    {torch.cuda.get_device_name(0) if device.type == 'cuda' else 'cpu'}")
    say(f"precision {'fp16' if model.dtype == torch.float16 else 'fp32'}")
    say(f"tiling    {args.tile}px, {args.overlap}px overlap")
    say(f"target    {args.long_edge}px long edge")
    say(f"found     {len(sources)} image(s)\n")

    emit(
        event="start",
        total=len(sources),
        model=args.model.name,
        architecture=model.architecture.name,
        scale=model.scale,
        device=torch.cuda.get_device_name(0) if device.type == "cuda" else "cpu",
        half=model.dtype == torch.float16,
        longEdge=args.long_edge,
    )

    done: list[Result] = []
    skipped = 0
    failed = 0
    root = args.input if not args.in_place else None
    output = args.output if not args.in_place else None

    for index, source in enumerate(sources):
        destination = destination_for(source, root, output, args.suffix)
        if destination.exists() and not args.force:
            say(f"skip  {source.name} (exists)")
            skipped += 1
            emit(event="skip", index=index, source=str(source), destination=str(destination))
            continue
        emit(event="begin", index=index, source=str(source), name=source.name)
        try:
            result = process(
                source,
                destination,
                model,
                device,
                long_edge=args.long_edge,
                tile=args.tile,
                overlap=args.overlap,
                want_half=args.fp16,
            )
        except Exception as error:  # one bad file must not end the batch
            say(f"FAIL  {source.name}: {type(error).__name__}: {error}")
            failed += 1
            emit(
                event="failed",
                index=index,
                source=str(source),
                name=source.name,
                message=f"{type(error).__name__}: {error}",
            )
            continue

        emit(
            event="item",
            index=index,
            source=str(result.source),
            destination=str(result.destination),
            name=result.source.name,
            sourceWidth=result.source_size[0],
            sourceHeight=result.source_size[1],
            finalWidth=result.final_size[0],
            finalHeight=result.final_size[1],
            seconds=round(result.seconds, 2),
            peakVramMb=round(result.peak_vram_mb),
            fellBackToFp32=result.fell_back_to_fp32,
        )

        done.append(result)
        note = "  (fp32 fallback)" if result.fell_back_to_fp32 else ""
        say(
            f"ok    {source.name}  "
            f"{result.source_size[0]}x{result.source_size[1]} -> "
            f"{result.model_size[0]}x{result.model_size[1]} -> "
            f"{result.final_size[0]}x{result.final_size[1]}  "
            f"{result.seconds:.1f}s  {result.peak_vram_mb:.0f}MB{note}"
        )

    total = sum(r.seconds for r in done)
    say(
        f"\n{len(done)} upscaled, {skipped} skipped, {failed} failed"
        # ASCII only. The Windows console is cp1252 by default, where an em dash
        # prints as a replacement character.
        + (f" - {total:.1f}s total, {total / len(done):.1f}s each" if done else "")
    )
    emit(
        event="done",
        upscaled=len(done),
        skipped=skipped,
        failed=failed,
        seconds=round(total, 2),
        peakVramMb=round(max((r.peak_vram_mb for r in done), default=0.0)),
    )
    return 1 if failed else 0


def _fail(message: str) -> int:
    print(f"error: {message}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
