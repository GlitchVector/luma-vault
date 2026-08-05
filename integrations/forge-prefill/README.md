# luma-vault-prefill

A Forge / Automatic1111 extension that lets Luma Vault's **Open in Forge**
button fill the txt2img tab from a URL.

## Install

From the repo root:

```bash
pnpm setup:forge
```

It finds your webui, copies this folder into its `extensions/`, and tells you
where it put it. **Restart Forge afterwards** — extensions are loaded at
startup.

If the install is somewhere unusual, say where:

```bash
pnpm setup:forge "D:\AI\Stable Diffusion\webui"
```

Or set `LUMA_FORGE_DIR` once and keep running the bare command. To remove it:

```bash
pnpm setup:forge --uninstall
```

Re-running is safe: the folder is replaced wholesale rather than merged, so an
older version cannot leave a stale file behind.

There is no Python, no dependency and nothing to configure — Forge loads every
`.js` under `extensions/*/javascript/` on its own.

## Why it lives in the Luma Vault repo

Because a webui gets reinstalled, moved between drives and occasionally wiped,
and this extension is Luma Vault's, not Forge's. Keeping the source here means
recovering it after a reinstall is one command rather than remembering what it
used to do.

## What it does

Luma Vault opens:

```
http://127.0.0.1:7860/#luma_params=<url-encoded parameter block>
```

The extension takes that block, puts it in the txt2img prompt box, and presses
Forge's own **↙ "read generation parameters"** button.

A `#` fragment rather than a `?` query, for two reasons: a real block with
ControlNet and ADetailer is ~6KB once encoded and would crowd the usual request
header limit, and a fragment is never sent to the server — so the prompt does
not end up in Forge's log on its way to filling in a form.

It drives that button rather than filling each field itself, which is the whole
trick: Forge's parser already handles hires-fix settings, LoRA hashes, ADetailer
blocks and whatever the next extension adds. A hand-written field-filler would
know about none of them and would quietly go stale.

## Without it

Luma Vault still works — the button copies the same block to the clipboard and
opens Forge, and you paste it into the prompt box and press ↙ yourself. The
extension removes those two steps; it does not enable anything otherwise
impossible.

## If it stops working

It is pinned to three things in Forge's UI:

| What | Selector |
|---|---|
| The prompt box | `#txt2img_prompt textarea` |
| The toolbar | `#txt2img_tools` |
| The paste button | `#paste`, looked up *inside* the toolbar |

The last one matters: `paste` is a bare id that every tab reuses, so an
unscoped lookup finds whichever tab Gradio rendered first. If a future Forge
renames these, the extension does nothing rather than doing something wrong.

## The `/luma/v1` endpoints

`scripts/luma_api.py` adds four routes. They exist because Forge's own API has
two gaps that make it impossible to drive from outside:

| Route | Why it exists |
|---|---|
| `GET /luma/v1/checkpoints` | `GET /sdapi/v1/sd-models` returns **500 on every request** in Forge f2.0 — the handler builds five keys, the response model declares six, and the sixth is `Optional[str]` with no default, which Pydantic v2 treats as *required*. |
| `POST /luma/v1/checkpoint` | Setting `sd_model_checkpoint` via `/sdapi/v1/options` **silently does nothing**. Forge registers it as `OptionInfo(None, "(Managed by Forge)", gr.State)` with no onchange, so the value is stored and the model never loads. |
| `POST /luma/v1/vae` | Same reason, for `sd_vae`. |
| `GET /luma/v1/loaded` | Reports what is *actually* loaded next to what the settings claim. |

That last one is not redundant. During a failed switch the two disagree, and
the settings are the ones that lie — a test driven off `/sdapi/v1/options`
reports success while generating with the previous model. Read `sd_model_name`
from a generation's own `info`, or read this route.

Switching is done by calling `modules_forge.main_entry.checkpoint_change`,
which is what the UI dropdown calls: it sets the option **and** refreshes the
loading parameters. On plain Automatic1111 there is no `modules_forge`, so it
falls back to `sd_models.reload_model_weights()`.

Nothing is monkey-patched. Both bugs are upstream's, and a fix that rewrites a
host app's internals breaks on their next upgrade.

```bash
curl -s localhost:7860/luma/v1/checkpoints
curl -s -X POST localhost:7860/luma/v1/checkpoint \
     -H 'Content-Type: application/json' -d '{"name":"revAnimated_v122EOL"}'
```


## The dropdown repair

Forge's refresh buttons (the 🔄 beside Checkpoint and VAE) assign the new list
straight onto the Gradio component:

```python
for k, v in args.items():        # {"choices": sd_vae_items()}
    setattr(comp, k, v)          # -> ['Automatic', 'None', 'x.safetensors']
```

That skips the normalisation `gr.Dropdown.__init__` performs. Gradio 4 keeps
choices as `(label, value)` pairs and reads them back with
`[value for _, value in self.choices]`, so the next update to that dropdown
tries to unpack a filename into two variables:

```
ValueError: too many values to unpack (expected 2)
```

It matters more than a red badge on the dropdown. The exception escapes through
Gradio's event pipeline and takes the session's event stream with it — the
generation continues server-side while the browser stops hearing about it, so
the UI sits on **"Waiting…"** at 0% for a job that is already running. Ask
`/sdapi/v1/progress` if you ever want the truth.

`ui_vae` is the one that bites, because `on_preset_change` is wired to the
page's `load` event and lists it among its outputs — so once a VAE refresh has
happened, this fires on *every page load*, including the tab this extension
opens. `ui_checkpoint` is not among those outputs.

`_repair_dropdowns()` runs before anything here disturbs the UI, and is also
exposed as `POST /luma/v1/repair-dropdowns` for the case where nothing of ours
is involved at all: press refresh, reload the page, and the stream dies before
this extension is ever reached.

Forge's refresh button is deliberately **not** patched. Monkey-patching a host
app is how you end up debugging someone else's upgrade — this repairs the state
it is about to disturb, and nothing more.
