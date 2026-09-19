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
    day = root / datetime.now().strftime("%Y-%m-%d")
    manifest_dir = day / MANIFEST_DIR
    manifest_dir.mkdir(parents=True, exist_ok=True)
    run = set_run(character, stamp)
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


def starred_files(character: Character, run: str) -> set[str]:
    """Ask the vault which files of the set carry at least one star."""
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
    return {Path(str(item["path"]).replace("\\", "/")).name for item in answer["ok"]["items"]}


def collect_into_sheets(character: Character, state: dict) -> tuple[int, int, list[str]]:
    """Copy the starred, generated views into the training sheet folders. Returns (body, face, not-collected)."""
    if not state.get("stamp"):
        raise FileError("nothing generated yet")
    run = set_run(character, state["stamp"])
    starred = starred_files(character, run)
    body_dir = character.settings.sheets_dir / f"{slug(character.name)}-refs-gen"
    face_dir = character.settings.sheets_dir / f"{slug(character.name)}-face-refs-gen"
    body_dir.mkdir(parents=True, exist_ok=True)
    face_dir.mkdir(parents=True, exist_ok=True)
    n_body = n_face = 0
    missing: list[str] = []
    for view in character.views:
        entry = state["views"].get(view.key)
        if not entry or entry.get("status") != "done":
            missing.append(f"{view.key} ({entry.get('status') if entry else 'not generated'})")
            continue
        vault_name = f"refgen-{slug(character.name)}-{Path(entry['file']).name}"
        if vault_name not in starred:
            missing.append(f"{view.key} (generated, not starred)")
            continue
        source = character.out_dir / entry["file"]
        dest_dir = body_dir if view.kind == "body" else face_dir
        dest = dest_dir / f"{slug(character.name)}-{view.kind}-{view.id}{source.suffix}"
        shutil.copyfile(source, dest)
        dest.with_suffix(".tags.txt").write_text(view.tags + "\n", encoding="utf-8")
        if view.kind == "body":
            n_body += 1
        else:
            n_face += 1
    return n_body, n_face, missing
