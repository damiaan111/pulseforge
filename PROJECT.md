# Project: **Pulseforge** *(working title)*
### Self-hosted, GPU-accelerated audio visualizer & music-video renderer

> Status: **Planning / foundation** — no code yet.
> Owner: Damiaan
> Last updated: 2026-09-14

---

## 1. Purpose

A desktop application that turns an audio file into a fully customized music video, rendered
locally on my own gaming PC using its CPU and GPU. It replaces web services like Vizzy and
Shimga: no accounts, no credits, no ad-block detection, no upload limits, no watermarks,
no render queue except my own.

**The five things that define success:**

1. **Deep customizability** — a layer/effect system that composes, not a gallery of fixed presets.
2. **True audio reactivity** — any audio feature, including *per-instrument stems*, can drive any parameter.
3. **Production-grade export** — deterministic offline rendering to 4K60 via NVENC, perfectly in sync.
4. **Auto-director** — analyse the track and generate a complete, editable project automatically.
5. **Lyrics & karaoke** — timed lyrics with word-level highlight, human-assisted rather than fake-automatic.

And one hard operational constraint that shapes every dependency choice:

6. **Self-contained and offline.** Clone the repo, run once with internet, and from then on it
   works forever with the network cable pulled. See §3.

### Visual direction
Three target aesthetics, which set the module build order:

1. **Neon / synthwave / glow** — saturated pinks and purples, heavy bloom, circular visualizers on dark backgrounds. The Shimga screenshot look.
2. **Minimal / clean / typographic** — restrained palettes, strong type, subtle motion, negative space. This one raises the stakes on the text engine: in a minimal composition, *type is the design*, and sloppy kerning or a font substitution is the whole frame.
3. **Photoreal / 3D / cinematic** — Three.js scenes, depth of field, camera moves, reactive geometry.

**Explicitly not a priority: psychedelic / MilkDrop chaos.** That's the one aesthetic not on the
list, which demotes the Butterchurn layer from an early Should-have to a Could-have — and
promotes 3D scene work correspondingly, since "cinematic" cannot be reached with 2D layers.

### Design north star
UI/UX modelled closely on **Shimga.app** (see reference screenshot): dark studio chrome, left
asset/preset rail, centre canvas preview, right properties inspector, bottom multi-track timeline.
That layout is proven, dense and immediately readable. We are not reinventing the UX.

---

## 2. Decisions already locked in

| Area | Decision |
|---|---|
| **Runtime** | **Electron** desktop app. Not a browser tab. |
| **Export** | Offline **deterministic** frame-by-frame render, piped to FFmpeg with **NVENC** hardware encoding. |
| **Lyrics** | Manual entry + **tap-to-sync** + optional local **forced alignment** for word timing; karaoke fill. |
| **Customization core** | **Layer system + effect stack**, **modulation matrix** (any audio feature → any parameter), and an **Auto mode**. |
| **Auto mode** | Full **auto-director** *plus* a seeded **"Surprise me"** randomiser. |
| **Effect sources** | Custom modular set (v1) + **Three.js 3D** (v1, promoted) + **Shadertoy/GLSL import** (v1.x) + **Butterchurn/MilkDrop** (deferred — not a target aesthetic). |
| **Dev/run split** | Planned on a non-NVIDIA laptop; built and run on the home PC. See §14 — it changes how testing and setup errors must work. |
| **Output formats** | MP4 only: H.264 8-bit + HEVC 10-bit master, all via NVENC. 1080p60, 4K60, 9:16, 1:1, custom. No alpha/ProRes/PNG-sequence — **no CPU encoder path at all**. |
| **Audio analysis** | FFT + configurable bands + onset/beat/BPM + RMS **+ stem separation (Demucs)** — stems are a v1 must-have. |
| **ML runtime** | **Portable embedded Python env**, provisioned at setup. Runs official Demucs *and* WhisperX. Capability over minimalism. |
| **Distribution** | Single repo, first-run setup downloads and pins all binaries/models/wheels, then **runs fully offline**. |
| **Target hardware** | Ryzen 7 + **RTX 3060 12 GB** (Ampere). See §4 for the performance envelope this implies. |

### Explicit non-goals
- No cloud, no accounts, no multi-user, no telemetry, no licensing server.
- Not a DAW. We do not edit or mix audio; we consume a rendered mix (stems are derived, not authored).
- Not a general video editor. No multi-clip video timeline editing.
- No mobile app.

---

## 3. Self-containment & offline operation

This is a **first-class requirement**, not packaging polish. It rules out any design that
phones home at runtime.

### The contract
1. `git clone` → `npm install` → `npm run setup` (one command, one time, needs internet).
2. Setup fetches **every** external artefact into a local `vendor/` folder, verifies each against a
   pinned SHA-256, and writes a lockfile recording exactly what was installed.
3. After that, the app launches, analyses, renders and exports **with zero network access**.
4. A `--verify-offline` mode (and a CI job) runs the full pipeline with networking disabled to
   prove the contract hasn't rotted.

### The ML sidecar — **decided: portable embedded Python**

Official Demucs and WhisperX, not ONNX conversions. Capability and model choice matter more
than install size here. The cost is a second runtime to manage; the payoff is the entire
Python audio-ML ecosystem available offline, with no model-conversion step standing between
a new upstream release and using it.

**Provisioning approach (the part that makes Python offline-safe):**

- **Portable interpreter**, not a system Python: a `python-build-standalone` distribution unpacked into `vendor/python/`. Never touches the machine's Python, never modifies PATH, uninstalls with `rm -rf`.
- **`uv`** as installer and resolver — fast, and produces a genuinely reproducible lockfile.
- **Vendored wheelhouse**: `uv pip compile --generate-hashes --only-binary :all:` produces the committed lock (`setup/python/requirements.lock.txt`); the vendored interpreter's `pip download --require-hashes` fills `vendor/wheelhouse/` from it (uv has no download command); `uv pip install --no-index --offline --find-links=vendor/wheelhouse` installs. The wheels stay on disk, so the env can be *rebuilt* offline later, not just used offline. This is the detail that usually gets skipped and is exactly what breaks a year from now.
- **Sidecar process, not a library**: Node spawns `vendor/python/python.exe -m pulseforge_ml …` and talks JSON-lines over stdio. The app never depends on Python being importable, and a crashed sidecar never takes the UI with it.
- **Health check at startup**: verify interpreter, torch CUDA availability and model files; if anything is missing, say precisely what and offer to re-run setup — never silently reach out.

### What setup has to fetch

| Artefact | Why | Approx size | Notes |
|---|---|---|---|
| FFmpeg + FFprobe (Windows, NVENC build) | decode, encode, mux | ~120 MB | Pinned build URL + checksum. LGPL build keeps licensing clean. **Keep the downloaded archive in `vendor/`** — upstream autobuild releases get pruned, so a pinned URL alone does not guarantee a rebuild. |
| Portable Python 3.11 | ML sidecar interpreter | ~40 MB | `python-build-standalone`, unpacked to `vendor/python/`. |
| PyTorch (CUDA build — pinned `cu130`, needs driver R580+) + deps | runs Demucs & WhisperX on the GPU | ~2.8 GB | The single biggest item. Must be the CUDA wheel, not CPU. |
| Demucs + `htdemucs_ft` weights | stem separation (best quality) | ~1 GB | `_ft` is 4 fine-tuned models — slower, noticeably cleaner. `htdemucs` (~320 MB) as the fast option. |
| `htdemucs_6s` weights | 6-stem: + guitar, piano | ~330 MB | Optional; trivial addition once the env exists. |
| WhisperX + faster-whisper (CTranslate2) | lyric transcription & alignment | ~200 MB | |
| Whisper `large-v3` (CT2, float16) | transcription quality | ~3.1 GB | `medium` (~1.5 GB) offered as the lighter choice. |
| wav2vec2 alignment models | word-level timing per language | ~360 MB each | Fetch per language actually used. |
| Bundled fonts | text/lyrics layers | ~20 MB | Open-licence only (SIL OFL / Apache). |
| Starter asset pack | backgrounds, LUTs, particle sprites | ~100 MB | Keeps the repo light; lives in `vendor/assets/`. |
| MilkDrop preset pack | Butterchurn layer | ~50 MB | Optional. |

**Full download ≈ 8–9 GB. On disk, budget ≈ 13–15 GB**: the vendored wheelhouse keeps the torch
wheels (~2.8 GB) *and* the installed env holds them unpacked (roughly twice that). Still inside
the 30 GB ceiling; P0 replaces this estimate with a measured figure. Setup still offers tiers —
not to save space, but so the first run isn't a 9 GB wait before you can look at anything:

| Tier | Contents | Approx download |
|---|---|---|
| **core** | FFmpeg, fonts, starter assets | ~250–300 MB — editing works immediately |
| **stems** | portable Python, torch-CUDA wheelhouse, Demucs + `htdemucs` | ~3–3.5 GB (`htdemucs_ft` / `6s` on demand) |
| **lyrics** | WhisperX, Whisper `medium` (`large-v3` on demand), wav2vec2 per language | ~2 GB+ |
| **extras** | MilkDrop presets, optional models | varies |

Core gets you editing immediately while the rest downloads in the background.

**Secondary benefit worth noting:** once a real Python env is present, `librosa` and `madmom`
become available for beat-tracking, key and chord detection. That makes several Could-haves
nearly free later — but the core FFT/band/onset analysis still stays in TypeScript, because
the engine's determinism contract depends on it being fast, synchronous and always present.

### Rules this imposes on the codebase
- **No runtime CDN links.** No Google Fonts, no remote shader/preset fetches, no update checks. All assets resolved from `vendor/` or the user's disk.
- **No implicit downloads.** If something is missing, the app says exactly what is missing and offers to run setup — it never silently reaches out.
- **Setup is resumable and re-runnable**, verifies checksums, and can repair a partial install.
- **Everything version-pinned**, including the FFmpeg build, so a render made today reproduces next year.
- **Vendored binaries are invoked by absolute path, never resolved from `PATH`.** A system-wide `ffmpeg` or `python` (common on dev machines) must never be picked up by accident — that silently breaks reproducibility.
- **`LICENSES.md` is generated by setup**, listing every fetched artefact and its licence.

---

## 4. Target hardware & performance envelope

**Ryzen 7 · RTX 3060 12 GB (Ampere, GA106) · Windows 11.** The app should still run elsewhere,
but this is the machine it is tuned for, and several decisions fall directly out of it.

### What the GPU can and cannot do

| Capability | Verdict |
|---|---|
| **NVENC H.264** | Yes — 7th-gen encoder. The default export codec. |
| **NVENC HEVC (H.265)** | Yes, including 10-bit and 4:4:4. The quality option for 4K. |
| **NVENC AV1** | **No.** AV1 *encode* requires Ada (RTX 40-series) or newer. The 3060 does AV1 *decode* only. Probe for it and hide the option rather than offering a codec that fails at render time. |
| **Concurrent NVENC sessions** | Not a constraint — the render queue is sequential by design. |
| **CUDA for torch** | Yes. Demucs and WhisperX both run on-GPU. |
| **VRAM** | 12 GB — generous for this workload, but see the contention note below. |

### VRAM contention — the one real constraint
Three things want this GPU: the WebGL2 renderer, Demucs, and WhisperX. Rough budgets:

- **4K60 rendering** with a deep layer/effect stack: ~1–2 GB (each 4K RGBA16F target is ~66 MB, and ping-pong buffers multiply that fast).
- **Demucs `htdemucs_ft`**: ~4–7 GB depending on segment length.
- **WhisperX `large-v3` (float16)**: ~4–6 GB.

Any two of those fit; all three at once will not. **Therefore: serialise GPU-heavy jobs.**
A single global GPU job queue in the shell process, with the renderer holding priority
(it's the interactive one) and ML tasks yielding to it. Expose `segment` / batch-size settings
so a user on 6 GB isn't dead in the water, and free the torch model between jobs rather than
keeping it warm.

### Realistic performance expectations (to validate in P0, not to trust on paper)
- **Stem separation**, `htdemucs_ft`, 4-minute track: roughly 1–2 minutes on this GPU. Plain `htdemucs` is ~4× faster at slightly lower quality — make it the default, `_ft` the "final render" option.
- **WhisperX transcribe + align**, 4-minute vocal stem, `large-v3`: roughly 30–60 seconds.
- **1080p60 export**: should comfortably exceed realtime on moderate projects — the shader work, not NVENC, is the bottleneck.
- **4K60 export**: 4× the fragment cost. Expect below realtime on heavy stacks. This is exactly why the renderer is offline and deterministic — slow is fine, dropped frames are not.
- **Readback bandwidth**: 4K RGBA at 60 fps is ~2 GB/s over PCIe. Well within budget, *provided* readback is asynchronous. Synchronous `glReadPixels` will dominate the frame time — measure it in P0.

### Sizing implications
Design every GPU-side buffer allocation to be configurable and to fail loudly, not silently
degrade. A 12 GB card is comfortable today; the code shouldn't assume it.

---

## 5. Architecture

Three cleanly separated concerns. This separation is the single most important architectural
decision, because it is what makes deterministic export possible.

```
┌──────────────────────────────────────────────────────────────────────┐
│  SHELL  (Electron main process)                                      │
│  file dialogs • project I/O • FFmpeg/FFprobe child processes         │
│  render job queue • GPU/codec capability probe • settings • setup    │
└───────────────▲──────────────────────────────────┬───────────────────┘
                │ IPC                              │ spawn
┌───────────────┴──────────────────┐   ┌───────────▼───────────────────┐
│  STUDIO UI  (renderer process)   │   │  ANALYSIS WORKERS             │
│  React + TypeScript              │   │  decode → PCM → FFT frames    │
│  timeline • inspector • assets   │   │  bands • onsets • BPM • RMS   │
│  live preview (throttled)        │   │  STEM SEPARATION (GPU)        │
│                                  │   │  → per-stem analysis          │
│                                  │   │  writes AnalysisCache (.bin)  │
└───────────────┬──────────────────┘   └───────────────────────────────┘
                │ reads
┌───────────────▼──────────────────────────────────────────────────────┐
│  ENGINE  (pure, headless-capable, no DOM assumptions)                │
│  ProjectDocument + AnalysisCache + time t  →  one deterministic frame │
│  WebGL2 renderer • layer compositor • effect chain • modulation eval  │
└──────────────────────────────────────────────────────────────────────┘
```

### The determinism contract (non-negotiable)

> `renderFrame(project, analysis, t)` must produce **byte-identical output** for the same
> inputs, on every call, independent of wall-clock time, frame rate, or system load.

Consequences that must be enforced from the very first commit:

- **No `Date.now()`, no `performance.now()`, no rAF delta** anywhere inside the engine. Time is a parameter, always.
- **No `Math.random()`.** All randomness comes from a seeded PRNG stored in the project; particles and randomisers derive from `hash(seed, layerId, index)`.
- **Stateful simulations must be reproducible.** Particle systems either (a) are a pure function of `t`, or (b) step at a fixed internal timestep from `t=0` and can be deterministically fast-forwarded/checkpointed on seek.
- **Audio data comes from the pre-computed AnalysisCache**, never from a live `AnalyserNode`. Preview and export read the exact same numbers.

Preview is therefore just "the engine, called at whatever rate the screen manages, at reduced
resolution". Export is "the engine, called at exactly `n/fps`, at full resolution". One renderer,
no divergence between what you see and what you get.

### Data flow for an export
```
project.pvproj + audio.wav
        │
        ├─► AnalysisCache   (computed once, cached on disk, keyed by audio hash)
        │     ├─ mix: spectrum, bands, rms, onsets, beat grid
        │     └─ stems: drums / bass / vocals / other → same feature set each
        │
        └─► for n in 0..totalFrames:
                engine.renderFrame(t = n / fps)  →  GPU framebuffer
                async PBO readback               →  raw RGBA
                write to ffmpeg stdin ───────────────────────────────┐
                                                                     ▼
              ffmpeg -f rawvideo … -i pipe:0 -i audio.wav -c:v h264_nvenc -c:a aac out.mp4
```

---

## 6. Tech stack (proposed)

| Layer | Choice | Why |
|---|---|---|
| Shell | **Electron** | Bundles Chromium → identical WebGL2 behaviour in dev and prod; trivial FFmpeg bundling. Tauri is lighter but delegates rendering to the system WebView, breaking "same pixels everywhere". |
| UI | **React 18 + TypeScript** | Complex inspector/timeline UI, best tooling. |
| State | **Zustand + Immer** with a command/undo stack | Undo/redo is mandatory; model every mutation as a command. |
| Styling | **Tailwind + Radix primitives** | Dense studio UI fast; accessible sliders/menus for free. |
| Rendering | **WebGL2** directly, **Three.js** for 3D layers | Full control of compositor and readback. WebGPU is a future path, not v1. |
| Timeline | Custom canvas-drawn timeline | DOM timelines die at thousands of keyframes/waveform samples. |
| Audio decode | FFmpeg → PCM; `OfflineAudioContext` for resampling | FFmpeg handles every format including FLAC/Opus/M4A. |
| Analysis | TypeScript in Workers; hot loops in **WASM** if profiling demands | Only optimise when measured. |
| ML sidecar | **Portable Python 3.11 + PyTorch CUDA**, spawned as a stdio JSON-lines subprocess | Official Demucs + WhisperX, no conversion step; isolated from the app so a crash can't take the UI down. See §3. |
| Encoding | **FFmpeg** `h264_nvenc` / `hevc_nvenc` — no CPU encoder (D5) | Hardware encode on the RTX. No AV1 encode on Ampere — probe and hide. |
| Packaging | electron-builder (NSIS) + `npm run setup` | One-click install, one-command provisioning. |
| Testing | Vitest + golden-frame image diffs | Golden frames are how the determinism contract gets enforced in CI. |

---

## 7. Core data model

### `ProjectDocument` (the `.pvproj` file — JSON, versioned, human-diffable)

```
ProjectDocument
├─ schemaVersion, id, name, createdAt, modifiedAt
├─ seed                      ← master PRNG seed ("Surprise me" rolls this)
├─ canvas { width, height, fps, aspectPreset, backgroundColor }
├─ audio  { path, hash, durationMs, offsetMs, gain, stemsEnabled }
├─ analysisSettings { fftSize, bandDefinitions[], onsetSensitivity, bpmOverride?, stemModel }
├─ palette { colors[], role assignments }     ← reskin the whole project in one click
├─ layers[]                  ← ordered, bottom→top
│   └─ Layer
│      ├─ id, name, type, enabled, locked, soloed
│      ├─ timeRange { inMs, outMs }           ← layers scoped to song sections
│      ├─ transform { x, y, scale, rotation, anchor, skew }
│      ├─ blendMode, opacity, maskLayerId?
│      ├─ params { … module-specific, schema-declared … }
│      ├─ effects[]           ← ordered post-process chain on this layer
│      └─ modulations[]       ← bindings targeting any param path on this layer
├─ globalEffects[]            ← post chain on the final composite
├─ globalModulations[]
├─ lyrics { source, lines[], style, karaokeStyle }
├─ automation[]               ← keyframe tracks (Should-have; schema slot reserved in v1)
└─ exportPresets[]
```

### `AnalysisCache` (sidecar binary, regenerated if audio hash or settings change)
Per-frame-time arrays at a fixed analysis rate (proposal: 240 Hz, interpolated on read so any
fps works), stored **once for the mix and once per stem**:

`spectrum[bins]` · `bands[n]` · `rms` · `peak` · `onsetStrength` · `beatGrid[]` · `bpm` ·
`spectralCentroid` · `spectralFlux` · `stereoWidth` · `sectionBoundaries[]`

Stem tracks: **drums · bass · vocals · other** (6-stem model optional: + guitar, piano).
Stem separation runs once per track, GPU-accelerated, and is cached with everything else —
a few minutes of one-time cost that buys per-instrument reactivity forever.

### Module schema (drives the whole UI)
Every visualizer/effect module declares its parameters as data: name, type
(`float | int | bool | color | enum | vec2 | curve | asset`), range, default, unit, group, and
whether it is modulatable. **The inspector UI is generated from this schema.** Adding a new
effect = adding one module file; no UI code. This is what makes "lots of effects" sustainable
instead of a maintenance disaster.

---

## 8. Subsystem specifications

### 8.1 Audio analysis
- Decode via FFmpeg → mono + stereo PCM at 48 kHz.
- **Stem separation** (Demucs on GPU) → drums/bass/vocals/other WAVs, cached alongside the project.
- STFT per source: configurable FFT size (1024–8192), Hann window, hop ≈ 240 Hz.
- Log-frequency binning; user-definable bands (default: sub, bass, low-mid, mid, high-mid, presence, brilliance) with per-band gain, min/max Hz, attack/release smoothing.
- Onset detection via spectral flux + adaptive threshold; BPM via autocorrelation of the onset envelope; beat grid with tap-tempo and offset correction. **Beat detection runs on the drum stem**, which is dramatically more reliable than on a full mix.
- RMS/loudness envelope, peak, crest factor.
- Lightweight section segmentation from the energy/timbre novelty curve (feeds the auto-director).
- Cached to disk keyed by `sha256(audio)` + analysis settings — analysed once per track, ever.
- **Progress UX matters here:** stem separation takes minutes. Show a real progress bar, allow working on the project with mix-only features while stems finish in the background, and make it cancellable.

### 8.2 Layer types
`Visualizer` · `Image` · `Video` · `Text` · `Lyrics` · `Logo/Watermark` · `Shape` · `Particles` ·
`Shader (GLSL)` · `Scene3D (Three.js)` · `MilkDrop (Butterchurn)` · `Group` · `Adjustment`

### 8.3 Visualizer module catalogue (target set)
**2D:** bars (linear/log, mirrored, rounded, gradient) · circular/radial bars · waveform (line, filled, mirrored, oscilloscope) · spectrum curve · rings · pulse/orb · grid/matrix · dot field · polar spiral · terrain/mountain scroll · VU meters · spectrogram scroll.
**3D (Three.js):** reactive geometry (icosphere/torus/cube field) · audio-displaced plane/terrain · tunnel flight · point cloud · instanced bar city · reactive camera rig with beat-synced moves.
**Generative:** particle emitters (beat-triggered bursts, gravity, turbulence, trails) · flow fields · curl-noise fluid · lightning/arc · starfield.
**Imported:** Butterchurn/MilkDrop preset player · Shadertoy-style GLSL slot with audio uniforms bound.

### 8.4 Effect stack (per-layer and global)
Bloom/glow · blur (gauss/radial/directional) · chromatic aberration · RGB split · glitch/datamosh ·
displacement (audio- or texture-driven) · kaleidoscope/mirror · feedback/echo trails · pixelate ·
scanlines/CRT · film grain · vignette · levels/curves/HSV · LUT · edge detect · wave/ripple ·
motion blur (sub-frame accumulation on export) · zoom/rotate feedback · shake (beat-driven).

### 8.5 Modulation matrix — *the heart of the app*
> **Specified in detail in [docs/modulation-spec.md](docs/modulation-spec.md)** — binding model, source catalogue, signal chain, precomputed envelopes, musical time & look-ahead, auto-calibration, accumulation rules, UI, recipe cookbook.
A modulation binding:
```
{ source, target: "layers.<id>.params.scale", mode: add|multiply|replace,
  amount, offset, curve, attack, release, clamp, invert, band?, quantiseToBeat? }
```
**Sources:** any band of the mix **or of any individual stem** · RMS · peak · onset impulse ·
beat pulse with subdivisions (½, 1, 2, 4 bars) · BPM-locked LFO (sine/tri/saw/square/noise/S&H) ·
spectral centroid · time/progress ramp · lyric-active flag · random-per-beat · another
parameter's value (chaining) · MIDI/keyboard input (Could-have).

Stems make this qualitatively better: *particles burst on the kick, the background hue follows
the bassline, the glow pulses only on the vocal, the kaleidoscope spins on hi-hats* — each
isolated, none of them fighting each other for the same frequency range.

**UX:** right-click any slider → "Add modulation". The slider then shows a live moving ring/bar
of the modulated value against the base value. Bipolar amount, visual curve editor, per-binding
solo/bypass, and a matrix panel listing every binding in the project.

### 8.6 Auto-director + Surprise me
> **Specified in detail in [docs/auto-director-spec.md](docs/auto-director-spec.md)** — TrackDigest, StyleVector, template format, slot resolution, modulation calibration, arrangement, guardrails, decision log, reroll semantics, template authoring.
Pipeline: **analyse → classify → template → populate → arrange → hand over as a normal editable project.**

1. **Classify:** BPM, energy profile, spectral brightness, dynamic range, transient density, stereo width, and **stem presence** (is there a vocal? is it drum-led? is the bass dominant?) → a style vector.
2. **Template selection:** a library of hand-authored *director templates* (rule sets), each declaring which style vectors it suits, which layer archetypes it uses, and its palette strategy.
3. **Populate:** instantiate layers; auto-assign modulations to the *right stems* (kick→scale, vocal→glow, etc.) with amounts calibrated to this track's measured dynamics, so sensitivity is right without touching a slider; derive a palette from the background image, a chosen palette, or the style vector.
4. **Arrange:** use section boundaries and drops to schedule layer in/out times, palette shifts and effect intensity — so the video has structure instead of one static look for four minutes.
5. **Output is a plain project.** Nothing locked, nothing black-box. Every decision it made is a normal layer/modulation you can edit or delete.
6. **Surprise me:** rerolls `seed` and re-runs steps 2–4 with randomised but constrained template, palette and module choices. Lock toggles per aspect (keep palette, reroll layout…) and a history strip of the last N rolls so you can return to one you liked.

### 8.7 Lyrics & karaoke
> **Specified in detail in [docs/lyrics-spec.md](docs/lyrics-spec.md)** — data model, input routes, tap-to-sync with latency calibration, WhisperX alignment, karaoke fill modes, styling, validation, subtitle export.
- **Input:** paste plain text, import `.lrc` / `.srt` / `.vtt`, or type in the editor. Split into lines, optionally into words.
- **Tap-to-sync:** play the track and hit a key to stamp each line's start; second pass for line ends or word starts. Nudge/drag afterwards on the timeline with the waveform, beat grid **and the isolated vocal stem** visible — syncing against a solo'd vocal waveform is far easier than against a full mix.
- **Optional forced alignment:** local WhisperX/aeneas, run **on the separated vocal stem** (which is exactly the input those tools want, and raises accuracy substantially). Produces word-level timings in the same editable structure. Never a hard dependency, never trusted blindly — a first draft you correct.
- **Karaoke rendering:** word-fill sweep (colour wipes left→right across the active word/line), per-word pop/scale, bouncing-ball option, next-line preview, configurable lead-in and hold-out.
- **Styling:** local font picker, size, weight, letter spacing, line height, fill/stroke/shadow/glow, gradient fill, background plate, per-line alignment and position, entry/exit animations (fade, slide, typewriter, blur-in), and full modulation support — the text pulses on the beat like anything else.
- **Timeline track:** lyrics are a first-class timeline track with draggable line blocks, not a hidden text field.

### 8.8 Export
> **Specified in detail in [docs/export-spec.md](docs/export-spec.md)** — exact frame timing, readback strategy, encoder settings, colour management, audio reconciliation, motion blur, queue, failure handling, verification, cross-machine golden frames, and the P0 validation script.
- **Encoders:** `h264_nvenc` (default), `hevc_nvenc` (quality/10-bit). No CPU encoder (D5). Probe capabilities at startup and only show what the installed GPU/driver actually supports — no AV1 encode on Ampere; if NVENC is unavailable, export is disabled with a message saying why.
- **Quality:** CQ/bitrate control, preset (p1–p7), profile/level, pixel format, optional 10-bit.
- **Pipeline:** GPU render → async PBO readback (triple-buffered so readback never stalls the GPU) → raw frames to FFmpeg stdin → mux with original audio.
- **Extras:** render range (in/out), spatial supersampling (SSAA — MSAA does not survive the effect chain), optional temporal supersampling for motion blur, still-frame/thumbnail export. *(Alpha, ProRes, PNG sequences and GIF are out of scope — D5/W7.)*
- **UX:** progress with fps, ETA, frames done, live thumbnail; pause/cancel; a queue so several exports (landscape + vertical, say) run back to back overnight.
- **Presets:** YouTube 1080p60, YouTube 4K60, Shorts 1080×1920, Instagram 1080×1080, custom.

### 8.9 Studio UI (Shimga-inspired)
> **Specified in detail in [docs/ui-spec.md](docs/ui-spec.md)** — layout, canvas, timeline, inspector, panels, export dialog, first-run, shortcuts, state/undo, errors, performance.
- **Top bar:** New / Import / Undo / Redo / Save Preset / **Export Video**.
- **Left rail (tabs):** Presets · Audio (incl. stem status & solo) · Assets (background, quick colours, random background, logo/watermark).
- **Centre:** canvas preview with resolution badge, safe-area guides, zoom/fit, on-canvas transform handles, before/after toggle.
- **Right inspector (tabs):** Visualizer · Effects · Background · Text/Lyrics · Modulation · Auto.
- **Bottom:** transport (play/pause, prev/next marker, timecode, volume, zoom) + multi-track timeline: Audio (waveform + beat grid, expandable to per-stem waveforms) · Visualizer · Background · Text · Lyrics · Logo · Automation.
- **Throughout:** keyboard shortcuts, undo/redo everywhere, drag-drop onto the canvas, per-layer solo/mute/lock, reduced-resolution live preview with a "full quality" toggle.

### 8.10 Audio clip & timing model
One audio file per project, but not necessarily edge-to-edge:
- **Trim**: `clipIn` / `clipOut` points into the source file.
- **Fades**: fade-in and fade-out with adjustable length and curve, applied to the exported audio.
- **Lead-in / lead-out padding**: silence before and after the music, for a title card intro or a credits outro.

**Timeline time (`t`) is the master coordinate**, not audio-file time. The project timeline starts
at 0 = start of the video; audio maps into it at `leadInMs`, and every analysis lookup translates
through that offset. Getting this right once, at the bottom, avoids an entire class of
off-by-one-second sync bugs later. Analysis is still computed on the *source* file (so trimming
doesn't invalidate the cache) and indexed through the mapping on read.

*Not included:* multi-clip sequencing, and importing a video file for its audio — both are
Could-haves, neither is needed for "render a music video".

### 8.11 Layout & aspect system — *how one project exports to four shapes*
The naïve version of this ("just scale everything") produces vertical exports with the logo
half off-screen. The real design:

- **Relative coordinates + anchors.** A layer's transform is stored as a fraction of canvas size plus an anchor (9-point grid or custom). Scaling to any resolution is then trivially correct.
- **Scale reference.** Each layer declares whether its size follows canvas *width*, *height*, the *smaller* dimension, or *diagonal*. A logo that should stay the same physical size in both 16:9 and 9:16 follows the smaller dimension; a full-bleed background follows the larger.
- **Per-aspect overrides.** The core mechanism. A layer stores its base transform plus optional overrides keyed by aspect bucket (`16:9`, `9:16`, `1:1`, `4:5`, custom). Editing while a given aspect is active writes to that aspect's override; unedited properties inherit the base. The inspector shows clearly when a value is overridden, with a reset-to-base control.
- **Aspect switcher in the preview.** Flip between target aspects instantly to check the composition. Safe-area guides per platform.
- **Export writes every aspect from the one project**, each using its own overrides — so "make a Short of this" is a checkbox, not a duplicate project.
- **Reflow-aware modules.** Visualizers receive canvas aspect as an input, so e.g. a bar visualizer can use fewer, wider bars in vertical rather than 128 hairlines.

This costs real work in the transform system and the inspector, and it is the difference between
the multi-format promise being useful and being a lie.

### 8.12 Preview clock & A/V sync
A subtle one worth specifying up front, because the engine is deterministic but playback is not.

- **The Web Audio clock is the master.** During playback, the preview asks the audio context for the current position, converts to `t`, and renders that frame. The renderer never drives time.
- **Preview may drop frames; it may never drift.** If a frame takes too long, the next frame jumps to the correct `t` rather than advancing by one. Audio and visuals stay locked by construction.
- **Scrubbing** seeks the audio context and renders single frames on demand; optional scrub audio (short grains) can be toggled.
- **A dropped-frame / preview-fps indicator** so it's obvious when the preview is lying about the final result — and a reminder that export quality is unaffected, since export never uses this clock.

### 8.13 Text & lyric rasterisation
Text must look identical in preview and export, at any resolution.
- Render glyphs via canvas 2D to a texture atlas at the **target** resolution (not preview resolution), cached and keyed by (text, font, size, style).
- Never rely on DOM layout for positioning; measure and lay out explicitly.
- Fonts resolved from bundled `vendor/fonts/` and the user's installed fonts, recorded in the project by family + a hash so a missing font is reported rather than silently substituted (the classic way a project "changes" on another machine).
- Word-level metrics are required for karaoke fill, so per-word bounding boxes come out of layout, not guesswork.

### 8.14 Cache & storage management
Caches grow fast: analysis, stem WAVs, waveform peaks, glyph atlases, proxies. Roughly
50–150 MB per track, forever, silently.
- One predictable cache root, configurable, with per-project and global views.
- A panel showing size by category and by track, sorted biggest-first, with prune/clear actions and "keep the last N projects".
- LRU eviction with a configurable ceiling, plus a warning when the disk is running low.
- Caches are always **rebuildable** — deleting any of it must only ever cost time, never data. Nothing that can't be regenerated lives in the cache.

### 8.15 Diagnostics & render reports
What turns "the render looks wrong / is slow" from a mystery into a fix.
- Structured logs to disk with rotation; log level toggle; "open log folder" and "copy diagnostics" actions.
- **Per-render report** saved next to the output: project version, seed, resolution/fps/codec settings, FFmpeg command line, total and per-frame timings, per-layer GPU cost, VRAM high-water mark, warnings (dropped effects, missing fonts, clamped values). Reproducing a render a year later starts here.
- Startup environment report: GPU, driver, CUDA, torch, FFmpeg build, encoder capabilities, vendored artefact versions.
- Optional per-layer GPU timer queries surfaced in the performance HUD (S12).

### 8.16 Settings & preferences
Cache root and ceiling · default export presets · preview quality and resolution scale ·
default stem model and Whisper model · GPU device selection · temp/scratch directory ·
autosave interval · keyboard shortcut map · theme · log level · setup/repair entry point
(re-run provisioning, verify checksums, rebuild the Python env).

### 8.17 Module authoring & plugin folder
> **Specified in detail in [docs/module-spec.md](docs/module-spec.md)** — manifest, parameter types, value resolution order, render contract, versioning, presets, conformance tests, inspector generation.
The mechanism that makes the effect library grow without the codebase rotting.
- A module is a single file: a parameter schema, a shader or draw function, and metadata (name, category, tags, thumbnail). The inspector UI, preset serialisation and modulation targets all derive from the schema automatically.
- **`modules/` drop-in folder** scanned at startup, so adding an effect needs no rebuild.
- A documented authoring guide with a worked example, plus a template module to copy.
- A module conformance test: deterministic across repeated renders, resolution-independent, survives aspect changes, all params serialise round-trip. A module that fails is flagged in the UI rather than quietly producing non-reproducible exports.

---

## 9. Requirements — MoSCoW

### MUST HAVE (v1.0 — not shippable without these)

**Foundation**
- **M1** Desktop shell; project new/open/save/save-as; autosave + crash recovery; versioned `.pvproj` schema with migrations.
- **M2** **Self-contained setup**: one command provisions FFmpeg, models and assets into `vendor/` with checksum verification; app then runs fully offline. No runtime network calls anywhere.
- **M3** Audio import (mp3, wav, flac, m4a, ogg, opus) via FFmpeg; waveform display; transport with accurate seek.
- **M4** Analysis pipeline: FFT, configurable bands, RMS, onsets, BPM/beat grid; on-disk cache keyed by audio hash.
- **M5** **Stem separation (Demucs, GPU)** with per-stem feature extraction, cached; background processing with progress and cancel; graceful degradation to mix-only while it runs.
- **M6** **Deterministic engine contract** enforced from commit one: time as a parameter, seeded PRNG, no live audio node, golden-frame tests in CI.
- **M7** WebGL2 compositor: layer stack, blend modes, opacity, transform, render-to-texture per layer.
- **M8** Undo/redo command stack covering every project mutation.
- **M27** **ML sidecar lifecycle**: spawn/supervise/restart the Python process, JSON-lines protocol, structured progress events, cancellation, startup health check (interpreter + CUDA + model files present) with actionable errors.
- **M28** **Global GPU job queue** (§4): serialises renderer / Demucs / WhisperX so they never contend for VRAM; interactive rendering takes priority, ML jobs yield, models freed between jobs.

**Creative core**
- **M9** Layer system: add/delete/reorder/duplicate/rename/solo/mute/lock, per-layer time range.
- **M10** Schema-driven parameter system → auto-generated inspector UI.
- **M11** ≥10 core 2D visualizer modules (bars, circular, waveform, radial, particles, rings, pulse, mirrored, spectrum curve, grid).
- **M12** ≥10 effects (bloom, blur, chromatic aberration, glitch, kaleidoscope, feedback trails, pixelate, vignette, colour grade, shake).
- **M13** **Modulation matrix** with all core sources **including per-stem bands**, curves, attack/release, per-parameter binding UI with live value feedback.
- **M14** Background layer: solid, gradient, image, video, with fit modes and Ken Burns / audio-reactive movement.
- **M15** Logo/watermark layer: position, scale, opacity, reactive pulse.
- **M16** Text layer with full styling and animation.
- **M17** Global palette system — reskin a whole project in one action.
- **M29** **Audio clip model** (§8.10): trim in/out, fade in/out with curves, lead-in/lead-out padding, and a timeline-time master coordinate that all analysis lookups map through.
- **M30** **Layout & aspect system** (§8.11): relative coordinates, anchors, scale references, **per-aspect overrides**, aspect switcher in the preview, and multi-aspect export from one project.
- **M31** **Preview clock** (§8.12): audio as master clock, drop-frames-never-drift, scrubbing, dropped-frame indicator.
- **M32** **Deterministic text rasterisation** (§8.13) with per-word metrics for karaoke and explicit reporting of missing fonts. *Raised in importance by the minimal/typographic direction — in those compositions the type is the design.*
- **M37** *(promoted from S4)* **Three.js 3D scene layers**: reactive geometry, camera rig with beat-synced moves, post-processing (bloom, DOF). Promoted because "photoreal/cinematic" is a stated target aesthetic and is unreachable with 2D layers. Must share the compositor's framebuffer and obey the determinism contract (fixed timestep, seeded, no internal clock).

**Lyrics**
- **M18** Lyrics editor: paste/import `.lrc`/`.srt`, line splitting, per-line in/out times.
- **M19** Tap-to-sync with beat-grid snapping, vocal-stem waveform reference, and drag-adjust on the timeline.
- **M20** Karaoke word-fill rendering with configurable styling.
- **M26** *(promoted from Should)* **WhisperX transcription + forced alignment**, run on the isolated vocal stem, producing word-level timings as an editable draft. Promoted because the Python env now ships regardless — the marginal cost is a model download, and it's the difference between typing lyrics out and correcting them.

**Auto**
- **M21** Auto-director producing a complete, fully editable project from a track (stem-aware).
- **M22** "Surprise me" seeded reroll with per-aspect locks and a history strip.

**Output**
- **M23** Deterministic offline renderer with NVENC at 1080p60, 4K60, 9:16 and 1:1, progress/cancel, perfect A/V sync.
- **M24** Export presets + render queue.
- **M25** Preset save/load (project-level and layer-level) as portable JSON.
- **M38** **Layer groups**: nesting with shared transform, opacity, blend and effect chain; hierarchical parameter addressing; trivial groups collapsed at render time.
- **M39** **Video layers** via a deterministic frame cache at project fps, with proxy sequences for preview and cache-size attribution.
- **M40** **Managed asset library** for backgrounds, logos and fonts: path+hash references, missing-asset detection and relink, "collect files" for archiving.

**Operability** *(added after the scope audit — the difference between a demo and something still usable in a year)*
- **M33** **Cache & disk management** (§8.14): cache root, size breakdown by category and track, prune/clear, LRU ceiling, low-disk warning. Everything cached must be rebuildable.
- **M34** **Diagnostics** (§8.15): structured rotating logs, per-render report saved beside the output (settings, seed, FFmpeg command, timings, per-layer cost, warnings), startup environment report, copy-diagnostics action.
- **M35** **Module authoring + `modules/` drop-in folder** (§8.17): documented recipe, template module, schema-driven UI generation, and a conformance test that flags non-deterministic or non-reflowing modules.
- **M36** **Settings screen** (§8.16) including a setup/repair entry point (re-verify checksums, rebuild the Python env).

### SHOULD HAVE (v1.x — strongly wanted, not blocking)
- **S1** **Keyframe automation** on any parameter with an easing curve editor (schema slot reserved in v1).
- **S2** **Custom GLSL shader layer** (Shadertoy-compatible) with audio uniforms and live compile errors.
- **S3** *(demoted to C15 — psychedelic is not a target aesthetic)*
- **S4** *(promoted to M37 — "cinematic" is a target aesthetic and cannot be reached in 2D)*
- **S5** *(now M26 — promoted)*
- **S6** 6-stem model option (adds guitar, piano) — a model download away, once the env exists.
- **S15** Karaoke export mode: render with the instrumental stem as the audio track, using stems we already have.
- **S17** **Unicode & font fallback** for text/lyric layers: accents, non-Latin scripts, emoji, fallback chains, and RTL handling. Deferred by choice — but the text renderer (M32) must be built so this is an addition, not a rewrite.
- **S18** Draft/proxy mode: render the preview at a fixed low resolution with expensive effects approximated, for smooth editing on heavy projects.
- **S19** Project "collect files" action: gather every referenced asset next to the project for archiving or moving to another machine.
- **S16** `librosa`/`madmom` beat-tracking as an optional refinement pass over the TypeScript beat grid, for tracks where flux-based detection struggles (rubato, live drums, sparse percussion).
- **S7** Masking: any layer as an alpha/luma mask for another.
- **S8** Preset browser with live animated thumbnails and tagging.
- **S9** Section/marker system: named markers, snapping, scene changes.
- **S10** Motion blur via temporal supersampling on export.
- **S11** Colour management: sRGB-correct compositing, LUT support.
- **S12** Performance HUD: GPU frame time per layer, so heavy effects are visible *before* a 4K render.
- **S13** Batch mode: drop 10 tracks in, auto-direct and render them all overnight.
- **S14** Headless CLI (`pulseforge render project.pvproj -o out.mp4`).

### COULD HAVE (nice, later)
- **C1** Musical key/chord detection driving palettes; ML-grade structure detection.
- **C2** Node-graph editor as an alternative view of the layer/effect/modulation graph.
- **C3** MIDI input / MIDI file import to drive modulation (perfect sync for produced tracks).
- **C4** Live mode: real-time mic/loopback input for VJ use, fullscreen on a second monitor.
- **C5** *(now M35 — the `modules/` drop-in folder is a must-have)*
- **C6** WebGPU renderer path.
- **C7** Cover-art import for auto-styling from album artwork (local file, not a web lookup).
- **C8** NDI / Spout output for streaming.
- **C9** Audio-reactive 3D text (extruded, beat-synced).
- **C10** A/B render of two project variants side by side.
- **C11** *(now S15 — promoted)*
- **C15** *(demoted from S3)* **Butterchurn/MilkDrop preset player** — a huge free library, but its psychedelic character isn't a target look, and its frame-rate dependence makes it the most determinism-hostile layer type. Low value, high cost: last in line.
- **C13** Multi-clip audio sequencing (intro sting + track + outro as separate files).
- **C14** Import a video file for its audio track, optionally using its video as a background layer.
- **C12** Vocal-stem-driven lyric *timing verification*: flag lines whose text doesn't line up with detected vocal activity, so bad timings are caught before a 20-minute render.

### WON'T HAVE (this project)
- **W1** Cloud rendering, accounts, subscriptions, DRM, telemetry.
- **W2** Collaborative/multi-user editing.
- **W3** Full video editing or audio mixing.
- **W4** Mobile or web-hosted versions.
- **W5** Any ad-block detection or usage gating (the entire point of building this).
- **W6** Any feature that requires internet at runtime.
- **W7** Alpha/transparency export, ProRes, VP9 and PNG sequences — and with them the entire CPU encoding path. Everything ships as NVENC-encoded MP4.

---

## 10. Milestones

| Phase | Goal | Definition of done |
|---|---|---|
| **P0 — Spike** *(built and **validated on the home PC**)* | De-risk the hard parts | One `npm run validate` script producing a pasteable report: (a) a 10-second 1080p60 clip of one bar visualizer rendered offline via NVENC, in sync, with **byte-identical raw frames across two runs** (per-frame SHA-256; the MP4 compared separately with bit-exact muxing — export-spec §17); (b) async vs synchronous PBO readback measured at 4K; (c) Demucs `htdemucs` separating a track on the GPU from the portable Python env, driven over stdio from Node with real progress events; (d) encoder capability probe; (e) measured timings for all of it, replacing the §4 estimates. No UI. |
| **P1 — Provisioning** | Self-containment | `npm run setup` provisions Python, torch-CUDA, models, FFmpeg and assets with checksums and a vendored wheelhouse; the env can be **rebuilt** offline; the app passes a networking-disabled end-to-end run in CI. |
| **P2 — Engine** | Layers, compositor, param schema, modulation, **layout/aspect system**, module authoring contract | Engine renders a multi-layer project from a hand-written JSON file, headlessly, correctly at 16:9 / 9:16 / 1:1. Golden-frame tests green. The engine/shell import boundary is lint-enforced. |
| **P3 — Studio** | The Shimga-style UI | Load audio, trim/fade, add/edit layers, live preview on the audio master clock, timeline, undo/redo, aspect switcher, save/load. |
| **P4 — Library** | Breadth of looks | 10+ visualizers, 10+ effects, backgrounds (incl. video frame cache, M39), text, logo, palette system, layer groups (M38), **Three.js scene layers (M37)**, preset save/load, asset library (M40), `modules/` drop-in folder + authoring guide. |
| **P5 — Export** | Production output | All aspect ratios from one project, export presets, queue, progress/cancel, quality options, render reports. |
| **P6 — Lyrics** | Lyrics & karaoke | Editor, tap-to-sync, timeline track, word-fill karaoke, styling, **WhisperX alignment on the vocal stem (M26)**. |
| **P7 — Auto** | Auto-director & Surprise me | One click from audio file to a complete, good-looking, editable project. |
| **P8 — Expansion** | Should-haves | Keyframes (needs a short spec first), GLSL slot, masking, motion blur, CLI, 6-stem model. MilkDrop is a Could-have (C15) and comes after. |

P0 is deliberately first and deliberately ugly. If deterministic NVENC export or GPU stem
separation from the portable Python env doesn't work, every other decision changes — find out in
week one, not month four.

---

## 11. Risks & mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| **Readback stalls the GPU** — `glReadPixels` is synchronous and can halve throughput at 4K. | Export far slower than expected. | Async PBO readback, triple-buffered; measure in P0; render N frames ahead. |
| **The Python env rots** — a torch/CUDA/driver mismatch, or a wheel that has vanished upstream, and it can no longer be rebuilt. | The "works offline forever" promise quietly dies; stems and lyrics stop working. | Fully pinned lock + **vendored wheelhouse on disk** so rebuild never needs the network; portable interpreter isolated from system Python; CI job that wipes and rebuilds the env offline; a recorded known-good (driver, CUDA, torch) triple. |
| **VRAM contention** between the renderer, Demucs and WhisperX. | OOM crash mid-edit or mid-render — the worst possible moment. | The global GPU job queue (M28); free models between jobs; configurable segment/batch size; measured budgets in §4; explicit OOM handling that retries smaller rather than dying. |
| **Stem separation is slow** (1–2 min per track). | Feels broken, kills the "quick idea" workflow. | Sidecar + progress + cancel; mix-only editing available immediately while stems run; aggressive caching (once per track, ever); `htdemucs` as the default, `htdemucs_ft` reserved for final renders. |
| **Large first-run download** (~8–9 GB, ~13–15 GB on disk). | Poor first impression; setup failures halfway through 3 GB of torch. | Tiered, resumable, checksum-verified, re-runnable setup (§3). Core tier (~300 MB) makes the app usable in a minute while the rest streams in the background. Show sizes and a running total up front. |
| **Butterchurn presets are frame-rate dependent.** | Non-deterministic export. | Fixed-timestep driver stepped from t=0; accept slow seeking; flag presets that fail the determinism test. |
| **Particle systems drift on seek.** | Preview ≠ export. | Pure-function particles where possible; otherwise deterministic fast-forward with periodic state checkpoints. |
| **Auto-director output looks generic.** | Headline feature disappoints. | Hand-authored templates made by eye, not procedural mush; few excellent templates over many mediocre ones; Surprise me makes exploration cheap. |
| **Scope explosion** (4 effect sources × everything). | Never ships. | Custom modular set and Three.js scenes (M37) are the v1 musts; GLSL import is a Should-have (S2) and MilkDrop a Could-have (C15), both behind the same stable layer interface. Build the *interface* in v1, the deferred *implementations* after. |
| **Forced alignment quality on sung vocals.** | Word timings unusable. | Run on the isolated vocal stem (much better input); optional from the start; tap-to-sync is the guaranteed path. |
| **Licence contamination.** | Legal mess if ever shared. | Vizzy is **AGPL-3.0 — inspiration only, do not copy code**. Butterchurn MIT, Three.js MIT (safe). FFmpeg: ship an LGPL build. Demucs weights carry their own terms — check before redistributing (fetching them at setup, rather than vendoring, is also the cleaner licence position). `LICENSES.md` generated by setup. |
| **Preview performance at 4K on complex projects.** | Editing feels sluggish. | Preview always renders scaled, with an explicit quality slider; full-res opt-in; draft/proxy mode (S18). |
| **Per-aspect overrides become confusing** — you edit in vertical, wonder why landscape changed (or didn't). | The multi-format feature actively wastes time. | The inspector must always show which aspect is active and which values are overridden, with reset-to-base per property. Build the override UI *with* the feature, never after. |
| **Timeline-time vs audio-time confusion** once trim and lead-in exist. | Off-by-seconds sync bugs that are maddening to trace. | One documented mapping function, used everywhere, unit-tested with padding and trim set to awkward values. Never let raw audio-file time reach the engine. |
| **Cache silently consumes the disk** (stems, analysis, glyph atlases, proxies). | Mystery disk exhaustion months in. | M33: visible cache breakdown, LRU ceiling, low-disk warning, everything rebuildable. |

---

## 12. Open questions — resolved

**All resolved — see [docs/decisions.md](docs/decisions.md)** for the full log of 47 decisions with rationale.

Headline resolutions: Electron · name *Pulseforge* · **full layer groups in v1** · **video backgrounds via frame cache** · **MP4 only, no CPU encoder path** · managed asset library · filmic tone mapping · fast model defaults with quality on demand · auto-director offered on import.


---

## 13. Repo structure

```
pulseforge/
├─ package.json              scripts: dev · setup · verify-offline · test · build · render (CLI)
├─ setup/                    provisioning: manifest, checksums, downloader, wheelhouse, repair
├─ vendor/                   ← gitignored, created by setup
│   ├─ ffmpeg/  python/  wheelhouse/  models/  fonts/  assets/  milkdrop/
│   └─ vendor.lock.json      exactly what is installed, with hashes
├─ src/
│   ├─ shell/                Electron main: IPC, file I/O, FFmpeg, GPU job queue, sidecar supervisor
│   ├─ engine/               ★ pure, headless, deterministic. NO Electron/DOM imports.
│   │   ├─ core/             time, PRNG, param schema, modulation eval, layout/aspect resolution
│   │   ├─ render/           WebGL2 compositor, framebuffer pool, blend modes, readback
│   │   ├─ modules/          built-in visualizers & effects (one file each)
│   │   └─ text/             layout, glyph atlas, karaoke metrics
│   ├─ analysis/             decode, FFT, bands, onsets, BPM, cache format
│   ├─ ml/                   sidecar protocol client (Demucs, WhisperX)
│   ├─ ui/                   React studio: timeline, inspector, canvas, panels
│   ├─ project/              document schema, migrations, commands/undo, presets
│   └─ export/               frame pump, FFmpeg pipe, queue, render reports
├─ modules/                  ← user drop-in modules, scanned at startup
├─ python/pulseforge_ml/     sidecar package (stdio JSON-lines)
├─ tests/golden/             reference frames for the determinism contract
└─ docs/                     authoring guide, architecture notes, this file
```

**The one boundary that must never be crossed:** `src/engine/` may not import Electron, the DOM,
React, or anything time- or network-aware. Enforce it with a lint rule from day one — it's what
keeps headless rendering, golden-frame testing and the CLI possible, and it is very hard to
recover once violated.

---

## 14. Development & deployment split

**The plan was written on a laptop that cannot run it; the code is built and run on the home PC.**
Planning happened on an Intel Core Ultra 5 with integrated graphics; implementation and running
happen on the Ryzen 7 / RTX 3060 home PC. The app itself stays NVIDIA-only — no CPU fallbacks —
and the laptop remains useful only for GPU-free work (engine logic, specs).

| Consequence | What it requires |
|---|---|
| **No GPU validation on the laptop.** NVENC, CUDA Demucs, WhisperX and readback throughput can only be tested on the home PC — Intel iGPU numbers say nothing useful about a 3060. | Every GPU-dependent milestone ends with a **validation script** run on the home PC that prints a structured, pasteable report. Design decisions wait on those numbers rather than on estimates. |
| **Setup must diagnose itself.** | Provisioning must be aggressively self-diagnosing: check every precondition up front, name the exact failure, suggest the exact fix, log everything, and be safely re-runnable. A stack trace is a failure of the setup script, not a diagnosis. |
| **Shader compilation differs by vendor.** Code that compiles on Intel may fail on NVIDIA and vice versa. | Target WebGL2/GLSL ES 3.00 strictly, avoid vendor extensions, and treat "it compiled locally" as no evidence at all. Shader compile errors must surface in the UI with the source line, never fail silently to a black layer. |
| **Golden-frame tests are GPU-dependent.** Reference frames generated on the iGPU won't match the 3060 bit-for-bit. | Golden frames are **generated and verified on the home PC** and committed from there. Locally, tests cover engine *logic* — modulation evaluation, layout resolution, time mapping, schema round-trips — which is pure CPU and where most bugs live anyway. |
| **Two machines, one repo.** | Git from the start. The home PC is authoritative for source; the laptop pulls if it is used at all. `vendor/`, caches, outputs and golden frames' large binaries stay out of the repo (or in LFS). Nothing machine-specific in committed config — all paths from settings. |

Practical rhythm: build and run on the home PC, let the validation output drive decisions, and
adjust the plan to measured reality. The estimates in §4 are explicitly placeholders awaiting
that first report.

---

## 15. Distribution & maintenance

**Private repo, personal use.** That simplifies several things and is assumed throughout.

- **No licence obligations to satisfy**, no cross-machine support burden, no docs written for strangers. Provisioning targets NVIDIA + Windows; CPU/AMD fallbacks are not required (though the code shouldn't gratuitously hard-code the 3060).
- **Licence hygiene is still worth keeping cheaply**: don't paste AGPL code from Vizzy. Not because anything is being distributed today, but because "we might publish this" stays an option only while no such code is in the history. Costs nothing to avoid, expensive to unpick later.
- **Update path for an offline app**: `git pull` → `npm install` → `npm run setup` (incremental — re-verifies checksums, fetches only what changed). Setup must be safely re-runnable and must never invalidate existing projects.
- **Project compatibility is a promise to yourself.** Every `.pvproj` schema change ships a migration, and old projects open in new versions. A render from last year must still render. This is why the schema is versioned from v1 and why render reports record the exact settings used.
- **Backups**: projects, presets and `vendor.lock.json` are the irreplaceable parts; `vendor/` and caches are regenerable. Keep them separable so the backup stays small.

---

## 16. Reference material

- **Shimga.app** — UI/UX reference for the studio layout (see project screenshot).
- **Vizzy.io** — feature reference; open-source modules at vizzy.io/open-source. **AGPL-3.0 — read only, do not copy code.**
- **Butterchurn** — MilkDrop preset engine for WebGL (MIT).
- **Three.js** — 3D layer rendering (MIT).
- **Shadertoy** — source material for the GLSL import slot (per-shader licences vary).
- **FFmpeg + NVENC** — decode/encode backbone.
- **Demucs (Meta)** — stem separation. MIT code; **model weights carry their own terms — check before redistributing** (fetching at setup rather than vendoring is the cleaner position).
- **WhisperX** — transcription + word-level forced alignment, run on the vocal stem.
- **python-build-standalone** + **uv** — portable interpreter and reproducible, offline-capable dependency installs.
