"""Load and validate the three config layers: shared defaults, the view library, one character.

``config/defaults.json`` holds every setting shared by all characters; ``config/views.json``
is the library of body and face views; ``characters/<name>/character.json`` holds what is
specific to one character (description, audit list, references, which views, overrides).
Environment variables override the defaults so one machine can run another quality or
model without editing committed files. Relative paths in a character file resolve against
that character's folder; relative paths in defaults resolve against the project root.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
CONFIG_DIR = PROJECT_ROOT / "config"
CHARACTERS_DIR = PROJECT_ROOT / "characters"
PROMPTS_DIR = PROJECT_ROOT / "prompts"

# What the installed SDK (openai 3.x) lists. For a WARNING only - the service adds values
# faster than this file changes, so an unknown value is passed through, never refused.
KNOWN_QUALITIES = ("standard", "low", "medium", "high", "xhigh", "max", "auto")
KNOWN_SIZES = ("1024x1024", "1536x1024", "1024x1536", "auto")
KNOWN_FORMATS = ("png", "jpeg", "webp")

ENV_OVERRIDES = {
    "model": "OPENAI_IMAGE_MODEL",
    "quality": "OPENAI_IMAGE_QUALITY",
    "output_format": "OPENAI_OUTPUT_FORMAT",
    "vault_outdir": "LUMA_VAULT_OUTDIR",
    "vault_rpc": "LUMA_RPC",
}


class ConfigError(Exception):
    """A configuration problem the person can fix; the message says how."""


# Every framing the LoRA is rendered at, so every framing is trained at its own scale rather than cut out of a
# full-body frame at a fraction of the pixels. `detail` views are per character (garment close-ups) and live in
# character.json rather than the library.
VIEW_KINDS = ("body", "cowboy", "upper", "face", "detail")


@dataclass(frozen=True)
class View:
    kind: str  # one of VIEW_KINDS
    id: str
    prompt: str
    tags: str
    # Per-view background. A dataset where every frame shares one background teaches that background to the
    # trigger, so the library rotates neutral fields and this overrides the character's own default.
    background: str | None = None

    @property
    def key(self) -> str:
        return f"{self.kind}/{self.id}"


@dataclass
class Settings:
    model: str
    quality: str
    output_format: str
    input_fidelity: str
    size: dict[str, str]
    dry_run: bool
    retry_cap: int
    transient_cap: int
    transient_wait_seconds: float
    refusal_rewordings: list[str]
    variation_hints: list[str]
    vault_outdir: str
    vault_rpc: str
    vault_link: str
    sheets_dir: Path
    overrides: dict[str, str] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)


@dataclass
class Character:
    name: str
    folder: Path
    description: str
    audit: list[str]
    background: str
    reference_images: list[Path]
    # The owner's sheets the reference was cut from, when it was; filed with the dataset by `collect`.
    source_sheets: list[Path]
    views: list[View]
    settings: Settings
    config_path: Path

    @property
    def out_dir(self) -> Path:
        return self.folder / "out"

    @property
    def state_path(self) -> Path:
        return self.folder / "state.json"


def _read_json(path: Path) -> dict:
    if not path.exists():
        raise ConfigError(f"file not found: {path}")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ConfigError(f"not valid JSON ({path}): line {exc.lineno}, column {exc.colno}: {exc.msg}") from exc
    if not isinstance(data, dict):
        raise ConfigError(f"top level must be a JSON object: {path}")
    return data


def load_views(path: Path = CONFIG_DIR / "views.json") -> list[View]:
    raw = _read_json(path)
    views: list[View] = []
    for kind in VIEW_KINDS:
        items = raw.get(kind)
        if items is None and kind == "detail":
            continue
        if not isinstance(items, list) or (not items and kind != "detail"):
            raise ConfigError(f'views file needs a non-empty "{kind}" list: {path}')
        seen: set[str] = set()
        for index, item in enumerate(items):
            if not isinstance(item, dict) or not all(isinstance(item.get(k), str) and item[k].strip() for k in ("id", "prompt", "tags")):
                raise ConfigError(f'{kind}[{index}] in {path} needs non-empty strings "id", "prompt", "tags"')
            if item["id"] in seen:
                raise ConfigError(f'duplicate {kind} view id "{item["id"]}" in {path}')
            seen.add(item["id"])
            bg = item.get("background")
            views.append(View(kind=kind, id=item["id"], prompt=item["prompt"].strip(), tags=item["tags"].strip(),
                              background=bg.strip() if isinstance(bg, str) and bg.strip() else None))
    return views


def load_settings(overrides_from_character: dict | None = None, path: Path = CONFIG_DIR / "defaults.json") -> Settings:
    raw = _read_json(path)
    merged = {key: value for key, value in raw.items() if not key.startswith("_")}
    for key, value in (overrides_from_character or {}).items():
        # A character that overrides one size keeps the defaults for the other kinds.
        if key == "size" and isinstance(value, dict) and isinstance(merged.get("size"), dict):
            merged["size"] = {**merged["size"], **value}
        else:
            merged[key] = value
    applied: dict[str, str] = {}
    for key, env_name in ENV_OVERRIDES.items():
        value = os.environ.get(env_name)
        if value:
            merged[key] = value
            applied[key] = env_name
    body_size = os.environ.get("OPENAI_IMAGE_SIZE")
    if body_size:
        merged["size"] = {**merged.get("size", {}), "body": body_size}
        applied["size.body"] = "OPENAI_IMAGE_SIZE"

    required = ("model", "quality", "output_format", "input_fidelity", "size", "dry_run", "retry_cap", "transient_cap", "transient_wait_seconds", "refusal_rewordings", "vault_outdir", "vault_rpc", "vault_link", "sheets_dir")
    missing = [key for key in required if key not in merged]
    if missing:
        raise ConfigError(f"defaults are missing: {', '.join(missing)} ({path})")
    for key in ("model", "quality", "output_format", "input_fidelity", "vault_outdir", "vault_rpc", "vault_link", "sheets_dir"):
        if not isinstance(merged[key], str) or not merged[key].strip():
            raise ConfigError(f'setting "{key}" must be a non-empty string')
    if not isinstance(merged["size"], dict) or not all(isinstance(merged["size"].get(k), str) for k in VIEW_KINDS):
        raise ConfigError(f'setting "size" must be an object with a string for each of {", ".join(VIEW_KINDS)}')
    if not isinstance(merged["dry_run"], bool):
        raise ConfigError('setting "dry_run" must be true or false')
    if not isinstance(merged["refusal_rewordings"], list) or not merged["refusal_rewordings"]:
        raise ConfigError('setting "refusal_rewordings" must be a non-empty list of strings')
    if merged["output_format"] not in KNOWN_FORMATS:
        raise ConfigError(f'setting "output_format" must be one of {", ".join(KNOWN_FORMATS)}')

    warnings: list[str] = []
    if merged["quality"] not in KNOWN_QUALITIES:
        warnings.append(f'quality "{merged["quality"]}" is not one the installed SDK lists; passing it through')
    for kind, size in merged["size"].items():
        if size not in KNOWN_SIZES:
            warnings.append(f'{kind} size "{size}" is not one the installed SDK lists; passing it through')

    sheets = Path(merged["sheets_dir"])
    return Settings(
        model=merged["model"],
        quality=merged["quality"],
        output_format=merged["output_format"],
        input_fidelity=merged["input_fidelity"],
        size=dict(merged["size"]),
        dry_run=merged["dry_run"],
        retry_cap=int(merged["retry_cap"]),
        transient_cap=int(merged["transient_cap"]),
        transient_wait_seconds=float(merged["transient_wait_seconds"]),
        refusal_rewordings=[str(item) for item in merged["refusal_rewordings"]],
        variation_hints=[str(item) for item in merged.get("variation_hints", [])],
        vault_outdir=merged["vault_outdir"],
        vault_rpc=merged["vault_rpc"],
        vault_link=merged["vault_link"],
        sheets_dir=sheets if sheets.is_absolute() else PROJECT_ROOT / sheets,
        overrides=applied,
        warnings=warnings,
    )


def _detail_views(raw: dict, path: Path) -> list[View]:
    """The character's own garment close-ups: the small parts a full-body frame holds at a tenth of the frame.

    Per character rather than in the library because the parts differ (Ari's shorts and collar, another's belt
    and choker). Each needs an id, a prompt and framing-only caption tags - the garment itself is never captioned,
    the trigger owns it (caption doctrine, 2026-09-16). Backgrounds rotate like the library's.
    """
    items = raw.get("details")
    if items is None:
        return []
    if not isinstance(items, list):
        raise ConfigError(f'{path}: "details" must be a list of {{id, prompt, tags}} objects')
    backgrounds = [view.background for view in load_views() if view.background]
    views: list[View] = []
    seen: set[str] = set()
    for index, item in enumerate(items):
        if not isinstance(item, dict) or not all(isinstance(item.get(k), str) and item[k].strip() for k in ("id", "prompt", "tags")):
            raise ConfigError(f'{path}: details[{index}] needs non-empty strings "id", "prompt", "tags"')
        if item["id"] in seen:
            raise ConfigError(f'{path}: duplicate detail id "{item["id"]}"')
        seen.add(item["id"])
        bg = item.get("background")
        background = bg.strip() if isinstance(bg, str) and bg.strip() else (backgrounds[index % len(backgrounds)] if backgrounds else None)
        views.append(View(kind="detail", id=item["id"], prompt=item["prompt"].strip(), tags=item["tags"].strip(), background=background))
    return views


def character_dir(name: str) -> Path:
    return CHARACTERS_DIR / name


def load_character(name: str) -> Character:
    folder = character_dir(name)
    path = folder / "character.json"
    raw = _read_json(path)
    for key in ("name", "description", "audit", "reference_images"):
        if key not in raw:
            raise ConfigError(f'{path} is missing "{key}"')
    if not isinstance(raw["description"], str) or not raw["description"].strip():
        raise ConfigError(f'{path}: "description" is empty - describe the character from the source image first')
    if not isinstance(raw["audit"], list) or not raw["audit"]:
        raise ConfigError(f'{path}: "audit" is empty - list what every generated frame is checked against')
    if not isinstance(raw["reference_images"], list) or not raw["reference_images"] or not all(isinstance(item, str) for item in raw["reference_images"]):
        raise ConfigError(f'{path}: "reference_images" must be a non-empty list of paths')

    settings = load_settings(raw.get("settings") if isinstance(raw.get("settings"), dict) else None)
    library = load_views() + _detail_views(raw, path)
    wanted = raw.get("views")
    if wanted is None:
        views = library
    else:
        if not isinstance(wanted, list) or not all(isinstance(item, str) for item in wanted):
            raise ConfigError(f'{path}: "views" must be a list of "body/<id>" or "face/<id>" keys, or absent for all')
        by_key = {view.key: view for view in library}
        unknown = [key for key in wanted if key not in by_key]
        if unknown:
            raise ConfigError(f'{path}: unknown views: {", ".join(unknown)}')
        views = [by_key[key] for key in wanted]

    references = [Path(item) if Path(item).is_absolute() else folder / item for item in raw["reference_images"]]
    sheets_raw = raw.get("source_sheets") or []
    if not isinstance(sheets_raw, list) or not all(isinstance(item, str) for item in sheets_raw):
        raise ConfigError(f'{path}: "source_sheets" must be a list of paths')
    source_sheets = [Path(item) if Path(item).is_absolute() else folder / item for item in sheets_raw]
    return Character(
        name=str(raw["name"]),
        folder=folder,
        description=raw["description"].strip(),
        audit=[str(item) for item in raw["audit"]],
        background=str(raw.get("background") or "plain white or extremely simple, low-detail background; no scenery, no floor detail beyond a faint contact shadow"),
        reference_images=references,
        source_sheets=source_sheets,
        views=views,
        settings=settings,
        config_path=path,
    )
