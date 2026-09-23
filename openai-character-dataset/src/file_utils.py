"""Folders, path checks, safe writes, the vault review set and the collect step. ``pathlib`` throughout.

The vault filing is the bridge to the owner's review flow: a copy of every generated image goes
into the folder his image vault watches with a set manifest, he stars what is correct, and
``collect`` asks the vault which members carry stars and copies only those into the training
sheet folders. Nothing generated is training data before that.
"""

from __future__ import annotations

import json
import os
import shutil
import urllib.request
from datetime import datetime
from pathlib import Path

from config_loader import Character, View


class FileError(Exception):
    """A filesystem or vault problem, with the path or endpoint in the message."""


def validate_reference_images(character: Character) -> tuple[list[Path], list[Path]]:
    present = [path for path in character.reference_images if path.is_file()]
    missing = [path for path in character.reference_images if not path.is_file()]
    return present, missing


def output_path(character: Character, view: View) -> Path:
    return character.out_dir / f"{view.kind}-{view.id}.{character.settings.output_format}"


def write_image_bytes(path: Path, data: bytes) -> Path:
    if not data:
        raise FileError(f"refusing to write an empty image to {path}")
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".part")
        tmp.write_bytes(data)
        os.replace(tmp, path)
    except OSError as exc:
        raise FileError(f"could not write {path}: {exc}") from exc
    return path


# ---------------------------------------------------------------- state

def read_state(character: Character) -> dict:
    if character.state_path.exists():
        return json.loads(character.state_path.read_text(encoding="utf-8"))
    return {"stamp": None, "views": {}}


def write_state(character: Character, state: dict) -> None:
    character.folder.mkdir(parents=True, exist_ok=True)
    character.state_path.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")


def new_stamp() -> str:
    return datetime.now().strftime("%Y%m%dT%H%M")


# ---------------------------------------------------------------- vault review set

MANIFEST_DIR = ".luma-sets"


def slug(text: str) -> str:
    out = "".join(ch.lower() if ch.isalnum() else "-" for ch in text)
    while "--" in out:
        out = out.replace("--", "-")
    return out.strip("-")


def set_run(character: Character, stamp: str) -> str:
    return slug(f"refgen-{character.name}-{stamp}")


def file_into_vault(character: Character, image: Path, *, stamp: str, label: str) -> Path:
    """Copy ``image`` into today's vault folder and record it in the set ``refgen-<name>-<stamp>``."""
    root = Path(character.settings.vault_outdir)
    if not root.exists():
        raise FileError(f"vault folder not reachable: {root}")
    run = set_run(character, stamp)
    # A set lives in ONE day folder: the one its manifest was first written to. Filing a later day's
    # images into that day's own folder made a twin set with the same name (2026-09-23), so an
    # existing manifest for the run wins over today's date.
    existing = sorted(root.glob(f"*/{MANIFEST_DIR}/{run}.json"))
    day = existing[0].parent.parent if existing else root / datetime.now().strftime("%Y-%m-%d")
    manifest_dir = day / MANIFEST_DIR
    manifest_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = manifest_dir / f"{run}.json"
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    else:
        manifest = {"run": run, "command": "refgen", "character": character.name, "title": "generated references - star what is correct", "createdAt": int(datetime.now().timestamp() * 1000), "members": []}
    target = day / f"refgen-{slug(character.name)}-{image.name}"
    shutil.copyfile(image, target)
    member = {"file": target.name, "label": label}
    members = manifest["members"]
    for index, existing in enumerate(members):
        if existing.get("file") == target.name:
            members[index] = member
            break
    else:
        members.append(member)
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return target


# The owner's star scale on a review set (2026-09-23): ONE star is a rejection - "re-roll this" - and a chosen
# picture carries two or more. A view whose original and alternatives all sit at one star is not collected.
REJECTED = 1


def vault_rpc(character: Character, name: str, args: dict) -> object:
    body = json.dumps({"name": name, "args": args}).encode("utf-8")
    request = urllib.request.Request(character.settings.vault_rpc, data=body, headers={"content-type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            answer = json.loads(response.read().decode("utf-8"))
    except OSError as exc:
        raise FileError(f"vault not reachable at {character.settings.vault_rpc}: {exc}") from exc
    if "ok" not in answer:
        raise FileError(f"vault {name} failed: {json.dumps(answer)[:300]}")
    return answer["ok"]


def refresh_stale_copies(character: Character, state: dict, log) -> int:
    """Give every overwritten vault copy a new name, so the vault sees a new file.

    The vault indexes a path once and leaves the row alone on a rescan by design (a backup tool
    rewriting timestamps must not wipe a library's thumbnails), and the watcher did not see the
    in-place overwrites the re-renders and re-cuts made over the share (2026-09-23: the set still
    showed the old back views). So a copy whose index row is older than the file on disk is filed
    again as `<name>-r<N>`, the manifest member points at the new file, and the stale row's file
    is deleted through the vault, which on a network folder is permanent - it is our own superseded
    copy, the truth is in out/.
    """
    run = set_run(character, state["stamp"])
    query = {
        "folderId": None, "kind": None, "rating": None, "sexyOnly": False, "search": "", "searchPaths": False, "tag": None,
        "set": run, "sets": [], "minStars": None, "maxStars": None, "unstarred": False, "hasPrompt": None, "img2img": None,
        "extras": None, "label": None, "animated": None, "greyscale": None, "minLongestEdge": None, "duplicatesOnly": False,
        "hideTags": [], "modifiedAfter": None, "modifiedBefore": None, "limit": 500, "offset": 0, "sort": "recent",
    }
    items = vault_rpc(character, "query_media", {"query": query})["items"]
    by_name = {Path(str(item["path"]).replace("\\", "/")).name: item for item in items}
    root = Path(character.settings.vault_outdir)
    manifests = sorted(root.glob(f"*/{MANIFEST_DIR}/{run}.json"))
    if not manifests:
        raise FileError(f"no manifest for {run} under {root}")
    manifest_path = manifests[0]
    day = manifest_path.parent.parent
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    members = manifest["members"]
    refiled = 0
    for key, entry in state["views"].items():
        if entry.get("status") != "done" or not entry.get("file"):
            continue
        source = character.out_dir / entry["file"]
        if not source.is_file():
            continue
        member = next((m for m in members if Path(m["file"]).stem.startswith(f"refgen-{slug(character.name)}-{source.stem}")), None)
        if member is None:
            continue
        item = by_name.get(member["file"])
        if item is None:
            continue  # not indexed at all: a rescan picks it up as new
        disk_ms = int(source.stat().st_mtime * 1000)
        if abs(int(item.get("modifiedAt") or 0) - disk_ms) < 5000 and (source.stat().st_size == int(item.get("sizeBytes") or item.get("size") or -1) or "sizeBytes" not in item and "size" not in item):
            continue
        # A new name the index has never seen.
        n = 2
        while (day / f"refgen-{slug(character.name)}-{source.stem}-r{n}{source.suffix}").exists():
            n += 1
        target = day / f"refgen-{slug(character.name)}-{source.stem}-r{n}{source.suffix}"
        shutil.copyfile(source, target)
        old_file = member["file"]
        member["file"] = target.name
        vault_rpc(character, "delete_media", {"ids": [int(item["id"])], "permanent": True})
        log.info("%s: %s -> %s (stale row %s deleted)", key, old_file, target.name, item["id"])
        refiled += 1
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return refiled


def starred_files(character: Character, run: str) -> dict[str, int]:
    """Ask the vault how many stars each file of the set carries (only starred files come back)."""
    query = {
        "folderId": None, "kind": None, "rating": None, "sexyOnly": False, "search": "", "searchPaths": False, "tag": None,
        "set": run, "sets": [], "minStars": 1, "maxStars": None, "unstarred": False, "hasPrompt": None, "img2img": None,
        "extras": None, "label": None, "animated": None, "greyscale": None, "minLongestEdge": None, "duplicatesOnly": False,
        "hideTags": [], "modifiedAfter": None, "modifiedBefore": None, "limit": 500, "offset": 0, "sort": "recent",
    }
    body = json.dumps({"name": "query_media", "args": {"query": query}}).encode("utf-8")
    request = urllib.request.Request(character.settings.vault_rpc, data=body, headers={"content-type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            answer = json.loads(response.read().decode("utf-8"))
    except OSError as exc:
        raise FileError(f"vault not reachable at {character.settings.vault_rpc}: {exc}") from exc
    if "ok" not in answer:
        raise FileError(f"vault query failed: {json.dumps(answer)[:300]}")
    return {Path(str(item["path"]).replace("\\", "/")).name: int(item.get("stars") or 0) for item in answer["ok"]["items"]}


# Where each kind of view lands under sheets_dir. The body and face names predate the other kinds and every
# prep script reads them, so they stay; the rest follow the same shape.
SHEET_FOLDERS = {"body": "{name}-refs-gen", "cowboy": "{name}-cowboy-refs-gen", "upper": "{name}-upper-refs-gen",
                 "face": "{name}-face-refs-gen", "detail": "{name}-detail-refs-gen"}


def sheet_dir(character: Character, kind: str) -> Path:
    return character.settings.sheets_dir / SHEET_FOLDERS[kind].format(name=slug(character.name))


def collect_into_sheets(character: Character, state: dict, *, accept_all: bool = False) -> tuple[dict[str, int], list[str]]:
    """Copy the acknowledged, generated views into the training sheet folders. Returns (count per kind, not-collected).

    Normally only the views the owner STARRED in the vault are taken. ``accept_all`` skips that check and is
    only for when he has accepted the whole set in words instead - his acknowledgement is the gate either way,
    never my own audit.
    """
    if not state.get("stamp"):
        raise FileError("nothing generated yet")
    run = set_run(character, state["stamp"])
    starred = {} if accept_all else starred_files(character, run)
    counts: dict[str, int] = {}
    missing: list[str] = []
    for view in character.views:
        entry = state["views"].get(view.key)
        if not entry or entry.get("status") != "done":
            missing.append(f"{view.key} ({entry.get('status') if entry else 'not generated'})")
            continue
        # The original and its re-rolled alternatives compete for the one star; whichever carries it is the view.
        candidates = [Path(entry["file"]).name] + [Path(name).name for name in entry.get("alternatives", [])]
        stars = {name: starred.get(f"refgen-{slug(character.name)}-{name}", 0) for name in candidates}
        # A pick the owner said in words is recorded as `chosen` on the view and outranks the stars.
        chosen = [entry["chosen"]] if entry.get("chosen") in candidates else [name for name in candidates if stars[name] > REJECTED]
        if accept_all:
            chosen = chosen[:1] or [name for name in candidates if stars[name] != REJECTED][:1]
        if not chosen:
            missing.append(f"{view.key} (generated, not starred)")
            continue
        if len(chosen) > 1:
            missing.append(f"{view.key} ({len(chosen)} starred - star only one: {', '.join(chosen)})")
            continue
        source = character.out_dir / chosen[0]
        dest_dir = sheet_dir(character, view.kind)
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest = dest_dir / f"{slug(character.name)}-{view.kind}-{view.id}{source.suffix}"
        shutil.copyfile(source, dest)
        dest.with_suffix(".tags.txt").write_text(view.tags + "\n", encoding="utf-8")
        counts[view.kind] = counts.get(view.kind, 0) + 1
    return counts, missing
