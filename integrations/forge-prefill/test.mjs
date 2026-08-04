// Tests for the Forge prefill extension.  `node integrations/forge-prefill/test.mjs`
//
// The extension runs inside Forge, which is a heavy thing to start and cannot be
// scripted from here. Its *logic* needs neither: reading the fragment, deciding
// which toggles the block implies, and refusing to enable ADetailer whose
// settings did not arrive are all decisions about a string and a few elements.
//
// Written after shipping three fixes that were each verified by asking someone
// else to click the button.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, 'javascript', 'luma_prefill.js'), 'utf8')

// --- the file is what it looks like ---------------------------------------
//
// This shipped once containing six literal 0x08 bytes where regex word
// boundaries were meant to be, because the edit that wrote it went through a
// layer that ate one backslash. Every toggle rule then matched nothing, and it
// was invisible: editors, `sed` and diffs all render a backspace as nothing at
// all, so the file *looked* correct in every tool used to check it.
//
// Cheap to assert, and it fails loudly instead of silently doing nothing.
{
    const control = [...source]
        .map((ch, index) => [ch.codePointAt(0), index])
        .filter(([code]) => code < 32 && code !== 10 && code !== 13 && code !== 9)
    assert.deepEqual(
        control,
        [],
        `the source contains ${control.length} stray control characters — ` +
            'almost certainly a mangled escape that renders as nothing',
    )
    console.log('ok  source is free of stray control characters')
}

/** The handful of elements the extension touches, and nothing else. */
function makeDom({ hash, adetailerModel = '', scriptsContainer = true, toggles = {}, preset = null }) {
    const logs = []
    const clicks = []

    // Forge's `sd | xl | flux | all` radio group, which has no elem_id and is
    // found by its choices. `preset` is the one currently selected.
    const radios = preset
        ? ['sd', 'xl', 'flux', 'all'].map((choice) => {
              const input = {
                  type: 'radio',
                  checked: choice === preset,
                  click() {
                      this.checked = true
                      clicks.push('preset:' + choice)
                  },
              }
              input.parentElement = { textContent: choice, parentElement: null }
              input.closest = () => group
              return input
          })
        : []
    const group = { querySelectorAll: () => radios }
    for (const radio of radios) radio.parentElement.parentElement = group

    const checkbox = (id, checked) => ({
        id,
        type: 'checkbox',
        checked,
        click() {
            this.checked = !this.checked
            clicks.push(id)
        },
    })

    const elements = {
        '#txt2img_prompt textarea': { value: '', dispatched: [], tagName: 'TEXTAREA' },
        '#txt2img_tools': { querySelector: () => elements['#paste'] },
        // Forge's paste is a server round-trip, and when it returns it replaces
        // the whole block in the prompt box with just the positive prompt.
        // The stub has to do that too: the extension waits for exactly this to
        // know the components have re-rendered, and a stub that skipped it let
        // a fixed-delay race pass the tests while failing in the real app.
        '#paste': {
            click: () => {
                clicks.push('paste')
                const box = elements['#txt2img_prompt textarea']
                box.value = String(box.value).split('\n')[0]
            },
        },
        '#txt2img_script_container': scriptsContainer ? {} : null,
        '#script_txt2img_adetailer_ad_model input, #script_txt2img_adetailer_ad_model select':
            { value: adetailerModel },
        'input[type=radio]': radios,
    }
    for (const [id, checked] of Object.entries(toggles)) {
        elements[`#${id} input[type=checkbox]`] = checkbox(id, checked)
    }

    const textarea = elements['#txt2img_prompt textarea']
    const typed = []
    textarea.dispatchEvent = (event) => {
        textarea.dispatched.push(event.type)
        typed.push(textarea.value)
    }

    const document = {
        querySelector: (selector) => elements[selector] ?? null,
        querySelectorAll: (selector) => elements[selector] ?? [],
        getElementById: (id) => elements[`#${id} input[type=checkbox]`] ?? elements[`#${id}`] ?? null,
    }

    const window = {
        location: { hash, pathname: '/', search: '' },
        history: { replaceState: (_a, _b, url) => (window.location.replaced = url) },
        addEventListener: () => {},
        HTMLTextAreaElement: { prototype: {} },
    }

    return { window, document, logs, clicks, elements, textarea, typed, fetches: [] }
}

async function run(dom, { tick }) {
    const timers = []
    const context = vm.createContext({
        window: dom.window,
        document: dom.document,
        URLSearchParams,
        Event: class { constructor(type) { this.type = type } },
        Object,
        Boolean,
        console: {
            log: (...args) => dom.logs.push(args.join(' ')),
            warn: (...args) => dom.logs.push('WARN ' + args.join(' ')),
        },
        setTimeout: (fn) => timers.push(fn),
        setInterval: (fn) => { timers.push(fn); return 1 },
        clearInterval: () => {},
        onUiLoaded: (fn) => fn(),
        JSON,
        // The checkpoint and VAE are set over HTTP, because Forge's paste
        // cannot set them. Captured rather than sent.
        fetch: (url, options) => {
            dom.fetches.push({ url, body: JSON.parse(options.body) })
            return Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve({ preset: 'sd' }),
            })
        },
    })
    vm.runInContext(source, context)
    // Drain the timers the extension queued, `tick` rounds deep.
    for (let round = 0; round < tick; round += 1) {
        const pending = timers.splice(0, timers.length)
        for (const fn of pending) fn()
        // The extension sets the checkpoint over HTTP before pasting, so the
        // paste is queued from a promise callback. Draining timers without
        // yielding never reaches it.
        await new Promise((resolve) => setImmediate(resolve))
    }
}

const BLOCK_WITH_ADETAILER =
    'a girl by a pool\nNegative prompt: lowres\n' +
    'Steps: 30, Sampler: DPM++ 2M, Seed: 2582348948, ADetailer model: face_yolov8n.pt'
const BLOCK_PLAIN = 'a girl by a pool\nNegative prompt: lowres\nSteps: 30, Seed: 1'

// --- the fragment, not the query string ------------------------------------
{
    const dom = makeDom({ hash: `#luma_params=${encodeURIComponent(BLOCK_PLAIN)}` })
    await run(dom, { tick: 12 })
    assert.ok(dom.typed.includes(BLOCK_PLAIN), 'the whole block reached the prompt box')
    assert.ok(dom.textarea.dispatched.includes('input'), 'Gradio is told the value changed')
    assert.ok(dom.clicks.includes('paste'), "Forge's own parser is invoked")
    console.log('ok  reads the block from the fragment and presses paste')
}

// --- a page opened without params is left alone ----------------------------
{
    const dom = makeDom({ hash: '' })
    await run(dom, { tick: 12 })
    assert.equal(dom.textarea.value, '', 'nothing typed')
    assert.deepEqual(dom.clicks, [], 'nothing clicked')
    console.log('ok  does nothing when opened normally')
}

// --- the fragment is consumed, so a refresh does not re-paste --------------
{
    const dom = makeDom({ hash: `#luma_params=${encodeURIComponent(BLOCK_PLAIN)}` })
    await run(dom, { tick: 12 })
    assert.ok(
        !String(dom.window.location.replaced ?? '').includes('luma_params'),
        'the parameter is cleared from the address bar',
    )
    console.log('ok  clears the fragment after using it')
}

// --- stale toggles are switched off ---------------------------------------
{
    // Hires left on from an earlier session; this block says nothing about it.
    const dom = makeDom({
        hash: `#luma_params=${encodeURIComponent(BLOCK_PLAIN)}`,
        toggles: { 'txt2img_hr-checkbox': true, 'txt2img_enable-checkbox': true },
    })
    await run(dom, { tick: 12 })
    assert.equal(
        dom.elements['#txt2img_hr-checkbox input[type=checkbox]'].checked,
        false,
        'Hires fix is turned off when the parameters do not mention it',
    )
    assert.equal(
        dom.elements['#txt2img_enable-checkbox input[type=checkbox]'].checked,
        false,
        'Refiner likewise',
    )
    console.log('ok  turns off Hires and Refiner the block never asked for')
}

// --- ADetailer is enabled only once its settings actually arrived ----------
{
    const dom = makeDom({
        hash: `#luma_params=${encodeURIComponent(BLOCK_WITH_ADETAILER)}`,
        adetailerModel: 'face_yolov8n.pt', // paste landed
        toggles: { 'script_txt2img_adetailer_ad_main_accordion-checkbox': false },
    })
    await run(dom, { tick: 12 })
    assert.equal(
        dom.elements['#script_txt2img_adetailer_ad_main_accordion-checkbox input[type=checkbox]']
            .checked,
        true,
        'enabled when the detector shows the pasted model',
    )
    console.log('ok  enables ADetailer once its settings have landed')
}

{
    const dom = makeDom({
        hash: `#luma_params=${encodeURIComponent(BLOCK_WITH_ADETAILER)}`,
        adetailerModel: '', // paste did not reach it
        toggles: { 'script_txt2img_adetailer_ad_main_accordion-checkbox': false },
    })
    await run(dom, { tick: 12 })
    assert.equal(
        dom.elements['#script_txt2img_adetailer_ad_main_accordion-checkbox input[type=checkbox]']
            .checked,
        false,
        'NOT enabled with default settings — that would run a different refinement and look like success',
    )
    assert.ok(
        dom.logs.some((line) => line.startsWith('WARN')),
        'and it says so rather than failing quietly',
    )
    console.log('ok  refuses to enable ADetailer whose settings did not paste')
}

// The checkpoint and the VAE, which the paste cannot carry.
//
// This is the failure that looks most like success: every field fills in, the
// image generates, and it came from whatever model was already loaded. Worse
// when the block is SD1.5 and the loaded model is SDXL — the block's VAE gets
// applied to the wrong architecture and the output is rainbow noise.
{
    // The real settings line from 00166-3997412987.png, which is the awkward
    // case: `Model hash` appears *before* `Model`, `VAE hash` before `VAE`, and
    // `ADetailer model` after both.
    const REAL =
        'a girl\nNegative prompt: lowres\n' +
        'Steps: 50, Sampler: DPM++ 2M Karras, CFG scale: 7, Seed: 3997412987, ' +
        'Size: 660x990, Model hash: a1ff10e2dc, Model: aniversev20-revAnimatedv122-50p-hll3vtubers, ' +
        'VAE hash: 42a404c885, VAE: vae-ft-mse-840000-ema-pruned.safetensors, ' +
        'Denoising strength: 0.4, Clip skip: 2, ADetailer model: face_yolov8n.pt, ' +
        'Hires upscale: 2, Hires upscaler: 4xUltrasharp_4xUltrasharpV10'
    const dom = makeDom({ hash: `#luma_params=${encodeURIComponent(REAL)}` })
    await run(dom, { tick: 12 })

    const sent = Object.fromEntries(dom.fetches.map((f) => [f.url, f.body.name]))
    assert.equal(
        sent['/luma/v1/checkpoint'],
        'aniversev20-revAnimatedv122-50p-hll3vtubers',
        'the checkpoint is taken from `Model`, not from `Model hash` or `ADetailer model`',
    )
    assert.equal(
        sent['/luma/v1/vae'],
        'vae-ft-mse-840000-ema-pruned.safetensors',
        'and the VAE from `VAE`, not `VAE hash`',
    )
    console.log('ok  sets the checkpoint and VAE the block names')
}

{
    // A merge keeps its recipe as its name, parentheses, spaces and all. A
    // parser that splits the settings line on commas truncates this one at
    // "0.7(aniverse_v20HDPruned) + 0.3(hll3vtubers-last-pruned)" — which is
    // not a checkpoint anyone has, so the switch fails and the old model stays.
    const MERGE =
        'a girl\nNegative prompt: lowres\n' +
        'Steps: 50, Model: 0.7(aniverse_v20HDPruned) + 0.3(hll3vtubers-last-pruned), Clip skip: 2'
    const dom = makeDom({ hash: `#luma_params=${encodeURIComponent(MERGE)}` })
    await run(dom, { tick: 12 })
    assert.equal(
        dom.fetches.find((f) => f.url === '/luma/v1/checkpoint').body.name,
        '0.7(aniverse_v20HDPruned) + 0.3(hll3vtubers-last-pruned)',
        'a model name containing spaces and parentheses survives intact',
    )
    console.log('ok  keeps a merge recipe name whole')
}

{
    // A block naming neither must not touch the loaded model.
    const dom = makeDom({ hash: `#luma_params=${encodeURIComponent(BLOCK_PLAIN)}` })
    await run(dom, { tick: 12 })
    assert.deepEqual(dom.fetches, [], 'nothing named, nothing switched')
    console.log('ok  leaves the model alone when the block does not name one')
}

// --- the preset switch happens before the paste, not after -----------------
//
// Forge's `on_preset_change` resets width, height, CFG, sampler, scheduler and
// clip skip to the preset's defaults — 512x640 and Euler a for `sd`. So the
// radio has to move BEFORE the paste. The other way round, every setting in
// the block is silently replaced by those defaults, and the result looks
// pasted while generating at the wrong size with the wrong sampler.
{
    const REAL =
        'a girl\nNegative prompt: lowres\n' +
        'Steps: 50, Model: aniversev20-revAnimatedv122-50p-hll3vtubers, Clip skip: 2'
    // Sitting on `xl` while the block wants an SD1.5 checkpoint.
    const dom = makeDom({ hash: `#luma_params=${encodeURIComponent(REAL)}`, preset: 'xl' })
    await run(dom, { tick: 12 })

    assert.ok(dom.clicks.includes('preset:sd'), "the UI moves to the checkpoint's architecture")
    assert.ok(
        dom.clicks.indexOf('preset:sd') < dom.clicks.indexOf('paste'),
        'and it moves BEFORE the paste, or the reset would wipe the pasted settings',
    )
    console.log('ok  switches the UI preset before pasting, not after')
}

{
    // Already on the right one, where a click would reset the settings for
    // nothing at all.
    const REAL = 'a girl\nNegative prompt: lowres\nSteps: 50, Model: some-model, Clip skip: 2'
    const dom = makeDom({ hash: `#luma_params=${encodeURIComponent(REAL)}`, preset: 'sd' })
    await run(dom, { tick: 12 })
    assert.ok(
        !dom.clicks.some((click) => click.startsWith('preset:')),
        'an unnecessary preset click is avoided — it would reset size and sampler',
    )
    assert.ok(dom.clicks.includes('paste'), 'and the paste still happens')
    console.log('ok  leaves the preset alone when it already matches')
}

{
    // `all` shows every control there is, so it is never wrong — and someone
    // sitting on it put it there deliberately, usually to reach clip skip,
    // which `xl` hides. Switching them off it takes away the control they went
    // looking for and resets width, height and CFG on the way out.
    const REAL = 'a girl\nNegative prompt: lowres\nSteps: 28, Model: perfectdeliberate_v10, Clip skip: 2'
    const dom = makeDom({ hash: `#luma_params=${encodeURIComponent(REAL)}`, preset: 'all' })
    await run(dom, { tick: 12 })
    assert.ok(
        !dom.clicks.some((click) => click.startsWith('preset:')),
        'a UI left on "all" is left alone',
    )
    assert.ok(dom.clicks.includes('paste'), 'and the paste still happens')
    console.log('ok  never switches away from the "all" preset')
}

console.log('\nall extension tests passed')
