"""One image of a character in, the LoRA reference set out. The single CLI of this project.

    charrefs.py init <name> --reference <image>           write characters/<name>/character.json (then fill it)
    charrefs.py generate <name> [--dry-run | --no-dry-run] [--only body/01-front,face/02-front-smile] [--limit N] [--redo] [--vault]
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
import shutil
import sys
import time
from pathlib import Path

from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).resolve().parent))

from config_loader import CHARACTERS_DIR, PROJECT_ROOT, Character, ConfigError, View, character_dir, load_character, load_views  # noqa: E402
from file_utils import FileError, collect_into_sheets, file_into_vault, new_stamp, output_path, read_state, set_run, validate_reference_images, write_image_bytes, write_state  # noqa: E402
from logger_utils import setup_logging  # noqa: E402
from openai_image_client import ImageClientError, OpenAIImageClient  # noqa: E402
from prompt_builder import PromptError, build_prompt, load_template  # noqa: E402


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
        "_fill": "description and audit are derived from the reference image BEFORE anything renders; the description is what every prompt says about her, the audit list is what every generated frame is checked against (physics first). Leave `views` out for the whole library, or list keys like body/01-front.",
        "description": "",
        "audit": [],
        "background": "plain white or extremely simple, low-detail background; no scenery, no floor detail beyond a faint contact shadow",
        "reference_images": [target.name],
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


def cmd_generate(args: argparse.Namespace, log) -> int:
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

def cmd_collect(args: argparse.Namespace, log) -> int:
    character = load_character(args.name)
    if args.all:
        log.warning("--all: taking every generated view, the vault stars are NOT consulted")
    n_body, n_face, missing = collect_into_sheets(character, read_state(character), accept_all=args.all)
    name = character.name.lower()
    log.info("%d body refs -> %s", n_body, character.settings.sheets_dir / f"{name}-refs-gen")
    log.info("%d face refs -> %s", n_face, character.settings.sheets_dir / f"{name}-face-refs-gen")
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
        return {"init": cmd_init, "generate": cmd_generate, "collect": cmd_collect, "status": cmd_status}[args.command](args, log)
    except (ConfigError, PromptError, FileError) as exc:
        log.error("%s", exc)
        return 2
    except ImageClientError as exc:
        log.error("[%s] %s", exc.kind, exc)
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
