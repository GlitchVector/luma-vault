"""The prompt, in two layers, built once per request.

Layer one is ``prompts/global_dataset_prompt.txt`` with the character's description and
background filled into it; layer two is the view's own text from the library. A retry after
a moderation refusal appends one of the configured rewordings, so a refused view is asked
for differently each time instead of identically.
"""

from __future__ import annotations

from pathlib import Path

from config_loader import PROMPTS_DIR, Character, View

SEPARATOR = "\n\n----- VIEW -----\n\n"
TEMPLATE_PATH = PROMPTS_DIR / "global_dataset_prompt.txt"


class PromptError(Exception):
    """A prompt template problem the person can fix; the message names the file."""


def load_template(path: Path = TEMPLATE_PATH) -> str:
    if not path.exists():
        raise PromptError(f"prompt template not found: {path}")
    text = path.read_text(encoding="utf-8").strip()
    if not text:
        raise PromptError(f"prompt template is empty: {path}")
    for placeholder in ("{character_name}", "{description}", "{background}"):
        if placeholder not in text:
            raise PromptError(f"prompt template lacks {placeholder}: {path}")
    return text


def global_prompt(character: Character, template: str | None = None, background: str | None = None) -> str:
    text = template or load_template()
    return (text.replace("{character_name}", character.name)
                .replace("{description}", character.description)
                .replace("{background}", background or character.background))


def build_prompt(character: Character, view: View, *, attempt: int = 1, template: str | None = None) -> str:
    """Global text, separator, the view; from the second attempt on, one rewording is appended in rotation."""
    rewordings = character.settings.refusal_rewordings
    extra = rewordings[(attempt - 1) % len(rewordings)] if attempt > 1 else ""
    view_text = view.prompt if not extra else f"{view.prompt}\n\n{extra}"
    return f"{global_prompt(character, template, view.background)}{SEPARATOR}{view_text}"
