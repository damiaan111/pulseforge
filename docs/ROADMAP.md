# Roadmap — what is done, what is left, what comes next

> The requirement-by-requirement view of the build. `docs/STATUS.md` is the narrative (how each
> part works, how it was verified, what went wrong); this file is the checklist against
> PROJECT.md §9–§10. **Update both at the end of every step.**
>
> **As of 2026-09-25, after P7 (the auto-director) is complete.** States: ✅ done · 🔶 partly done · ⬜ not started.
> "Where" points at the STATUS section that describes it. Every ✅ was verified on the RTX machine
> (tests, golden frames, the studio smoke check, and a real render where it applies).

---

## 1. At a glance

| Phase | State | Notes |
|---|---|---|
| Planning | ✅ | PROJECT.md, eight specs, decisions D1–D51 |
| P0 — Spike | ✅ | `npm run validate` 8/8 |
| P1 — Provisioning | 🔶 | core, stems and lyrics tiers; extras tier, `htdemucs_ft`, offline-rebuild check still open |
| P2 — Engine | ✅ | |
| P3 — Studio | ✅ | |
| P4 — Library | ✅ | 16 steps, 2026-09-15 → 09-18 |
| P5 — Export | 🔶 | most of it landed early with the render pipeline; see M34 and §3 |
| P6 — Lyrics | ✅ | five steps, 2026-09-25: STATUS 4.50–4.55 |
| P7 — Auto-director | ✅ | three steps, 2026-09-25: STATUS 4.56–4.58 |
| P8 — Expansion (Should-haves) | 🔶 | a few already done in passing (S8, S14, S19) |

**Must-haves (M1–M40): 38 done, 2 partly done, 0 not started.** By count that is 90%+; by effort —
what remains is operability (cache screen, logs and diagnostics, the settings screen) and the P1
remainder — the v1 must-have work is **roughly nine-tenths done**.

---

## 2. Requirements

### Foundation

| | Requirement | State | Where | What is left |
|---|---|---|---|---|
| M1 | Shell; new/open/save/save-as; autosave + crash recovery; versioned schema with migrations | ✅ | 4.7, 4.14, 4.49 | the autosave interval is fixed at 1 min until the settings screen (M36); auto-generate and lyrics re-align must autosave first when built |
| M2 | One-command setup with checksums; fully offline after | 🔶 | 4.2, 4.55 | the lyrics tier is done (4.55); the extras tier, `htdemucs_ft`, Whisper `large-v3`, other languages' alignment models, an offline-rebuild check. Offline at runtime is enforced (network requests are blocked and logged, 4.14) |
| M3 | Audio import (mp3/wav/flac/m4a/ogg/opus), waveform, transport with accurate seek | ✅ | 4.4, 4.16, 4.27 | |
| M4 | FFT, bands, RMS, onsets, BPM/beat grid; cache keyed by audio hash | ✅ | 4.4, 4.17, 4.45 | the project's bands are computed since 4.45; editing them in the UI is not built |
| M5 | Stem separation (Demucs, GPU), per-stem features, cached, background with progress/cancel, mix-only fallback | ✅ | 4.6, 4.24, 4.48 | per-stem waveform rows and stem solo in the preview are not built |
| M6 | Determinism contract from commit one; golden frames | ✅ | 4.3, 4.12 | golden frames run locally (`npm run golden`); the repo is on GitHub but no CI is configured (the golden set needs the RTX GPU, so a hosted runner could not run it) |
| M7 | Compositor: stack, blend modes, opacity, transform, render-to-texture | ✅ | 4.3, 4.39, 4.47 | thirteen modes (normal, add, screen and the ten separable ones); the HSL family is not implemented and not offered |
| M8 | Undo/redo for every mutation | ✅ | 4.15 | |
| M27 | ML sidecar lifecycle: spawn/supervise/restart, JSON-lines, progress, cancel, health check | ✅ | 4.24, 4.48 | a health check on start-up (surfaced in a settings screen) comes with M36 |
| M28 | Global GPU job queue: renderer / Demucs / WhisperX never contend for VRAM | ✅ | 4.48, 4.55 | |

### Creative core

| | Requirement | State | Where | What is left |
|---|---|---|---|---|
| M9 | Layers: add/delete/reorder/duplicate/rename/solo/mute/lock, per-layer time range | ✅ | 4.15, 4.27, 4.47 | time ranges are edited in the inspector; dragging them on the timeline, and multi-select, are not built |
| M10 | Schema-driven inspector | ✅ | 4.27 | |
| M11 | ≥10 2D visualizers | ✅ | 4.28, 4.29 | 10 |
| M12 | ≥10 effects | ✅ | 4.30, 4.31 | 10, plus depth of field (4.43). Feedback trails and shake from the example list are not among them |
| M13 | Modulation matrix: all sources incl. per-stem bands, curves, attack/release, per-parameter binding UI with live values | ✅ | 4.10, 4.46, 4.48 | per-stem sources work once a track's stems are separated; not built: source sparkline, copy/paste of bindings, global-chain bindings |
| M14 | Background: solid, gradient, image, video; fit modes; Ken Burns | ✅ | 4.35, 4.41 | |
| M15 | Logo/watermark with reactive pulse | ✅ | 4.40 | |
| M16 | Text layer with styling and animation | ✅ | 4.38 | |
| M17 | Palette: reskin in one action | ✅ | 4.32 | |
| M29 | Audio clip model: trim, fades with curves, lead-in/out, timeline→source mapping | ✅ | 4.7, 4.16, 4.47 | edited in the Clip panel; dragging clip edges on the timeline is not built |
| M30 | Layout & aspect: anchors, scale references, per-aspect overrides, switcher, multi-aspect export | ✅ | 4.8, 4.27, 4.34 | |
| M31 | Preview clock: audio master, drop never drift, scrub, dropped-frame indicator | ✅ | 4.16, 4.27 | |
| M32 | Deterministic text rasterisation with per-word metrics, missing-font reporting | ✅ | 4.38 | |
| M37 | Three.js 3D scene layers | ✅ | 4.43 | point cloud and tunnel-flight scenes not built (terrain flowing toward the camera covers flight) |

### Lyrics (P6)

| | Requirement | State | What is left |
|---|---|---|---|
| M18 | Lyrics editor: paste, `.lrc`/`.srt` import, per-line times | ✅ | 4.50, 4.53 — paste/type with markers, import and export of five formats, typed times, roles, locks, words, checklist |
| M19 | Tap-to-sync with beat snapping, vocal-stem waveform, drag-adjust | ✅ | 4.53, 4.54 — tap-to-sync; the timeline lane with the vocal level, drag/resize/ripple/word boundaries, snapping, zoom, keyboard. Not built: marquee select, loop region |
| M20 | Karaoke word-fill rendering | ✅ | 4.51 — seven fill modes, line window with scroll/crossfade/cut, roles, lyric modulation sources. Not built: contrast enforcement against the backdrop, gradient fills |
| M26 | WhisperX transcription + alignment on the vocal stem | ✅ | 4.55 — English alignment; other languages' models and `large-v3` are not provisioned |

### Auto (P7)

| | Requirement | State | Where | What is left |
|---|---|---|---|---|
| M21 | Auto-director: complete editable project from a track | ✅ | 4.21, 4.26, 4.56–4.58 | Could-level: `derive-from-image` palettes, "Extract as template", palette shifts at chorus/drop |
| M22 | Surprise me: seeded reroll, per-aspect locks, history strip | ✅ | 4.57, 4.58 | — |

### Output

| | Requirement | State | Where | What is left |
|---|---|---|---|---|
| M23 | Deterministic NVENC render at 1080p60, 4K60, 9:16, 1:1; progress/cancel; A/V sync | ✅ | 4.5, 4.33 | |
| M24 | Export presets + render queue | ✅ | 4.23, 4.34 | the encoder probe exists (`src/export/encoder-probe.ts`) but the dialog does not consult it; today's presets use only codecs Ampere has |
| M25 | Preset save/load, project and layer level, portable JSON | ✅ | 4.19, 4.25, 4.44 | presets reference assets by project id, so a preset that uses an image does not bring it to another project |
| M38 | Layer groups | ✅ | 4.39 | |
| M39 | Video layers via a deterministic frame cache, proxies | ✅ | 4.41 | cache-size attribution waits for M33 |
| M40 | Managed asset library: path + hash, missing detection, relink, collect files | ✅ | 4.37 | |

### Operability

| | Requirement | State | Where | What is left |
|---|---|---|---|---|
| M33 | Cache & disk management: root, breakdown, prune, LRU ceiling, low-disk warning | ✅ | 4.17, 4.41, 4.60 | "per-project" view: the breakdown is per track and video, which is what a project's cache consists of |
| M34 | Diagnostics: rotating logs, per-render report, environment report, copy diagnostics | 🔶 | 4.5, 4.14 | render reports beside each output and the environment report exist; **rotating logs and copy-diagnostics** do not |
| M35 | Module authoring, `modules/` folder, conformance test | ✅ | 4.42 | see §4 for the deliberate difference from module-spec §12 |
| M36 | Settings screen incl. setup/repair entry | ✅ | 4.59 | shortcut remapping and GPU choice are shown, not settable (§4) |

### Should-haves already touched

| | State | Notes |
|---|---|---|
| S2 Custom GLSL layer | 🔶 | drop-in shader modules (M35) cover "a shader with audio uniforms and live compile errors"; Shadertoy compatibility (`iTime`, `iResolution`, `mainImage`) is not there |
| S8 Preset browser | ✅ | 4.44 |
| S9 Sections/markers | 🔶 | automatic section detection (4.21); no markers or snapping UI |
| S11 Colour management | 🔶 | linear-light, premultiplied compositing and correct output transfer; no LUTs |
| S14 Headless CLI | ✅ | `npm run render` (4.13) |
| S18 Draft/proxy mode | 🔶 | preview resolution scale and video proxies; no effect approximations |
| S19 Collect files | ✅ | 4.37 |

S1, S6, S7, S10, S12, S13, S15, S16 and S17 are not started. Could-haves (C1–C15) are untouched.

---

## 3. What comes next, in order

Ordered by what makes the app most useful soonest, then by what unblocks what.

1. ✅ **Modulation binding UI (M13)** — done (STATUS 4.46), with the analysis bands fix (4.45).
2. ✅ **Layer and clip editing gaps (M9, M29, M7)** — done (STATUS 4.47). Timeline dragging of
   time ranges and clip edges is still open.
3. ✅ **Stems end to end (M5, M27, M28)** — done (STATUS 4.48). Per-stem waveform rows are still open.
4. ✅ **Autosave and crash recovery (M1)** — done (STATUS 4.49).
5. ✅ **Lyrics (P6: M18–M20, M26)** — done (STATUS 4.50–4.55).
6. ✅ **Auto-director (P7: M21, M22)** — done (STATUS 4.56–4.58).
7. **Operability (M33, M34, M36)** — ✅ the settings screen with setup/repair (STATUS 4.59), ✅ storage
   (4.60); next rotating logs and copy-diagnostics (M34).
8. **P1 remainder** — extras tier, `htdemucs_ft`, Whisper `large-v3`, alignment models for more languages, an offline-rebuild check.
9. **P8** — keyframes (needs a short spec first), masking, motion blur, 6-stem model, and the rest
   of the Should-haves.

---

## 4. Deviations from the specs, for the owner to confirm

Deliberate choices made while building that differ from what a spec says. Each is described where
it was made; they are collected here so none is a surprise.

| Choice | Spec | Why | Where |
|---|---|---|---|
| Drop-in modules are **declarative only** (JSON + GLSL); no JavaScript from `modules/` runs | module-spec §12 describes plugins as "code", trust model "none" | keeps the renderer sandboxed and the IPC surface unchanged, and makes drop-ins deterministic by construction; built-ins cover what shaders cannot | STATUS 4.42, `docs/module-authoring.md` §7 |
| Depth of field is an **engine effect gated by `needsDepth`**, not Three's post-processing | compositor-spec §7.2 says the same; §7.3's "depth as a second output" is implemented as `LayerDepth` on the effect context | one post path for 2D and 3D | STATUS 4.43 |
| Lyric **styling lives on the lyrics layer**, not in the lyrics document | lyrics-spec §1 sketches style/karaoke/layout inside `LyricsDocument`; §7 and §13 require schema-declared params of a text-kind module | only as layer params are they modulatable, per-aspect overridable and in presets; a project can show lead and backing lines on two differently styled layers. Per-line overrides (D38) stay on the line | STATUS 4.50 |
| **CTranslate2 4.8.2 overrides WhisperX's `<4.5` pin**, and the `nvidia-cublas-cu12` wheel is added | PROJECT.md §3 "official WhisperX" | the pinned CTranslate2 needs cuDNN 8, which cannot sit beside the pinned torch CUDA 13 build; 4.8.2 is API-compatible (faster-whisper allows `<5`) and needs CUDA 12's cuBLAS, which the wheel provides | STATUS 4.55 |
| Transcription uses **faster-whisper with its bundled Silero VAD**, not `whisperx.load_model` | "WhisperX transcription + alignment" (M26) | WhisperX's VAD front-end imports pyannote.audio 3.x, broken on the torchaudio that matches the pinned torch; the forced alignment is WhisperX's own (`whisperx.alignment`) | STATUS 4.55 |
| Preset **thumbnails use a fixed reference track**, not the loaded song | D45 ("live preview-with-my-audio later") | a thumbnail is then a property of the preset alone, so it caches and matches across machines | STATUS 4.44 |
| User presets live in **Documents/Pulseforge/Presets**, built-ins in the repo, thumbnails in `cache/` | data-formats §3 names "known folders" without fixing them | user work beside the asset library, in the user's backups; caches rebuildable | STATUS 4.44 |
| The 3D field of view applies to the frame's **short side** | not specified | a 9:16 cut shows the same subject as the 16:9 one | STATUS 4.43 |
| Arrangement (section intensity, drop impulses) is a **`curve` modulation source**, not keyframes | auto-director-spec §6 speaks of keyframed intensity | keyframes (S1) are unbuilt and need their own spec; a curve binding is deterministic, editable, listed in the matrix, and can be converted to keyframes when they exist | STATUS 4.56 |
| **Layer opacity is a modulation target** (`layers.<id>.opacity`) | modulation-spec §4 targets module parameters | the director's section presence has to fade a layer in and out; one opacity binding does it for every module, and is editable in the matrix | STATUS 4.57 |
| Templates key section states by **this build's labels** (intro, build, main, breakdown, outro); a modulation may list **alternative targets**; the budget is **numeric** (low 1, medium 2, high 4 × pixels/1080p) | auto-director-spec §4 sketch: chorus/drop states, one target, `maxGpuCost: "high"` | the section detector's labels are what exist; candidates do not share parameter names; a budget has to be summed to be enforced | STATUS 4.57 |
| The Settings screen **shows the GPU and the keyboard map** rather than letting them be chosen | PROJECT.md §8.16 lists GPU device selection and a shortcut map | Chromium chooses the WebGL device and offers no per-app switch; remapping needs a shortcut registry the studio does not have yet (the reference is accurate) | STATUS 4.59 |
| A **`split` harmony** (+90°, −110°) in template palettes | auto-director-spec §4 lists analogous, complementary, triad, duotone | the contact sheet showed a triad's sun lime-green; synthwave's magenta/orange/cyan needs it | STATUS 4.58 |
| Multiplying bindings are **capped** at ×1.25 / ×1.6 / ×2.5 per band | §5.2: band share of the soft range | on a small base the range share becomes a ×13 factor | STATUS 4.57 |
| The analysis cache key **includes band names** | data-formats §4.3: a band rename should keep the cache | cached tracks are stored by name, so a rename that hit the cache would silently disable every binding on the band; a rename now costs one re-analysis | STATUS 4.45 |

---

## 5. How this is checked

| Command | What it proves |
|---|---|
| `npm run check` | typecheck, lint (including the engine boundary) and 1002 tests — unit tests, and GPU tests that render through Electron |
| `npm run golden` | 29 reference frames (bars, layered, 3D scenes, lyrics at 16:9, 9:16, 1:1) are byte-identical |
| `npm run dev -- --smoke` | 22 end-to-end checks in the real studio window, each confirmed to fail when its feature is broken |
| `npm run modules:check` | every drop-in module compiles, is deterministic and reflows |
| `npm run render -- <project> -o <mp4>` | a real NVENC export, verified after encoding |
| `npm run validate` | the P0 hardware checks (determinism, readback, NVENC, stems, sync) |
