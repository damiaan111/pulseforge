# Roadmap — what is done, what is left, what comes next

> The requirement-by-requirement view of the build. `docs/STATUS.md` is the narrative (how each
> part works, how it was verified, what went wrong); this file is the checklist against
> PROJECT.md §9–§10. **Update both at the end of every step.**
>
> **As of 2026-09-27, P8 in progress (S1, S2, S6, S7, S9, S10, S11, S12, S13, S15 and S18 done). States: ✅ done · 🔶 partly done · ⬜ not started.
> "Where" points at the STATUS section that describes it. Every ✅ was verified on the RTX machine
> (tests, golden frames, the studio smoke check, and a real render where it applies).

---

## 1. At a glance

| Phase | State | Notes |
|---|---|---|
| Planning | ✅ | PROJECT.md, eight specs, decisions D1–D51 |
| P0 — Spike | ✅ | `npm run validate` 8/8 |
| P1 — Provisioning | ✅ | core, stems, lyrics and extras tiers; the offline rebuild check (STATUS 4.62) |
| P2 — Engine | ✅ | |
| P3 — Studio | ✅ | |
| P4 — Library | ✅ | 16 steps, 2026-09-15 → 09-18 |
| P5 — Export | ✅ | the render pipeline, reports and diagnostics; the free-space check (STATUS 4.75) was the last of it |
| P6 — Lyrics | ✅ | five steps, 2026-09-25: STATUS 4.50–4.55 |
| P7 — Auto-director | ✅ | three steps, 2026-09-25: STATUS 4.56–4.58 |
| P8 — Expansion (Should-haves) | ✅ | all 16 done (S3 became C15, S4 M37, S5 M26) |

**Must-haves (M1–M40): all 40 done.**

---

## 2. Requirements

### Foundation

| | Requirement | State | Where | What is left |
|---|---|---|---|---|
| M1 | Shell; new/open/save/save-as; autosave + crash recovery; versioned schema with migrations | ✅ | 4.7, 4.14, 4.49 | the autosave interval is fixed at 1 min until the settings screen (M36); auto-generate and lyrics re-align must autosave first when built |
| M2 | One-command setup with checksums; fully offline after | ✅ | 4.2, 4.55, 4.62 | alignment beyond en/fr/de/es/it (Hugging Face models) not provisioned; those languages use tap-to-sync |
| M3 | Audio import (mp3/wav/flac/m4a/ogg/opus), waveform, transport with accurate seek | ✅ | 4.4, 4.16, 4.27 | |
| M4 | FFT, bands, RMS, onsets, BPM/beat grid; cache keyed by audio hash | ✅ | 4.4, 4.17, 4.45 | the project's bands are computed since 4.45; editing them in the UI is not built |
| M5 | Stem separation (Demucs, GPU), per-stem features, cached, background with progress/cancel, mix-only fallback | ✅ | 4.6, 4.24, 4.48 | 4.81 per-stem rows and stem solo in the preview |
| M6 | Determinism contract from commit one; golden frames | ✅ | 4.3, 4.12 | golden frames run locally (`npm run golden`); the repo is on GitHub but no CI is configured (the golden set needs the RTX GPU, so a hosted runner could not run it) |
| M7 | Compositor: stack, blend modes, opacity, transform, render-to-texture | ✅ | 4.3, 4.39, 4.47 | thirteen modes (normal, add, screen and the ten separable ones); the HSL family is not implemented and not offered |
| M8 | Undo/redo for every mutation | ✅ | 4.15 | |
| M27 | ML sidecar lifecycle: spawn/supervise/restart, JSON-lines, progress, cancel, health check | ✅ | 4.24, 4.48 | a health check on start-up (surfaced in a settings screen) comes with M36 |
| M28 | Global GPU job queue: renderer / Demucs / WhisperX never contend for VRAM | ✅ | 4.48, 4.55 | |

### Creative core

| | Requirement | State | Where | What is left |
|---|---|---|---|---|
| M9 | Layers: add/delete/reorder/duplicate/rename/solo/mute/lock, per-layer time range | ✅ | 4.15, 4.27, 4.47 | 4.79 time ranges drag on the timeline; 4.81 multi-select; 4.88 new visuals stay under the words, To bottom |
| M10 | Schema-driven inspector | ✅ | 4.27 | |
| M11 | ≥10 2D visualizers | ✅ | 4.28, 4.29 | 10 |
| M12 | ≥10 effects | ✅ | 4.30, 4.31 | 10, plus depth of field (4.43). Feedback trails and shake from the example list are not among them |
| M13 | Modulation matrix: all sources incl. per-stem bands, curves, attack/release, per-parameter binding UI with live values | ✅ | 4.10, 4.46, 4.48 | per-stem sources work once a track's stems are separated; 4.81 source sparkline, copy and paste of bindings |
| M14 | Background: solid, gradient, image, video; fit modes; Ken Burns | ✅ | 4.35, 4.41 | |
| M15 | Logo/watermark with reactive pulse | ✅ | 4.40 | |
| M16 | Text layer with styling and animation | ✅ | 4.38 | |
| M17 | Palette: reskin in one action | ✅ | 4.32 | |
| M29 | Audio clip model: trim, fades with curves, lead-in/out, timeline→source mapping | ✅ | 4.7, 4.16, 4.47 | edited in the Clip panel, and 4.79 by dragging the clip's edges on the timeline |
| M30 | Layout & aspect: anchors, scale references, per-aspect overrides, switcher, multi-aspect export | ✅ | 4.8, 4.27, 4.34 | |
| M31 | Preview clock: audio master, drop never drift, scrub, dropped-frame indicator | ✅ | 4.16, 4.27 | |
| M32 | Deterministic text rasterisation with per-word metrics, missing-font reporting | ✅ | 4.38 | |
| M37 | Three.js 3D scene layers | ✅ | 4.43 | point cloud and tunnel-flight scenes not built (terrain flowing toward the camera covers flight) |

### Lyrics (P6)

| | Requirement | State | What is left |
|---|---|---|---|
| M18 | Lyrics editor: paste, `.lrc`/`.srt` import, per-line times | ✅ | 4.50, 4.53 — paste/type with markers, import and export of five formats, typed times, roles, locks, words, checklist |
| M19 | Tap-to-sync with beat snapping, vocal-stem waveform, drag-adjust | ✅ | 4.53, 4.54 — tap-to-sync; the timeline lane with the vocal level, drag/resize/ripple/word boundaries, snapping, zoom, keyboard. 4.81 marquee select and a loop region |
| M20 | Karaoke word-fill rendering | ✅ | 4.51 — seven fill modes, line window with scroll/crossfade/cut, roles, lyric modulation sources. 4.81 gradient fills. Contrast against the live backdrop is decided against |
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
| M24 | Export presets + render queue | ✅ | 4.23, 4.34 | the dialog consults the encoder probe and disables what cannot open, with the reason (STATUS 4.75) |
| M25 | Preset save/load, project and layer level, portable JSON | ✅ | 4.19, 4.25, 4.44 | presets reference assets by project id (D6), so a preset that uses an image does not bring it to another project |
| M38 | Layer groups | ✅ | 4.39 | |
| M39 | Video layers via a deterministic frame cache, proxies | ✅ | 4.41 | cache-size attribution waits for M33 |
| M40 | Managed asset library: path + hash, missing detection, relink, collect files | ✅ | 4.37 | |

### Operability

| | Requirement | State | Where | What is left |
|---|---|---|---|---|
| M33 | Cache & disk management: root, breakdown, prune, LRU ceiling, low-disk warning | ✅ | 4.17, 4.41, 4.60 | "per-project" view: the breakdown is per track and video, which is what a project's cache consists of |
| M34 | Diagnostics: rotating logs, per-render report, environment report, copy diagnostics | ✅ | 4.5, 4.14, 4.61 | per-layer GPU timer queries are S12 (performance HUD) |
| M35 | Module authoring, `modules/` folder, conformance test | ✅ | 4.42 | see §4 for the deliberate difference from module-spec §12 |
| M36 | Settings screen incl. setup/repair entry | ✅ | 4.59 | 4.81 shortcuts remap; GPU choice is shown, not settable (§4) |

### Should-haves already touched

| | State | Notes |
|---|---|---|
| S1 Keyframe automation | ✅ | 4.63, 4.64 — the auto-director still writes arrangement as `curve` bindings (ROADMAP §4); converting it to keyframes is a follow-up |
| S7 Masking | ✅ | 4.65 — alpha and luma, invert, feather; stencil modes are alpha and inverted alpha |
| S6 6-stem model | ✅ | 4.67 — `htdemucs_6s` as an optional model, guitar and piano stems, 1.27× the time of `htdemucs` |
| S10 Motion blur | ✅ | 4.66 — export dialog and CLI, 2–32 samples, 1–360° shutter, in the render report; 4.81 spatial supersampling |
| S2 Custom GLSL layer | ✅ | 4.42 drop-in shader modules; 4.72 Shadertoy dialect: paste with a live check, bare `.glsl` files, `iChannel0` audio; single pass only, no image channels |
| S8 Preset browser | ✅ | 4.44 |
| S9 Sections/markers | ✅ | 4.21 sections; 4.69 markers: named and coloured, snapping, prev/next, render ranges, `marker`/`markerProgress` sources; 4.81 loop region and I/O keys |
| S11 Colour management | ✅ | linear-light, premultiplied compositing and correct output transfer; 4.73 the LUT effect with `.cube` files (3D and 1D), for display or linear input |
| S13 Batch mode | ✅ | 4.68 — drop tracks or Batch…, `npm run batch`; completion notification, shutdown when done; 4.75 a job that will not fit holds the queue |
| S15 Karaoke export | ✅ | 4.70 — export dialog, `render --instrumental`, batch; every stem but the vocals, summed; refused without stems |
| S12 Performance HUD | ✅ | 4.71 — GPU time per top-level layer, whole-frame effects and output; estimates at full size and 4K; per-layer cost in every render report |
| S14 Headless CLI | ✅ | `npm run render` (4.13), `npm run batch` (4.68) |
| S18 Draft/proxy mode | ✅ | 4.74 — Draft: 640 px long side, DOF 16 taps instead of 48, no MSAA on 3D scenes; measured −64% on the heaviest case; video proxies already existed |
| S19 Collect files | ✅ | 4.37 |
| S16 Beat and structure refinement | ✅ | 4.77 — librosa (madmom has no Windows wheels), stored in the project; F 0.98 against 0.20–0.40 on known tracks; not in batch or the auto-director |
| S17 Unicode & font fallback | ✅ | 4.76 — bundled Noto chain, right-to-left layout and karaoke, CJK line breaks, a report instead of system fonts; emoji are monochrome |

Could-haves (C1–C15) are untouched.

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
7. ✅ **Operability (M33, M34, M36)** — done (STATUS 4.59–4.61).
8. ✅ **P1 remainder** — done (STATUS 4.62).
9. **P8** — ✅ keyframes (S1, 4.63–4.64), ✅ masking (S7, 4.65), ✅ motion blur (S10, 4.66), ✅ the
   6-stem model (S6, 4.67), ✅ batch mode (S13, 4.68), ✅ markers (S9, 4.69), ✅ karaoke export (S15,
   4.70), ✅ the performance HUD (S12, 4.71), ✅ Shadertoy shaders (S2, 4.72), ✅ LUTs (S11, 4.73), ✅ draft mode
   (S18, 4.74), ✅ the free-space check (4.75), ✅ Unicode text (S17, 4.76), ✅ beat refinement (S16, 4.77). **P8 is complete.**

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
| Keyframes: **not per aspect**; **transform fields are targets**; colours ease **in linear light**; key times are **timeline ticks** (moving a layer does not move its keys); **presets do not carry keys** | module-spec left these open (keyframes-spec.md, marked "proposed") | one track per target keeps the timeline readable (D44's concern); transform is the most animated thing; linear light matches the compositor; ticks match lyric times | STATUS 4.63 |
| The markers lane sits **under the waveform**; **[ / ] also stop at section boundaries**; timeline markers are **separate from the lyrics' `[Chorus]` section markers** | ui-spec §3 lists a Markers track without placing it | the waveform stays the scrub strip; the keys work before any marker exists; lyrics own their structure | STATUS 4.69 |
| **No built-in presets**; the Presets panel opens on MilkDrop | D16: modules ship starting presets | the owner: they were generated and did not look good | STATUS 4.84 |
| **Software H.264 where NVENC will not open** | PROJECT.md and export-spec: NVENC, no CPU fallback | an app that cannot export on most PCs is no release; NVENC stays first wherever it works | STATUS 4.85 |
| **MilkDrop is in** (C15 was last in line), through Butterchurn; its presets run as code from a pinned package; no checkpoints, a final render replays from frame 0 | PROJECT.md C15: not a target look, determinism-hostile; export-spec §8 asks for checkpoints | the owner asked for well-made visuals; seeding `Math.random` and a fixed step made it byte-identical; replay meets the contract at the cost of time on a late start | STATUS 4.83 |
| **librosa only**, no madmom; refinement is **stored in the project** and **offered, not automatic** | D28 and PROJECT.md S16 name both tools and "an optional pass" | madmom has no Windows wheels, and the lock is wheels only; a render must not need Python; for music on a click the built-in grid is only as good as its tempo, but refining is still an edit to the project | STATUS 4.77 |
| **Emoji are monochrome** unless a title asks for colour (STATUS 4.89), and one CJK font (Japanese forms) serves Chinese and Korean | PROJECT.md S17 lists emoji and non-Latin scripts without saying how | text effects work from coverage masks, which colour bitmaps do not have; a project can choose its own font, which goes first | STATUS 4.76 |
| The **vignette now darkens and keeps alpha** (it used to fade the edges to transparent) | module-spec §6 says only "darkens toward the edges" | a LUT after it graded see-through corners; on a layer, darkening is what "vignette" means | STATUS 4.73 |
| **Dropped audio files open the Batch dialog**, even one; a CLI folder is read **one level deep**; "shut down when done" waits **two minutes** | export-spec §12 says "optional shutdown-when-done" and nothing about drops or folders | the dialog is where the folder and preset are chosen; a library's subfolders are albums; two minutes to see it and cancel | STATUS 4.68 |
| Motion-blur subframes **keep the frame's index** (only `t` moves), and one **before the timeline is held at 0** | export-spec §9 gives the shutter interval only | a video layer has one decoded frame per frame and its own motion blur; grain keyed on the frame should not smear; frame 0 has nothing before it | STATUS 4.66 |
| Masks are applied **in canvas space** (the source as drawn in the frame, after both layers' transforms); a source that is **off leaves the target unmasked** | compositor-spec §5 places the mask step before the target's transform and does not say what an off source means | "a shape masks what is under it on screen" is what people expect; switching a mask's eye off to compare is a common gesture | STATUS 4.65 |
| **The VoxPopuli alignment models (fr, de, es, it) are CC BY-NC 4.0** — non-commercial | PROJECT.md §3 wants open licences | they are what WhisperX uses for these languages. **Decided by the owner 2026-10-30:** they stay, as optional downloads with a notice that needs a tick | STATUS 4.62, 4.80 |
| The offline rebuild check is **a command and a Settings button, not a CI job** | P1 exit: "passes a networking-disabled end-to-end run in CI" | the repo has no CI; the check runs the same rebuild locally with the network made unusable | STATUS 4.62 |
| **MilkDrop presets** (PROJECT.md §3 extras) are not provisioned | extras tier | there is no MilkDrop renderer in the app to use them | STATUS 4.62 |
| The Settings screen **shows the GPU and the keyboard map** rather than letting them be chosen | PROJECT.md §8.16 lists GPU device selection and a shortcut map | Chromium chooses the WebGL device and offers no per-app switch; shortcuts have remapped since 4.81 | STATUS 4.59 |
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

---

## 6. What is left

Every Must-have and Should-have is done. These are the gaps inside finished features, smallest
effect on a finished video last. Each is noted beside its requirement in §2.

**Lyrics:** transcribed line breaks follow Whisper's segments, and text over a busy MilkDrop preset can be hard to
read (STATUS 4.86).

**Before a public release:** a PC with no NVIDIA card has not been tried, only this one with NVENC unusable;
stems and lyrics through the chooser from a fresh clone (done with the setup command, not the chooser); moving
the FFmpeg pin before BtbN drops it, around 2028.

**Visuals:** MilkDrop is in, and the director uses it (STATUS 4.83, 4.84). ISF is in as a dialect and an optional
component (STATUS 4.89): 105 of Vidvox's 327 files run; point2D inputs, more image inputs and passes are what
would bring in the rest. The Shadertoy `input` channel darkens what it reads (mid-grey 128 comes out 55): fixing
it changes existing projects, so it waits for the owner. Hydra is ruled out (AGPL would bind
the whole app). LYGIA and gl-transitions have unchecked licences, and Shadertoy's site default is
non-commercial, so nothing is bundled from it without checking each shader.

**Auto-director (Could-level in the spec):** `derive-from-image` palettes; "Extract as template";
palette shifts at a chorus; converting arrangement curves to keyframes.

**Text:** colour emoji in lyrics, vertical lyrics (STATUS 4.89 did titles), Thai word segmentation.

**Components:** removing one from the app (today: delete its folder under `vendor/`).

**The owner's decisions:** §4, above all whether to keep offering the non-commercial alignment models.

**Could-haves (C1–C15):** optional, not started.
