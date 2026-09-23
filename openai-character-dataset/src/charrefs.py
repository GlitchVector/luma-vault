"""One image of a character in, the LoRA reference set out. The single CLI of this project.

    charrefs.py init <name> --reference <image>           write characters/<name>/character.json (then fill it)
    charrefs.py generate <name> [--dry-run | --no-dry-run] [--only body/01-front,face/02-front-smile] [--limit N] [--redo] [--vault]
    charrefs.py generate <name> --only <views> --variants 3 [--vault]   re-roll: N alternatives of each view, filed BESIDE the original
    charrefs.py collect <name>                             starred vault members -> training sheet folders
    charrefs.py status <name>                              what is done, open, pending

Dry run (the default while ``defaults.json`` says so) prints every request and sends nothing. A live
run retries a moderation refusal with reworded prompts up to the cap and then reports the view OPEN;
one failing view never stops the batch, an auth or billing error does. Billing and the key are the
account's business: the SDK reads ``OPENAI_API_KEY`` from the environment (``.env`` here or the repo's).
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import time
from pathlib import Path

from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).resolve().parent))

from config_loader import CHARACTERS_DIR, PROJECT_ROOT, Character, ConfigError, View, character_dir, load_character, load_views  # noqa: E402
from file_utils import FileError, collect_into_sheets, file_into_vault, new_stamp, output_path, read_state, set_run, sheet_dir, validate_reference_images, write_image_bytes, write_state  # noqa: E402
from logger_utils import setup_logging  # noqa: E402
from openai_image_client import ImageClientError, OpenAIImageClient  # noqa: E402
from prompt_builder import PromptError, SEPARATOR, build_prompt, global_prompt, load_template  # noqa: E402
from sheet_utils import split_sheet, to_png_bytes  # noqa: E402


# ---------------------------------------------------------------- init

def cmd_init(args: argparse.Namespace, log) -> int:
    folder = character_dir(args.name)
    path = folder / "character.json"
    if path.exists() and not args.force:
        log.error("%s exists - edit it, or pass --force to overwrite", path)
        return 2
    reference = Path(args.reference)
    if not reference.is_file():
        log.error("reference image not found: %s", reference)
        return 2
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / f"reference{reference.suffix.lower()}"
    if reference.resolve() != target.resolve():
        shutil.copyfile(reference, target)
    library = load_views()
    skeleton = {
        "name": args.name,
        "_fill": "description and audit are derived from the reference image BEFORE anything renders; the description is what every prompt says about her, the audit list is what every generated frame is checked against (physics first). Leave `views` out for the whole library, or list keys like body/01-front. `details` are HER garment close-ups: one entry per small part a full-body frame holds at a tenth of the frame (shorts, collar, cuffs, shoes...), each {id, prompt, tags}, tags framing-only (lower body / close-up / feet, never the garment) - see characters/ari/character.json.",
        "description": "",
        "audit": [],
        "background": "plain white or extremely simple, low-detail background; no scenery, no floor detail beyond a faint contact shadow",
        "reference_images": [target.name],
        "details": [],
        "views_available": [view.key for view in library],
        "settings": {},
    }
    path.write_text(json.dumps(skeleton, indent=2) + "\n", encoding="utf-8")
    log.info("wrote %s (%d views in the library); fill description and audit, then: generate %s --dry-run", path, len(library), args.name)
    return 0


# ---------------------------------------------------------------- generate

def request_summary(character: Character, view: View, prompt: str, references: list[Path], output: Path) -> str:
    s = character.settings
    lines = [
        f"  view           : {view.key}",
        f"  model          : {s.model}",
        f"  size           : {s.size[view.kind]}",
        f"  quality        : {s.quality}",
        f"  output format  : {s.output_format}",
        f"  call           : images.{'edit' if references else 'generate'}" + (f" (input_fidelity {s.input_fidelity})" if references else ""),
        f"  references     : {', '.join(str(p) for p in references) if references else '(none)'}",
        f"  output path    : {output}",
        f"  caption tags   : {view.tags}",
        f"  background     : {view.background or character.background}",
        "  final prompt   :",
    ]
    lines.extend("    " + line for line in prompt.splitlines())
    return "\n".join(lines)


def resolve_dry_run(character: Character, args: argparse.Namespace) -> bool:
    if args.dry_run:
        return True
    if args.no_dry_run:
        return False
    return character.settings.dry_run


def render_alternative(client, character: Character, view: View, template: str, output: Path, log) -> Path | None:
    """One more picture of a view, with the same retry rules as the main loop but its own counters.

    Alternatives never touch the view's status or file: the original stays what it was, the owner picks in
    the vault, and `collect` takes whichever of them carries the star.
    """
    s = character.settings
    present, _ = validate_reference_images(character)
    refusals = transient = attempt = 0
    while True:
        if refusals >= s.retry_cap or transient >= s.transient_cap:
            log.warning("    %s alternative OPEN - refused %d, service errors %d", view.key, refusals, transient)
            return None
        attempt += 1
        prompt = build_prompt(character, view, attempt=attempt, template=template)
        try:
            if present:
                data = client.edit_with_references(prompt, present, model=s.model, size=s.size[view.kind], quality=s.quality, output_format=s.output_format, input_fidelity=s.input_fidelity)
            else:
                data = client.generate_from_prompt(prompt, model=s.model, size=s.size[view.kind], quality=s.quality, output_format=s.output_format)
            return write_image_bytes(output, data)
        except ImageClientError as exc:
            if exc.kind == "moderation":
                refusals += 1
                log.info("    %s alternative refused (%d/%d) - rewording", view.key, refusals, s.retry_cap)
            elif exc.kind in ("auth", "billing", "bad_request"):
                raise
            else:
                transient += 1
                log.warning("    %s alternative [%s] (%d/%d): %s", view.key, exc.kind, transient, s.transient_cap, str(exc).splitlines()[0][:160])
                time.sleep(s.transient_wait_seconds)


def cmd_variants(args: argparse.Namespace, log) -> int:
    """`--variants N`: N alternatives of each selected view, beside the original, for the owner to choose from."""
    character = load_character(args.name)
    template = load_template()
    if not args.only:
        log.error("--variants needs --only <views>: a re-roll is for the views the owner marked, not the whole set")
        return 2
    wanted = args.only.split(",")
    by_key = {view.key: view for view in character.views}
    unknown = [key for key in wanted if key not in by_key]
    if unknown:
        log.error("unknown view(s): %s", ", ".join(unknown))
        return 2
    state = read_state(character)
    if not state.get("stamp"):
        log.error("nothing generated yet - alternatives need an original to sit beside")
        return 2
    stamp = new_stamp()
    if resolve_dry_run(character, args):
        for key in wanted:
            print(f"DRY RUN: {args.variants} alternatives of {key} -> {character.out_dir / f'{key.replace(chr(47), chr(45))}-alt{stamp}-N.{character.settings.output_format}'}")
        return 0
    try:
        client = OpenAIImageClient()
    except ImageClientError as exc:
        log.error("[%s] %s", exc.kind, exc)
        return 3
    made = 0
    for key in wanted:
        view = by_key[key]
        entry = state["views"].setdefault(key, {"status": "pending", "attempts": 0, "refusals": 0, "transient": 0})
        alternatives = entry.setdefault("alternatives", [])
        for n in range(1, args.variants + 1):
            output = character.out_dir / f"{view.kind}-{view.id}-alt{stamp}-{n}.{character.settings.output_format}"
            started = time.time()
            # --vary: the same reference and prompt give near-identical pictures, so each alternative
            # carries its own camera/stance hint from defaults.json (owner, 2026-09-23: "re-roll" must
            # mean something different, not three copies)
            varied = view
            if args.vary:
                hints = character.settings.variation_hints
                if hints:
                    varied = View(kind=view.kind, id=view.id, prompt=f"{view.prompt} {hints[(n - 1) % len(hints)]}", tags=view.tags, background=view.background)
            try:
                saved = render_alternative(client, character, varied, template, output, log)
            except ImageClientError as exc:
                log.error("    [%s] %s", exc.kind, exc)
                log.error("stopping: every further request would fail the same way")
                write_state(character, state)
                return 3
            if saved is None:
                continue
            alternatives.append(saved.name)
            made += 1
            log.info("%s alternative %d/%d ok (%d s, %d KB)", key, n, args.variants, int(time.time() - started), saved.stat().st_size // 1024)
            if args.vault:
                file_into_vault(character, saved, stamp=state["stamp"], label=f"{character.name} {view.kind} · {view.id} · alternative {n} · {view.tags}")
            write_state(character, state)
    print("")
    print("Summary")
    print(f"  Alternatives   : {made} of {len(wanted) * args.variants}")
    print(f"  Review set     : {character.settings.vault_link}{set_run(character, state['stamp'])}")
    print("  Star ONE of each view - the original or an alternative - and `collect` takes the starred one.")
    return 0


SHEET_SIZE = os.environ.get("OPENAI_SHEET_SIZE", "3072x2048")
SHEET_TEMPLATE = PROJECT_ROOT / "prompts" / "sheet_prompt.txt"
SHEET_KINDS = ("body", "cowboy")


def generate_sheets(character: Character, state: dict, batch: list[View], client, present: list[Path], dry_run: bool, args: argparse.Namespace, log) -> int:
    """Two pending views per request, as the middle and right figures of a three-view model sheet.

    The moderation gate lets a model sheet through where it refuses the same character as a single
    standing figure (owner, 2026-09-23). The sheet is asked for at SHEET_SIZE so that each figure keeps
    about the pixels a single 1024x1536 view has - half-size figures are how ari_gen_v1 lost its shorts.
    Only body and cowboy views go this way; upper, face and detail views are crops the sheet cannot hold.
    """
    s = character.settings
    views = [v for v in batch if v.kind in SHEET_KINDS]
    skipped = [v.key for v in batch if v.kind not in SHEET_KINDS]
    if skipped:
        log.info("sheet mode leaves %d non-body view(s) for a normal run: %s", len(skipped), ", ".join(skipped))
    pairs = [views[i : i + 2] for i in range(0, len(views), 2)]
    template = SHEET_TEMPLATE.read_text(encoding="utf-8").strip()
    sheets_dir = character.out_dir / "sheets"
    done = opened = 0
    stopped = False
    for index, pair in enumerate(pairs, start=1):
        middle, right = pair[0], pair[1] if len(pair) > 1 else pair[0]
        keys = " + ".join(v.key for v in pair)
        base = global_prompt(character, template, middle.background).replace("{middle}", middle.prompt).replace("{right}", right.prompt if len(pair) > 1 else "the same view as the middle figure, seen from the opposite side")
        if dry_run:
            print(f"\n[{index}/{len(pairs)}] DRY RUN sheet {keys} at {SHEET_SIZE}\n{base[:400]}...")
            done += len(pair)
            continue
        entries = [state["views"].setdefault(v.key, {"status": "pending", "attempts": 0, "refusals": 0, "transient": 0}) for v in pair]
        lead = entries[0]
        for e in entries:
            if e.get("status") in ("open", "done"):
                e.update(refusals=0, transient=0)
            e["status"] = "pending"
            e.pop("reason", None)
        started = time.time()
        while lead["status"] == "pending":
            if lead["refusals"] >= s.retry_cap:
                for e in entries:
                    e["status"], e["reason"] = "open", f"refused {lead['refusals']} times (sheet)"
                break
            if lead["transient"] >= s.transient_cap:
                for e in entries:
                    e["status"], e["reason"] = "open", f"service errors {lead['transient']} times (sheet)"
                break
            lead["attempts"] += 1
            rewordings = s.refusal_rewordings
            extra = rewordings[(lead["attempts"] - 1) % len(rewordings)] if lead["attempts"] > 1 else ""
            prompt = base if not extra else f"{base}\n\n{extra}"
            try:
                assert client is not None
                data = client.edit_with_references(prompt, present, model=s.model, size=SHEET_SIZE, quality=s.quality, output_format=s.output_format, input_fidelity=s.input_fidelity)
                sheets_dir.mkdir(parents=True, exist_ok=True)
                raw = write_image_bytes(sheets_dir / f"{'+'.join(v.id for v in pair)}.{s.output_format}", data)
                figures = split_sheet(data)
                for v, e, fig in zip(pair, entries, figures[1:1 + len(pair)]):
                    saved = write_image_bytes(output_path(character, v), to_png_bytes(fig))
                    e.update(status="done", file=saved.name, prompt=prompt, sheet=raw.name, attempts=lead["attempts"])
                    e.pop("reason", None)
                    done += 1
                    if args.vault:
                        file_into_vault(character, saved, stamp=state["stamp"], label=f"{character.name} {v.kind} · {v.id} · {v.tags} (sheet)")
                log.info("[%d/%d] sheet %s ok (attempt %d, %d s, %d KB, figures %s)", index, len(pairs), keys, lead["attempts"], int(time.time() - started), len(data) // 1024, [f.size for f in figures])
            except ImageClientError as exc:
                if exc.kind == "moderation":
                    lead["refusals"] += 1
                    log.info("    sheet %s refused (%d/%d) - rewording", keys, lead["refusals"], s.retry_cap)
                elif exc.kind in ("auth", "billing"):
                    log.error("    [%s] %s", exc.kind, exc)
                    log.error("stopping the batch: every further request would fail the same way")
                    stopped = True
                    break
                elif exc.kind == "bad_request":
                    for e in entries:
                        e["status"], e["reason"] = "open", str(exc).splitlines()[0][:200]
                else:
                    lead["transient"] += 1
                    log.warning("    sheet %s [%s] (%d/%d): %s", keys, exc.kind, lead["transient"], s.transient_cap, str(exc).splitlines()[0][:160])
                    time.sleep(s.transient_wait_seconds)
            except FileError as exc:
                log.error("    %s", exc)
                for e in entries:
                    e["status"], e["reason"] = "open", str(exc)[:160]
            write_state(character, state)
        if stopped:
            break
        if lead["status"] == "open":
            opened += len(pair)
            log.warning("    sheet %s OPEN - %s", keys, lead["reason"])
        write_state(character, state)
    open_views = [key for key, entry in state["views"].items() if entry.get("status") == "open"]
    print("\nSummary (sheet mode)")
    print(f"  Sheets this run: {len(pairs)} for {len(views)} view(s)")
    print(f"  Successful     : {done}")
    print(f"  Left open      : {opened}" + (f"  ({', '.join(open_views)})" if open_views else ""))
    if stopped:
        print("  Stopped early  : yes (auth or billing)")
    return 0


def cmd_generate(args: argparse.Namespace, log) -> int:
    if getattr(args, "variants", None):
        return cmd_variants(args, log)
    character = load_character(args.name)
    s = character.settings
    for warning in s.warnings:
        log.warning(warning)
    for key, env_name in s.overrides.items():
        log.info("%s overridden by %s", key, env_name)
    dry_run = resolve_dry_run(character, args)
    template = load_template()
    present, missing = validate_reference_images(character)
    for path in missing:
        log.warning("reference image not found (add it before a live run): %s", path)
    if not dry_run and missing:
        log.error("live run refused: %d reference image(s) missing", len(missing))
        return 2

    state = read_state(character)
    if not state.get("stamp"):
        state["stamp"] = new_stamp()
    run = set_run(character, state["stamp"])

    wanted = set(args.only.split(",")) if args.only else None
    if wanted:
        unknown = wanted - {view.key for view in character.views}
        if unknown:
            log.error("unknown view(s): %s", ", ".join(sorted(unknown)))
            return 2
    todo = [view for view in character.views if (wanted is None or view.key in wanted) and (args.redo or state["views"].get(view.key, {}).get("status") != "done")]
    batch = todo[: args.limit] if args.limit else todo
    log.info("%s: %d of %d pending view(s) this run, %s, model %s, quality %s%s", character.name, len(batch), len(todo), "DRY RUN" if dry_run else "LIVE", s.model, s.quality, f", set {run}" if not dry_run else "")

    client = None
    if not dry_run:
        try:
            client = OpenAIImageClient()
        except ImageClientError as exc:
            log.error("[%s] %s", exc.kind, exc)
            return 3

    if args.sheet:
        return generate_sheets(character, state, batch, client, present, dry_run, args, log)

    done = opened = 0
    stopped = False
    for index, view in enumerate(batch, start=1):
        output = output_path(character, view)
        if dry_run:
            print(f"\n[{index}/{len(batch)}] DRY RUN - no request is sent")
            print(request_summary(character, view, build_prompt(character, view, template=template), present, output))
            done += 1
            continue
        entry = state["views"].setdefault(view.key, {"status": "pending", "attempts": 0, "refusals": 0, "transient": 0})
        # A re-attempt starts its own budget: the caps are per run, not for the life of the state file.
        if entry.get("status") in ("open", "done"):
            entry.update(refusals=0, transient=0)
        entry["status"] = "pending"
        entry.pop("reason", None)
        started = time.time()
        while entry["status"] == "pending":
            if entry["refusals"] >= s.retry_cap:
                entry["status"], entry["reason"] = "open", f"refused {entry['refusals']} times"
                break
            if entry["transient"] >= s.transient_cap:
                entry["status"], entry["reason"] = "open", f"service errors {entry['transient']} times"
                break
            entry["attempts"] += 1
            prompt = build_prompt(character, view, attempt=entry["attempts"], template=template)
            try:
                assert client is not None
                if present:
                    data = client.edit_with_references(prompt, present, model=s.model, size=s.size[view.kind], quality=s.quality, output_format=s.output_format, input_fidelity=s.input_fidelity)
                else:
                    data = client.generate_from_prompt(prompt, model=s.model, size=s.size[view.kind], quality=s.quality, output_format=s.output_format)
                saved = write_image_bytes(output, data)
                entry.update(status="done", file=saved.name, prompt=prompt)
                entry.pop("reason", None)
                done += 1
                log.info("[%d/%d] %s ok (attempt %d, %d s, %d KB)", index, len(batch), view.key, entry["attempts"], int(time.time() - started), len(data) // 1024)
                if args.vault:
                    copied = file_into_vault(character, saved, stamp=state["stamp"], label=f"{character.name} {view.kind} · {view.id} · {view.tags}")
                    log.debug("    filed %s", copied)
            except ImageClientError as exc:
                if exc.kind == "moderation":
                    entry["refusals"] += 1
                    log.info("    %s refused (%d/%d) - rewording", view.key, entry["refusals"], s.retry_cap)
                elif exc.kind in ("auth", "billing"):
                    log.error("    [%s] %s", exc.kind, exc)
                    log.error("stopping the batch: every further request would fail the same way")
                    entry["status"] = "pending"
                    stopped = True
                    break
                elif exc.kind == "bad_request":
                    # Not transient: the same request would fail the same way every time.
                    entry["status"], entry["reason"] = "open", str(exc).splitlines()[0][:200]
                else:
                    entry["transient"] += 1
                    log.warning("    %s [%s] (%d/%d): %s", view.key, exc.kind, entry["transient"], s.transient_cap, str(exc).splitlines()[0][:160])
                    time.sleep(s.transient_wait_seconds)
            except FileError as exc:
                log.error("    %s", exc)
                entry["status"], entry["reason"] = "open", str(exc)[:160]
            write_state(character, state)
        if stopped:
            break
        if entry["status"] == "open":
            opened += 1
            log.warning("    %s OPEN - %s", view.key, entry["reason"])
        write_state(character, state)

    open_views = [key for key, entry in state["views"].items() if entry.get("status") == "open"]
    print("\nSummary")
    print(f"  Views this run : {len(batch)}")
    print(f"  Successful     : {done}")
    print(f"  Left open      : {opened}" + (f"  ({', '.join(open_views)})" if open_views else ""))
    if stopped:
        print("  Stopped early  : yes (auth or billing)")
    if len(todo) > len(batch):
        print(f"  Still pending  : {len(todo) - len(batch)} (run generate again)")
    print(f"  Dry-run        : {'true' if dry_run else 'false'}")
    if not dry_run and done and args.vault:
        print(f"  Review set     : {s.vault_link}{run}")
    return 0 if not stopped else 3


# ---------------------------------------------------------------- collect / status

def cmd_resplit(args: argparse.Namespace, log) -> int:
    """Re-cut every kept sheet with the current split and overwrite its two views (and their vault copies).

    The sheets are the generated output; the cut is ours, so a better cut is applied to what exists
    rather than paid for again. State entries carry the sheet each view came from.
    """
    character = load_character(args.name)
    state = read_state(character)
    by_sheet: dict[str, list[View]] = {}
    views = {v.key: v for v in character.views}
    for key, entry in state["views"].items():
        if entry.get("sheet") and key in views:
            by_sheet.setdefault(entry["sheet"], []).append(views[key])
    if not by_sheet:
        log.info("no sheet-cut views in %s", character.name)
        return 0
    for sheet, pair in by_sheet.items():
        raw = character.out_dir / "sheets" / sheet
        if not raw.is_file():
            log.warning("sheet missing: %s", raw)
            continue
        figures = split_sheet(raw.read_bytes())
        for v, fig in zip(pair, figures[1:1 + len(pair)]):
            saved = write_image_bytes(output_path(character, v), to_png_bytes(fig))
            if args.vault and state.get("stamp"):
                file_into_vault(character, saved, stamp=state["stamp"], label=f"{character.name} {v.kind} · {v.id} · {v.tags} (sheet)")
            log.info("%s <- %s  %dx%d", v.key, sheet, fig.width, fig.height)
    return 0


def cmd_collect(args: argparse.Namespace, log) -> int:
    character = load_character(args.name)
    if args.all:
        log.warning("--all: taking every generated view, the vault stars are NOT consulted")
    counts, missing = collect_into_sheets(character, read_state(character), accept_all=args.all)
    for kind, n in counts.items():
        log.info("%d %s refs -> %s", n, kind, sheet_dir(character, kind))
    if not counts:
        log.warning("nothing collected: no starred, generated view")
    if missing:
        print("not in the dataset yet:\n  " + "\n  ".join(missing) + f"\n(regenerate with: generate {args.name} --only <view> --redo)")
    return 0


def cmd_status(args: argparse.Namespace, log) -> int:
    character = load_character(args.name)
    state = read_state(character)
    counts = {"done": 0, "open": 0, "pending": 0}
    for view in character.views:
        status = state["views"].get(view.key, {}).get("status", "pending")
        counts[status if status in counts else "pending"] += 1
    print(f"{character.name}: {len(character.views)} views - {counts['done']} done, {counts['open']} open, {counts['pending']} pending")
    if state.get("stamp"):
        print(f"review set: {character.settings.vault_link}{set_run(character, state['stamp'])}")
    for key, entry in state["views"].items():
        if entry.get("status") == "open":
            print(f"  open: {key} - {entry.get('reason')}")
    return 0


# ---------------------------------------------------------------- main

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="One image of a character in, the LoRA reference set out.")
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("init", help="create characters/<name>/character.json from a reference image")
    p.add_argument("name")
    p.add_argument("--reference", required=True)
    p.add_argument("--force", action="store_true")
    p = sub.add_parser("generate", help="render the pending views (dry run per defaults.json)")
    p.add_argument("name")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--no-dry-run", action="store_true")
    p.add_argument("--only", help="comma-separated view keys, e.g. body/01-front,face/02-front-smile")
    p.add_argument("--limit", type=int)
    p.add_argument("--redo", action="store_true", help="regenerate views that are already done")
    p.add_argument("--vault", action="store_true", help="also file every result into the vault review set")
    p.add_argument("--variants", type=int, help="re-roll: render N alternatives of each --only view beside the original, for the owner to pick from")
    p.add_argument("--vary", action="store_true", help="with --variants: give each alternative its own camera/stance hint so they differ")
    p.add_argument("--sheet", action="store_true", help="render pending body/cowboy views two at a time as one three-figure model sheet (left = front), and keep the middle and right figures; the gate passes a sheet where it refuses a single figure")
    p = sub.add_parser("resplit", help="re-cut every sheet-mode view from its kept sheet with the current split")
    p.add_argument("name")
    p.add_argument("--vault", action="store_true", help="also replace the copies in the vault review set")
    p = sub.add_parser("collect", help="copy the starred views into the training sheet folders")
    p.add_argument("name")
    p.add_argument("--all", action="store_true", help="take every generated view instead of only the starred ones - use ONLY when the owner has accepted the whole set")
    p = sub.add_parser("status", help="done / open / pending per character")
    p.add_argument("name")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args(argv)
    if getattr(args, "dry_run", False) and getattr(args, "no_dry_run", False):
        parser.error("--dry-run and --no-dry-run exclude each other")

    load_dotenv(PROJECT_ROOT / ".env")
    load_dotenv(PROJECT_ROOT.parent / ".env")  # the repo's .env, where the key already lives
    log = setup_logging(PROJECT_ROOT / "logs", verbose=args.verbose)
    CHARACTERS_DIR.mkdir(parents=True, exist_ok=True)
    try:
        return {"init": cmd_init, "generate": cmd_generate, "resplit": cmd_resplit, "collect": cmd_collect, "status": cmd_status}[args.command](args, log)
    except (ConfigError, PromptError, FileError) as exc:
        log.error("%s", exc)
        return 2
    except ImageClientError as exc:
        log.error("[%s] %s", exc.kind, exc)
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
