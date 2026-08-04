"""Endpoints Forge's own API is missing.

Two gaps, both hit as soon as anything tries to drive Forge from outside:

1. `GET /sdapi/v1/sd-models` returns 500 on every request in Forge f2.0. The
   handler builds five keys; the response model declares six, and the sixth
   (`config`) is `Optional[str]` with no default — which in Pydantic v2 is a
   *required* field that merely tolerates None. Validation fails before the
   response is ever serialised.

2. Setting `sd_model_checkpoint` through `/sdapi/v1/options` does nothing.
   Forge registers that option as `OptionInfo(None, "(Managed by Forge)",
   gr.State)` with no onchange handler, so the value is stored and the model is
   never loaded. The real work happens in `modules_forge.main_entry
   .checkpoint_change`, which is wired only to the UI dropdown. The API accepts
   the setting and silently keeps the old model — the failure looks exactly
   like a successful switch until you read what the generation actually used.

Neither is patched here; monkey-patching a host app is how you end up debugging
someone else's upgrade. These are additive routes under `/luma/v1/` that call
Forge's own functions.
"""

from modules import script_callbacks


def _resolve(name):
    """A checkpoint by title, model name, or filename — whichever is at hand.

    Callers outside the webui know a filename; the dropdown knows a title with
    a hash appended. Accepting either keeps the caller from having to fetch the
    list first just to translate.
    """
    import modules.sd_models as sd_models

    match = sd_models.get_closet_checkpoint_match(name)
    if match is not None:
        return match

    wanted = name.lower()
    for info in sd_models.checkpoints_list.values():
        candidates = (info.title, info.model_name, info.filename)
        if any(c and c.lower() == wanted for c in candidates):
            return info
        if info.filename and info.filename.lower().endswith(wanted):
            return info
    return None


def _architecture(filename):
    """`sd`, `xl` or `flux`, read from the tensor names in the header alone.

    Forge's UI radio decides which controls are shown and what they default
    to: on `xl` the clip-skip slider and the VAE picker are hidden, which is
    wrong for an SD1.5 checkpoint that specifies both. It does *not* filter the
    checkpoint dropdown - `on_preset_change` does not list that component among
    its outputs at all.

    A safetensors header is a length-prefixed JSON blob at the front of the
    file, so this is a few KB read, not a model load.
    """
    import json
    import struct

    if not filename or not filename.lower().endswith(".safetensors"):
        return None
    try:
        with open(filename, "rb") as handle:
            length = struct.unpack("<Q", handle.read(8))[0]
            # Guard against a corrupt length turning into a huge allocation.
            if not 0 < length < 64 * 1024 * 1024:
                return None
            keys = json.loads(handle.read(length)).keys()
    except (OSError, ValueError, struct.error):
        return None

    for key in keys:
        if key.startswith("double_blocks.") or ".double_blocks." in key:
            return "flux"
        # SDXL is the one with a second text encoder.
        if key.startswith("conditioner.embedders.1."):
            return "xl"
    return "sd"


def _dropdown_value(info):
    """The string the checkpoint dropdown will actually match.

    A `CheckpointInfo.title` is not stable. It starts as the bare filename and
    becomes `filename [shorthash]` the first time the model is loaded, because
    `calculate_shorthash` rewrites it — and rewrites the setting with it.

    The dropdown's `choices`, meanwhile, are captured **once** when Forge builds
    its UI. So after a model has been used, the setting holds the hashed title
    while the frozen choice list still offers the bare one. Gradio finds no
    match and renders an empty box — the checkpoint is selected, loaded and
    generating, and the control shows nothing.

    Reading the choices off the live component sidesteps the whole question:
    whatever it is offering is what gets stored.
    """
    try:
        from modules_forge import main_entry
    except ImportError:
        return info.title

    dropdown = getattr(main_entry, "ui_checkpoint", None)

    # Bring the component's choices up to date first. They are captured once
    # when the UI is built, so a checkpoint added to the folder afterwards is
    # missing from them — and `/sdapi/v1/refresh-checkpoints` rebuilds Forge's
    # internal list without touching this. Same visible symptom as the stale
    # title: a working model in an empty box.
    if dropdown is not None:
        try:
            from modules import shared, shared_items

            # `(label, value)` pairs, which is how Gradio 4 normalises choices
            # in the constructor. Assigning bare strings leaves the component
            # in a shape its own postprocess does not expect, and the page
            # shows an "Error" toast over the dropdown on the next update.
            tiles = shared_items.list_checkpoint_tiles(
                shared.opts.data.get("sd_checkpoint_dropdown_use_short", False)
            )
            dropdown.choices = [(tile, tile) for tile in tiles]
        except Exception:
            # Best effort. A Forge that renames these still switches models.
            pass

    for choice in getattr(dropdown, "choices", None) or []:
        # Gradio 4 carries choices as (label, value) pairs; older ones as plain
        # strings.
        text = choice[0] if isinstance(choice, (tuple, list)) and choice else choice
        if not isinstance(text, str):
            continue
        if text == info.title or text == info.name or text.startswith(info.name + " ["):
            return text
    return info.title


def on_app_started(_demo, app):
    from fastapi import Body, HTTPException

    @app.get("/luma/v1/checkpoints")
    def list_checkpoints():
        import modules.sd_models as sd_models

        return [
            {
                "title": info.title,
                "name": info.model_name,
                "filename": info.filename,
                "hash": info.shorthash,
                "sha256": info.sha256,
            }
            for info in sd_models.checkpoints_list.values()
        ]

    @app.post("/luma/v1/checkpoint")
    def set_checkpoint(name: str = Body(..., embed=True)):
        info = _resolve(name)
        if info is None:
            raise HTTPException(status_code=404, detail=f"no checkpoint matching {name!r}")

        preset = _architecture(info.filename)

        try:
            # Forge's own path: sets the option *and* refreshes the loading
            # parameters, which is the half the options endpoint skips.
            from modules import shared
            from modules_forge import main_entry

            # Set before the switch so the two never disagree. It changes which
            # controls Forge shows, not which checkpoints it offers.
            if preset and shared.opts.data.get("forge_preset") not in (preset, "all"):
                shared.opts.set("forge_preset", preset)

            main_entry.checkpoint_change(_dropdown_value(info))
        except ImportError:
            # Plain Automatic1111: no preset radio, and the option does have an
            # onchange handler.
            from modules import shared
            import modules.sd_models as sd_models

            shared.opts.set("sd_model_checkpoint", info.title)
            sd_models.reload_model_weights()

        return {
            "requested": name,
            "title": info.title,
            "filename": info.filename,
            "preset": preset,
        }

    @app.post("/luma/v1/vae")
    def set_vae(name: str = Body(..., embed=True)):
        from modules import shared

        try:
            from modules_forge import main_entry

            main_entry.vae_change(name)
        except ImportError:
            shared.opts.set("sd_vae", name)
        return {"vae": name}

    @app.get("/luma/v1/loaded")
    def loaded():
        """What is *actually* loaded, not what the settings claim.

        The distinction is the whole point of this file: during a checkpoint
        switch those two disagree, and trusting the settings is how a test
        silently runs against the wrong model.
        """
        from modules import shared

        model = getattr(shared, "sd_model", None)
        info = getattr(model, "sd_checkpoint_info", None) if model else None
        option = shared.opts.data.get("sd_model_checkpoint")

        # Whether the dropdown can render the current setting at all. These
        # disagree whenever a title gained its `[hash]` after the UI froze its
        # choices, and the visible symptom is an empty box over a working model.
        choices = []
        try:
            from modules_forge import main_entry

            for choice in getattr(getattr(main_entry, "ui_checkpoint", None), "choices", None) or []:
                text = choice[0] if isinstance(choice, (tuple, list)) and choice else choice
                if isinstance(text, str):
                    choices.append(text)
        except ImportError:
            pass

        return {
            "option": option,
            "loaded_title": getattr(info, "title", None),
            "loaded_hash": getattr(info, "shorthash", None),
            "dropdown_can_show_it": option in choices if choices else None,
        }


script_callbacks.on_app_started(on_app_started)
