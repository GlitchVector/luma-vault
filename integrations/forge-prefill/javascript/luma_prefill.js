// Pre-fill Forge / Automatic1111 from a URL.
//
// Luma Vault opens:
//
//     http://127.0.0.1:7860/#luma_params=<url-encoded A1111 parameter block>
//
// and this puts that block into the txt2img prompt box and presses Forge's own
// "read generation parameters" button.
//
// # Why it drives that button instead of filling the fields itself
//
// Because Forge's parser is better than anything worth reimplementing here. It
// already understands hires-fix settings, LoRA hashes, ADetailer blocks,
// refiner settings and whatever the next extension adds — all of which appear
// in a real parameter block and none of which a hand-written field-filler would
// know about. Handing it the text means this stays correct as Forge changes.
//
// # Why a fragment and not a query string
//
// A real parameter block with ControlNet and two ADetailer passes runs to 2,656
// bytes, which is about 6KB once url-encoded — close enough to the usual 8KB
// request-header limit to fail on a long one. A fragment is never sent to the
// server at all, so there is no limit to hit.
//
// It also keeps the prompt out of Forge's request log. The text describes what
// someone generated, and it has no business being written to a file on the way
// to filling in a form.
//
// # Why JavaScript and no Python
//
// Forge loads every `.js` under `extensions/*/javascript/` automatically, so
// this needs no callbacks, no imports and nothing that can break a launch. The
// worst failure mode is a file that does nothing.

(function () {
    'use strict'

    const PARAM = 'luma_params'

    // Read once and clear it from the address bar, so a refresh does not paste
    // the same thing over work in progress.
    function takeParams() {
        // `hash` keeps its leading '#'.
        const params = new URLSearchParams(window.location.hash.slice(1))
        const value = params.get(PARAM)
        if (!value) return null

        params.delete(PARAM)
        const rest = params.toString()
        window.history.replaceState(
            {},
            '',
            window.location.pathname + window.location.search + (rest ? '#' + rest : ''),
        )
        return value
    }

    // Gradio listens for `input`, and its textarea is bound by Svelte. Setting
    // `.value` alone updates the DOM without telling the framework, so the next
    // thing to touch that component overwrites it with the stale value.
    function setTextarea(textarea, value) {
        const descriptor = Object.getOwnPropertyDescriptor(
            window.HTMLTextAreaElement.prototype,
            'value',
        )
        if (descriptor && descriptor.set) descriptor.set.call(textarea, value)
        else textarea.value = value
        textarea.dispatchEvent(new Event('input', { bubbles: true }))
    }

    // Scoped to the txt2img toolbar. The paste button's elem_id is a bare
    // `paste`, which every tab reuses — an unscoped lookup would find whichever
    // tab Gradio happened to render first.
    function pasteButton() {
        const tools = document.getElementById('txt2img_tools')
        return (tools && tools.querySelector('#paste')) || document.getElementById('paste')
    }

    // Toggles that survive a paste and change the image.
    //
    // A1111's "read generation parameters" *sets* what the block names and
    // never resets what it omits. So a Hires pass left on from an hour ago
    // silently upscales an image whose parameters say nothing about Hires, and
    // the result does not match the original however correct the block was.
    //
    // Each entry says: this toggle should be on exactly when the block mentions
    // this text.
    const TOGGLES = [
        { id: 'txt2img_hr-checkbox', mentions: /Hires (upscale|upscaler|steps)/ },
        { id: 'txt2img_enable-checkbox', mentions: /Refiner/ },
        {
            id: 'script_txt2img_adetailer_ad_main_accordion-checkbox',
            mentions: /ADetailer model/,
            // Ticking this box while its settings are still at their defaults
            // would run a *different* refinement and look like success. Only
            // enable once the block's own detector has actually landed.
            confirm: () => {
                const model = document.querySelector(
                    '#script_txt2img_adetailer_ad_model input, ' +
                    '#script_txt2img_adetailer_ad_model select',
                )
                return Boolean(model && model.value && model.value !== 'None')
            },
        },
    ]

    // Read one field out of the settings line, quote-aware.
    //
    // Splitting on "," is wrong: ADetailer and ControlNet write quoted values
    // containing commas, and a model name can contain anything at all — this
    // library has one called `0.7(aniverse_v20HDPruned) + 0.3(hll3vtubers)`.
    // So a value runs until the next `Key: `, not until the next comma.
    function settingsField(params, key) {
        const lines = params.trim().split('\n')
        const line = lines[lines.length - 1]
        const pattern = new RegExp(
            '(?:^|,\\s*)' + key + ':\\s*(.*?)(?=,\\s*[A-Za-z][A-Za-z0-9 _/-]*:|$)',
        )
        const found = line.match(pattern)
        return found ? found[1].trim().replace(/^"|"$/g, '') : null
    }

    // The checkpoint and VAE cannot be pasted, so they are set over HTTP.
    //
    // Forge registers `sd_model_checkpoint` as `OptionInfo(None, "(Managed by
    // Forge)", gr.State)` with no onchange, so A1111's paste — and the options
    // API — set a string that nothing reads. The model actually loads through
    // `modules_forge.main_entry.checkpoint_change`, which our own endpoint
    // calls. Same story for the VAE.
    //
    // This matters more than it sounds: a paste that fills every field but
    // leaves the previous model loaded looks like it worked, and quietly
    // generates from the wrong checkpoint. Worse, an SD1.5 block pasted over a
    // loaded SDXL model keeps that model with the SD1.5 VAE the block names —
    // which decodes to rainbow noise.
    function send(route, name) {
        return fetch('/luma/v1/' + route, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
        })
            .then((response) => {
                if (response.ok) {
                    console.log('[luma-vault] %s -> %s', route, name)
                    return response.json()
                }
                // 404 means scripts/luma_api.py is not installed, or this is a
                // webui old enough not to need it. Not worth a scary message:
                // every other field still pasted.
                console.warn(
                    '[luma-vault] could not set %s "%s" (%d) — set it by hand',
                    route, name, response.status,
                )
                return null
            })
            .catch((error) => {
                console.warn('[luma-vault] setting %s failed:', route, error)
                return null
            })
    }

    // Forge's architecture radio — the `sd | xl | flux | all` group above the
    // checkpoint dropdown. It has no elem_id, so it is found by its choices:
    // a radio group offering exactly those four is that control and nothing
    // else on the page.
    function presetRadio(preset) {
        const CHOICES = ['sd', 'xl', 'flux', 'all']
        const inputs = document.querySelectorAll('input[type=radio]')
        for (const input of inputs) {
            const own = ((input.parentElement && input.parentElement.textContent) || '').trim()
            if (own !== preset) continue
            const group = input.closest('fieldset') || (input.parentElement && input.parentElement.parentElement)
            if (!group) continue
            const labels = Array.from(group.querySelectorAll('input[type=radio]')).map(
                (radio) => ((radio.parentElement && radio.parentElement.textContent) || '').trim(),
            )
            if (CHOICES.every((choice) => labels.includes(choice))) return input
        }
        return null
    }

    // Select the checkpoint, and put the UI on its architecture.
    //
    // The radio is not what fills the checkpoint dropdown — `on_preset_change`
    // does not even list it among its outputs. What it controls is which
    // controls Forge shows and what it defaults them to: on `xl` the clip-skip
    // slider and the VAE picker are hidden, which is wrong for an SD1.5 block
    // that specifies both.
    //
    // It runs *before* the paste, and that order is the point. The same
    // callback resets width, height, CFG, sampler, scheduler and clip skip to
    // the preset's defaults — 512x640 and Euler a for `sd`. Moving the radio
    // after a paste would throw away the settings that just arrived, leaving
    // something that looks pasted and generates at the wrong size. Pasting
    // last means the block overwrites those defaults.
    //
    // None of this makes the dropdown *display* the checkpoint. That value is
    // read once when Gradio builds the page, so a checkpoint set afterwards
    // shows as blank until a reload — while being the model that generates.
    function applyCheckpoint(params) {
        const name = settingsField(params, 'Model')
        if (!name) return Promise.resolve()

        return send('checkpoint', name).then((result) => {
            const preset = result && result.preset
            if (!preset) return
            // `all` shows every control for every architecture, so it is never
            // the wrong setting — and someone sitting on it chose it. Moving
            // off it to a narrower preset hides controls they went looking for:
            // clip skip is not shown under `xl`, which is exactly why a person
            // switches to `all` in the first place.
            const current = presetRadio('all')
            if (current && current.checked) {
                console.log('[luma-vault] UI is on "all"; leaving it')
                return
            }
            const radio = presetRadio(preset)
            if (!radio) {
                console.warn('[luma-vault] no UI preset radio found; leaving it as it is')
                return
            }
            if (radio.checked) return
            radio.click()
            console.log('[luma-vault] UI preset -> %s', preset)
            // Gradio round-trip. The paste that follows re-fills everything
            // this reset just cleared.
            return new Promise((resolve) => setTimeout(resolve, 900))
        })
    }

    // After the paste: `on_preset_change` forces the VAE back to Automatic, so
    // setting it earlier would be undone.
    function applyVae(params) {
        const name = settingsField(params, 'VAE')
        if (name) send('vae', name)
    }

    function syncToggles(params) {
        for (const toggle of TOGGLES) {
            const box = document.querySelector('#' + toggle.id + ' input[type=checkbox]')
                || document.getElementById(toggle.id)
            if (!box || box.type !== 'checkbox') continue

            const wanted = toggle.mentions.test(params)
            if (wanted && toggle.confirm && !toggle.confirm()) {
                console.warn(
                    '[luma-vault] %s is in the parameters but its settings did not paste — ' +
                    'leaving it off rather than running it with defaults',
                    toggle.id,
                )
                continue
            }
            if (box.checked !== wanted) {
                box.click()
                console.log('[luma-vault] %s -> %s', toggle.id, wanted ? 'on' : 'off')
            }
        }
    }

    // Poll until the paste round-trip completes, then run `then`.
    //
    // The observable signal is the prompt box: Forge replaces the whole block
    // with just the positive prompt once it has parsed it. When "Negative
    // prompt:" has gone from the textarea, the response has landed and the
    // components have re-rendered.
    //
    // Gives up after ~8s and syncs anyway — a toggle set late beats one never
    // set, and the log says which happened.
    function whenPasteLands(prompt, then) {
        let waited = 0
        const timer = setInterval(() => {
            waited += 150
            const consumed = prompt.value.indexOf('Negative prompt:') === -1
            if (consumed || waited > 8000) {
                clearInterval(timer)
                console.log(
                    '[luma-vault] paste ' +
                    (consumed
                        ? 'landed after ' + waited + 'ms'
                        : 'NOT confirmed after 8s, syncing anyway'),
                )
                // One more tick so the re-render has finished painting.
                setTimeout(then, 150)
            }
        }, 150)
    }

    function prefill(params) {
        const prompt = document.querySelector('#txt2img_prompt textarea')
        const button = pasteButton()
        if (!prompt || !button) return false

        // Extension-owned fields — ADetailer, ControlNet — register their paste
        // handlers as their accordions are built, which happens after the
        // prompt box exists. Firing as soon as the textarea appears finds only
        // core fields registered, and the block's ADetailer settings are
        // silently dropped. Waiting for the accordion is the signal that those
        // handlers are in place.
        const extensionsReady = document.querySelector('#txt2img_script_container')

        setTextarea(prompt, params)
        // The checkpoint goes first and the paste waits for it — see
        // `applyCheckpoint`, which may reset half the generation settings on
        // the way. Everything after this point overwrites those defaults.
        void applyCheckpoint(params).then(() =>
        setTimeout(
            () => {
                setTextarea(prompt, params)
                button.click()
                console.log(
                    '[luma-vault] pasted %d chars, scripts container %s',
                    params.length,
                    extensionsReady ? 'present' : 'MISSING at paste time',
                )
                // Wait for the paste to actually land before touching anything.
                //
                // Gradio's paste is a server round-trip: the click posts to
                // /queue/join and the components re-render when the response
                // arrives. Syncing on a fixed delay races that, and the
                // re-render silently undoes it — which is what a 400ms guess
                // did, while a stub test containing no round-trip passed.
                whenPasteLands(prompt, () => {
                    syncToggles(params)
                    applyVae(params)
                })
            },
            // Longer when the scripts container is not up yet: there is nothing
            // to lose by waiting, and everything to lose by pasting early.
            extensionsReady ? 120 : 600,
        ))
        return true
    }

    function start() {
        const params = takeParams()
        if (!params) return

        // The UI builds progressively and the toolbar can arrive after the
        // prompt box. Retry briefly rather than firing once into an empty page.
        let attempts = 0
        const timer = setInterval(() => {
            attempts += 1
            // Hold out for the scripts container for a few seconds before
            // settling for whatever is present.
            const ready =
                document.querySelector('#txt2img_script_container') || attempts > 12
            if ((ready && prefill(params)) || attempts > 40) clearInterval(timer)
        }, 250)
    }

    if (typeof onUiLoaded === 'function') onUiLoaded(start)
    else window.addEventListener('load', start)
})()
