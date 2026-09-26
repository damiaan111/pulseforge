# Build status — handoff document

> **Read this first in any new session.** It records what exists, how it works, how it was
> verified, what is known to be missing, and what to do next. Update it at the end of every step,
> in the same commit. **`docs/ROADMAP.md`** is the companion: every requirement (M1–M40, S1–S19)
> with its state and what is left, and the recommended order of the remaining work.
>
> **Last updated: 2026-09-26.** P0, **P1**, P2, P3, P4, **P6 (lyrics), P7 (the auto-director) and operability are complete** (P1: core,
> stems and lyrics tiers). The studio runs end to end: import audio, build a look from 25+ layer and effect
> modules (2D visualizers, text, logo, image/video backgrounds, groups, drop-in shader modules, three
> Three.js scenes), browse and save presets, preview on the audio clock, and queue NVENC renders at
> any aspect. Last full verification: `npm run check` 1132 tests, `npm run golden` 29/29 identical,
> `--smoke` 32/32 (33/33 with the queued render), `npm run setup -- --verify` and `--rebuild-check` pass.
>
> **Since P4:** modulation can now be wired in the studio (M13, §4.46); the analysis computes the
> project's own bands (§4.45); ten separable blend modes, layer solo/lock/reorder/drag and time
> ranges, and the audio clip's trim, padding, fades and gain are all editable and rendered (§4.47);
> and **stems work end to end** — Demucs from the studio through the supervised sidecar and a
> global GPU queue, every stem analysed and cached, stem sources live in the preview and exports
> (§4.48); and **autosave with crash recovery** — rolling snapshots every minute and before a
> preset is applied, offered back after a crash with a summary of what they hold (§4.49).
>
> **P6, lyrics (§4.50–§4.55):** the lyrics model and five subtitle formats; the karaoke layer with
> seven fill modes; the lyrics editor, tap-to-sync with latency calibration, and a lyrics lane on
> the zoomable timeline with the vocal level behind it; and WhisperX transcription and word
> alignment on the vocal stem, through the GPU queue, offline.
>
> **P7, the auto-director (§4.56–§4.58):** a complete, editable project from a track. Seven
> hand-authored templates are matched to the track's style, and the palette is generated with
> contrast enforced. Modulation is calibrated to the track's own statistics. The arrangement follows
> its sections (intensity, layers entering and leaving, drops, the title clearing before the
> vocals), guardrails run last, and a plain-language decision log says why. In the studio: the Auto
> drawer, Generate (offered on import), Surprise me with locks and a thumbnail history, and
> `npm run contact-sheet` to check the templates across a folder of tracks.
>
> **Operability (§4.59–):** the Settings screen (M36) — theme, autosave interval, models, export
> default, setup verify and repair from the app, the environment and a shortcut reference; and
> Storage (M33) — one cache root, a breakdown by category and track, remove/clear/keep-the-last-N,
> an LRU size limit that never touches what is in use, and a low-disk warning; and diagnostics
> (M34) — rotating JSON-lines logs of the main process and the studio, a level setting, Open log
> folder and Copy diagnostics (also on a failed render).
>
> **P1 finished (§4.62):** the extras tier — `htdemucs_ft`, Whisper `large-v3`, word alignment for
> French, German, Spanish and Italian — installable one at a time from Settings, and an offline
> rebuild check that builds a second Python environment from the wheelhouse with the network made
> unusable.
>
> **P8 (§4.63–):** keyframe automation (S1) is done: spec (`docs/keyframes-spec.md`), model, file
> format and commands, engine evaluation for parameters, effects, opacity and transform, and editing
> in the studio — diamonds and auto-key in the inspector, a key editor with easing presets and a
> Bézier curve editor, and keyframe rows in the timeline (drag, snap, Alt-copy, Delete).
>
> Masking (S7) is done too (§4.65): any layer masks another by shape or brightness, inverted and
> feathered, and a mask source is hidden unless shown. So is motion blur (S10, §4.66): an export
> option that averages 4–16 subframes across a 90–360° shutter, in the export dialog and the CLI.
> And the 6-stem model (S6, §4.67): `htdemucs_6s` is an optional model that adds guitar and piano
> stems, chosen per project. And batch mode (S13, §4.68): drop tracks onto the studio, or
> `npm run batch`, and each becomes an auto-directed project and a render, with a notification and
> an optional shutdown when everything is finished.
>
> **Biggest gaps, in order** (details and the rest in ROADMAP.md): the rest of P8 — markers (S9),
> Shadertoy compatibility (S2), LUTs (S11), the performance HUD (S12), karaoke export (S15),
> librosa (S16), Unicode fonts (S17) and draft mode (S18).

**Contents** — §1 where we are · §2 environment · §3 commands · §4 what exists (below) ·
§5 measured results · §6 decisions made while building · §7 known gaps · §8–§10 phase summaries

| §4 | Area |
|---|---|
| | **Foundation, engine, spike (P0–P2)** |
| 4.1 | Tooling |
| 4.2 | Provisioning (`setup/`) |
| 4.3 | Engine (`src/engine/`) |
| 4.4 | Analysis (`src/analysis/`) — M4, P3 step 3 |
| 4.5 | Export (`src/export/`) |
| 4.6 | ML sidecar |
| 4.7 | Project document (`src/project/`) — P2 step 1 |
| 4.8 | Layout & aspect (P2 step 2) |
| 4.9 | Spike and validation harness (`spike/`) |
| 4.10 | Modulation & value resolution (P2 step 3) |
| 4.11 | Effect chain (P2 step 4) |
| 4.12 | Golden frames (P2 step 5) — `npm run golden` |
| 4.13 | Headless render CLI (P2 step 6) — `npm run render` |
| | **Studio (P3, plus logic built ahead of time)** |
| 4.14 | App shell (`src/shell/`, `src/ui/`) — P3 step 1 |
| 4.15 | Commands and undo (P3 step 2) — M8, ui-spec §10 |
| 4.16 | Preview clock (P3 step 4) — M31, PROJECT.md §8.12, export-spec §3 |
| 4.17 | Analysis cache tree — M4, M33, data-formats §4 |
| 4.18 | Waveform peaks — ui-spec §3, data-formats §4.1 `peaks/` |
| 4.19 | Presets (M25, module-spec §10, data-formats §3) |
| 4.20 | Two group bugs in `toRenderProject` — fixed |
| 4.21 | Section detection — PROJECT.md §8.1, auto-director-spec §2 |
| 4.22 | Code audit (`d527f8e`) — five bugs found and fixed |
| 4.23 | Render queue and progress (M24, export-spec §12–13) |
| 4.24 | Supervised ML sidecar (M27, PROJECT.md §3) |
| 4.25 | Preset store on disk (M25, S8's data layer) |
| 4.26 | Auto-director classification (M21, auto-director-spec §2–3) |
| 4.27 | The React studio (P3 step 5) — ui-spec |
| | **Library (P4)** |
| 4.28 | The visualizer library, first batch (P4 step 1) — M11, module-spec §6 |
| 4.29 | The visualizer library, second batch (P4 step 2) — M11 complete |
| 4.30 | The effect library (P4 step 3) — M12 complete |
| 4.31 | The effect chain in the studio (P4 step 4) — M12's other half |
| 4.32 | The palette (P4 step 5) — M17, compositor-spec §9 |
| 4.33 | One document → video pipeline (P4 step 6) |
| 4.34 | Render queue in the studio (P4 step 7) — M24, ui-spec §7 |
| 4.35 | Background layer and image assets (P4 step 8) — M14, data-formats §1.2 |
| 4.36 | Code and UI audit (2026-09-15, owner request) |
| 4.37 | Asset library (P4 step 9) — M40, D6, data-formats §1.2, ui-spec §5 |
| 4.38 | Text layer (P4 step 10) — M16, M32, PROJECT.md §8.13, §8.7 |
| 4.39 | Layer groups (P4 step 11) — M38, compositor-spec §1 |
| 4.40 | Logo layer (P4 step 12) — M15 |
| 4.41 | Video layers (P4 step 13) — M39, M14, D4, compositor-spec §8 |
| 4.42 | The `modules/` drop-in folder (P4 step 14) — M35, module-spec §11, PROJECT.md §8.17 |
| 4.43 | Three.js scene layers (P4 step 15) — M37, compositor-spec §7, module-spec §1 |
| 4.44 | Preset browser (P4 step 16) — S8, M25, ui-spec §5, module-spec §10, D16, D45 |
| | **After P4** |
| 4.45 | The project's own analysis bands — M4 |
| 4.46 | Modulation in the studio — M13, modulation-spec §10–§11, ui-spec §4, §6 |
| 4.47 | Blend modes, layer editing and the audio clip — M7, M9, M29 |
| 4.48 | Stems end to end — M5, M27, M28 |
| 4.49 | Autosave and crash recovery — M1 |
| | **Lyrics (P6)** |
| 4.50 | Lyrics data (P6 step 1) — M18 model, lyrics-spec §1–§2, §9, §10 |
| 4.51 | The karaoke layer (P6 step 2) — M20, lyrics-spec §6–§8 |
| 4.52 | Fix: audio modulation read the wrong moment with a lead-in or a trim — M13, M29 |
| 4.53 | Lyrics in the studio (P6 step 3) — M18, M19 tap-to-sync, D33 |
| 4.54 | The lyrics timeline track (P6 step 4) — M19, lyrics-spec §5, ui-spec §3 |
| 4.55 | WhisperX transcription and alignment (P6 step 5) — M26, the lyrics setup tier |
| | **Auto-director (P7)** |
| 4.56 | Groundwork: the curve source, the whole-frame chain, group bindings fix (P7 step 1) |
| 4.57 | The director and its seven templates (P7 step 2) — M21, auto-director-spec §1–§9, §11 |
| 4.58 | The Auto drawer, Surprise me and the contact sheet (P7 step 3) — M21, M22 complete; D9 |
| | **Operability** |
| 4.59 | The Settings screen (operability step 1) — M36, PROJECT.md §8.16, ui-spec §8 |
| 4.60 | Storage: one cache root, breakdown, prune, LRU limit, low disk (operability step 2) — M33 |
| 4.61 | Logs and diagnostics (operability step 3) — M34 complete |
| | **P1 remainder** |
| 4.62 | The extras tier, measured; per-project stem model; the offline rebuild check — M2, P1 complete |
| | **P8 — Should-haves** |
| 4.63 | Keyframes: spec, model, commands, engine (P8 step 1) — S1 |
| 4.64 | Keyframes in the studio: inspector, key editor, timeline rows (P8 step 2) — S1 complete |
| 4.65 | Masking (P8 step 3) — S7 |
| 4.66 | Motion blur (P8 step 4) — S10 |
| 4.67 | The 6-stem model (P8 step 5) — S6 |
| 4.68 | Batch mode (P8 step 6) — S13 |

---

## 1. Where we are

| Milestone | State |
|---|---|
| Planning (PROJECT.md, docs/*-spec.md, decisions D1–D50) | ✅ complete |
| **P0 — Spike** | ✅ **complete** — `npm run validate` passes 8/8; measurements in PROJECT.md §4 and `docs/validation/p0-full-report.md` |
| **P1 — Provisioning** | ✅ **complete** (2026-09-25) — core, stems and lyrics tiers (§4.2, §4.55), the extras tier and the offline rebuild check (§4.62) |
| **P2 — Engine** | ✅ **complete** — all six steps done (see §4.7–§4.13, §8) |
| **P3 — Studio** | ✅ **complete** — all five steps done (see §4.14–§4.27, §9) |
| **P4 — Library** | ✅ **complete** — M11 ✅, M12 ✅, M17 ✅, effect chain in the studio ✅, render pipeline shared by CLI and queue ✅, render queue UI ✅, background layer M14 ✅, asset library M40 ✅, text layer M16/M32 ✅, layer groups M38 ✅, logo M15 ✅, video layers M39 ✅, `modules/` drop-in folder M35 ✅, Three.js scene layers M37 ✅, preset browser S8 ✅ (§4.28–§4.44) |
| P5 — Export | 🔶 largely delivered early — deterministic NVENC export at every aspect, presets, queue with progress/cancel, render reports (M23, M24, M30); open: quality-option UI, capability-probed codec list in the dialog, diagnostics (M34) |
| **P6 — Lyrics** | ✅ **complete** (2026-09-25) — lyrics data §4.50, karaoke layer §4.51, studio editor and tap-to-sync §4.53, timeline track §4.54, WhisperX §4.55 |
| **P7 — Auto-director** | ✅ **complete** (2026-09-25) — groundwork §4.56, the director and seven templates §4.57, the Auto drawer, Surprise me and contact sheets §4.58 |
| P8 — Expansion | ⬜ not started (CLI S14 and collect-files S19 already done) |

P4 steps:

| # | Step | State | Commit |
|---|---|---|---|
| 1 | Four visualizers + analysis-texture helper | ✅ | `79574d3` |
| 2 | Five visualizers — M11 complete | ✅ | `50f32db` |
| 3 | Eight effects — M12 complete | ✅ | `a59a6c7` |
| 4 | Effect chain in the studio | ✅ | `6f3c196` |
| 5 | Palette system (M17) | ✅ | `1170fd1` |
| 6 | One document → video pipeline, abortable (`src/export/render-document.ts`) | ✅ | `8ad784b` |
| 7 | Render queue in the studio: export dialog, queue drawer; EXDEV fix | ✅ | `024fd7c` |
| 8 | Background layer (M14): solid/gradient/image, fit modes, Ken Burns; image assets end to end | ✅ | `e20d14c` |
| — | Code and UI audit (§4.36) | ✅ | `96520b9` |
| 9 | Asset library (M40): status, relink, find-in-folder, collect files, relative paths, library folder | ✅ | `daaea3b` |
| 10 | Text layer (M16, M32): deterministic rasterisation, per-word metrics, styling, animation, bundled fonts | ✅ | `5472289` |
| 11 | Layer groups (M38): real group compositing, group/ungroup in the studio | ✅ | `1c9efa7` |
| 12 | Logo layer (M15): sized image with aspect kept, tint and reactive pulse | ✅ | `1a42b07` |
| 13 | Video layers (M39): deterministic frame cache, engine video store, export + preview | ✅ | `c81752b` |
| 14 | `modules/` drop-in folder (M35): declarative shader modules, hot reload, authoring guide, `npm run modules:check` | ✅ | `64d1b36` |
| 15 | Three.js scene layers (M37): shared-context host, camera rig, shape/terrain/city scenes, depth → depth of field | ✅ | `c2561d0` |
| 16 | Preset browser (S8): browser panel, animated thumbnails, save dialog, partial apply, 14 built-in presets | ✅ | `c980c7c` |

P3 steps:

| # | Step | State | Commit |
|---|---|---|---|
| 1 | App shell: safe process layout, typed IPC, project I/O | ✅ | `cab80a0` |
| 2 | Command/undo stack (M8) | ✅ | `59000e0` |
| 3 | Analysis pipeline: features, onsets, beat grid (M4) | ✅ | `05471d4` |
| 4 | Preview clock (M31) | ✅ | `f3153e8` |
| 5 | React studio (ui-spec) | ✅ | `a571971` |

P2 steps:

| # | Step | State | Commit |
|---|---|---|---|
| 1 | Project document v1: schema, parse, migrate, serialise, `toRenderProject` | ✅ | `ce8b68f` |
| 2 | Layout & aspect system | ✅ | `830bea9` |
| 3 | Param resolution + modulation evaluator | ✅ | `91c18db` |
| 4 | Effect chain contract + bloom/vignette | ✅ | `117cb4e` |
| 5 | Golden frames | ✅ | `d1bfe6e` |
| 6 | Headless render CLI | ✅ | `f1c95fc` |

P0 steps:

| # | Step | State | Commit |
|---|---|---|---|
| 1 | Scaffolding + engine boundary lint | ✅ | `2152b91` |
| 2 | `npm run setup` provisioning | ✅ | `2152b91` |
| 3 | Deterministic engine + GPU determinism spike | ✅ | `0a0f2ba` |
| — | D48/D49, this document | ✅ | `8d00833` |
| 4 | Export pipe: readback, GPU NV12, NVENC, audio mux, verify, report | ✅ | `56cf79a` |
| 5 | `npm run validate` + Python sidecar + test modules | ✅ 8/8 pass | `38d5362` |

**Starting a new session:** open Claude Code in `D:\pulseforge` and say: *"Read CLAUDE.md, docs/STATUS.md
and docs/ROADMAP.md, run `npm run check` and `npm run golden`, then continue with the next item in
ROADMAP.md §3. Keep STATUS.md and ROADMAP.md updated and commit after each step."*

---

## 2. Environment (the RTX machine)

- Repo: `D:\pulseforge` (must stay on D:, C: has ~19 GB free). Git branch `main`, remote `origin` = `github.com/damiaan111/pulseforge` (push with `git push origin main`; `gh` is logged in). No CI is configured.
- Hardware: Ryzen 7 3800X (16 threads), 16 GB RAM, RTX 3060 12 GB, driver 616.92, PCIe Gen3 x16, Windows 11 (10.0.26200).
- Node 24.19. Node-side scripts run TypeScript directly (type stripping); Electron-side code is bundled with esbuild.
- System-wide Python 3.11 and `C:\ffmpeg` exist on PATH — **never use them**; everything goes through `vendor/` by absolute path.
- Shell gotchas: never edit files with PowerShell `Get-Content | -replace | Set-Content` (re-encodes UTF-8).
  Python's `pathlib.write_text` has the same hazard in a different form — it translates `\n` to
  `\r\n` on Windows, against `.gitattributes`' `eol=lf`. Use the editor's own edit tooling, or
  `sed -i`, for text edits.
  In the Bash tool, avoid `cd` (it moves the session's working directory). FFmpeg `crop` needs ≥ 2×2 on 4:2:0.
- Do not run GPU work (spikes, validate) concurrently with benchmarks — it skews timings.
- **`%APPDATA%\Electron` (the dev app's userData) is a redirected folder** (`C:\WpSystem\…`):
  `rename` inside it fails with EXDEV even within one directory. Every temp-then-rename write goes
  through `src/node/rename-into-place.ts`, which falls back to copy. Before that fix the render
  queue crashed the studio at startup, and the studio's analysis cache silently never saved.
- `npm run dev -- --smoke` opens a real window on the owner's screen for a few seconds. Results
  are in `out/smoke-result.json` (stdout from Electron does not reliably reach a captured shell).
  `PULSEFORGE_SMOKE_RENDER=<audio file>` adds a real queued render from inside the app.

---

## 3. Commands

| Command | What it does | Time |
|---|---|---|
| `npm install` | deps (TypeScript 6.0, ESLint 10, Vitest 5, Electron 44.3.0, esbuild 0.28.2, **three 0.186.0 — pinned exactly**, React 19) | once |
| `npm run check` | typecheck + lint + 1002 tests in 82 files (FFmpeg/Python tests skip without `vendor/`; GPU tests in `tests/golden/*-gpu.test.ts` skip without Electron) | ~70 s |
| `npm run setup` | provision `vendor/` (FFmpeg, **Inter fonts**, Python, uv, Demucs; **WhisperX, Whisper medium, wav2vec2** for the lyrics tier); `--plan`, `--verify`, `--relock`, `--from <dir>`, `--tier core,stems,lyrics` | first run ~15 min |
| `npm run validate` | the eight P0 checks → `out/validate/report.md` + `report.json`; `--quick` (~5 min), `--only 2,4,8` | ~11 min full |
| `npm run dev` | bundle and launch the app; extra args open a project (`-- song.pvproj`) | ~15 s |
| `npm run build` | bundle the app to `dist/app/` without launching | ~1 s |
| `npm run dev -- --smoke` | launch, self-check the security posture and core UI flows, screenshot to `out/smoke.png`, verdict in `out/smoke-result.json`, exit. Env: `PULSEFORGE_SMOKE_RENDER=<audio>` adds a real queued render; `PULSEFORGE_UI_TOUR=1` adds screenshots of dialogs, drawer, override mode and toast at two window sizes to `out/ui-tour/` | ~5–30 s |
| `npm run batch` | `-- <tracks or folders…> -o <folder>`; `--preset`, `--template`, `--seed`, `--stems`, `--motion-blur`, `--seconds`, `--direct-only` — every track auto-directed into a project and rendered (§4.68) | minutes per track |
| `npm run render` | `-- <project.pvproj> -o <out.mp4>`; `--aspect`, `--size`, `--codec`, `--audio`, `--seconds`, `--quiet`, `--motion-blur`, `--blur-samples N`, `--shutter DEG` | seconds |
| `npm run golden` | re-render the golden set (`tests/golden/goldens.json`: neon-bars, layered, scene3d, lyrics) and compare with the committed references; `--update`, `--only <name>` (an `--only` update keeps the other entries' references) | ~40 s |
| `npm run presets:builtin` | regenerate `presets/builtin/` from `scripts/make-builtin-presets.ts` (refuses unknown modules/keys); commit the diff | ~2 s |
| `npm run modules:check` | conformance test for drop-in modules in `modules/` (params, compile, determinism, reflow) → `out/modules-check.json`; `-- <dir>` for another folder | ~15 s |
| `npm run spike:determinism` | engine determinism on GPU; `--4k`, `--seconds N`, `--audio <file>` | ~30 s |
| `npm run spike:export` | real export ×2 with comparison + timings; `--4k`, `--seconds`, `--codec h264\|hevc`, `--conversion gpu-nv12\|swscale`, `--readback sync\|async`, `--depth`, `--no-hash`, `--runs`, `--audio` | ~1 min |

Outputs go to `out/` (gitignored). `--only` rewrites report.md with the other checks marked skipped.

---

## 4. What exists, by area

### 4.1 Tooling
- TypeScript strict + `exactOptionalPropertyTypes`, `erasableSyntaxOnly`, `.ts` import extensions.
- ESLint engine boundary on `src/engine/**` (proven by `tests/lint/engine-boundary.test.ts`); named exports only;
  `_`-prefixed unused names allowed. Stay on TypeScript `~6.0.3` until typescript-eslint supports 7.

### 4.2 Provisioning (`setup/`)
- Pins in `setup/manifest.ts`: FFmpeg n8.1.2 LGPL, python-build-standalone 3.11.16, uv 0.12.13, htdemucs weights.
- `setup/python/requirements.lock.txt`: torch 2.13.0+cu130, demucs 4.1.0, numpy (explicit — demucs omits it off macOS).
- Wheelhouse in `vendor/wheelhouse/`, offline install, isolation from system Python, `vendor.lock.json`, `LICENSES.md`.

### 4.3 Engine (`src/engine/`)
| File | Contents |
|---|---|
| `core/time.ts` | rational fps, 48 kHz ticks, `frameCount`, `frameTimeSeconds`, `frameStartTick`, `timelineToSourceSeconds` |
| `core/prng.ts` | keyed `hash32`/`random01`/`createPrng` + `HASH_GLSL` (outputs pinned by snapshot) |
| `core/color.ts` | transfer functions, hex, premultiply, D48 tone shoulder (`TONEMAP_KNEE = 0.9`) + `COLOR_GLSL` |
| `core/params.ts` | param schema + `resolveParams` (full module-spec §5 order: base → modulation → clamp → coerce) |
| `core/analysis.ts` | analysis tracks and sampling |
| `core/layout.ts` | anchors, scale references, layer transform matrix (§4.8) |
| `core/modulation.ts` | binding compilation, precomputed envelopes, signal chain, accumulation (§4.10) |
| `core/module.ts`, `core/project.ts` | module contract; `RenderProject` P0 snapshot |
| `render/gl.ts` | context requirements + `ContextInfo` (renderer, versions, limits, extensions), shader errors with source lines |
| `render/targets.ts` | pooled `rgba16f` / `rgba8` / `rgb10a2` targets |
| `render/compositor.ts` | linear premultiplied compositing (normal/add/screen) → tonemap → OETF → seeded dither (8/10-bit) → output |
| `render/yuv.ts` | GPU BT.709 limited-range NV12 packed into RGBA8 targets |
| `render/readback.ts` | async PBO ring + sync readback (8- and 10-bit) |
| `render/effects.ts` | `runEffectChain` — ping-ponged pooled targets, stated ownership (§4.11) |
| `modules/bars.ts` | `core.visualizer.bars` |
| `modules/bloom.ts`, `modules/vignette.ts` | `core.effect.bloom` (bright-pass + separable Gaussian + additive), `core.effect.vignette` |
| `modules/test-pattern.ts` | `core.test.pattern` — 24 fixed patches (`TEST_PATTERN_COLORS`) for colour measurement |
| `modules/flash.ts` | `core.test.flash` — full-frame flash on a timeline schedule (`flashLit`) for sync measurement |
| `engine.ts` | `createEngine(gl, {quality, output, packing})`, `renderFrame`, `readOutputSync`, `createSyncReadback`, `createReadback`; `ENGINE_VERSION = '0.1.0-p0'` |

### 4.4 Analysis (`src/analysis/`) — M4, P3 step 3
| File | Contents |
|---|---|
| `decode.ts` | `decodeMono48k` via the vendored FFmpeg, by absolute path |
| `fft.ts`, `spectrum.ts` | FFT 2048 → 64 log bins, named bands, **and the scalar features, all in one STFT pass** |
| `features.ts` | `levelToUnit`, `spectralCentroid`, `spectralFlux`, windowed RMS/peak, `stereoWidth`, `detectOnsets`, `detectTempo`, `beatPulse` |
| `analyze.ts` | `analyzeMix` — the single entry point, so the CLI, the app and the spikes produce identical numbers |
| `container.ts` | the binary cache format (data-formats §4.2): float32 LE, JSON header, versions checked on read |
| `cache.ts` | the on-disk cache tree (§4.17) — keys, readiness, listing, pruning |
| `cached.ts` | `analyzeCached` — the cache in front of `analyzeMix` |
| `peaks.ts` | the waveform peak pyramid the timeline draws from (§4.18) |
| `sections.ts` | structural section detection for the arranger (§4.21) |

- Features: `rms`, `peak`, `onset`, `beat`, `centroid`, `flux`, and `stereoWidth` when a stereo
  decode is available. **All on one 0..1 scale** (sine-equivalent dBFS against the floor), so a
  modulation amount means roughly the same thing wherever it is pointed.
- Onsets are peak-picked against an **adaptive** threshold — a local mean plus a margin. A fixed
  threshold either misses the quiet intro or fires continuously through the loud section, which
  is why naive detectors feel broken on dynamic material. Each onset becomes a decaying impulse.
- Tempo by autocorrelation of the onset envelope, then phase by trying every offset within one
  beat. The grid is a **list of beat times**, not a BPM and an offset, so tempo drift is
  representable (modulation-spec §6.1) when a drift-aware detector (S16) arrives. Confidence
  measures how far the winning lag stands out; silence reports no grid rather than a confident
  wrong tempo. `bpmOverride` lays the grid out without detecting.
- Where the grid is detected is a stated choice: the drum stem when there is one, the mix
  otherwise (PROJECT.md §8.1). Stems are not wired in yet, so today it is the mix.
- `ANALYSIS_VERSION = 2`. The container refuses to decode a different version rather than
  reinterpreting old numbers — that is how a stale cache survives a bug fix (data-formats §4.3).
  No checksum: the whole cache is rebuildable (M33), so corruption costs time, never data.
- **This unblocked the modulation sources built in P2 step 3.** `rms`, `peak`, `onset`, `beat`,
  `centroid`, `flux` and `stereoWidth` now resolve through the same path as bands; the evaluator
  needed no changes. Verified: golden frames byte-identical and `spike:determinism` still
  `5f0ade89…`, so adding the features changed no existing render.
- The on-disk cache tree landed separately — see §4.17.
- Not yet: stems analysis, workers, quantisation and beat-synced LFO rates (which now have a
  grid to use). Sections landed — §4.21.

### 4.5 Export (`src/export/`)
`ffmpeg-args.ts` (settings, D40 defaults, gpu-nv12/swscale, colour tags via `setparams`, bit-exact), `pump.ts`
(bounded pipeline), `encoder.ts` (FFmpeg process + diagnosis), `audio.ts` (exact placement), `verify.ts` (ffprobe
checks), `encoder-probe.ts`, `report.ts`, `job.ts` (`runExport`, optional `dither: false` for measurement).

### 4.6 ML sidecar
- `python/pulseforge_ml/` (`python -m pulseforge_ml`, cwd = `python/`): JSON lines on stdout
  (`progress` / `log` / `result` / `error`). Commands: `health` (python, torch, CUDA, cuDNN, demucs) and
  `separate` (raw float32 PCM in, htdemucs via `get_model(name, repo=vendor/models/demucs)`, per-segment
  progress from Demucs' callback, timings, peak VRAM, per-stem RMS, optional stem output files).
- `src/ml/sidecar.ts`: `runSidecar` (spawn, parse, progress callbacks, `SidecarError` with stderr tail), `parseSidecarLine`.
- Not yet: long-lived process, cancellation, supervisor/restart, GPU job queue (M27/M28), WhisperX.
  *Since: the supervisor, cancellation and restart landed in §4.24; the GPU job queue (M28) and
  WhisperX are still open.*

### 4.7 Project document (`src/project/`) — P2 step 1
| File | Contents |
|---|---|
| `document.ts` | `ProjectDocument` v1 types: canvas, audio clip/placement, analysis settings, palette, layers (module + group, nesting per M38), transform, time range, effects, modulation bindings, per-aspect overrides. `CURRENT_SCHEMA_VERSION = 1`, `RESERVED_DOCUMENT_KEYS`, `walkLayers`, `aspectBucket` |
| `ids.ts` | ULID-style 26-char Crockford base32 ids, injectable clock/RNG, `createTestIdFactory` for fixtures |
| `parse.ts` | `parseDocument` → `{ document, issues }`. Refuses (throws) a non-object, a missing `schemaVersion` and a future version; everything else is a reported, repaired issue. Every node keeps an `extra` bag of undeclared fields |
| `migrate.ts` | ordered `v(n) → v(n+1)` chain, forward-compat refusal, missing-step refusal, `backupPathFor` (`song.v3.bak`). Empty at v1 by design |
| `serialize.ts` | stable key order, `extra` written back, trailing newline |
| `load.ts` | text → migrate → parse, reporting `migratedFrom` so the shell knows to back up |
| `create.ts` | `createDocument` / `createModuleLayer` / `createGroupLayer` / `createEffect` / `createBinding`, default bands, D8 stem model |
| `snapshot.ts` | `toRenderProject` (flattens groups, applies solo/disabled-parent, carries time ranges) + `timelineDurationTicks`. Returns **notes** naming everything the document asks for that the engine cannot render yet |

Engine side: `LayerSpec.timeRange` (optional) and `layerIsLive`; `renderFrame` skips layers outside
their range, using the frame's start tick.

Not yet: undo/commands, presets, asset library, lyrics/automation/export-preset slots (reserved,
round-tripped untouched). *Since: undo §4.15, presets §4.19/§4.44, asset library §4.37; the
lyrics and automation slots are still reserved only.*

### 4.8 Layout & aspect (P2 step 2)
- `src/engine/core/layout.ts`: `ANCHORS`, `SCALE_REFERENCES` (the single definition — `src/project/`
  re-exports them), `LayerTransform`, `referenceLength`, `anchorFraction`, affine `Mat3` helpers,
  `layerMatrix` (forward + inverse), `isIdentityTransform`.
- Matrix is built in **document space** (y down, positive rotation clockwise) as
  `translate(position) · rotate · skew · scale · translate(−anchor)`, then conjugated into the
  compositor's y-up space. Identity in → identity out, so an untransformed layer takes the exact
  1:1 `texelFetch` blit and its pixels are unchanged from P0.
- `isIdentityTransform` compares the position against the **anchor fraction**, not against 0.5:
  anchored top-left at (0.5, 0.5) is a real move. Getting this wrong makes the transform work
  everywhere except that combination.
- Compositor: `CompositeLayer.inverseTransform` (optional). When present the layer pass samples
  with the inverse matrix, bilinear, with an explicit bounds test — `CLAMP_TO_EDGE` alone smears
  border texels across the canvas. Pooled targets are set to `LINEAR` at sample time.
- `RenderContext.canvas.referenceScale` is **per layer**, from that layer's `scaleReference`, so a
  logo on `min` and a full-bleed background on `max` each get the number they need.
- A collapsed transform (zero scale) is reported as a warning and the layer is skipped, rather
  than dividing by a zero determinant.
- `toRenderProject` applies the aspect override (step 2 of module-spec §5): the override replaces
  only the properties it declares, both for `transform` and for `params`.
- Group transforms still do not compose onto children (M38, step 4 territory) — noted, not dropped.

Verified on the GPU by `tests/golden/layout-gpu.test.ts` (Electron + the new `frames` spike mode,
`spike/lib/frames-run.ts`): orientation, centre-anchored scale, top-left anchor, and no edge
smearing, checked against the test pattern's known patch positions. Skipped where Electron is absent.

### 4.9 Spike and validation harness (`spike/`)
- `harness.ts` (bundle + run Electron), `electron/{main,renderer,protocol}.ts` (determinism and export modes; export config carries the whole `RenderProject`).
- `lib/determinism-run.ts` (`runDeterminismSpike`), `lib/export-run.ts` (`runExportSpike`).
- `validate.ts` + `validate/`: `context.ts`, `media.ts` (FFmpeg decode helpers), `projects.ts` (pattern, click, heavy projects; click track), `checks-render.ts` (2 determinism, 3 readback, 4 colour), `checks-system.ts` (1 environment, 5 encoders, 6 throughput, 7 stems, 8 sync).

### 4.10 Modulation & value resolution (P2 step 3)
`src/engine/core/modulation.ts` — the full signal chain of modulation-spec §4, with the
determinism trap designed out rather than managed:

- **Envelopes are precomputed, never accumulated.** `compileModulation` walks the whole track at
  240 Hz and builds each binding's smoothed signal as a derived track; render time is a
  sample-and-interpolate. A per-frame one-pole filter would make a seek and a playthrough
  disagree on some frames only — the most expensive bug this project could have.
- Identical `(source, range, curve, envelope, look-ahead)` share one derived track (D22).
- Compilation is cached in the engine on `(project, analysis)` **object identity** — sound
  because a `RenderProject` is an immutable snapshot — so the track walk never runs per frame.
- Sources implemented: `band`, `progress`, `ramp`, `lfo` (sine/triangle/saw/square/noise/
  sample-hold), `noise`. Everything else (`rms`, `onset`, `beat`, `centroid`, `flux`, structural,
  lyric, `parameter` chaining, beat-synced LFO, quantisation) is **reported as unsupported and the
  binding kept inactive** — they need analysis tracks or a beat grid that `src/analysis/` does not
  produce yet (§4.4), not modulation work.
- Curves: linear, exp/pow, log, s-curve, threshold, stepped. The `amount` mapping per curve is
  part of every project's appearance and is pinned by tests.
- Auto-calibration (§7): p10 → 0, p90 → 1 across the track. Generators skip it — they are already
  0..1, and calibrating an LFO is meaningless.
- Accumulation (§9): explicit `order`, id as tie-break so the document's array order never
  matters; `multiply` is `acc *= (1 + out)` (D21); `replace` ends the chain.
- Randomness is `hash(seed, bindingId, eventIndex)` keyed on the cycle number, never a counter.

`src/engine/core/params.ts` now implements the whole of module-spec §5: base → (aspect override,
applied in `snapshot.ts`) → automation (reserved, S1) → modulation → **clamp once at the end** →
coerce. Clamping moved to the end deliberately: an intermediate may legally exceed the range, so
`multiply` after `add` no longer behaves differently depending on where the base sat. Discrete
targets follow D25 — bool thresholds at 0.5, enums modulate by option index; colour and stem
params report that they have no numeric axis rather than guessing.

GPU-verified in `tests/golden/layout-gpu.test.ts`: a band-driven, enveloped binding renders
byte-identical frames whether the frames are reached in order or jumped to, and the frames do
differ from each other (so the check is not vacuous). `npm run spike:determinism` still produces
hash `5f0ade89…` — the unmodulated path is byte-for-byte unchanged from P0.

### 4.11 Effect chain (P2 step 4)
- `src/engine/render/effects.ts`: `runEffectChain` ping-pongs pooled targets, one per pass. The
  ownership contract is stated once — it **consumes** the source and returns a target the caller
  releases exactly once — so an empty chain and a five-pass chain free the same way.
- An effect never writes to its input: reading and writing one attachment is undefined in GL and
  shows up as driver-dependent tearing.
- `RenderContext` gained `input` (the layer's texture, effects only), `outputTarget` (the bound,
  cleared target — a multi-pass module binds its own framebuffers and needs the way back) and
  `targets` (the pool, for scratch). `CompositeLayer.draw` now takes its target.
- Chains run per layer *before* the transform and blend (compositor-spec §1), and once more over
  the finished composite for `globalEffects`. Layer chains address as
  `layers.<id>.effects.<effectId>.params.<key>`, global as `global.effects.…`, so effect
  parameters are modulatable through the same paths as everything else (module-spec §4).
- `core.effect.bloom`: bright-pass at half resolution, separable 9-tap Gaussian ping-ponged with
  a widening step, additive composite. Works in linear light on RGBA16F — bloom in sRGB is why
  glows look grey and muddy. The blur step is `radius × referenceScale`, never a pixel count.
- `core.effect.vignette`: aspect-corrected falloff with a `roundness` blend between a circle and
  the frame's own shape. Premultiplied, so edges do not gain a halo.
- `expandsBounds` is declared on the manifest but not yet acted on: layer targets are
  canvas-sized, so a halo already has the whole frame to spread into. Padding becomes real only
  when targets are sized to layer bounds.

GPU-verified in `tests/golden/effects-gpu.test.ts` (7 checks): bloom lights pixels the plain
render leaves black, a wider radius reaches further, the glow covers the same *fraction* of the
frame at 320×180 and 640×360 (resolution independence), vignette darkens edges and leaves the
centre, chain order changes the image, a disabled effect is byte-identical to no effect, and an
unknown effect module is reported rather than dropped.

### 4.12 Golden frames (P2 step 5) — `npm run golden`
The end-to-end check, and the thing that makes the determinism contract enforceable rather than
aspirational: it runs whole project **documents** through the real path — load → migrate → parse
→ `toRenderProject` → engine → compositor → readback — at several canvas shapes, and compares
pixels against committed references.

- `tests/golden/projects/*.pvproj` — `neon-bars` (bars + bloom + a global vignette, with
  per-aspect overrides) and `layered` (two layers, transform with rotation and non-uniform
  scale, screen and add blends, a time range, a band-driven binding and an LFO on an *effect*
  parameter).
- `tests/golden/goldens.json` — which project renders at which canvases and frames. One project
  is rendered at 16:9, 9:16 and 1:1, because that is the M30 promise being tested.
- `tests/golden/references/` — `manifest.json` (per-frame SHA-256 **plus the snapshot notes**)
  and a PNG per frame. 684 KB for 15 frames. `.actual.png` is written on failure and gitignored.
- Audio is the fixed synthetic track from `spike/test-signal.ts`, so the set needs no media
  asset in the repo.
- Tolerance, per export-spec §16: a **hash match is a pass**, full stop — that is the contract on
  this machine. A mismatch is measured (`spike/lib/compare.ts`: SSIM over 8×8 windows, max
  channel delta, MAE, share of changed pixels); within the cross-machine budget (SSIM ≥ 0.995,
  max Δ ≤ 8) it is reported as `near` and named as a different GPU/driver, beyond it as `FAIL`.
- The manifest stores the snapshot notes too, so a change in *what the engine silently cannot do*
  fails the run even when the pixels are identical.
- `--update` rewrites references (read the diff before committing — it is the record of what a
  change did to every project's appearance); `--only <name>` narrows the run. Exit code 1 on
  failure. Takes ~40 s.

Verified: 15/15 identical across two consecutive runs. A deliberate one-bar change to
`neon-bars` was caught at 16:9 (SSIM 0.835, max Δ 217) while 9:16 and 1:1 stayed identical —
because those aspects override `barCount`, which is the aspect system visible in the output.

### 4.13 Headless render CLI (P2 step 6) — `npm run render`
`src/cli/render.ts`: a project document on disk → an encoded MP4, no UI involved. It closes P2's
definition of done and is the proof that the engine really is separable from the shell — batch
rendering (S13) and CI become short steps rather than a rewrite.

```
npm run render -- <project.pvproj> -o <out.mp4>
    --aspect 16:9|9:16|1:1|4:5   render at that shape, keeping the project's pixel count
    --size WxH                   explicit canvas size
    --codec h264|hevc            default h264
    --audio <file>               override the document's audio path
    --seconds N                  render only the first N seconds
    --quiet
```

- Loading, decoding, analysis and reporting are plain Node; only the render itself goes through
  Electron, because a WebGL2 context needs Chromium.
- Audio paths resolve relative to the project file (data-formats §1.2), and the audio
  **placement** (lead-in, clip in/out) is now passed through the export config instead of being
  assumed zero — a project with lead-in silence would otherwise have exported out of sync with
  its own preview. That was a latent bug in the spike path, fixed here.
- Parse issues and snapshot notes are printed, never swallowed: a silently missing effect gets
  debugged as a broken module.
- Errors name the fix (`--codec av1` is refused up front, because Ampere has no AV1 encoder).
- Argument parsing and aspect sizing are unit-tested in `tests/cli/render-args.test.ts`. One bug
  found there: a leading `-` was treating `-30` as a flag, so no option could ever take a
  negative value.

Measured on the RTX 3060: the 640×360 golden project, 120 frames, ~320 fps end to end including
process startup, H.264 and HEVC 10-bit, both passing ffprobe verification.

**Known debt:** `src/cli/` imports the Electron render host from `spike/`. That host belongs in
`src/shell/` once P3 builds it; the CLI should then use the shell's, and `spike/` should go back
to being only a measurement harness.

### 4.14 App shell (`src/shell/`, `src/ui/`) — P3 step 1
| File | Contents |
|---|---|
| `shell/main.ts` | Electron main: the security posture (below), window, IPC handlers, environment report, `--smoke` self-check |
| `shell/preload.ts` | the only bridge: `contextBridge.exposeInMainWorld('pulseforge', …)`, CommonJS because a sandboxed preload has no ESM loader |
| `shell/ipc.ts` | the channel contract, shared by main, preload and UI so all three agree by construction |
| `shell/project-io.ts` | atomic writes (temp file + rename in the same directory) and the pre-migration `.bak` |
| `ui/boot.ts`, `ui/view-model.ts`, `ui/index.html`, `ui/styles.css` | the renderer: open/save, project summary, loader issues, snapshot notes, environment |
| `scripts/app.ts` | three esbuild bundles → `dist/app/`; `npm run build` / `dev` / `dev -- --smoke` |

**The security posture** — this closes the `nodeIntegration` gap carried since P0:
- Sandboxed renderer, `contextIsolation: true`, `nodeIntegration: false`, `app.enableSandbox()`.
- Navigation and `window.open` denied; external links go to the OS browser, never an in-app window.
- **Every non-local request is blocked at the session level**, with a loud console error naming the
  URL. PROJECT.md §3's "runs fully offline after setup" is enforced in code, so a stray CDN link
  fails visibly here rather than working on this machine and breaking on a disconnected one.
- Strict CSP (header + meta), permission requests denied, `webview` disabled.
- The renderer parses and serialises projects itself with the pure `src/project/`; only main
  touches the filesystem. A **lint rule** on `src/ui/**` blocks Node and Electron imports, and the
  renderer bundle is built with esbuild's `platform: 'browser'` so a stray `node:fs` fails the
  build. `tests/lint/engine-boundary.test.ts` proves both boundaries fire.

`npm run dev -- --smoke` verifies the posture on every run and screenshots the window: it asserts
the page rendered, the bridge is reachable, the renderer has **no Node** (`require`, `process`,
`__dirname` all undefined) and **cannot reach the network**. All four pass.

Also here: `pulseforge song.pvproj` opens a project from the command line (the file-association
path), and `FFPROBE_EXE` moved to `setup/lib/paths.ts` so the vendored tools have one definition.

Not yet: undo/commands, autosave and crash recovery, the React studio, menus and shortcuts.
*Since: undo §4.15, the studio and its shortcuts §4.27, autosave and crash recovery §4.49.*

### 4.15 Commands and undo (P3 step 2) — M8, ui-spec §10
- `src/project/history.ts` — **the document is immutable, so history is a list of documents, not
  a list of inverse operations.** Undo restores a previous reference; there is no `revert` to
  write and so no way for apply and revert to disagree, which is the bug every apply/revert
  design eventually has. Commands rebuild only the path they touch and share the rest, so an
  entry costs a handful of small objects rather than a copy of the project (pinned by a test).
- Merge keys collapse a slider drag into one undo step; `seal()` (pointer-up, blur) ends a run so
  the next edit of the same parameter is its own step. Keys include the edit target, so dragging
  in 16:9 and then in 9:16 stays two steps — they are two different stored values.
- Bounded (200 steps), labelled and **browsable**: `entries` + `jumpTo` give "undo twelve steps"
  in one click. `dirty` tracks the last save in both directions, and reads dirty when the saved
  point falls out of a trimmed history rather than claiming the file matches.
- `modifiedAt` is stamped here from an injectable clock, so commands stay pure and tests are
  byte-stable. Selection and panel state never enter history — undoing a selection is maddening.
- `src/project/commands.ts` — params, transforms, flags, name, opacity, blend, time range, mask,
  add/remove/move/duplicate layer, effects (add/remove/reorder/bypass/params), modulation
  bindings, canvas, audio, seed, palette.
- **Aspect-aware editing (D44)** is explicit in the API: most edits take an `EditTarget` of
  `'base'` or an aspect bucket. An override stores only the properties actually edited.
  `clearParamOverride` / `clearAspectOverride` are the inspector's reset-to-base.
- `duplicateLayer` regenerates every id (ids are never reused) **and retargets the copy's
  bindings at the copy** — otherwise duplicating a layer silently gives you two bindings driving
  the original. `removeLayer` clears masks that pointed at what it deleted.
- `moveLayer`'s `index` is into the destination list *after* the layer is removed. Documented
  and tested because a drop indicator counts positions in the list as it looks now, and the two
  differ by one whenever a layer moves down within its own parent.
- Wired into the renderer: labelled Undo/Redo buttons, a clickable history list, Ctrl+Z /
  Ctrl+Shift+Z / Ctrl+S, click a layer to hide it, double-click to rename. Every mutation goes
  through the stack — there is no second path that skips undo.

The launch smoke check now waits for `document.body.dataset.pulseforgeReady` before asserting,
and drives one real edit through the command stack. **That gate was added because the screenshot
disagreed with the checks**: they were racing the renderer's async startup and passing against an
empty project. Anything driving the window from outside must wait on that flag.

Not yet: autosave, crash recovery, multi-select editing, keyframes. *(Autosave and crash recovery since §4.49.)*

### 4.16 Preview clock (P3 step 4) — M31, PROJECT.md §8.12, export-spec §3
`src/ui/clock.ts`, 17 tests in `tests/ui/clock.test.ts`. A pure state machine: no DOM, no audio
element, no render loop — the caller reads the audio element and applies what the clock returns.

- **The audio is the master.** Each `tick(reading)` asks where the audio has reached and returns
  the frame *there*. The clock never advances time itself, so a slow frame skips frames and
  cannot drift. `dropped` reports how many were stepped over; they are never rendered.
- **Silent stretches.** During lead-in and lead-out there is no audio to follow, so the playhead
  rides a wall-clock anchor — which is re-synced from the audio on every audible tick, making the
  handover in both directions continuous rather than a jump. `frame.source` says which clock a
  frame came from, which is the first thing to look at if sync ever seems wrong.
- **Frames snap to the project grid** by default, so a preview frame is a time an export would
  also render. `snapToFrameGrid: false` exists for a continuous readout.
- Returns instructions rather than performing them: `seekAudioTo` (source position, already mapped
  through lead-in and trim) and `pauseAudio`. Loop regions wrap by asking for a seek.
- `seek()` renders exactly one frame even when paused or stopped — scrubbing is a rapid sequence
  of seeks. A seek to the frame already on screen still redraws; a *tick* onto the same frame
  does not.
- Stats over a rolling window: `renderedFps`, `droppedRecent`, `droppedTotal` — what ui-spec §2's
  dropped-frame indicator shows.

**Gotcha found here, worth knowing before writing anything similar:** `Math.floor(t * fps)` is
float-fragile exactly at frame boundaries — at t = 3 + 1/60, `t * 60` is `180.99999999999997`, so
the index lands one low and the tick renders nothing. Eight of thirty ticks collapsed that way in
the first test run. `frameIndexFor` now rounds to integer ticks first (1/48000 s, ~800× finer than
a 60 fps frame) and divides in integers. Anything else turning a continuous time into a frame
index should do the same.

Also added: `sourceToTimelineSeconds` in `src/engine/core/time.ts`, the exact inverse of
`timelineToSourceSeconds`, so both directions of the audio↔timeline mapping live in one file.
An `<audio>` element reports **source** time; the timeline differs by lead-in *and* trim. Passing
one where the other belongs is the risk PROJECT.md §10 flags, and it is exactly what the first
draft of these tests got wrong.

Not yet: the render loop itself, audio element wiring, and the on-screen indicator — all P3 step 5.
*Since: all three landed with the studio, §4.27.*

### 4.17 Analysis cache tree — M4, M33, data-formats §4
`src/analysis/cache.ts` + `src/analysis/cached.ts` (`f5325f1`), 23 tests in `tests/analysis/cache.test.ts`.
Closes the gap §4.4 left open: the container format existed, nothing wrote a keyed tree.

```
<root>/analysis/<audioHash>/<settingsHash>/
  meta.json      versions, key inputs, per-source readiness and sizes
  mix.bin        the container from container.ts — one file per source
  beatgrid.json  the grid *and the onset times*
```

- **`audioHash` is SHA-256 of the decoded PCM, not of the file**, so re-encoding the same audio
  into another container still hits the cache (data-formats §4.3).
- **`settingsHash` covers everything that changes the numbers**: spectrum settings, onset
  sensitivity, bpm override, stem model — and `ANALYSIS_VERSION`, the one that is easy to forget
  and whose absence keeps a fixed detector serving the old results out of cache. Band definitions
  contribute their *edges, not their names*: renaming a band keeps the cache, moving it does not.
  `meta.json` stores the readable key inputs next to the hash, so a cache that missed can be
  diffed rather than guessed at.
- **Readiness is per source** (`ready | pending | failed`, with the failure message). The mix
  finishes in seconds and stems take minutes, so a half-populated entry is the normal state; a
  pending source reads as *absent*, never as a track of zeros that looks like silence.
- `writeSource` merges into the existing entry, so stems can land one at a time; `createdAt`
  survives, `updatedAt` moves.
- A corrupt or foreign-version entry is a **miss, not an error** — the cache is rebuildable, so
  re-analysing quietly is the right answer. Writes are atomic (temp + rename, as `project-io.ts`).
- `list()` / `totalBytes()` / `prune(maxBytes)` / `clear()` are the data and the actions behind
  M33's cache panel. Pruning evicts least-recently-updated first and returns what it removed.
- **Onsets live in `beatgrid.json`.** They are not a track, so the container has nowhere to put
  them — and without this a cache hit silently loses the timeline's snap targets (ui-spec §3).
  Caught by a test, not by inspection.
- `analyzeCached(pcm, cache, options)` is the entry point: hit → read, miss → compute, write,
  return. `force: true` recomputes without changing the key. **A cache that cannot be written
  still analyses** — a full or read-only disk costs speed, never correctness.

Wired into `npm run render`: it analyses through the cache at `<repo>/cache/` and prints
`Analysis: cache hit (<hash>…)` or `computed and cached`. `--no-cache` re-analyses, which is the
first thing to try if a render looks like it is reacting to the wrong numbers.
`runExportSpike` gained an optional `analysis` input so the caller can supply one; the spikes pass
nothing and are byte-for-byte unaffected.

**Unverified on this machine:** the CLI wiring was written on the non-NVIDIA laptop, so
`npm run render` itself has not been executed since; typecheck, lint and the full suite passed
at that commit. On the RTX machine, run it twice on the same audio and confirm the second says
`cache hit` — and that `npm run golden` is still green, since the analysis path feeding the
engine changed shape.

Not yet: stem sources in the tree (nothing produces them yet), `derived/`, and
the app's own cache root — the CLI uses `<repo>/cache/`, the app will want its user-data
directory (M33).

### 4.18 Waveform peaks — ui-spec §3, data-formats §4.1 `peaks/`
`src/analysis/peaks.ts` (`5d07050`), 15 tests in `tests/analysis/peaks.test.ts`, plus 3 through the cache.
Built for P3 step 5's timeline, which cannot scan 14 M samples on every repaint.

- A **pyramid**: level 0 is 256 samples per bucket (~5.3 ms at 48 kHz), each level above halves
  the resolution. One pass over the audio plus a geometric tail; queries never touch the PCM.
- Each bucket stores **min and max**, not an average or an absolute peak. Averages flatten the
  envelope as you zoom out and absolute peaks lose asymmetry; min/max keeps the waveform looking
  like the same sound at every zoom, which is what makes it usable for lining lyrics up against
  (lyrics-spec §5). There is a test per failure mode.
- `peaksForRange(pyramid, start, end, columns)` picks the coarsest level with at least one bucket
  per column, so a whole-track view reads a few hundred buckets and a 20 ms view keeps full
  detail — same call either way. Columns past the end of the audio are zero, so the timeline
  draws a flat line rather than running off the array.
- `encodePeaks` / `decodePeaks` use the same shape as the analysis container (JSON header, then
  float32 LE) and refuse another format version rather than misreading it. Under 2% of the size
  of the PCM they describe.
- Stored at `peaks/mix.peaks` in the cache entry and returned by `analyzeCached`. **A missing
  peaks file is not a cache miss** — they cost one pass to rebuild from PCM already in hand, so
  the entry still counts as a hit.

Not yet: per-stem peaks (the timeline's expandable stem rows, ui-spec §3), and drawing them.
*Since: the timeline draws the mix's peaks (§4.27); per-stem rows wait for stems (M5).*

### 4.19 Presets (M25, module-spec §10, data-formats §3)
`src/project/presets.ts` (`a773cb3`), 20 tests in `tests/project/presets.test.ts`. Pure: the module defaults
it needs are injected as a `ManifestLookup`, so this file never imports the engine and the tests
need no GL.

- **Only non-defaults are stored.** A preset recording every parameter freezes that day's
  defaults forever, so improving a module default later could never reach presets already saved.
  Objects are compared by value, not reference, or every colour would look "changed".
- **Modulation targets are relative.** Bindings address `layers.<id>…`, and those ids belong to
  the document they came from. A preset stores `self.params.x` and rebinds on apply — so applying
  one twice gives two independent layers instead of two bindings fighting over the original.
  There is a test for exactly that.
- **Effect references are positional** (`self.effects.0.params.intensity`). Effect ids are
  regenerated on apply, so a stored id would dangle; "the first effect in the chain" survives.
- Binding ids are dropped on save and regenerated on apply. `bypass`/`solo` never travel — the
  document model already excludes them (modulation-spec §9.5).
- **Two apply semantics, deliberately separate.** By default applying a preset *replaces* the
  module — that is what "apply this preset" means. `keepModule: true` is module-spec §10's
  "replace module" case: keep the target's module and carry across only the keys it shares,
  **reporting every key left behind**. The first draft blurred these two into one confused
  branch; splitting them is what made the behaviour describable.
- `styleOnly` applies the look and leaves the target's own modulations alone; `keepName` keeps
  the layer's name.
- Nothing is silently dropped (CLAUDE.md constraint 4): an uninstalled module, a params schema
  version mismatch, a binding pointing outside the preset — each returns a note the UI can show.
- Groups cannot be saved as a preset: a group's meaning is its children's ids and their relative
  geometry, which does not survive being lifted out of its document. `createProjectPreset` skips
  them rather than failing.
- Assets are **referenced, not embedded** (D6). Nothing references assets yet, but the shape is set.

`applyProjectPreset` completes the loop: it replaces (or, with `merge`, adds above) the layers
and global chain, and adopts the palette unless `keepPalette` is set. It **never touches the
audio, canvas, seed or timing** — a project preset is a look, and the song it lands on is not
part of it, which is what makes "try this look on this track" one action. Asserted by a test,
because a preset that silently retimed a project is the kind of surprise no undo fully repairs.

Not yet: wiring into the UI (a Save Preset button, the browser and thumbnails — S8) and a preset
folder on disk. *Since: the folder is §4.25, the UI §4.44.*

### 4.20 Two group bugs in `toRenderProject` — fixed
Found while looking at what group compositing would need. Both were pure-logic faults in
flattening, both had a clearly correct answer, and both are now covered by tests.

- **A group's time range did not clip its children.** A group scoped to a section kept drawing
  everything inside it after the section ended. Now intersected with every ancestor's range:
  the tighter bound wins on each side independently, `null` means "to the end" and narrows
  nothing, and an empty result is left empty rather than clamped — the engine already reads that
  as never live, and rewriting it would hide the fact that the ranges do not overlap.
- **Soloing a group hid everything inside it** — the opposite of what solo means. A layer now
  counts as soloed if it or any ancestor is.

Golden frames are unaffected: neither golden project uses a group or a solo (checked, not
assumed). The change is still worth re-running `npm run golden` against on the RTX machine.

### 4.21 Section detection — PROJECT.md §8.1, auto-director-spec §2
`src/analysis/sections.ts` (`c3b53ed`), 12 tests in `tests/analysis/sections.test.ts`. Written now because
the arranger leans on it (auto-director-spec §6) and because it is pure DSP — no GPU needed.

- **Foote's method**: a self-similarity matrix over timbre, a checkerboard kernel slid down its
  diagonal, peak-pick the resulting novelty curve. A boundary is where the music before sounds
  unlike the music after, which is what a section change *is*.
- **Timbre, not level.** Spectrum frames are normalised per frame before comparison and compared
  by cosine similarity, so a quiet chorus and a loud verse are distinguishable and a plain
  crescendo is not a boundary. There is a test asserting a level change alone produces one
  section.
- The matrix is never materialised — only the window around each diagonal position is needed, so
  it is O(n·k²) work and no large allocation.
- **Two robustness rules the tests forced out**, both worth knowing:
  - An **absolute novelty floor** (1e-4), not just a relative threshold. On material with no
    structural change the curve is float noise around zero, and a purely relative threshold
    happily finds a "peak" in it — the same trap the tempo detector avoids by reporting no grid
    for silence rather than a confident wrong answer.
  - Minimum spacing is enforced **against the track ends too**, not only between boundaries. A
    boundary 6 s in makes a 6 s section that spacing-between-boundaries alone never catches.
- Boundaries are picked strongest-first, so when two are too close together the clearer musical
  change wins rather than whichever came first.
- Labels (`intro | build | main | breakdown | outro`) are a coarse energy-and-position heuristic
  and are documented as hints for the director, not ground truth.
- Written to `sections.json` in the cache entry and returned by `analyzeCached`. The novelty
  curve is kept in memory so a boundary can be explained, but not written — it is reconstructible.

Known weakness, as specified (D28): good on electronic and beat-driven material, weaker on
dynamic acoustic playing. `librosa`/`madmom` refinement is S16 if that becomes a problem.

### 4.22 Code audit (`d527f8e`) — five bugs found and fixed
A deliberate pass over all 15.5 k lines looking for defects rather than confirming correctness.
Each was **reproduced by a failing test first**, then fixed; the tests stayed as regressions.

| # | Severity | Where | What |
|---|---|---|---|
| 1 | High | `analysis/cache.ts` | A stray **file** in the cache tree crashed listing, sizing and pruning |
| 2 | High | `analysis/cache.ts` | **Concurrent source writes lost each other** in `meta.json` |
| 3 | Medium | `project/presets.ts` | Default comparison was **key-order sensitive** |
| 4 | Low | `ui/clock.ts` | A loop wrap **skipped one frame** |
| 5 | Low | `analysis/features.ts` | Beat times were **accumulated**, not computed |

**1 — `readdirIfPresent` handled only `ENOENT`.** Anything that is a file where a directory was
expected threw `ENOTDIR` straight out of `list()`, `totalBytes()`, `prune()` and `remove()` —
i.e. all of M33's cache panel. Windows creates `Thumbs.db` and `desktop.ini` unprompted, and an
interrupted `writeAtomic` leaves a `.tmp` behind, so this was a matter of time. Now `ENOTDIR`
reads as "nothing to list", and entry enumeration only considers directories.

**2 — `updateMeta` is a read-modify-write, and stems are written as they finish (M5).** Three
concurrent `writeSource` calls each read the same `meta.json` and the last write won, silently
erasing the other two sources — they existed on disk as `.bin` files but were invisible to every
reader. Meta updates now chain per entry. This was on the critical path for the feature stems
were designed around, and a sequential test would never have caught it.

**3 — `sameValue` compared with `JSON.stringify`.** `{r,g,b}` and `{b,g,r}` are the same colour
and stringify differently, so an identical value rebuilt by a UI control counted as a
non-default. That defeats the entire reason for storing only non-defaults: the value is then
frozen against every future improvement to the module's default. Now a structural comparison.

**4 — a loop wrap lands on a position whose frame may be the one already shown**, and `emit`
skips a repeat frame. A wrap is a jump backwards, so it now forces a redraw like any other seek.

**5 — `layOutBeats` did `t += period`.** At 127.4 bpm the seventh beat came out
`2.8249999999999997` instead of `2.825`. Musically nothing, but it breaks the project's own rule
(CLAUDE.md constraint 5) in the one place about to feed quantisation and beat-synced LFO phase,
where "on the grid" should mean exactly on the grid. Computed from the beat index now.

**Checked and found correct** (worth not re-auditing): the PRNG and its GLSL twin; `sampleTrack`
clamping; the value-resolution order in `params.ts` (clamp once, at the end); envelope
precomputation in `compileModulation` (modulation-spec §5 is genuinely met); premultiplied blend
functions; `layerIsLive`; the migration chain and unknown-field round-trip; FFmpeg argument
construction including all four colour tags; `samplesForFrames` rounding; download checksum
verification; and every `.sort()` call (all on strings, where lexicographic is correct).

**Noted, not fixed** — performance, not correctness: `resolveParams` allocates a `Set` and two
objects per layer per frame, and `PreviewClock.stats` filters two arrays per read. Both are
cheap enough at current scale and are the kind of thing to fix against a profile, not a hunch.

### 4.23 Render queue and progress (M24, export-spec §12–13)
`src/export/queue.ts` + `src/export/progress.ts`, 21 tests in `tests/export/queue.test.ts` (`987986a`).
GPU-free by construction: the queue owns *what* runs and in what order and is handed a
`JobRunner` that owns *how*, so all of it is testable without a renderer — and the same queue
drives the CLI and the app.

- **Snapshot on enqueue.** The document is serialised into `<root>/snapshots/<id>.pvproj` the
  moment a job is created, and the job renders *that*. Editing or closing the project afterwards
  cannot change the output, which is the whole reason a queue is worth having: "queue three
  variants and keep working" has to be safe. The snapshot's SHA-256 goes in the job.
- **Sequential, and provably so.** Jobs contend for one GPU (M28). `drain()` called twice returns
  the run already in progress rather than starting a second — a test asserts no overlap, because
  two callers pressing Render is the obvious way to get two renders fighting for the card.
- **A failing job does not stop the batch.** An overnight run must survive one bad project rather
  than stopping at it and wasting the night.
- **Persisted on every change**, atomically. A job recorded as `running` when the process died
  becomes **`interrupted`, not restarted**: relaunching the app should not silently kick off a
  forty-minute 4K render nobody asked for. `retry` puts it back in line against the same snapshot.
  A corrupt queue file loses the queue, never the projects it pointed at.
- **Cancel is polled, not a kill.** A queued job stops immediately; a running one is flagged and
  the runner sees it on its next `isCancelled()` check, so the encoder can close cleanly
  (export-spec §13). `pause()` finishes the running job and stops; `stop()` cancels it too.
- `move`, `retry`, `remove` (which deletes the snapshot) and `clearFinished`.

**`ProgressTracker`** implements export-spec §13's two rules and the reasons for them: count the
**encoder's** frames rather than the pump's (the pump runs ahead, so its position makes a render
look finished and then hang), and take the rate from a **moving window** rather than the average
since the start (an early heavy section otherwise poisons the estimate for the rest of the run).
A backwards frame count — FFmpeg's progress stream can repeat a line — is ignored rather than
trusted into a negative rate.

**A bug the tests caught in my own window trimming:** the guard kept "one sample older than the
window", but with a `<` comparison a sample landing exactly on the cutoff survived forever and
the window silently became the whole render — reporting 50 fps where the true recent rate was
100, and doubling the ETA. `<=` fixes it; the test pins the difference.

Not yet wired: nothing constructs a `RenderQueue` yet — the CLI still renders one job inline.
Connecting it needs the job runner to call `runExport`, which is GPU work and belongs with the
export UI (ui-spec §7). *Since: wired — §4.33 (shared render pipeline) and §4.34 (studio queue).*

### 4.24 Supervised ML sidecar (M27, PROJECT.md §3)
`src/ml/protocol.ts`, `src/ml/supervisor.ts`, `python/pulseforge_ml/serve.py`, 19 tests in
`tests/ml/supervisor.test.ts` (`ac11b9f`).

**Why, concretely:** a one-shot process pays ~4 s of Python start plus model load on every
command (§5). That is *all* of a health check and most of a batch of short tracks. One resident
process pays it once — a test pins that the pid does not change across requests.

- **A second protocol, not a replacement.** One-shot `runSidecar` and `python -m pulseforge_ml
  health|separate` are untouched, because that path is verified on the RTX machine and drives P0.
  Serve mode is `python -m pulseforge_ml serve` speaking an id-addressed protocol (v2) where every
  reply echoes its request id — so a late progress line from a cancelled request is *dropped*
  rather than attributed to whatever is running now.
- **Requests are serialised.** The sidecar does one GPU job at a time (M28); interleaving two
  would interleave their progress as well. A failed request does not poison the ones behind it.
- **Cancellation is cooperative, never a kill.** The Python side reads stdin on its own thread, so
  a cancel arriving mid-separation is seen at once, and Demucs' per-segment callback is the
  checkpoint where it takes effect. Killing instead would discard a loaded model and leave
  half-written stem files. The process stays usable afterwards — asserted by a test.
- **A crash fails the request in flight with the stderr tail**, rather than leaving a promise that
  can never settle while somebody watches a progress bar. The next request restarts the process.
- **Idle shutdown.** Torch holds VRAM while loaded and the renderer wants it back (M28, §4), so an
  idle supervisor stops itself and respawns on demand.
- Protocol mismatch, a sidecar that never reports ready, and unparseable stdout (torch and Demucs
  write banners uninvited) each produce a specific message with a suggested fix — this is the part
  that runs on a machine I cannot watch.

**Testing approach worth reusing:** the tests drive a **stub sidecar written in Node** that speaks
the same protocol, so restart, cancellation, crash handling, ordering and idle shutdown are all
exercised without Python, torch or a GPU.

**Verified on the RTX machine, 2026-09-15 — and it was broken.** Serve mode deadlocked on its
first real request and never replied. Found by driving it by hand, as step 3 of §9's list asked:

- **The bug:** on Windows, importing a native extension deadlocks against a thread already
  blocked in `sys.stdin.readline()`. `_served_health` does `import torch`, which pulls numpy's
  `_multiarray`; the reader thread was already blocked; the import never returned and the request
  never answered. Reproduced in twelve lines: **numpy imports in 0.12 s with no reader running
  and hangs indefinitely with one.** A `faulthandler` stack dump put the main thread inside
  `numpy/_core/multiarray.py` and the reader in `_read_stdin`.
- **Why the Node-stub tests could not catch it.** The stub speaks the protocol from Node, so it
  never imports a Python native extension — the tests exercise the protocol, and the bug is in
  the runtime underneath it. This is exactly the class of thing §9's list existed to catch.
- **The fix:** `serve(handlers, warmup=…)` calls `warmup` **before starting the reader thread**;
  `_warm_native_extensions` imports torch and demucs there. The ordering is load-bearing, not
  tidy-minded, and both places say so. It is also the right shape regardless: a resident server
  should pay its imports once at boot, so `ready` means ready and no request carries the cost.
- **A wrong turn worth recording:** the first hypothesis was that `for line in sys.stdin` blocked
  on read-ahead buffering, because closing stdin made the request succeed. It did not — closing
  stdin *ends the reader thread*, which is why it appeared to help. Tested directly: the iterator
  form delivers a line instantly. That change was reverted; the diff is only the warm-up.

**Now measured here:** `ready` at 2.0 s (the warm-up, honestly reported), health result 0.1 s
later. A `cancel` during a real 120 s separation returned `cancelled` **0.2 s** after it was sent,
two progress events in, and a follow-up `health` on the same process succeeded immediately —
so cooperative cancellation works and does not poison the process. All four steps below pass.


1. ✅ `npm run check` — the one-shot path still passes (527 tests).
2. ✅ One-shot end to end: `npm run validate -- --only 7` passes.
3. ✅ Serve mode driven by hand: `ready` arrives first, then `result`.
4. ✅ `cancel` during a real separation returns `cancelled` in 0.2 s; the next request succeeds.

The refactor to watch is `cmd_separate` → `_separate(args, context)`: one-shot passes `context =
None` and emits exactly as before, served mode passes a context that reports progress and raises
`Cancelled` at the checkpoint.

### 4.25 Preset store on disk (M25, S8's data layer)
`src/project/preset-store.ts`, 20 tests in `tests/project/preset-store.test.ts` (`ca6d8ca`).

A folder of small JSON files rather than a database, because presets are meant to be copied
between machines, dropped into a folder, kept in git and hand-edited when one value is off — and
a binary store makes all four awkward for no gain at a few hundred kilobytes.

- **Two sources, merged on read**: `builtin/` ships with the app and is read-only, so an update
  can improve it (D16); `user/` is writable and **shadows a built-in with the same slug**, so
  improving a shipped preset never fights an edit the user made to their copy.
- **Saving the same name twice keeps both** (`neon-pulse`, `neon-pulse-2`). Silently replacing
  the first would destroy a look that took real effort to dial in; `overwrite` is the explicit
  path.
- **One bad file does not hide the library.** A preset that will not parse — corrupt, or from a
  newer format — becomes a *problem* the browser can show, not an exception that blanks the list.
- `slugify` turns a human name into a filename (`"Neon Pulse ⚡ (v2)"` → `neon-pulse-v2`) without
  losing anything: the name lives inside the file, the slug only has to survive a filesystem.
- Deleting distinguishes "that is a built-in and not yours to delete" from "there is no such
  preset" — two quite different situations that one message would blur.
- `searchPresets` and `tagCounts` are pure, so the browser's filtering is testable without a
  filesystem. Tags narrow: every requested tag must be present.
- A stray file where a folder should be reads as an empty library, not an `ENOTDIR` — the same
  lesson as §4.22.

Not yet: the browser UI itself, animated thumbnails, and nothing ships a `builtin/` folder yet.
*Since: all three — §4.44.*

### 4.26 Auto-director classification (M21, auto-director-spec §2–3)
`src/director/digest.ts`, 17 tests in `tests/director/digest.test.ts` (`fb08f45`). The director's first two
steps — summarise what the analysis measured (`TrackDigest`), then classify what kind of track it
is (`StyleVector`). Pure, so all of it is testable here; the rest of P7 builds on these.

- **Normalised against music in general, not against the track.** Ranges are hand-tuned shipped
  constants (D27). Normalising within the track would rate an ambient piece's loudest moment as
  maximum energy, and the director would dress it like a festival banger — there is a test with
  exactly those two tracks. Learning the ranges from the user's library was rejected on purpose:
  the same track would then classify differently on two machines, breaking the promise that a
  seed plus a track reproduce a project.
- **Every axis is an explicit rule**, no model. `organic`, for instance, is the inverse of how
  closely onsets land on the beat grid, tempered by tempo confidence — a quantised production
  scores near 0, a drummer pushing and pulling around the beat scores above 0.5.
- **Tempo is perceptual**: 90→140 bpm spans more of the axis than 140→190, because that is where
  the distinction between kinds of music actually lives. Pinned by a test.
- **Percentiles, not extremes**, throughout: `dynamicRange` is p90 − p10, so one clipped sample
  or one silent gap does not define how dynamic a track is.
- **Unmeasurable axes say so.** Stems are not produced yet, so `vocalWeight` lands in
  `unmeasured` rather than being guessed — a director that knows it is guessing can pick a
  template that does not depend on the guess. `stems.vocalPresence` is `null`, never `0`, for the
  same reason a pending stem reads as absent rather than silent (data-formats §4.4).
- `describeStyle` renders the vector as a sentence ("fast, high-energy, bright, electronic,
  vocal-led") — the decision log's first line (auto-director-spec §8), and the thing that makes a
  wrong classification obvious rather than mysterious.

Next for P7, in order: the template format and affinity scoring (§4), slot resolution (§5.1),
then modulation calibration (§5.2) — which can reuse `autoRange` from `compileModulation`, since
the spec says the director and the modulation UI must share that code.

### 4.27 The React studio (P3 step 5) — ui-spec
`src/ui/` — React 19 + Zustand. Layout per ui-spec §1: top bar, left rail, centre canvas, right
inspector, bottom transport and timeline.

| File | Contents |
|---|---|
| `main.tsx` | mount, and the `pulseforgeReady` flag anything driving the window waits on |
| `store.ts` | Zustand state; the `History` instance is the source of truth for the document |
| `preview/host.ts` | the WebGL2 canvas, engine, `PreviewClock` and audio element, in their own loop |
| `components/*.tsx` | TopBar, LeftRail, CanvasPane, Inspector, TransportBar, Timeline |

- **The preview loop is outside React** (ui-spec §13). It owns its rAF loop and pushes a summary
  in at 10 Hz; re-rendering a React tree per frame is the standard way these tools get sluggish.
- **The engine can now draw on screen.** `Engine.present()` blits the output target to the
  default framebuffer, **letterboxed** — a preview that quietly changes the frame's shape is
  worse than black bars, because every composition decision is then made against the wrong
  picture. Export still reads the same target back, so preview and export start from one frame.
- **A `needsRedraw` flag, and why it is not an optimisation.** The clock only yields a frame when
  time has moved, which is right for playback and wrong for editing: a paused editor showed a
  black canvas, and dragging a slider changed nothing. Any change to the document, analysis or
  scale forces one redraw; idle with nothing changed still costs nothing.
- **The inspector is generated from module schemas** (M10, module-spec §13) — float, int, bool,
  enum, colour and stem controls come from the declarations, grouped and ordered by them. No
  markup is written per module, which is the whole reason the fortieth effect costs one file.
- **Aspect editing is unmissable** (D44): switching aspect sets the edit target, the stage gets
  an accent border, a banner says which override is being written, and every overridden
  parameter shows a badge with reset-to-base.
- **Analysis is computed in the main process** through the same FFmpeg decode and on-disk cache
  the exporter uses, then handed over as the binary container. The preview therefore reacts to
  exactly the numbers the export will, rather than to Chromium's own decoder. Playback is
  separate and may use the browser decoder, because the clock reads positions, not samples.
- Audio reaches the sandboxed renderer as bytes over IPC and becomes a Blob URL; `file://` media
  would fight the CSP and the renderer has no filesystem to point at.
- Timeline is canvas-drawn (ui-spec §3): waveform from the peak pyramid, beat grid with
  downbeats emphasised and skipped below 3 px spacing, section bands, layer blocks, playhead.
  Click the wave to scrub, click a row to select.

**Verified here:** `npm run dev -- --smoke` passes all five checks, and the screenshot shows the
test pattern rendering correctly — 24 patches, right orientation, letterboxed — with undo/redo
state correct. Golden frames still 15/15 identical, so nothing the studio added moved a pixel.

**Two smoke-check bugs found and fixed along the way**, both the same shape as the one in P3
step 2: the check was passing without testing anything. It matched CSS classes the React rewrite
had renamed, and then matched the undo button by its *label* ("↶ Hide layer", not "Undo …"). It
now uses a `data-action` hook and waits for React to commit before reading the DOM — React
renders asynchronously, so the tree right after a dispatched click is still the old one.

*Since this step: the preset browser (§4.44), the export dialog and queue (§4.34), and the full module
library (§4.28–§4.43) have landed. Still open: transform handles, timeline drag/zoom, the modulation
matrix and binding UI, keyframes, lyrics and Auto panels — see ROADMAP.md.*

**Not yet, and deliberately named rather than implied:** no on-canvas transform handles, no
timeline drag or zoom, no modulation matrix panel, no preset browser, no export dialog (the
queue exists in `src/export/queue.ts` but nothing wires it to the UI), no keyframes, no lyrics
panel, no Auto panel. The library is still one visualizer and two effects, so the inspector has
little to show; that is P4's job, not a gap in the generation.

### 4.28 The visualizer library, first batch (P4 step 1) — M11, module-spec §6

M11 wants ten visualizers; there was one (`bars`) plus a test pattern. This adds four, all
written and **visually verified on the RTX machine**, and one shared helper.

`src/engine/modules/analysis-texture.ts` is the helper every spectrum-reading module now uses:

- It uploads the current frame's spectrum as an **R32F texture** and reads it back with
  `texelFetch`, never a filtered sample. Float texture *filtering* is not core WebGL2 — it needs
  `OES_texture_float_linear` — so a module that sampled with `texture()` would work on some
  drivers and return black on others. Interpolation between bins is done in GLSL instead.
- `SPECTRUM_GLSL` ships `pf_bin` / `pf_spectrum`, so a module gets a `0..1` position → magnitude
  function without restating the bin arithmetic.
- `FeatureUniforms` and `fillColour` cover the other two things every module needs.

The four new modules:

| Module | Reads | Note |
|---|---|---|
| `core.visualizer.radial` | spectrum | bars on a circle; mirrored so it is symmetrical |
| `core.visualizer.curve` | spectrum | a smooth line, optional fill and mirror. Distance to the line is computed from the local slope, so steep sections do not thin out |
| `core.visualizer.orb` | rms/peak/onset/beat | the quiet one — level, not detail, so it can sit under a spectrum layer |
| `core.visualizer.spectrogram` | spectrum over time | heat map or ridges |

**The spectrogram is the interesting one.** A live visualiser can only scroll a spectrogram by
keeping a history buffer, which is state, which breaks seeking (module-spec §7 rule 3). Here the
analysis is precomputed and random-access in time, so each of the 128 columns just reads the
spectrum at `t - age`. No history, no state, and scrubbing backwards shows exactly what playing
forwards showed.

Schema and inspector gained `visibleWhen` (module-spec §3.1): a control shown only when another
parameter has a given value — the spectrogram's ridge settings appear only in ridge style. A
hidden parameter **keeps its value and is still resolved**, so toggling a mode away and back does
not silently reset what it held. The inspector also honours `advanced`, behind a disclosure.

`engine.ts` gained `present(width, height)`, which letterboxes the output framebuffer into the
drawing buffer with `blitFramebuffer` — the studio was scaling by canvas CSS size, which is not
the same thing once the aspect differs.

`tests/golden/modules-gpu.test.ts` asserts, for every visualizer in the catalogue: the shader
compiles, the draw lights more than 0.5% of the canvas (a black layer from a silently failed
compile would pass a "it rendered" test but not this one), and two renders of the same frame are
byte-identical.

Verified: `npm run check` **538 tests pass**; `npm run golden` **15/15 byte-identical**;
`spike:determinism` still `5f0ade89…`. A contact sheet of all five visualizers was rendered and
inspected before committing — each one draws what its name says.

Still short of M11's ten: six more visualizers, and M12's effect list is at two of ten.

### 4.29 The visualizer library, second batch (P4 step 2) — M11 complete

Five more, which takes the catalogue to **ten visualizers** and closes M11. The test in
`tests/golden/modules-gpu.test.ts` now asserts ten, so removing one is a failure rather than a
quiet regression.

| Module | Idea | Why it earns a slot |
|---|---|---|
| `core.visualizer.grid` | a matrix of cells lit by the spectrum | chunky and flat — the one module that survives heavy compression and thumbnail size |
| `core.visualizer.waves` | stacked travelling lines, one band each | the calm one; nothing in it flickers on a single frame, so it works as a background |
| `core.visualizer.tunnel` | rings receding, perspective as `1/radius` | the only module that reads as **depth**; a video of flat layers gets monotonous |
| `core.visualizer.blobs` | metaballs that merge as they meet | the only module made of **mass** rather than edges |
| `core.visualizer.particles` | a drifting point field that flares on transients | motion without structure; also the first module that is not a fullscreen triangle |

Three things worth recording, because they are the kind of thing that is invisible until someone
looks at the output:

- **Particles draw as `POINTS`, and their randomness is an integer hash of the vertex index.**
  A particle field evaluated in a fragment shader costs `count` iterations *per pixel* — minutes,
  not milliseconds, at 4K. `Math.random` is banned in the engine and a CPU-side PRNG would mean
  a buffer upload every frame, so each particle derives its constants from a hash of its own
  index plus the layer's `seed`: no state, no upload, same field on every machine. Wang's 32-bit
  integer hash is exactly specified in GLSL ES 3.00 — `fract(sin(…))` noise is not, and would
  break "same pixels everywhere". Position is a closed form in `t`, so scrubbing backwards costs
  nothing.
- **Three defects the contact sheet caught and the tests did not**, all of which passed
  "compiles, draws, deterministic":
  1. *Particles had a brightness gradient across the frame.* Size and horizontal placement were
     read from the **same hash stream**, so every particle on the right was bigger than every
     particle on the left. Size now has its own stream.
  2. *The tunnel's centre was moiré.* Rings crowd past one-per-two-pixels near the vanishing
     point, and widening the antialiasing only turns aliasing into interference. Rings beyond
     what the frame can carry are now faded out entirely — which is also what a receding tunnel
     actually looks like.
  3. *Every blob merged into one disc at rest.* A blob's surface sits at `d = radius/√threshold`;
     the default radius and orbit put the surfaces inside each other before the music did
     anything. Defaults retuned so they are separate at rest and merge as they swell.
- **Particles set additive blending and put it back.** Overlapping particles should build light
  rather than occlude, but the compositor's premultiplied "over" is the state the next module in
  the chain is entitled to.

Also cleaned up in passing: `radial.ts` had a dead local and a re-export of `referenceLength`
that nothing imported.

Verified: `npm run check` **548 tests pass**; `npm run golden` **15/15 byte-identical**; the
21 GPU module tests pass; a ten-module contact sheet was rendered and inspected.

**M11 is done. M12 (ten effects) is at two:** bloom and vignette.

### 4.30 The effect library (P4 step 3) — M12 complete

Eight more effects, taking the catalogue to **ten** and closing M12.

`src/engine/modules/effect-base.ts` is the counterpart to `analysis-texture.ts`:
`singlePassEffect(manifest, frag, options)` handles the four things every effect does — refuse
politely when there is no input, bind it to unit 0, set uniforms, draw one triangle — so an
effect is a fragment shader plus a schema. `EFFECT_GLSL` ships `pf_unpremultiply` /
`pf_premultiply` / `pf_luma` and a deterministic integer-hash noise.

**Un-premultiplying is not optional and is easy to skip.** The compositor works in premultiplied
linear light; any operation that is not a plain multiply — contrast, saturation, a curve — must
divide the alpha out first or every soft edge in the frame darkens as the control goes up, which
reads as a halo with no obvious cause. Providing the two helpers rather than the rule alone is
the point.

| Effect | Note |
|---|---|
| `core.effect.blur` | separable Gaussian, two passes; N² taps become 2N. Radius follows `referenceScale` |
| `core.effect.grade` | exposure, contrast about a pivot, saturation, temperature/tint — all in linear light, because a contrast curve on sRGB crushes shadows and a saturation on sRGB shifts hue |
| `core.effect.chromatic` | channel separation growing towards the edges, as a lens does. Alpha comes from the **unshifted** tap, or the layer's edge creeps outwards each time |
| `core.effect.grain` | per-frame noise that is a hash of pixel and **frame index**, so frame 300 has the grain frame 300 always had. Weighted to the midtones, as film is |
| `core.effect.pixelate` | blocks or a dot-matrix panel; block size is canvas-relative, not a pixel count |
| `core.effect.scanlines` | CRT lines plus a phosphor mask. Line count is fixed in *frame* terms — a tube did not gain lines because you exported at 4K — while the mask stays a fixed number of output pixels, because it is a feature of the glass |
| `core.effect.kaleidoscope` | folds a wedge around the centre, in screen-circular polar space so wedges stay equal in 9:16 |
| `core.effect.glitch` | torn bands, channel shift and dropouts, hashed from band and frame index, in scheduled bursts |

`tests/golden/effects-catalogue-gpu.test.ts` is new and deliberately separate from
`effects-gpu.test.ts`, which measures the *chain*. The catalogue test walks every effect and
asserts it **changes the frame** — because an effect fails invisibly. A visualizer with a broken
shader draws nothing and any smoke test catches it; a broken effect looks exactly like an effect
at default settings. Each one is given settings strong enough to be unmistakable, and a second
test asserts the settings table covers every effect so the two cannot drift apart.

**That test immediately earned itself.** The kaleidoscope compiled, was deterministic, and
rendered a completely black frame. Rotation was applied *before* the fold, which pins the
sampled wedge to the same slice of the source for ever: point it at a bars layer, whose content
is all along the bottom, and there is nothing in the wedge. Rotation now applies after the fold
and actually aims the wedge. Also caught: `active` is a reserved word in GLSL ES.

Verified: `npm run check` **570 tests pass across 36 files**; `npm run golden` **15/15
byte-identical**; a ten-effect contact sheet was rendered over a bars layer and inspected.

**Known gap, and the obvious next step:** `addEffect` / `removeEffect` / `setEffectParam` have
existed in `src/project/commands.ts` since P3 step 2, but **the studio has no UI for them**. Ten
effects that can only be reached by editing a `.pvproj` by hand is a hollow milestone.

### 4.31 The effect chain in the studio (P4 step 4) — M12's other half

`addEffect` / `removeEffect` / `moveEffect` / `setEffectEnabled` / `setEffectParam` had existed
since P3 step 2 with nothing calling them. The inspector now has an Effects section: add from a
picker of every effect in the catalogue, expand one to edit its parameters (generated from its
schema, like everything else), bypass, reorder, remove.

**Order is shown as a list the user reorders, not a set of checkboxes**, because it is
meaningful: bloom then vignette darkens the glow at the edges; vignette then bloom makes the
darkened edges glow. There is nothing sensible to infer. Bypass is separate from remove for the
same reason every other tool separates them — comparing with and without is how an effect gets
dialled in, and deleting loses the settings.

#### The smoke check was passing vacuously again

Extending `--smoke` to cover the new UI exposed that **`undoable` had been green on nothing**. A
new project opens with no layers, so `before === 0`, and the check's own guard — "only meaningful
when a project was opened" — made it pass without touching anything. The screenshot showed
"No layers yet" while the log said `ok undoable`.

This is the fourth time a smoke check has passed against a state it never reached, and every
time the *screenshot* caught it rather than the assertions. The fix is structural rather than
another guard: the check now **adds a layer itself** as its first act, so everything below it —
the undo stack, the inspector, the effect chain — has something real to act on, and
`layerAdded: before === 1` fails loudly if that ever stops working. `effectChain` asserts the
effect both appears and goes away again (`added === 1 && removed === 0`), so a remove button
that silently did nothing would not read as success.

Verified: `npm run check` **570 tests pass**; `npm run golden` **15/15 byte-identical**; `--smoke`
reports seven checks green, and the screenshot shows a bars layer, a populated inspector, an
Effects section and "Remove effect" sitting on the undo stack.

### 4.32 The palette (P4 step 5) — M17, compositor-spec §9

"Reskin in one click" needs a *link*, not a copy. `src/project/palette.ts` spells one as the
parameter value itself — `@primary` instead of `#ff2d95`:

- the document format needs no new type and old files still parse;
- a preset carries links rather than colours, so applying it adopts **this** project's palette
  instead of importing a foreign one (compositor-spec §9);
- `@` is not legal anywhere in a hex colour, and a link is only recognised when it names a role
  this build knows, so a literal can never be mistaken for one.

**Links are resolved in `snapshot.ts`, on the way to the engine, and nowhere else.** The engine
receives a literal like any other and never learns that palettes exist — which is what keeps the
golden frames a statement about the engine rather than about the document model.

A role that resolves to nothing — unassigned, or pointing past the end of the colour list — has
its parameter **removed**, so the module's declared default applies, and a snapshot note says
which role and where. That is the behaviour `parse.ts` has been promising since P2 step 1 when it
validates the role table; it now exists.

`removePaletteColor` is the one command with a real trap in it, and it has a test of its own:
roles are *indices*, so deleting the second of three silently re-points every role above it.
Roles pointing at the removed colour are dropped; roles above it shift down.

UI: a palette editor in the left rail (colours, then role assignments — two lists, not seven
pickers, because two roles may point at the same colour and moving that colour must move both),
and every generated colour control gains a literal/role dropdown. Picking a role makes the
swatch read-only and show what the role currently resolves to: editing it there would silently
unlink, and "I changed the colour and it went back" is worse than a disabled control.

Verified: `npm run check` **580 tests pass across 37 files**; `npm run golden` **15/15
byte-identical** (no project uses a link, so nothing moved); `--smoke` green, and the screenshot
shows the palette panel and the literal/role dropdown on the fill colour.

Not done here, and still open from compositor-spec §9: palettes saveable independently of
projects, and import from an image (that one belongs with the auto-director's §5.3 extraction).

### 4.33 One document → video pipeline (P4 step 6)

`src/export/render-document.ts` — `renderDocument(options)`: document text → load/migrate/parse →
resolve audio (relative to the project) → decode → analysis through the cache → canvas/aspect →
`toRenderProject` → Electron export → report. `npm run render` now calls it, and the studio's
render queue is meant to be its second caller. Started by the previous session and finished here.

- **One copy, on purpose.** The CLI and the queue were about to carry the same forty lines twice;
  two copies drift, and "it renders differently from the CLI" would be a bug nobody chose.
  `canvasForAspect` and `ASPECT_RATIOS` live here now; the CLI wraps them to keep its `--size` hint.
- **Abort really stops the render.** `options.signal` → `runExportSpike` → `runElectron`, which
  kills the Electron child. Killing Electron closes FFmpeg's stdin, so the encoder exits on its own.
  Rejects with `ElectronCancelled` (spike/harness.ts), distinct from a failure.
- **Partial output is deleted** on cancel or failure, with the report JSON (export-spec §13).
- **`runElectron` deletes a stale result file before spawning.** Otherwise a child that crashed
  before writing its result would have its *previous* run's result read back as success.
- **Progress reads the encoded count**, not the read-back count (`parseProgress`, tested) — the
  unfinished version took the first `n/total` in the line, which is the pump's position.

Verified here: `npm run check` 584 tests; `npm run render` on `neon-bars` writes a verified MP4;
an abort 0.5 s into a 4K HEVC render rejected `ElectronCancelled` within 0.7 s with **no
`electron.exe` or `ffmpeg.exe` left running and no partial file**.

**Remaining for P4** (PROJECT.md §10: "10+ visualizers, 10+ effects, backgrounds (incl. video
frame cache, M39), text, logo, palette system, layer groups (M38), Three.js scene layers (M37),
preset save/load, asset library (M40), `modules/` drop-in folder + authoring guide"), in a
suggested order:

1. ✅ **Render queue in the studio** — §4.34.
2. ✅ **Background source layer** (M14) — §4.35.
3. ✅ **Asset library** (M40) — §4.37. Fonts join it with the text layer; video with M39.
4. ✅ **Text layer** (M16, M32) — §4.38.
5. ✅ **Logo layer** (M15) — §4.40.
6. ✅ **Group compositing** (M38) — §4.39.
7. ✅ **Video layers** (M39) — §4.41.
8. ✅ **Three.js scene layers** (M37) — §4.43.
9. ✅ **`modules/` drop-in folder + authoring guide** (M35) — §4.42.
10. ✅ **Preset browser** (S8) — §4.44.

**P4 is complete.**

### 4.34 Render queue in the studio (P4 step 7) — M24, ui-spec §7

- `src/export/export-presets.ts`: YouTube 1080p / 4K, Shorts, Square (H.264), Master HEVC 10-bit
  and Project size. Pure; the dialog and the runner read the same table. Every fixed 8-bit size
  keeps the GPU NV12 path (tested).
- `src/shell/render-service.ts` (plain Node): `RenderQueue` + a runner that calls `renderDocument`,
  adapting the queue's polled cancel flag to an `AbortSignal` (200 ms poll), feeding
  `ProgressTracker`, rejecting unverified output, and reporting a final 100 % snapshot.
- Main (`src/shell/main.ts`): the service lives in `out/studio-render/{queue,work}` on the repo
  drive; validated IPC handlers (`pf:render:*`); queue changes pushed on `pf:render:changed`;
  reveal only for paths the queue produced; a running render is cancelled on quit so its Electron
  child cannot outlive the app; a queue that fails to start leaves the studio usable.
- `spike/harness.ts`: `electronBinary()` — inside Electron's main process `import 'electron'` is
  the API object, so the running binary is `process.execPath`. `esbuild` is external in the main bundle.
- UI: **▸ Export** (Ctrl+E) opens the dialog (preset, output file, snapshot note, no-audio warning);
  **Renders (n)** toggles the queue drawer (status, progress, fps, ETA, cancel/retry/show file/remove,
  clear finished).

**Chrome colour, after owner feedback ("it's very… pink"):** the accent had been the neon content
pink and was on every slider, primary button, selection and timeline block — against ui-spec §12,
which keeps the chrome near-neutral so the canvas is the only saturated thing. Now: neutral
`--control` for sliders/progress, light neutral primary buttons, a muted blue-grey `--accent` for
selection and the playhead only, and `--warn` (amber) for the D44 aspect-override border, banner
and badges so that state stays unmissable. Timeline waveform neutral; selected layer block outlined.

Verified here: 588 tests; a Node-side run cancelled a 4K job mid-render (cancelled, no file) and
completed a square job (done, report) with no leftover processes; `--smoke` passes nine checks
including `exportDialog` and a real `queuedRender` from inside the app.

### 4.35 Background layer and image assets (P4 step 8) — M14, data-formats §1.2

**Module** `src/engine/modules/background.ts` — `core.source.background` (kind `source`, first in
`BUILTIN_MODULES`, so it is the first "Add layer" button). Params: `mode` solid | gradient | image;
`colorA` (palette role `background`), `colorB`; `gradient` linear | radial; `angle`; `image` (new
param type `asset`, value = asset id); `fit` cover | contain | stretch | tile; `dim`; `zoom`
(modulatable, aspect-overridable — audio-reactive movement is a modulation on it); `drift` and
`driftSeconds` (Ken Burns).

- Gradients mix in **linear light** (GPU test: midpoint of black→white is sRGB 188, not 128).
- `kenBurns(t, zoom, drift, period)` is closed form in `t`; its base magnification is exactly enough
  that the largest drift never reveals the image edge in cover mode (unit-tested over time/drift).
- Contain bars and transparent image areas show `colorA`. A missing image draws a dark checkerboard
  and warns — visibly wrong, never black.
- The texture is sampled outside per-pixel branches (derivatives); wrap is set per draw because one
  texture may be shared by two layers with different fit modes.

**Engine** — `core/image.ts` (`DecodedImage`: RGBA8 straight sRGB, top row first), `render/images.ts`
(`ImageStore`: uploads `SRGB8_ALPHA8` + mipmaps, checks `MAX_TEXTURE_SIZE`),
`Engine.setImage(hash, image)` / `hasImage(hash)`, `RenderContext.image(assetId)` resolving via
`RenderProject.assets` (id → `{kind, hash, name}`). The engine never sees paths.

**Document** — `document.assets: AssetRef[]` (`id, kind, path, hash, name, extra`); parsed with
unknown kinds kept and reported; **serialised only when non-empty**, so every older project still
round-trips byte-identically (goldens unchanged). Commands: `addAsset` (dedupes by hash — returns the
document unchanged, so callers must use `findAssetByHash` for the id), `findAssetByHash`, and
`sequence(label, commands)` for one-undo-step composites ("Use image X" = add asset + set param).

**Decoding** — `src/assets/image-decode.ts`: always the vendored FFmpeg (never Chromium's decoder),
so preview and export see identical pixels. ffprobe for size, `-f rawvideo -pix_fmt rgba` for pixels,
scaled down past 8192 px on the long side, SHA-256 of the file bytes as the hash. Limits, stated:
first frame of animated files; EXIF orientation not applied; ICC profiles ignored (treated as sRGB).
`src/assets/load-images.ts`: `resolveAssetPath` (relative to the project file) and
`loadImageAssets(document, projectPath)` → images by recorded hash + problems (missing file,
changed on disk, undecodable). Problems are **not fatal**: the render proceeds with the placeholder.

**Where images flow**
- Studio: IPC `pf:image:import` (dialog + decode) and `pf:image:load` (stored path + project path);
  store `images` (hash → pixels, not undoable state) and `imageProblems` (asset id → message), loaded
  on project open; `PreviewHost.setImages` uploads each hash once. Inspector `AssetControl`: name,
  **Choose…**, clear, and the reason if the asset cannot be shown.
- Export / CLI / queue: `renderDocument` decodes assets, writes each as a raw `.rgba` in the work dir,
  passes `images: ImageFile[]` in `ExportConfig`; the Electron renderer reads them and
  `runExport({ images })` registers them before the first frame; files deleted afterwards. Asset
  problems are returned as snapshot notes (`assets.<id>`) and logged by the CLI.
- Frames mode (`renderFrames({ images })`) takes decoded images too, for GPU tests.

**Inspector bug found by the smoke screenshot and fixed:** `visibleWhen` defaults were looked up in
one map keyed by parameter name across *all* modules, so another module's `mode` default hid the
background's gradient controls. Defaults now come from the layer's own manifest; conditions chain
(a control whose condition parameter is hidden is hidden) and read override-merged values; a group
whose controls are all hidden has no heading.

Verified here: `npm run check` **610 tests** (new: `tests/project/assets.test.ts`,
`tests/assets/image-decode.test.ts`, `tests/golden/background-gpu.test.ts` — solid, linear-light
gradient, stretch orientation, contain bars, missing checkerboard, drift determinism);
`npm run golden` **15/15 identical**; `npm run render` of a project with an image background
(relative path) + additive bars wrote a verified 1080p60 MP4 at 131 fps with no leftover `.rgba`;
`--smoke` **10/10** including new `imageControl` (picker appears in image mode; the image bridge
answers) and `queuedRender`.

### 4.36 Code and UI audit (2026-09-15, owner request)

Method: read the studio store, preview host/clock, timeline, dialogs, History, render queue and the
atomic writers; for the UI, a new `PULSEFORGE_UI_TOUR=1` smoke option screenshots every overlay at
1600×900 and 1100×680, which were reviewed by eye before and after the fixes.

**Bugs found and fixed (with regression tests where the code is testable without a window)**

| # | Where | Bug | Fix |
|---|---|---|---|
| 1 | `export/queue.ts`, `analysis/cache.ts`, `project/preset-store.ts` | Concurrent atomic writes of one file shared `path.<pid>.tmp`; the second rename failed. Real for the queue (loop + IPC persist) and the cache (preview + queued render analysing the same track). **Test reproduced it** (12 concurrent enqueues). | `tempPathFor()` unique temp names; queue writes serialised so an older state cannot land last |
| 2 | `project/history.ts` | Saving, undoing past the save and editing made the new branch read as **saved** at the old index | Save point invalidated when its branch is discarded (tested) |
| 3 | `project/history.ts` | An edit merging into the entry just saved left the project **not dirty** | `markSaved()` seals (tested) |
| 4 | `project/history.ts` | A command that changed nothing (re-importing a known image) made an undo step and a dirty flag | No-op commands are ignored (tested) |
| 5 | `ui/store.ts` | **New / Open discarded unsaved work** without asking; closing the window likewise | `confirm` on New/Open; `beforeunload` + main-process `will-prevent-unload` dialog |
| 6 | `ui/store.ts` | Opening project B while A's audio analysed let A's result land on B | Request counter; stale results dropped, their blob URLs revoked |
| 7 | `ui/store.ts` | A relative audio path (how the CLI and data-formats store them) was passed unresolved: the project opened with no audio | `resolveAgainstProject` (tested) |
| 8 | `ui/store.ts` | "New" kept the previous song loaded and reacting | New/Open-without-audio clear audio, analysis, peaks, sections |
| 9 | `ui/components/LeftRail.tsx` | A failed audio import still wrote the new path with the **previous track's duration** | Only recorded when that file actually loaded |
| 10 | `ui/clock.ts`, `ui/preview/host.ts` | Play in the lead-in started the track immediately (skipping the silence); nothing started it when the clip began; a trimmed clip played past its out-point | Clock emits `playAudio` entering the clip and `pauseAudio` leaving it; host only starts audio when audible (tested) |
| 11 | `ui/preview/host.ts` | Rebuilding the clock (audio imported, duration changed) reset the playhead to 0 and left audio playing under a "stopped" transport | Playhead kept; playing → paused together with the element |
| 12 | `ui/preview/host.ts` | Parked frame used `round` (showed the next frame from mid-frame) and could index one past the last frame | Floor on the tick grid, clamped — same rule as the clock |
| 13 | `ui/preview/host.ts` | One failed frame killed the preview until restart, even after undoing the edit | A new document retries and clears the error overlay |
| 14 | `ui/components/TransportBar.tsx` | 59.996 s printed as `00:60.00` | Round to hundredths before splitting (tested) |
| 15 | `ui/components/TransportBar.tsx` | Space on a focused button pressed it too (Space after "Bars" added another layer); Space in a select was stolen | Blur the button; SELECT counts as typing |
| 16 | `ui/components/Inspector.tsx` | `visibleWhen` used another module's defaults (§4.35) | Per-manifest, chained |

**UI problems found in the screenshots and fixed**

- **Preview canvas overflowed its stage** on large windows, over the transport bar and hiding the
  engine-notes bar: the canvas's measured size fed back into its grid cell. Now absolutely positioned.
- **Light native scrollbars** on every dark panel (Windows ignores `color-scheme` for them): styled.
- Override banner wrapped to two lines on a small window: one line, ellipsis.
- **Timeline rows were in the opposite order to the layer list** (bottom layer first); labels touched the
  top of their blocks; layers beyond four rows silently vanished. Now top-first, centred, the timeline
  grows to 240 px with the layer count, and a "+N more layers" row says when some do not fit.
- Toast sat bottom-centre over the notes bar and transport: now top-right, scrollable if long.
- No Esc: Esc now closes the export dialog, then the queue drawer, then a toast.
- Group headings with no visible controls (e.g. "Image" in gradient mode) are hidden.

**Looked at and left as they are:** export dialog layout at both sizes (fine); queue drawer (fine,
covers the timeline by design); "no analysis for stem mix" notes with no audio (honest); render queue
labels have no timestamps (cosmetic); IPC path trust and quit ordering (§7).

Verified here: `npm run check` **619 tests** (twice); `npm run golden` 15/15 identical; `--smoke` with
the UI tour 9/9 and screenshots re-reviewed after the fixes.

### 4.37 Asset library (P4 step 9) — M40, D6, data-formats §1.2, ui-spec §5

**Paths** — `src/project/asset-paths.ts` (pure; runs in the renderer): a file **inside the project's
folder** is stored relative (with `/`), anything else absolute; `..` paths are never written, since
they break exactly when the folder moves. The studio holds **absolute** paths in memory
(`withAbsolutePaths` on open) and relativises on write against the file being written
(`withStoredPaths`). "Save as" therefore became *pick path, then serialise*: IPC `saveProjectAs`
was replaced by `pickProjectSavePath` + `saveProject`. The CLI and queue still resolve relative
paths themselves (`render-document.ts`, `load-images.ts`), so both forms work everywhere.

**Document** — `AssetRef.size` (bytes, 0 = unknown). Commands: `assetUsage(document)` (a string
param equal to an asset id is a reference — base params, aspect overrides, layer and global
effects; works without manifests), `relinkAsset(id, file)` (id kept, so layers follow),
`removeAsset` (refused while used), `removeUnusedAssets`.

**Status** — store `assetStatus[id] = { state: loading | ok | missing | changed | error, detail, path,
hash }`. The path+hash pair makes a status go stale when undo/redo/relink changes the asset, and
`loadImages` re-checks after any command that touches `assets` and after undo/redo. IPC `loadImage`
now returns `{status: 'ok' | 'missing' | 'error'}` instead of throwing. A changed file still draws
(under the recorded hash) and says so; it is never silently accepted — relinking to a file whose
content differs asks first.

**Relink and find** — per asset **Relink…** (panel and inspector). **Find N missing files in folder…**:
`src/assets/find-in-folder.ts` walks the folder (depth 8, 50 000 files, reports truncation), hashes
only candidates (same size, or same name when the size is unknown) and relinks on an exact hash
match only; a same-name file with different bytes is not taken.

**Collect files** — `src/project/collect.ts` plans (pure, tested): `<folder>/<name>.pvproj`,
`audio/`, `assets/`; same file shared once (hash or source path), different file with the same name
→ `name-2.ext`, never overwrites anything already in the folder. `src/assets/collect-files.ts`
copies, checks sizes, and writes the project **last**; a missing source keeps its original path in
the collected project and is listed. Verified end to end: the image-background project collected
into `out/bg-collected/` and rendered from there with `npm run render` (verified MP4).

**Library** — a plain folder (`Documents/Pulseforge/Library`, override `PULSEFORGE_LIBRARY`) with
`backgrounds/` and `logos/`; `src/assets/library.ts` lists images and copies files in (identical
file skipped, same name → suffix, nothing overwritten). Panel: category, **Add…**, **Random**,
**Folder**, refresh, 160 px FFmpeg thumbnails (cached per session). Clicking an image adds a
background layer **just above the topmost existing background** (at the very bottom it hid behind
an opaque background — seen in the UI tour and fixed).

**Panel** — `src/ui/components/AssetsPanel.tsx`, in the left rail under Audio: each asset with
state, where it is used, size, Relink / Show / Remove (disabled while used, with the reason), plus
Find missing, Check again, Remove unused, Collect files.

**Smoke** — new `libraryToAsset` check: the smoke run gets its own library (`out/smoke-library`, one
FFmpeg-generated image); clicking it must add a layer and show the asset **ok** (decoded by the main
process), and undo must remove both. The UI tour adds `*-1b-assets-and-library.png`.

**Not done (deliberately):** drag-and-drop import (ui-spec §5 "drag-drop anywhere" — needs
`webUtils.getPathForFile` in preload), library search/tags, font and video assets (with M16 / M39),
audio relink from the panel (audio has its own "Replace audio…"), a "missing files" prompt on open
(the panel shows it; a modal would interrupt every open of a moved project).

Verified here: `npm run check` **636 tests** (new: `tests/project/asset-paths.test.ts`,
`tests/project/asset-library.test.ts`, `tests/assets/library-files.test.ts`); `--smoke` 10/10
including `libraryToAsset`; collect + CLI render of the collected copy.

### 4.38 Text layer (P4 step 10) — M16, M32, PROJECT.md §8.13, §8.7

**Rasterisation** — `TextRasterizer` is an *interface* in `src/engine/core/text.ts`; the engine never
touches a font engine (CLAUDE.md #2). The browser implementation is
`src/text/canvas-rasterizer.ts`: Chromium canvas 2D, `willReadFrequently` (CPU-backed, so two runs
agree), `textRendering: geometricPrecision` (no hinting differences between preview and export
resolution), fonts registered as `FontFace`s **from bytes keyed by content hash** — nothing is ever
looked up by family name, so an installed font of the same name cannot change a render (§8.13).
Layout is ours, not the DOM's: `src/text/layout.ts` is pure (injected `measure`) and tested in Node —
greedy wrap at spaces, a too-long word overflows rather than breaking, blank lines kept, font-wide
line rhythm, alignment ignoring trailing letter spacing. It returns per-line **and per-word boxes**,
which is M32's requirement and what karaoke fill will use (lyrics-spec §4).

**Module** `core.text.title` (kind `text`, second "Add layer" button). Params: text (new `string`
param type, multiline), font (`asset` with `accept: 'font'`), case, size (canvas-relative,
**not modulatable** — size re-rasterises; pulse with the layer's scale), tracking, line height,
align, max width; fill solid/vertical-gradient (mixed in linear light); outline; shadow (on by
default, ui-spec legibility); glow; rounded plate; in/out animation — none, fade, slide up/down,
scale, blur, typewriter, stagger — with `textAnimation()` a closed form in `t` (unit-tested), timed
from the layer's in and out points (`RenderContext.layer`, new).

**One shader** over two coverage masks (fill, outline) packed as RG8 with mipmaps: colour, gradient,
outline, shadow, glow, plate and animation. Blur samples `textureLod` one level finer than the
radius on a ring of taps — no derivatives, so it is safe inside branches. **Per-word animation**
multiplies the mask by a per-word visibility texture in a first pass and rebuilds its mipmaps, so a
hidden word cannot smear into its neighbour's glow (the first version did, as hard vertical streaks).
Word ids are painted from the word boxes, split at the midpoint between overlapping lines — without
that, a tight line height let the next line's boxes clip the descenders above them.

**Fonts** — `vendor/fonts/inter` (Inter 4.1, OFL), pinned in `setup/manifest.ts` and installed by a
new setup step; `DEFAULT_FONT_FILE` is Inter Regular. Fonts are ordinary **assets** (`kind: 'font'`,
path + hash), so relink, find-in-folder, collect-files and the asset panel already cover them.
A chosen font that is missing draws with the default **and warns**, never silently (§8.13).
`src/assets/fonts.ts` hashes the default once and resolves a document's font assets for the export;
the studio loads bytes over IPC (`pf:font:*`) and registers them with the preview's rasteriser.

**Studio** — generated `string` control (textarea, live preview as you type, one undo step per edit),
the asset picker now accepts fonts ("Inter (bundled)" when none is chosen), and text layers appear in
"Add layer" automatically because the rail lists `source | text | visualizer` kinds.

**Setup bug fixed:** a nested `installDir` (`fonts/inter`) failed to install — the final rename had no
parent directory.

**Default animation is `none`:** a fade-in is fully transparent *at* the in point, so a text layer
added to a stopped preview looked broken until you scrubbed. Found in the UI tour.

Verified here: `npm run check` **657 tests** (new: `tests/text/layout.test.ts`,
`tests/engine/text-module.test.ts`, `tests/golden/text-gpu.test.ts` — draws, deterministic across
runs and order, honours a font asset, reports a missing one, typewriter reveals per word and fades
out at the out point); `npm run golden` **15/15 identical**; `--smoke` **11/11** with a new
`textLayer` check (the generated text box exists and the preview rasterises with no engine notes);
a CLI render of background + bars + animated title wrote a verified 1080p60 MP4 at 135 fps.

**Deferred (stated, not forgotten):** S17 Unicode shaping, fallback chains and RTL (the rasteriser
boundary is where that lands); per-line and per-role overrides, background-plate blur, and
keyframed text (S1) belong with the lyrics work (P6); no font picker browsing the system font
folder yet — you choose a file.

### 4.39 Layer groups (P4 step 11) — M38, compositor-spec §1

A group is now a real thing in the engine, not a flattening step. Its children composite into the
group's own target, and the group's transform, opacity, blend and effect chain then apply to that
**result** — the difference between fading a scene and fading three layers, which is the whole
reason groups exist.

- `Compositor.drawInto(target, layers)` is the per-layer loop, extracted. `composite()` calls it for
  the frame; a group's `draw` calls it for its children. One code path, so a group behaves exactly
  like a layer at every level.
- `RenderProject.layers` is now a tree: `GroupSpec` (`kind: 'group'`, `children`) alongside
  `LayerSpec`, with `walkRenderLayers` / `walkRenderModules` for callers that want them flat (the
  render report's layer list, the modulation bindings collector, tests).
- `engine.ts` builds layers recursively; a group's `enabled` and time range skip the whole subtree,
  and nesting is capped at **8 deep** with a warning, since a document arrives from disk and each
  level costs a render target.
- `toRenderProject` keeps the nesting instead of flattening it, so `clipToParents` is gone: the
  engine applies a group's time range to its subtree directly. Solo now has one extra rule — a group
  containing a soloed layer stays enabled, or soloing a child would hide it with its group.
- Studio: **Group** / **Ungroup** in the layer actions (`groupLayers`, `ungroupLayer` commands —
  siblings only, order preserved, the group lands where the topmost of them was), and the inspector
  says what a group controls rather than "groups have no parameters".

Verified here: `npm run check` **666 tests** — new `tests/golden/groups-gpu.test.ts` proves the
distinction directly (two opaque children in a 50 % group show only the top one at 50 %; flattening
would bleed the lower one through), plus group transform, group effects, time range and the depth
cap; `tests/project/commands.test.ts` covers group/ungroup, nesting and the different-parents
refusal; `npm run golden` **15/15 identical**; `--smoke` **12/12** with a new `grouping` check.

Not included: dragging layers into a group in the list (use Group/Ungroup for now), and masks (S7).

### 4.40 Logo layer (P4 step 12) — M15

`core.source.logo`: an image drawn at a chosen width with its aspect kept, positioned by the layer
transform like any other layer, with opacity, a tint (0 → the image, 1 → a flat silhouette in the
tint colour, palette-linkable) and a **pulse** that grows it with the audio.

The pulse reads the analysis directly — beat, onsets, level or peak, per stem — rather than
requiring a modulation binding, because "make it breathe with the kick" is the thing people
actually want from a logo, and it still comes from the same precomputed analysis, so it stays
deterministic. It scales about the image's own centre, so a logo pinned to a corner grows in place.
A missing image draws a red outline and warns; it is never silently blank.

Verified here: `npm run check` **670 tests**, including `tests/golden/logo-gpu.test.ts` — drawn size
and aspect (0.5 of a 200 px reference with a 2:1 image is 100×50), tint, pulse (varies over frames
with `pulse: 1`, identical across frames with `pulse: 0`, and stays between its resting size and
1.5×), and the missing-image placeholder; `npm run golden` 15/15 identical.

### 4.41 Video layers (P4 step 13) — M39, M14, D4, compositor-spec §8

Decode is decoupled from render entirely, as the spec requires. A clip is **extracted once** to
still frames at the project's fps; rendering frame n draws cached frame `map(n)`. Nothing ever seeks
or plays a `<video>`, so a scrubbed frame is the frame that exports.

**Frame cache** — `src/assets/video-cache.ts`: `<root>/video/<hash>/<fpsNum>-<fpsDen>-<width>/`
holding `frame-NNNNNN.jpg` (q2) and an `index.json` written **last and atomically**, so a folder is
a hit only once complete; a corrupt or incomplete index is a miss and is re-extracted. Resumable,
idempotent, `maxFrames`-capped (a long clip under a short video is not decoded whole), abortable,
never upscaled (sizes round *down* to even — a test caught rounding up past an odd source width).
Keyed by content hash, so relinks and renames reuse it. Lives on the repo's drive (`ROOT/cache`,
shared by the CLI, the queue and the studio) — a frame cache runs to gigabytes and C: is nearly full.
The vendored FFmpeg is LGPL (no libx264); tests generate clips with the built-in `mpeg4` encoder.

**Engine** — `core/video.ts`: `videoSourceFrame(timing)`, a pure integer mapping from timeline
frame to sequence frame (layer in-point, trim, speed with `floor`, loop or hold), shared by the host
that fetches and the module that draws so they cannot disagree. `render/videos.ts`: one texture per
clip, re-uploaded in place (`SRGB8_ALPHA8`, linear on sample), accepting decoded bytes or an
`ImageBitmap`. `Engine.setVideoSequence / setVideoFrame / hasVideo`, `RenderContext.video(assetId)`.

**Module** `core.source.video`: clip (asset, `accept: 'video'`), fit cover/contain/stretch, bars
colour, dim (modulatable); speed, loop, start-at — **not** modulatable, because the host must know
which frame to fetch before the frame renders. A missing clip draws the checkerboard and warns; if
the host is behind, the module says which frame it is showing rather than pretending.

**Feeding frames** — `src/video/frame-feeder.ts`, host-agnostic (`readFrame` injected):
`videoRequests(project, frame)` walks groups and de-duplicates; the feeder decodes with
`createImageBitmap`, keeps a small cache, and uploads. **Export awaits** it — `PumpSource.prepareFrame`
and `ExportRequest.prepareFrame / onEngine` are new, rendering stays synchronous. **The preview never
fakes a frame**: if the clip's frame is not on the GPU yet it skips the tick (a dropped frame, which
the preview may do) and redraws when it lands, prefetching ahead while playing.

**Pipeline** — `renderDocument` extracts each video asset at the render's own fps and width before
the Electron child starts (problems become notes, not failures). The studio extracts a 640-px
**proxy** over IPC (`pf:video:import|prepare|frame`, progress pushed on `pf:video:progress`, one
extraction per clip+fps at a time), re-extracting when the fps changes or the timeline grows past a
capped proxy. Video assets get relink, find-in-folder, collect-files and the asset panel for free.

Verified here: `npm run check` **694 tests** — `tests/assets/video-cache.test.ts` (real FFmpeg:
probe, extraction count, reuse, corrupt/incomplete index, `maxFrames`, missing file, sizing),
`tests/engine/video-frames.test.ts` (mapping, trim, speed, loop/hold, request de-duplication), and
`tests/golden/video-gpu.test.ts`, which renders a red→green→blue clip and reads the colour back:
right second on screen, identical out of order, starts at the layer's in-point, trim, 2× speed,
loop and hold, missing-clip checkerboard. `npm run golden` 15/15; `--smoke` **13/13** with a new
`videoBridge` check (proxy extracted and a JPEG still read back over IPC). A CLI render of a video
background at half speed + bars + title shows the clip's own burned-in timecode reading 00:00:01.000
at 2.0 s — the exact source frame.

**Not done:** cache size in a settings screen and pruning (M33, with the cache-management step);
the smoke does not drive the video import dialog (it cannot), so the studio import → preview path is
covered by the IPC check plus the GPU tests rather than one click-through.

### 4.42 The `modules/` drop-in folder (P4 step 14) — M35, module-spec §11, PROJECT.md §8.17

A drop-in module is **data**: a folder in `modules/` with `module.json` (manifest + parameter
schema) and a GLSL ES 3.00 fragment shader. **No JavaScript from `modules/` runs** — the renderer
stays sandboxed, the IPC surface does not grow, and a shader has no clock, network or disk, so a
drop-in is deterministic by construction. What it cannot do (assets, state between frames,
multi-pass) is documented; built-in modules remain the route for that. Written for authors:
`docs/module-authoring.md`.

**Engine** — `src/engine/modules/shader-module.ts`: `validateShaderModule` (id shape, `core.`
reserved, duplicates against built-ins and each other, kind, parameter types/ranges/defaults/enum
options/colours, `void main`, no `#version`), `shaderPrelude(kind, params)` and
`shaderModuleDefinition` → an ordinary `ModuleDefinition`, so the inspector, presets, modulation,
aspect overrides and export treat it like a built-in. The prelude gives `u_resolution`, `u_time`,
`u_frame`, `u_scale`, the audio features of the first `select:stem` parameter's stem,
`pf_spectrum`/`pf_bin`, `pf_uv()` (top-left origin), the seeded `pf_hash`, `pf_input` for effects,
and one uniform per parameter (int → float, enum → index, colour → linear vec3). Compile errors are
rewritten to the **author's** line numbers. The engine now isolates any module whose `create`
throws: `broken` map, the layer is skipped with a note, the rest renders. `Engine.addModules`
replaces a registered module (hot reload) and disposes its instances.

**Scanning** — `src/modules-folder/scan.ts`: `scanModules(root, builtinIds)`, sorted folders,
`_`/`.` folders ignored (so `_template` is not loaded), 256 KB shader cap, `shader` must be a
file in the folder. Every folder that fails is returned with its reasons — never dropped silently.

**Wiring** — main scans on request and watches the folder (debounced recursive `fs.watch` →
`pf:modules:changed`); the studio's Modules line shows the count, Reload, Folder, and each broken
folder with its reason; Add layer and the effect picker include the drop-ins; the preview host
registers them. `renderDocument` scans `modules/` for the CLI and the queue and passes the sources to
the Electron child, which builds the same definitions — preview and export cannot disagree.

**Shipped** — `modules/example-pulse-rings/` (a worked example exercising every parameter type,
audio drive by enum, stem choice, `u_scale` sizing) and `modules/_template/`.

**Conformance** — `npm run modules:check [-- dir]` (`scripts/check-modules.ts`) renders each module
on the GPU: params resolve and round-trip; compiles; determinism (frames 12/40/75 rendered twice in
opposite orders, byte-identical); reflow (draws at 16:9, 9:16 and 1:1; effects are tested over the
test pattern). Writes `out/modules-check.json`, exits 1 on any failure. Verified on a deliberately
bad folder: a non-compiling shader and a pixel-sized one are both caught with the reason.

Verified here: `npm run check` **705 tests** — `tests/modules/scan.test.ts` (loading, ignored
folders, broken folders reported by name, id clashes, the shipped example, a message per schema
mistake, `main`/`#version`, the prelude's uniforms) and
`tests/golden/modules-folder-gpu.test.ts` (the example is deterministic; a drop-in effect over a
drop-in source reads back the right colour; a broken shader is isolated and reported at the
author's line 3). `npm run golden` 15/15; `npm run modules:check` passes on the shipped example;
`--smoke` **14/14** with a new `dropInModule` check (the example is offered under Add layer, adds,
shows its generated inspector, and no engine note says it is broken — without audio it rightly
notes it has nothing to react to — then undoes).

**Not done:** JS modules (deliberately — see above); drop-ins in the preset browser (S8); the
module's `version` is recorded but projects do not yet warn when a drop-in they use has changed.

### 4.43 Three.js scene layers (P4 step 15) — M37, compositor-spec §7, module-spec §1

The `scene3d` module kind, three scenes, a camera rig and a depth-of-field effect. From the
compositor's side a 3D layer is an ordinary layer: transform, opacity, blend, effects, groups and
per-aspect overrides all apply unchanged.

**Host** — `src/engine/modules/scene3d/host.ts`. The three rules from compositor-spec §7, each
enforced here:
- *One context.* A single `WebGLRenderer` is built over the engine's own WebGL2 context (never its
  own canvas or context), shared by every scene layer on that context, reference-counted.
- *State hygiene.* Every scene render is `resetState()` → render → `resetState()`, then the engine's
  framebuffer, viewport and state are rebound explicitly. Proven by a GPU test: an opaque 2D layer
  over a scene is byte-identical to that layer alone, and a scene over a 2D layer leaves the 2D
  layer's uncovered pixels untouched.
- *No clock.* Scenes are posed from `ctx.time` and the analysis every frame, from scratch; no
  `Clock`, no animation loop, no `EffectComposer` — post-processing is the engine's effect chain.
Each layer renders into its own RGBA16F target (4× MSAA, float depth texture), copied into the
layer's target. Three's shader failures are captured (`debug.onShaderError`) and reported as an
engine note naming the scene — never a silent black layer.

**Scene contract** — `scene-module.ts`: `scene3dModule(manifest, build)`; a scene supplies a Three
`Scene` and `update(frame)` that poses it from `{ctx, params, t, source, spectrum, features, level}`.
Shared parts: `reactivityParams` (stem + driving feature), `SpectrumTexture` (bins × rows float
texture, read with `texelFetch`), `SCENE_SPECTRUM_GLSL` (`pf_spectrumRow`, `pf_spectrumAt`, the same
interpolation as the 2D modules' `pf_spectrum`), `linearColour`.

**Camera rig** — `camera.ts`: parameters under "Camera" (move orbit/dolly/static/handheld,
distance, height, look-at height, field of view, speed, start angle, roll, shake, beat kick), all
modulatable. `cameraPose(params, t, kick, prng, aspect)` is pure and closed-form; handheld drift is
seeded cosine-interpolated noise from the project PRNG. The field of view applies to the short side.

**Scenes** (all `gpuCost: high`, category `3d`):
- `core.scene3d.shapes` — **Reactive shape**: sphere / torus / knot displaced along its normals by the
  spectrum on the GPU (bands chosen from position so the UV seams do not crack), pulse, spin, tilt,
  palette-linked colour and rim light, glow, metalness/roughness, faceted or smooth, wireframe.
- `core.scene3d.terrain` — **Terrain**: a 120×80-unit plane; across is the spectrum (mirrored or
  not), along is the last 128 moments. Rows are sampled from the analysis on a fixed time grid and
  the surface slides by the elapsed fraction of a row, so it scrolls smoothly yet every frame is a
  pure function of its time. Flow away (new sound in front) or toward (rushing in from the horizon),
  valley, neon grid, height-graded colour, fade to transparent at the horizon.
- `core.scene3d.city` — **Bar city**: up to 48×48 instanced towers in one draw call; layouts
  downtown (bass in the middle), history (bands × time, scrolling like the terrain), scatter (seeded
  bands); seeded variety, per-tower colour by level, glow, horizon fade.

**Depth → depth of field** — `ModuleInstance.depth()` hands the scene's depth texture (with near,
far and fov) to the layer's effect chain (`LayerDepth`, `RenderContext.depth`, `EffectPass.draw`'s
third argument). `core.effect.dof` declares `needsDepth`: a 48-tap golden-angle gather whose circle
of confusion comes from linearised depth, with the "background may not blur over a sharper
foreground" rule; focus distance, sharp range, blur (a fraction of the reference size). On any
non-scene layer — or in the global chain — the engine refuses it with a note, and the studio's
effect picker does not offer it.

**Studio** — the three scenes appear under Add layer (`scene3d` added to the rail's layer kinds);
the inspector generates their controls from their schemas like any module.

**Measured** (CLI, 1080p60, 10 s, RTX 3060): shape + bloom **193 fps**, terrain + bloom **177 fps**,
city + depth of field **155 fps** — all verified MP4s. 3D is well inside real time at 1080p.

Verified here: `npm run check` **720 tests** — `tests/engine/camera-rig.test.ts` (orbit, static,
dolly cycle, kick, short-side field of view, seeded handheld drift, smooth noise) and
`tests/golden/scene3d-gpu.test.ts` (shape draws and is identical in any frame order; similar framing
at 9:16; terrain and city at 16:9 and 9:16, deterministic; the city's history layout slides rather
than jumps; depth of field blurs by depth — focused on the city it is sharper than focused in front
of it — and is refused on a 2D layer with the frame left untouched; state hygiene both ways). The
effects catalogue test now hosts depth effects on a scene layer. `npm run golden` **21/21**, with a
new `scene3d` entry (terrain + depth of field, torus + bloom, at 16:9 and 9:16). `--smoke`
**15/15** with a new `sceneLayer` check (adds a Reactive shape in the live preview; no scene shader
error, no broken module, no canvas error), which was confirmed to fail when the shader is broken on
purpose.

Also fixed on the way: `npm run golden -- --update --only X` rewrote the manifest with X's records
alone, silently dropping every other entry's references; it now keeps them.

**Not done:** the point cloud and tunnel-flight scenes PROJECT.md §8 also lists (terrain flowing
toward the camera covers the flight look); shadows; per-quality MSAA (preview and final both use
4×); the auto-director's budget does not yet drop scene layers at 4K (compositor-spec §7.4 — the
auto-director is P7). Scene draw order relies on Three's sort, which is deterministic for a given
scene but not a documented contract.

### 4.44 Preset browser (P4 step 16) — S8, M25, ui-spec §5, module-spec §10, D16, D45

The preset library as a first-class part of the studio: browse, preview, apply, save. Built on the
store (§4.25) and the preset model (§4.19), which were already done and tested.

**Where presets live** — user presets in `Documents/Pulseforge/Presets/user/{layer,project}/`
(beside the asset library: they are the user's work and belong in their backups;
`PULSEFORGE_PRESETS` overrides it, which the smoke uses), favourites in `favourites.json` there;
built-ins in the repo at `presets/builtin/`; thumbnails are a **cache** at
`ROOT/cache/preset-thumbnails/<key>.png`, keyed by `presetThumbnailKey(preset, ENGINE_VERSION)` — a
changed preset or engine gets a new picture, never a stale one.

**Browser** — `src/ui/components/PresetsPanel.tsx`, at the top of the left rail (ui-spec §5 lists
Presets first): search, All/Layers/Projects, favourites-only, the ten most-used tag chips (tags
narrow), favourites sorted first, one card per preset. A click does the obvious thing
(`defaultApplyMode`): replace the selected layer, add a layer when none is selected, or replace the
project's look. The card's ⋯ menu has the rest — add as layer, replace selected, **style only**
(look, keep the layer's name and modulations), **modulations only** (new in `applyLayerPreset`:
keep the layer, take the bindings, effect targets positional), use this look / add its layers for
project presets, and delete for user presets. Built-ins cannot be deleted (the store says so).
Every apply is **one undo step labelled with the preset's name**, via `src/project/preset-apply.ts`
(pure, tested) and two new commands, `replaceLayer` and `replaceLook`. Notes from applying (a module
not installed, a binding that will not resolve) arrive as a toast — nothing dropped silently.
Unreadable preset files are listed under the grid with the reason.

**Thumbnails** (D45: pre-rendered on save) — an 8-frame animation strip, 192×108 per frame, drawn by
a **second engine on the preview's own context** (`PreviewHost.renderStills`), so it shares the
fonts, decoded images and drop-in modules and draws exactly what the preview would, without
touching the preview's engine. The preset is applied to a small dark blank project
(`src/project/preset-thumbnail.ts`, pure) and rendered at eight moments of the **reference track**
(`src/analysis/reference-track.ts`, moved from `spike/test-signal.ts`, which re-exports it) — never
the loaded song, so a thumbnail is a property of the preset alone and caches cleanly. Strips are
drawn one at a time, only when a card scrolls into view (IntersectionObserver), cached by the main
process, and animate only under the pointer (ui-spec §13). Save draws the new preset's strip at once.

**Save** — `SavePresetDialog.tsx`, from the top bar's "Save preset…" (PROJECT.md §8) or the panel's
Save…: selected layer or whole project, name, comma-separated tags. Only non-defaults are stored;
a taken name gets a suffix rather than overwriting.

**Built-ins** — 11 layer presets (neon bars, cyan horizon, radial pulse, deep orb, retro tunnel,
embers, heat map, soft waves, synthwave flight, chrome knot, night city) and 3 project presets
(synthwave night, club bars, cinematic chrome), generated by `npm run presets:builtin`
(`scripts/make-builtin-presets.ts`), which builds them with the Save dialog's own functions and
refuses a module or parameter the build does not have. Layer presets use literal colours; project
presets carry a palette and link to its roles (`@primary`), so they arrive reskinnable.

**IPC** — `pf:presets:list|save|delete|favourite|thumbnail|store-thumbnail|reveal`. Everything the
renderer sends is validated in main: presets through `parsePreset`, scope/slug against the store's
own slug alphabet, thumbnail keys against `^[0-9a-f]{32}$` (a key is a filename, never a path),
PNGs capped at 8 MB.

**Found and fixed on the way:** `core.scene3d.city` declared `height` twice (tower height and the
camera's), so one silently overrode the other; the tower's is now `towerHeight`, and
`tests/engine/manifests.test.ts` checks every built-in for duplicate keys, unique ids and clean
defaults.

Verified here: `npm run check` **813 tests** — `tests/project/preset-apply.test.ts` (each apply
mode, labels, refusals, project look/merge leaving audio/seed alone, the thumbnail document and
frames), `tests/project/builtin-presets.test.ts` (all 14 load, apply with no notes and resolve every
palette link), new cases in `presets.test.ts` (modulations only), `commands.test.ts` (replaceLayer
in a group, replaceLook touches nothing else), `preset-store.test.ts` (favourites, deleting drops the
star, corrupt favourites, thumbnail cache and key rejection, key follows content and engine), and
`manifests.test.ts`. `npm run golden` **21/21**. `--smoke` **18/18** with three new checks:
`presetBrowser` (14 built-ins listed and a real thumbnail drawn), `presetApply` (click applies, the
undo label names the preset, undo restores), `presetSave` (Save → card with its thumbnail drawn at
once → Delete removes it). The first smoke run caught two real bugs, both fixed: an "add" apply was
labelled "Add layer" in the undo history, and a new card below the fold never showed the thumbnail
Save had already drawn.

**Not done:** live preview of a preset with the loaded song (D45's later refinement); module-declared
starting presets inside manifests (D16's other half — built-ins live in `presets/builtin/` instead);
presets that bring their assets across projects (see §7); drag-and-drop of presets onto layers; a
rename action in the browser (the store has `rename`); thumbnails for video layers show the
missing-clip checkerboard, because the stills engine has no video frames.

### 4.45 The project's own analysis bands — M4 (commit `7baa1b9`)

Found while building the binding UI: the analyser computed **one hard-coded band** (`bass`,
40–160 Hz) whatever the project declared, so a binding on any other band could never move, and
`bass` itself was not the 60–250 Hz a document says it is.

- `STANDARD_BANDS` (`src/analysis/spectrum.ts`): the seven default bands (sub, bass, lowMid, mid,
  highMid, presence, brilliance) — one list, used as the analyser's default and as a new document's
  `analysisSettings.bands`.
- `analysisOptionsFor(analysisSettings)` (`src/analysis/project-settings.ts`): a project's bands,
  onset sensitivity and tempo override → analyser options. **Both** the studio (`pf:audio:analyze`
  now takes the settings, validated by `parseProjectAnalysisSettings` in main) and `renderDocument`
  go through it, so preview and export analyse a track identically. Before this, neither passed any
  project setting — they agreed only because both used the defaults.
- The analysis cache key now includes **band names** as well as edges (data-formats §4.3 said names
  should not count). Cached band tracks are stored under the names they were computed with, and the
  container has no edges to re-match them by, so a rename that hit the cache would find no track
  under its new name and silently kill every binding on it. A rename now costs one re-analysis.
  Listed as a deviation in ROADMAP §4.
- Golden `layered` frame 75 (16:9 and 9:16) was **re-baselined**: its document declares `bass` as
  60–250 Hz and the analyser now honours that. Only the band-modulated bars' heights moved.

Not done: editing bands in the UI (re-analysis on change comes with it); the stem model setting is
still recorded but unused until M5.

### 4.46 Modulation in the studio — M13, modulation-spec §10–§11, ui-spec §4 item 5 and §6

The engine could always evaluate bindings (§4.10); now they can be made, edited and seen in the
studio without touching the project file.

**∿ beside every modulatable control** — float, int, bool and enum parameters of layers *and*
effects (`isModulatable`: numeric or discrete, not `modulatable: false`; colours and pickers have no
axis). On sliders it sits in its own column so it never crowds the label; it lights up when the
parameter is bound. Its menu offers existing bindings to edit, then **sources suggested for that
parameter** (modulation-spec §10: scale-like → onsets first, glow-like → loudness, hue-like →
brightness, …, from the key and label the module already declares), then the **recipes**
(§11): kick pump, bass glow, level bloom, hat sparkle, hue drift, beat pulse, breathing. One click
makes a working binding — a quarter of the parameter's range, auto-calibrated, standard envelope
and look-ahead, or the recipe's settings scaled to the parameter — and opens its editor.
Recipes needing structural or lyric sources (build riser, drop flash, lyric dim) wait for them.

**Binding rows** (inspector "Modulation" section, and the matrix): what it drives
("Bars › Bloom › Intensity"), what drives it ("Onsets · drums"), a **live level meter** of its
shaped signal, on/off, remove. Problems are said, not hidden: a target that no longer resolves
(`describeTarget`: layer gone, effect removed, parameter renamed, module missing), a source the
compiler could not use (e.g. a stem not analysed), and **"too weak to see"** when at full signal it
moves the parameter by under 1% of its range (`isImperceptible`, modulation-spec §10).

**Editor**: source with a one-line explanation (onset vs beat is spelled out, as the spec asks),
stem, band (from the project's bands, with Hz), LFO shape and rate, drift speed, ramp ends, mode
(add / multiply / replace), amount (bipolar, in the parameter's own units; a factor in multiply
mode), offset, curve and its amount, attack, release, look-ahead (D51), invert, auto or fixed input
range, and a name. Every change is an `updateModulation` command; a slider drag merges into one
undo step.

**Live values** — `FrameReport` gains `modulatedValues` (each bound parameter's rendered value, by
target path — exactly what the module received) and `bindingLevels` (each binding's shaped signal,
`bindingLevels()` in modulation.ts). The preview host forwards them with the status tick (~10 Hz,
`onModulation`), and a modulated slider shows a glowing **marker at the rendered value** while its
handle stays at the base value, with the readout showing the rendered number.

**Matrix panel** (top bar "∿ Modulation", or "Matrix" in the section; a right-edge drawer that
replaces the render queue while open): every binding in the project, grouped by layer or by source,
filterable, with the same rows, **↑/↓ reordering among bindings on one target** (order matters for
add vs multiply, modulation-spec §9.2 — one undo step per swap), jump-to-layer, and all on / all
off for what the filter shows.

The authoring logic is pure and tested — `src/project/modulation-authoring.ts`: source catalogue,
suggestions, `defaultBinding`, `RECIPES`, target parsing and labels, `allBindings`,
`isImperceptible`, `describeSource`.

Verified here: `npm run check` **826 tests** — `tests/project/modulation-authoring.test.ts`
(spans, what is modulatable, suggestions, default amounts in the parameter's units, every recipe
compiles and scales to its parameter, target labels and every way a target breaks, weak-binding
rule, source descriptions) and new cases in `tests/engine/modulation.test.ts` (binding levels are
the shaped signal before amount/invert; disabled and uncompilable bindings are absent). `npm run
golden` **21/21**. `--smoke` **19/19** with a new `modulationUi` check (adds Bars, ∿ → Breathing,
then waits for the binding row, the slider's live marker, a moving level meter, the undo label and
the matrix listing it; undoes). The UI tour now captures the menu, the editor and the matrix
(`out/ui-tour/*-7*.png`).

**Not done:** the source sparkline/scope (the level meter answers "is it doing anything" for now);
copy/paste of bindings between parameters; right-click on controls; bindings on the global effect
chain; quantisation (needs a beat-synced grid source, §4.10); per-stem sources are offered but
inactive until M5.

### 4.47 Blend modes, layer editing and the audio clip — M7, M9, M29

Three small, visible holes, closed together (ROADMAP §3 item 2).

**Blend modes (M7, compositor-spec §3).** The inspector offered `multiply` and `overlay`, but the
compositor drew only normal/add/screen, so they rendered as normal with a note. Now the ten
**separable** modes are real: multiply, overlay, soft-light, hard-light, darken, lighten,
difference, exclusion, colour-dodge, colour-burn. They need the backdrop, so they cannot be GL blend
state: the compositor copies the backdrop to a pooled scratch target (a pass never reads what it
writes — the spec's ping-pong) and runs `BLEND_FRAG`, the W3C formula in premultiplied form —
`(1−αb)·Cs + (1−αs)·Cb + αs·αb·B(cs, cb)`, so a transparent backdrop (a layer alone in a group) draws
the layer as itself. The composite is linear and may exceed 1: modes defined on 0..1 see clamped
inputs; multiply, darken, lighten, difference and exclusion do not. Normal/add/screen keep the
fixed-function path. One list of modes now lives in the engine (`BLEND_MODES`, core/project.ts) and
the document re-exports it, so the UI can never again offer a mode that is not drawn; the
snapshot's fallback-with-a-note stays for files from a later build (tested with `hue`). The HSL
family is not implemented.

**Layer editing (M9, ui-spec §5).** In the layer list: **S** (solo — the snapshot already honoured
it) and **L** (lock) on every row; **↑/↓** in the actions (one step within the layer's group);
**drag a row onto another** to put it directly above that row, into that row's group
(`src/project/layer-order.ts`: `stepPosition`, `dropPosition`, pure and tested — the flip between
the top-first list and bottom-first storage and the index-after-removal are worked out once).
**Lock now means something**: the inspector's controls sit in a `fieldset` that is disabled for a
locked layer, with a note saying how to unlock; Delete is disabled; a preset cannot be applied onto
it (add-as-new-layer still works). **Timing** in the inspector: the layer's in and out points in
seconds, "at the playhead" buttons, and ∞ for "to the end" (an out point is kept at least one tick
after the in point). Found on the way: the list showed a **group's row below its own children**
(it reversed a pre-order walk); `displayOrder` fixes it.

**The audio clip (M29, PROJECT.md §8.10).** The model had trim, lead-in/out, fades and gain, but
**the export applied neither fades nor gain**, and nothing in the studio edited any of it. Now:
- `fadeInCurve` / `fadeOutCurve` join the document (`equal-power` — the default — `linear`,
  `s-curve`); additive, so older files read with the default and no schema bump was needed.
- `src/project/audio-clip.ts`: `fadeShape`, `clipLevel` (gain × fade-in × fade-out, in clip samples;
  overlapping fades rise and fall rather than jump), `isUnity`. **One definition, two users**: the
  exporter multiplies every placed sample by it (`placeAudio`, `AudioPlacement.level`), and the
  preview sets the audio element's volume from it each tick, so the fade you hear is the fade that
  renders. The fade-out ends where the clip ends even when the video cuts the clip short. An element
  cannot play above unity, so a gain boost is exported but not previewed louder (said in the UI).
- The **Clip** panel under Audio: trim in/out (with at-the-playhead buttons, clamped so the clip is
  never inside out; the file's end is stored as "to the end"), lead-in, lead-out, fade in/out with
  their curves, gain in dB (−24…+12). Every edit is `setAudio`, one undo step per field. If a
  project never recorded the file's length, the loaded audio's length stands in.
- Verified in a real export: a 6 s clip of a steady tone with 1.5 s equal-power fades measures RMS
  0.0066 → 0.035 across the fade-in, 0.044 in the middle, and the mirror image on the way out.

Verified here: `npm run check` **856 tests** — `tests/golden/blend-gpu.test.ts` (each of the ten
modes over the test pattern matches the W3C formula computed in the test, through the engine's tone
curve and sRGB, within 2 code values; a lone blended layer in a group draws as itself; screen is
unchanged), `tests/project/layer-order.test.ts` (step up/down, drop from either direction, into a
group, never into itself, display order), `tests/project/audio-clip.test.ts` (curves, clip level,
overlapping fades), new cases in `export-units`, `preset-apply` (locked layers) and `snapshot`
(fallback now tested with `hue`; separable modes pass through). `npm run golden` **21/21**.
`--smoke` **20/20** with a new `layerEditing` check (its own two layers: solo on/undo, lock disables
the inspector and Delete/undo, a one-step move/undo). The UI tour captures the clip panel when a
project with audio is opened (`npm run dev -- <project> --smoke` with `PULSEFORGE_UI_TOUR=1`).

**Not done:** dragging time ranges and clip edges on the **timeline** (the inspector and the Clip
panel edit the same values); multi-select; the HSL blend family; a fade curve preview; export-spec
§7's stream-copy of untouched audio.

### 4.48 Stems end to end — M5, M27, M28

Demucs worked since P0 (8.6 s for four minutes) and the supervised sidecar since §4.24, but nothing
in the studio used either: every stem source read "not analysed". Now **Separate stems** in the
Audio panel runs the whole chain, and a layer or binding set to `drums`, `bass`, `vocals` or
`other` reacts to that stem in the preview and in exports.

**The GPU job queue (M28)** — `src/node/gpu-queue.ts`: renders and ML jobs take turns; one at a
time; a waiting **render goes ahead of waiting ML jobs**; a running job is never pre-empted (a
separation takes seconds, and killing one throws away the model load); and before every render
`beforeRender` **stops the sidecar so its models give their VRAM back**. A job cancelled while
waiting never starts. The studio's render service now takes a GPU lease per render. The live
preview is deliberately not in the queue — it is interactive and light.

**The sidecar in the studio (M27)** — one `SidecarSupervisor` in main, started on first use, idle
shutdown after 60 s, stopped before renders and on quit. Before separating, main checks the
vendored FFmpeg, Python and the model file and, if the stems part of setup is missing, says so with
the fix rather than failing inside Python.

**The stem job (M5)** — `src/ml/stems.ts` `separateStems`, plain Node:
1. decode to mono 48 kHz — the same decode and hash as the mix, so **the same cache entry** — and
   make sure the mix is analysed;
2. mark each stem `pending` in the cache (visible to anything reading readiness);
3. decode to stereo 44.1 kHz float and ask the sidecar to separate (progress and cancellation via the
   supervisor);
4. per stem, one FFmpeg pass keeps it as **FLAC** (`ROOT/cache/stems/<audioHash>/<model>/<stem>.flac`,
   for lyrics alignment and per-stem waveforms later) and produces mono 48 kHz for the analyser; the
   stem is analysed with the project's settings and written to the cache. A stem's `beat` feature
   is the **mix's** grid pulse — the grid belongs to the song (modulation-spec §2.1).
Failures and cancels mark every unfinished stem `failed` with the reason — never pending for ever.
Scratch is removed either way. Progress is one 0..1 across decoding, separating and analysing.
The stem model is now part of every analysis cache key (`cacheOptionsFor`), so changing it
re-separates.

**Everywhere else, for free**: a cache hit already returned every ready source, so the studio's
`analyzeAudio` now sends the stems (and each stem's state) and the store merges them into the
preview's analysis; exports write one analysis container per source (`sourceFiles` in the export
config) and the render child merges them.

**Studio** — the Audio panel's **Stems** block: Separate stems, a progress bar with the stage
(waiting for the GPU, decoding, separating, analysing *drums*…), Cancel, then the list of stems; a
failure says why and offers to try again; an interrupted separation is noticed on the next open.

Verified here: `npm run check` **866 tests** — `tests/node/gpu-queue.test.ts` (one at a time,
renders first, no pre-emption, models freed before renders, failures do not stop the queue,
cancel-while-waiting), `tests/ml/stems.test.ts` (with a fake sidecar and real FFmpeg, analyser and
cache: five sources on the next hit, the mix's beat on every stem, FLACs kept, scratch cleaned,
progress monotonic; cancel and failure marked with the reason), and **`tests/golden/stems-gpu.test.ts`
running real Demucs on the GPU**: four stems cached with the mix, the kept stems **add back up to the
original within 1% of its energy**, the energy is genuinely split, and the sidecar stays healthy and
stops cleanly (about 5 s on an 8 s track, model load included). `npm run golden` **21/21**.
`--smoke` **20/20** in the standard run; opened with a project that has audio, a `stemsUi` check
presses Separate stems and waits for all four to be listed (passed). An export of a Bars layer set
to `drums` renders against the drums (no "no analysis for stem" warning), and the same render with
an empty cache warns — the control that shows the check means something.

**Not done:** per-stem waveform rows in the timeline and stem solo in the preview (ui-spec §5);
the 6-stem model (S6); the CLI shares no cache with the studio (see §7); cache size and pruning of
stems (M33). An earlier assumption worth recording: a test first asserted which stem Demucs files a
synthetic sound under (a pure-sine "kick" went to *other*, not *drums*); that is Demucs' business,
so the test checks reconstruction and energy split instead.

### 4.49 Autosave and crash recovery — M1

ui-spec §10: autosave on an interval and before risky operations, into a rolling set of recovery
files; on the next launch, offer the recovered state with a timestamp and a summary of what it holds.

**Sessions** — `src/project/recovery-store.ts`, plain Node, used by main. Each run of the studio is a
session with its own folder, `%APPDATA%/Electron/recovery/<sessionId>/` (`PULSEFORGE_RECOVERY`
overrides): `session.json` (project path and name, started, last snapshot and why) and rolling
`<n>.pvproj` snapshots, the newest **5** kept, each written atomically (temp + rename). A clean quit
deletes the session's folder (`endRecoverySession`, from `will-quit`, and from the smoke's
`app.exit`, which skips `will-quit`), and so does a successful save or save-as, since the file is
then the newest state. **A folder still there at the next start is a run that ended without either**
— a crash, a killed process, a power cut — and is offered back. Session ids are checked against
`newId`'s alphabet before they become folder names; a damaged session is skipped, not fatal to the
list; the running session is never offered and cannot be discarded.

**When it writes** — `store.autosave(reason)`: every 60 s (`App`), and **before applying a preset**
(a preset can rewrite the whole project). Only when the history is dirty and the state changed since
the last snapshot, so an idle or saved studio writes nothing. Snapshots hold absolute asset paths,
as the studio does, so a restore needs no folder to resolve against. A failed write is a warning
toast, never a stop. Opening or starting a project clears this run's snapshots (they belonged to the
project left behind).

**Recovery** — at start the studio lists crashed sessions (main also reads the saved file at the
session's project path, if any) and `RecoveryDialog` offers the newest: project name, path or "never
saved", when and why it was autosaved, and a summary from `src/project/recovery-diff.ts`
`summarizeRecovery(saved, recovered)` — layers added / removed / edited, by name (compared by id; a
group is not "edited" because a child was), palette, audio clip, canvas, global effects, rename; or
"never saved, with N layers", or "the same as the saved file" (ignoring `modifiedAt`). **Restore**
opens it under its original path **as unsaved** (`History.resetUnsaved`, so closing asks first),
immediately snapshots it into this session and only then deletes the crashed one — a crash from there
on recovers the restored work. **Discard** asks, then deletes. **Later** keeps it for the next start:
nothing is dropped without being asked. More than one crashed session: offered one at a time, newest
first.

Verified here: `npm run check` **877 tests in 69 files** (`tests/project/recovery.test.ts`, 11: newest
snapshot offered, the running and cleared sessions not, pruning to 5, newest-first with a damaged
session skipped, path-like ids refused, stray files ignored, a missing folder is empty; the summary's
added/removed/edited names, palette/audio/rename lines, never-saved and unchanged; a recovered
document dirty until saved). `npm run golden` **21/21 identical**. `--smoke` **21/21** with a new
`recoveryDialog` check: the smoke seeds a "crashed" session in its own folder; the dialog must offer
it with its summary, Restore must open its layer, and main then checks the crashed folder is gone and
this run holds a fresh snapshot. The smoke exit also fails if this run's folder survives a clean exit
(which caught that `app.exit` skips `will-quit`).

**Not done:** the interval is fixed at a minute until the settings screen (M36; PROJECT.md §8 lists
"autosave interval"); the other risky operations ui-spec §10 names — auto-generate and re-align
lyrics — must call `autosave` when they are built (P7, P6); no "browse older snapshots" (five are
kept, only the newest is offered); an autosave whose audio or assets were moved since restores with
the usual missing-asset reporting, nothing more.

### 4.50 Lyrics data (P6 step 1) — M18's model, lyrics-spec §1–§2, §6.4–§6.5, §9, §10

The lyrics layer, the studio editor and WhisperX all build on this step. It is pure code with no
GPU and no UI: the document model, the timing maths, text preparation, subtitle formats, undoable
commands and the checklist. 52 tests in `tests/lyrics/`.

**Document (`src/project/document.ts`).** `lyrics` was a reserved key; it is now typed:
`Lyrics { language, source: manual|import|aligned, lines, sections }`, `LyricLine { id, text,
startTicks|null, endTicks|null, words[], role: lead|backing|adlib|instrumental-note, style|null,
confidence|null, locked }`, `LyricWord { id, text, startTicks, endTicks, confidence|null }`,
`LyricSection { id, label, beforeLineId|null }`. Every node has `extra`, like the rest of the
format.
- **Untimed lines are allowed** (`startTicks: null`): pasted text has no time until it is tapped,
  imported or aligned. Such lines are not drawn and the checklist counts them.
- Times are **timeline ticks** (lyrics-spec §1), so trimming or padding the audio does not move the
  lyrics against the picture.
- **Parse:** a line's end before its start is moved to the start and reported, never swapped. Line
  breaks inside a line are joined. An unknown role becomes `lead`, reported. Line, word and section
  ids join the duplicate-id check, and a marker pointing at a missing line is reported.
- **Serialize:** lyrics are written only when they differ from a new project's, so every existing
  project and golden fixture saves to the same bytes as before. No schema version bump: adding an
  optional field is not a breaking change (data-formats §2.3).

**Styling is not in the document — a deliberate reading of the spec** (also in ROADMAP §4).
lyrics-spec §1 sketches `style`/`karaoke`/`layout` inside `LyricsDocument`. §7 and §13 also require
"everything is a schema-declared parameter … the lyrics layer is a text-kind module". Both can hold
only if the styling lives on the lyrics **layer**. That way it is modulatable, per-aspect
overridable (§7: vertical wants lyrics higher and larger) and carried by presets, and the inspector
generates itself. It also means a project can show its lyrics twice, for example lead vocals on
one layer and backing vocals styled differently on another. Only per-line overrides (D38:
`scale`, `opacity`, `offsetX/Y`, `color`) live on the line.

**Timing maths (`src/engine/core/lyrics.ts`, in the engine because the layer and the modulation
sources both need it).**
- `lyricTokens`: whitespace runs, the same rule as the text layout. A run with no letter or digit
  attaches to the word before it (§2.3), so a free-standing "—" never fills as its own word. Tokens
  carry character ranges into the text, which is how the renderer maps rasterised words onto them.
- `wordSpans`: explicit word timings when there is exactly one per token, otherwise the line's
  duration **by character count** (§6.4). A word list that does not match the text is ignored, never
  mis-assigned.
- `wordProgress` holds a finished word at 1 through a gap.
- `lineWindows`: `appear = max(start − leadIn, previous end)`, never later than the start; `disappear =
  min(end + holdOut, next appear)`, never earlier than the end. So a lead-in is clamped to the gap
  (§6.5), and a line that leaves exactly as the next appears is marked `handover` (the layer animates
  that with its advance mode rather than exit + entry).
- `lyricSignals` gives the three modulation sources of modulation-spec §2.4 as pure samplers:
  `lyricActive`, `lineProgress` and `wordActive` (an e^(−age/80 ms) impulse on every word start). An
  `instrumental-note` line is on screen but not sung.
- `toRenderProject` passes `RenderProject.lyrics = { lines (timed, sorted by start, stable),
  untimedLines }`.

**Text preparation (`src/lyrics/prepare.ts`).** Web lyrics come with annotations, which become
**section markers**, not lines (§2.2):
- `[Verse 1]`, `[Chorus: X]`, `(Chorus)`, `(x2)` alone on a line become markers.
- A trailing repeat (`Hold on (x2)`, `Let go x3`) is stripped into a `×N` marker before its line.
- A parenthesised line that is not a section name (`(ooh, yeah)`) is kept as a **backing** line. This
  is a heuristic and the role is editable.
- Text is NFC-normalised, exotic spaces and zero-width characters are removed, and runs of spaces
  collapse.
- `splitLongLine` splits at the punctuation nearest the middle, else at the nearest space, recursively.

**Formats (`src/lyrics/formats.ts`).**
- Import: `.lrc`, enhanced LRC with `<mm:ss.xx>` word tags, `.srt`, `.vtt` with inline word
  timestamps, and `.ttml`. The format is detected from the extension, then from the content.
- Export: `.lrc`, enhanced `.lrc`, `.srt`, `.vtt` (word timestamps when the line has explicit words) and
  `.ass` (karaoke `\k` durations that sum to the line).
- Choices worth knowing:
  - **LRC has no line ends.** A line ends at the next start or at an empty tag (the usual "line off"
    convention), capped at `max(3 s, 0.6 s × words)`, so a line does not "sing" through a break.
    LRC export writes empty end tags only where the next line does not start at this one's end.
  - `[offset:]` applies as LRC defines it: positive shows lyrics earlier.
  - Repeated time tags make repeated lines.
  - Word stamps covering several words are spread by character count. Stamps that do not line up
    with the words leave the line with line timing only, and a warning.
  - TTML span times are treated as absolute when they all fall inside their paragraph (how Apple's
    lyrics TTML writes them), relative otherwise.
- Round-trips are tested at each format's precision: SRT, VTT and TTML to the millisecond (exact in
  ticks at 48 per ms), LRC and ASS to the centisecond.

**Commands (`src/project/lyrics-commands.ts`).**
- **`setLyricsText` keeps timings through editing.** The editor is plain text, re-read on every
  keystroke, so it matches old lines to new ones in three steps:
  1. Lines that are unchanged (longest common subsequence) keep everything.
  2. Between those, an edited line pairs with its most similar old line (Levenshtein ≥ 0.5, in order)
     and keeps its id, times, role, style and lock. Its **word timings survive only if every word
     still matches** (compared as sung: case and punctuation ignored, so "tonight" → "Tonight!"
     keeps them). Otherwise the line interpolates rather than attaching a timing to the wrong word.
  3. Anything else is a new, untimed line.
  Typing merges into one undo step; the same text is a no-op.
- `lyricsToText` writes the editor text back out, with markers as `[label]`.
- Timing:
  - `setLineTimes` rescales explicit words with the line.
  - `moveLines` moves words with their lines, and with `ripple` moves every line from the earliest
    moved one on (§5). A move is clamped as a whole at 0, so spacing is kept.
  - `setWordTimes` materialises interpolated words first, so moving one word leaves the others put.
  - `clearLineTimes` clears unlocked lines only, unless given ids.
- Structure: `splitLine` at a word (timing splits at that word's start), `mergeWithNext` (markers
  move along).
- Also: `setLinesLocked`, `setLinesRole`, `setLineStyle`, `setLyricsLanguage`, and `importLyrics`
  (replaces the lines, keeps the language, `source: import`).
- `applyAlignment` writes **unlocked lines only** and counts what it skipped: locked lines, words
  that no longer match, lines that are gone (§4).

**Checklist (`src/lyrics/validate.ts`) — lyrics-spec §9.** Checks: untimed lines; overlaps and
out-of-order lines **per role** (backing over lead is normal, D35); lines under 0.25 s or over 15 s;
reading speed over 25 letters per second; word timings out of order, zero-length or outside the line;
a word list that does not match the text; low-confidence clusters (a line below 0.5, or three words
in a row below it); and, given vocal segments, **a line with no singing under it** (under 15 %
covered) and **singing with no line** (a segment of 1.5 s or more that is under 30 % covered).
Sorted by severity, then time. Each check names its lines and a jump-to time. Safe-area overflow and
missing fonts are reported by the layer itself, which has the renderer.

**Vocal segments (`src/lyrics/vocal-segments.ts`)**, from the vocal stem's `rms` feature.
- The threshold is **relative to the track**: between its 20th and 95th percentiles, because Demucs
  leaves a bleed bed whose level depends on the mix.
- Hysteresis (on at 45 %, off at 30 % of that range) keeps a dipping held note as one segment.
  Blips under 0.2 s are dropped and gaps under 0.35 s bridged.
- A stem that never rises above near-silence has no segments.

Also: the M1 recovery summary now mentions lyrics changes.

Verified here: `npm run check` **929 tests in 72 files** (52 new).

**Not done in this step:** the lyrics layer and karaoke rendering (step 2), the studio editor,
tap-to-sync and the timeline track (steps 3–4), WhisperX (step 5).

### 4.51 The karaoke layer (P6 step 2) — M20, lyrics-spec §6–§8, modulation-spec §2.4, §11

`core.text.lyrics` (`src/engine/modules/lyrics.ts`) draws the project's lyrics, timed to the music,
with karaoke fill. Its content comes from the project (`RenderProject.lyrics`, §4.50). Its look is
its own schema (≈50 params in Text, Lines, Karaoke, Outline, Shadow, Glow, Plate, Animation and
Roles), so the inspector generates itself and everything is modulatable and per-aspect overridable.

**Shared GPU code with the text layer.** The raster upload, the word-id map, the per-word
visibility pass, the blur sampling and the colour helpers moved from `text.ts` into
`src/engine/modules/text-gpu.ts`. A title and a karaoke line with the same style are drawn by the
same code. **Verified pixel-identical**: text frames exercising the plain path, the typewriter mask
pass, glow, outline, gradient and plate hashed the same before and after the move. (Text is not in
the golden set, so this was an A/B render with `text.ts` stashed.)

**Karaoke fill (§6.1, §6.2).**
- Each line is rasterised once per (text, style, resolution) and cached: 24 lines, least recently
  used (§11). The fill is computed per pixel from a small per-word table, a 2-row RGBA32F texture
  uploaded each frame: box, progress, the row's sweep front, pop and lift. It never re-rasterises.
- Rasterised words map onto lyric tokens **by character offset**, so a "—" standing alone fills
  with the word it belongs to, left to right across both.
- Modes:
  - `wipe`: hard or feathered edge (`softEdge`, em).
  - `wordSwap`: the whole word switches at its start.
  - `wordPop`: the word brightens and rises, decaying with a 0.18 s time constant. The id map is
    grown upward so the lift has room.
  - `fillStroke`: the outline is always there and the fill pours in; it forces at least a
    0.04 em outline.
  - `gradientSweep`: a front at least one em wide, crossing word boundaries on each row. Colour is
    "being sung" near the front and "sung" behind it.
  - `bouncingBall`: lands on each word as it starts, a sine hop between word centres, and settles
    onto the first word before it.
  - `none`: static, line-timed only.
- Colours: `upcoming` / `active` / `sung`, each palette-linkable. A line's own `style.color` replaces
  `upcoming`.

**The window (§6.3, §6.5).**
- Lead lines (and instrumental notes) form the sequence. The current line sits at the layer's
  anchor, with up to `lines − 1` previews below at `nextOpacity`. Spacing follows each line's
  actual height (a wrapped line is taller) plus `lineGap`.
- A **hand-over** (the next line appears as this one leaves, `lineWindows`) is animated by
  `advance`:
  - `scroll`: the stack slides up; the old line fades as it rises and the next preview fades in at
    the bottom.
  - `crossfade`: the old and new windows blend.
  - `cut`: an instant switch.
- **The hand-over is centred on the boundary**, starting half the advance time before the next line
  is sung (`windowCursor`). The first golden render showed why: starting at the boundary left the
  new line filling its first word while still dimmed in the preview slot. The half is capped at
  40 % of either line, so short lines still get a complete, faster move.
- A line that appears out of an empty screen, or leaves into one, plays the entry and exit
  animations instead: the text layer's `textAnimation`, including per-word typewriter and stagger.
- `leadIn` (0.6 s) and `holdOut` (0.4 s) follow the clamping rules of §4.50.

**Roles (D35).**
- With `roles: all`, backing and ad-lib lines are **satellites**: they never join the sequence
  (where they would push the lead line away).
- Backing lines sit **below the whole window, as actually laid out**. The first golden render put
  them one line below the current line, on top of the next-line preview, and a fixed estimate then
  failed when a 9:16 line wrapped.
- Ad-libs are offset to the side (`adlibOffsetX`, a fraction of the width).
- Each satellite role has its own scale and opacity, and concurrent satellites stack.
- A layer set to one role shows only that role, as its own sequence. So backing vocals can have
  their own layer, styled and placed independently.

**Legibility (§7) and checks (§9).**
- A shadow is on by default, and a plate per line is available.
- The layer reports **a line outside the title-safe area** (5 % margins) at the current canvas, for
  lines at more than half opacity.
- It also reports **missing fonts** (as the text layer does), **no lyrics** and **no timed lines**,
  each with where to fix it.
- Each line is scissored to its animated bitmap (plus the ball's airspace), so a window of four
  lines at 4K does not cost four full-screen passes.

**Modulation (modulation-spec §2.4, §11).**
- `lyricActive`, `lineProgress` and `wordActive` are live (§4.50's `lyricSignals`, cached per
  project) and fixed-range 0..1, like the generators.
- Without timed sung lines, a binding on them is **reported and inactive**, never a silent 0.
- The studio offers them as *Singing*, *Line progress* and *Words*.
- New recipes:
  - **Lyric dim**: `lyricActive`, 200 ms linear envelope, 200 ms look-ahead, `multiply −0.4` — the
    spec's "cheapest legibility win".
  - **Word accent**: `wordActive`, 150 ms release, +15 % of the parameter.

**A bug the determinism test caught.** The per-word mask pass ran with the previous line's scissor
still enabled, so it updated only part of the mask and left words from an earlier frame in the rest:
render order changed the pixels. The mask pass now disables the scissor itself.

**Golden entry `lyrics`** (`tests/golden/projects/lyrics.pvproj`): a two-second project going
through the real document path, at 16:9 and 9:16. Its first line has explicit word timings; it also
has a backing line, a scroll hand-over, a Word-accent binding on glow, and a 9:16 override (higher,
larger). Frames 30, 50, 64 and 100 were checked by eye before being accepted: mid-wipe, backing
below the window, the hand-over complete, and the wrapped vertical line.

Verified here:
- `npm run check`: **948 tests in 74 files**. New ones cover the pure layout (window, scroll,
  crossfade, cut, satellites, entry/exit, stack geometry, sweep fronts, punctuation fill, all fill
  modes offered) in `tests/lyrics/layout.test.ts`. `tests/golden/lyrics-gpu.test.ts` runs on the RTX
  3060 and checks: nothing before the lead-in; mid-line the band reads sung-then-unsung left to
  right; a finished line is all sung; the preview is lit but never full white; all seven fill modes
  draw and all differ, and `none` never uses the sung colour; the output is deterministic across
  runs and render order; and a project without lyrics says so.
- `npm run golden`: **29/29 identical**. `--smoke`: **21/21**.

**Not done:** contrast enforcement against the backdrop (§7, shared with auto-director-spec §7);
gradient fills and per-word styling (D38: per word is a Could-have); a lyrics layer is added from the
module list like any other layer, but lyrics cannot yet be *entered* in the studio (next step).

### 4.52 Fix: audio modulation read the wrong moment with a lead-in or a trim — M13, M29

Found while building tap-to-sync (P6 step 3), by reading how the analysis is sampled. Modules
sample the analysis at `ctx.audioSeconds`, the **source** time (lead-in and trim already mapped).
The modulation compiler sampled every audio source (bands and features) at the **timeline** time
`t`. With lead-in 0 and clip-in 0 the two are the same, which is every test and golden project,
so nothing caught it. With a 2 s lead-in, every binding reacted to the music 2 s early; with a
trimmed clip, to the wrong part of the song.

**Fix (`src/engine/core/modulation.ts` `trackReader`).**
- `CompileOptions.placement` maps timeline time to source time for audio sources.
- Before the clip starts and after it ends, an audio source reads **0**, because there is no
  sound there. It no longer reads the file's level at some other moment.
- Generators (LFO, noise, ramp, progress) and the lyric sources stay on timeline time.
- `RenderProject.audio` gained an optional `clipOutTicks`. The snapshot fills it from the clip's
  out-point, or the file length when the clip runs to the end.

Test: `tests/engine/modulation.test.ts` ("audio sources follow the clip, not the timeline").
Written first and seen to fail, then passing.

**One golden change, explained:** `layered` frame 75 at both aspects (SSIM 0.998). Its band binding
looks 30 ms ahead, so auto-range calibration samples a few points past the end of the 2-second
clip. Those used to read the file's last value and now read silence, which shifts the percentile
range slightly. References updated. Every other frame is byte-identical.

**Still open (§7):** modules themselves still see `audioSeconds` outside the clip. During the
lead-in it is negative and clamps to the file's first sample; past a trimmed out-point it keeps
reading the file. A visualizer can therefore still react during a lead-out to music that is not
playing.

### 4.53 Lyrics in the studio (P6 step 3) — M18, M19 (tap-to-sync), lyrics-spec §2–§3, §5, §9, §10; D33

**Where it lives.**
- The ui-spec puts Lyrics in the left rail. The rail is a narrow single column, too tight for a text
  editor plus a timing table, so the rail gets a **Lyrics section** (status, `Edit…`, and "Show
  lyrics on the canvas" when the project has lyrics but no lyrics layer).
- The editing happens in a **right-edge drawer** (`♪ Lyrics` in the top bar). It sits beside the
  canvas rather than over it, because tapping needs both. One drawer at a time (queue, matrix,
  lyrics); Esc closes it.

**The drawer (`src/ui/components/LyricsPanel.tsx`).**
- **Import…** `.lrc`/`.srt`/`.vtt`/`.ttml` replace the lines with timed ones, asking first when there
  are lines. A `.txt` file is read like a paste. The toast states the counts and any format warnings,
  and after an LRC import says that LRC timings are often 0.2–0.5 s off (D37: re-alignment is
  offered, never forced — the offer itself arrives with WhisperX).
- **Export…** writes LRC, LRC with word timings, SRT, WebVTT (with word timestamps) or ASS karaoke
  through a save dialog. **Language** is stored for alignment. **Split long lines** (untimed lines
  over 42 characters) goes through the text path, so every timed line keeps its timing.
- **Text tab.** Paste or type. Every edit re-derives the lines through `setLyricsText` (§4.50), which
  keeps timings, after a 250 ms pause; the textarea owns its text while focused, so the caret never
  jumps. Typing merges into one undo step, sealed on blur.
- **Lines tab.**
  - Section markers (`Verse 1`, `×2`, `Chorus`) show between lines. Backing and ad-lib lines are in
    italics, untimed lines dimmed, locked ones green.
  - Start and end are typed as `m:ss.cc`: a forgiving reader (`src/lyrics/timecode.ts`: `1:02.35`,
    `62,5`, `0:01:02.350`; empty clears), and invalid text is outlined and not applied.
  - Selection: click, shift-click, ctrl-click. Clicking a timed line moves the playhead to it.
    Selected lines can be given a role, locked, or have their times cleared in bulk.
  - The selected line shows its **words**: explicit or interpolated, each word's start editable,
    low-confidence words underlined. A split button before each word, and Merge ↓.
- **Checklist tab.** `validateLyrics`, run continuously, with vocal segments from the vocal stem
  when stems exist (and a note to separate them when they do not). A click selects the lines
  concerned and moves the playhead there. The rail shows how many warnings are open.

**Tap-to-sync (`src/lyrics/tap.ts`, `src/ui/components/TapOverlay.tsx`) — lyrics-spec §3.**
- **Where a tap lands:** the playhead when the handler runs, read unsnapped from the audio element
  (`PreviewHost.positionNow`, via the clock's new `positionAt`), minus the key event's age and the
  calibrated latency. Both of those are wall time, so they are scaled by the playback speed.
- **Snapping:** to the nearest **vocal-stem onset** within 100 ms (on by default when stems exist;
  peaks from the vocal `onset` feature), or to the **beat grid** within 80 ms (off by default, §3).
- **Passes:**
  - *Line starts*: T stamps the next line's start. **Holding T through the line marks its end too**
    (a hold of 0.35 s or more). Otherwise the end is estimated at about eight letters a second,
    clamped to 1–8 s, and the next tap pulls it back if it comes sooner. A line tapped again keeps
    its length and words, moved.
  - *Line ends*: T ends the next timed line.
  - *Words of the selected line*: T stamps each word's start and ends the word before; one more tap
    ends the line.
- **Backspace** restores exactly what the last tap changed and steps back. **Punch-in:** with one
  line selected the session starts there; with several, it re-taps just those. The preview seeks to
  the line before the range and plays.
- **Speed** 1×, 0.75× or 0.5×. The clock gained a rate: the audio element plays at it, silent
  stretches advance at it, and changing it re-anchors so the playhead does not jump. Tested.
- Every tap is one undo step in the project history (`setLineTimings`: exact start, end and words
  for several lines at once), so Ctrl+Z still works line by line afterwards.
- The overlay sits over the top of the canvas: the line just tapped, the one to tap next (large),
  and the one after. In words mode, the words with the next one underlined. There is a mouse tap
  button and key help. While a session runs, its keys are caught in the capture phase.

**Tap latency calibration (D33).** A click track of 16 clicks at 0.6 s. The taps are measured
against when each click was actually **heard**: `AudioContext.getOutputTimestamp` maps the page's
event time onto the audio clock, so output latency is not counted as the person's. The first four
taps are ignored as warm-up, and taps more than 250 ms from a click are strays. The dialog reports
the mean and spread, warns when the spread is over 60 ms, and saves the mean.

**User settings file (`src/shell/settings-store.ts`)** — the seed of M36 (data-formats §6).
- `settings.json` in the user data folder (`PULSEFORGE_SETTINGS` overrides; the smoke check uses a
  fresh file of its own). It is versioned and written atomically.
- A missing or damaged file gives defaults and reports the problem. A value with the wrong type is
  dropped and reported.
- Keys it does not know are **kept** through a save, and a file from a newer version is read but
  **never written over**.
- First field: `tapLatencyMs`. IPC: `getSettings` and `updateSettings`, validated in main.
- Also new: `openLyricsFile` (5 MB limit) and `saveLyricsFile`.

Verified here:
- `npm run check`: **969 tests in 76 files**. New ones cover tap placement, onset peaks and
  snapping, all three passes, hold-to-end, gaps, undo, punch-in and the refusals
  (`tests/lyrics/tap.test.ts`); timecodes; the clock's rate and `positionAt`; and the settings file.
- `npm run golden`: **29/29**.
- `--smoke`: **22/22**, with a new `lyricsUi` check. It opens the drawer from the top bar, pastes
  three lines and a marker, sees three lines and the marker, sees the checklist call them untimed,
  adds a lyrics layer from the rail, starts tapping, and taps T three times (all three lines timed).
  Backspace leaves two timed, and Esc ends the session and leaves the drawer open. The keys are
  dispatched from the page, as real key presses are.
- `PULSEFORGE_UI_TOUR=1` now also captures the drawer's tabs and a running tap session (`9a`–`9d`);
  they were looked at before committing. That caught an overlay line that did not wrap and noisy
  split buttons, both fixed.

Getting the smoke script right took three tries, recorded here because the causes are easy to repeat:
- The page script lives in a TypeScript **template literal** but runs as plain JavaScript, so
  **type annotations** in it are a syntax error.
- A `\n` in a string there becomes a real line break, **even inside a comment**. Use `\\n`.
- A key event dispatched on `window` itself also reaches the App's own `window` listener, even
  when a capture listener stops it, because both are "at target". Dispatch from `document.body`.
- A failing smoke page script shows the owner a "could not start" dialog, on top of the smoke's
  seeded "Smoke crash" recovery dialog. **Both are test artefacts, not the app** (the owner asked;
  see the conversation of 2026-09-25).

**Not done:** the lyrics track on the timeline with the vocal waveform, dragging and ripple (step
4); keyboard nudging of selected lines (±10/100 ms), set-in/out at the playhead (step 4); WhisperX
(step 5); a soft-subtitle track in exports (§10).

### 4.54 The lyrics timeline track (P6 step 4) — M19 complete; lyrics-spec §5, ui-spec §3, §9

**The timeline zooms now (ui-spec §3).** The wheel zooms around the pointer, down to one second
across; Shift+wheel pans; **F** fits the whole track. While playing, the view pages to follow the
playhead, and when zoomed in the corner shows the visible range. Dragging on the waveform
**scrubs**, and because the preview renders the frame at every seek, the karaoke fill is visible
while scrubbing (lyrics-spec §5 "karaoke scrub preview"). The view is pure, tested maths
(`src/ui/timeline-view.ts`).

**Two old timeline inaccuracies fixed on the way.** The waveform was drawn as the whole file
starting at the lead-in, ignoring the trim; now it is the clip only, where it sits on the timeline.
Sections and beats were offset by the lead-in only; they now map through the full clip placement.

**The lyrics lane** (under the waveform, when the project has lyrics):
- **The vocal stem's level is drawn behind the line blocks** — the feature that makes correction
  fast (§5). It is drawn *relative to the track*: the first look showed the stem's level almost
  flat, because Demucs leaves a bed of bleed that reads high on the analysis' dB scale. Now it runs
  between the 20th and 98th percentiles, so phrases stand out. The detected singing (the
  checklist's vocal segments) is a band along the bottom. The blocks are translucent so the level
  reads through them — the first look had them covering it.
- It uses the analysis' `rms` feature for the vocals (240 Hz, about 4 ms per sample), not a peak
  pyramid decoded from the stem's FLAC. The resolution is enough for placing lines and words, and it
  needs no new IPC or cache.
- Blocks per timed line: lead lines full height, backing and ad-libs lower. They are outlined (accent
  when selected, green when locked) with the text inside; the label stays in view when a block
  starts off the left edge. Word boundaries are solid when the line is timed word by word and faint
  when interpolated, and low-confidence words are tinted.

**Editing on the lane** (`src/lyrics/timeline-edit.ts`, pure and tested):
- **Selection:** click; Shift or Ctrl toggles. A click on a line puts the playhead at its start, and
  double-click opens the drawer's Lines tab.
- **Drag a line** to move it with its words; several selected lines move together. **Alt ripples**
  every line from the earliest moved one on.
- **Drag an edge** to resize; the words rescale.
- **On a selected line, drag the boundary between two words.** The later word's start and the
  earlier word's end move together, and interpolated words become explicit with deterministic ids.
- **Every drag is one undo step, and never compounds.** It is planned from the lyrics as they were
  when the drag began, plus the total distance, and written as absolute timings under one merge key
  (`setLineTimings` gained a merge key). A drag out and back leaves the line exactly where it was;
  this is tested.
- Moves clamp at 0 as a group, and nothing is dragged shorter than 50 ms (10 ms for a word).
- **Snapping (8 px):** to vocal-stem onsets (on by default when stems exist), the beat grid (a
  toggle), other lines' edges and the playhead. **Shift while dragging turns it off.** Toggles sit at
  the top of the drawer's Lines tab.
- **Where lines overlap, a selected line is hit and drawn first.** The smoke check found the case: a
  tapped line's estimated end covered the next line, and dragging picked the wrong one.

**Keyboard (lyrics-spec §5)**, while the drawer is open and nothing is being typed (capture phase,
because S, L and M mean other things elsewhere):
- ↑/↓ previous or next line (selects it and moves the playhead).
- `[` / `]` nudge the selection by 10 ms (Shift: 100 ms); nudges in a row merge into one undo step.
- I / O set the selected line's start or end at the playhead.
- L lock; S split at the playhead (before the first word starting after it); M merge with the next.
- The keys are listed in the Lines tab.

**Smoke and tour.** `lyricsUi` now also types a line's times (`0:00.50`–`0:00.90`), drags its block on
the timeline canvas (real pointer events, Shift while moving), and nudges it with `]`; each must move
its start. With a project opened on the command line, the smoke no longer seeds or runs the
crash-recovery check (restoring would replace that project), and `lyricsUi` runs only when the
project has no lyrics; both are then reported as not run. The UI tour captures the timeline zoomed
in (`9e`).

The visual check used a scratch project (`out/lyrics-lane-check.pvproj`, not committed): one of the
owner's own songs, read in place, with placeholder lines. Its stems were separated by the `stemsUi`
check. The screenshots drove the three fixes above: relative level, translucent blocks, and labels
that stay in view.

Verified here: `npm run check` **978 tests in 78 files** (new: drag planning, ripple, group clamp,
no-compounding merge, edge limits, word boundaries with stable valid ids, snapping, navigation,
split-at-playhead; the view maths), `npm run golden` **29/29**, `--smoke` **22/22**.

**Not done:** marquee multi-select; the per-stem waveform rows of the Audio track (ui-spec §3); a
loop region; markers as snap targets (markers do not exist yet).

### 4.55 WhisperX transcription and alignment (P6 step 5) — M26, lyrics-spec §4, D34, D37; the lyrics setup tier (M2)

**P6 is complete with this step.**

**Proved before it was built.** WhisperX brings a large dependency tree (102 packages), and it had
to agree with the pinned torch 2.13 CUDA 13 build. So it was first installed into a throwaway venv
(`out/wxtrial`, using the vendored torch through system site-packages) and run on the GPU.
- `whisperx 3.4.5` resolves, and its alignment core imports on torchaudio 2.11.
- **CTranslate2 4.4** (the version WhisperX pins, `<4.5`) **needs cuDNN 8** (`cudnn_ops_infer64_8.dll`),
  which cannot sit beside torch's CUDA 13 build, which ships cuDNN 9.
- **CTranslate2 4.8.2** (faster-whisper allows `<5`) runs, given CUDA 12's cuBLAS, which NVIDIA
  publishes as the `nvidia-cublas-cu12` wheel. It then worked in the same process as torch's CUDA 13
  libraries.
- **WhisperX's own VAD front-end is unusable here:** `pyannote.audio` 3.3 references
  `torchaudio.AudioMetaData`, which torchaudio 2.11 removed, and WhisperX pins pyannote below 4.
  So transcription uses **faster-whisper directly, with its bundled Silero VAD** (an ONNX file inside
  the package: offline). Forced alignment uses **`whisperx.alignment`** (wav2vec2 CTC) — the
  component that is WhisperX's reason to exist. These are exactly the pieces `whisperx.load_model`
  wraps. pyannote is still installed, as a declared dependency, but never imported.

**Setup: the `lyrics` tier (`npm run setup -- --tier lyrics`; part of the default).**
- `setup/python/requirements-lyrics.in` (the stems requirements plus `whisperx==3.4.5` and
  `nvidia-cublas-cu12`) resolves to the committed **`requirements-lyrics.lock.txt`**, with the
  **stems lock as constraints**. Every shared package keeps its stems version, so installing this tier
  cannot change stem separation. Checked: `--verify` passes for both tiers, and the real Demucs GPU
  test still passes afterwards.
- The CTranslate2 override is applied when resolving **and** when installing, because uv re-checks
  declared dependencies on install. The install copy is built from the lock's own entry *with its
  hashes*, since installs run with `--require-hashes` (both found on the first real runs).
- `setup/steps/python-env.ts` is now one factory, `createPythonEnvStep`, configured twice (stems,
  lyrics): the same wheelhouse, hash, offline-install and offline-verify rules for both. Each tier has
  its own marker file, and the vendor lock records the lyrics lock's hash (`pythonLyricsEnv`).
- Models (`setup/steps/lyrics-models.ts`), all pinned by URL and full SHA-256:
  - **Whisper medium** in CTranslate2 format (D8's default), `Systran/faster-whisper-medium` at
    revision `08e178d4…`, 1.53 GB. `model.bin`'s hash is the published LFS id; the three small files
    publish none and were recorded from a verified download.
  - **wav2vec2 base 960h** (English alignment, torchaudio), 378 MB.
  - After downloading, both are **loaded offline on the GPU**, as the sidecar will load them.
- Totals: 104 wheels (about 0.9 GB) and 1.9 GB of models. `--plan` shows them.

**Sidecar (`python/pulseforge_ml/lyrics.py`), two served commands.**
- `transcribe`: faster-whisper medium, fp16, VAD on, word timestamps, and
  `condition_on_previous_text=False` (lyrics repeat, and conditioning makes Whisper loop on a chorus).
  Progress by position in the audio.
- `align`: `whisperx.align` one line at a time, so progress is per line, a cancel lands between lines,
  and one failing line is reported without losing the rest.
- Both put the CUDA 12 cuBLAS folder on the DLL path before CTranslate2 loads. The native imports
  happen in **warmup, before the stdin reader thread** (the Windows deadlock of §4.24). That makes
  sidecar start-up about **7.8 s** including the lyrics imports; it is paid once per sidecar
  lifetime, stems included.
- Models stay loaded between requests. Idle shutdown and the GPU queue's stop-before-render free them.

**Which part of the song is which line (`src/lyrics/align-match.ts`, pure).**
- The lyric **words** are aligned to the transcript's **words** as two sequences (Needleman–Wunsch,
  scored by normalised Levenshtein similarity with a 0.6 threshold), so mishearings,
  skipped repeats and ad-libs do not derail it.
- A line's window is the span of the transcript words it matched, using the densest cluster so one
  stray match of "the" cannot stretch a window across a verse, padded by 0.35 s.
- An unmatched line is placed in the gap between its neighbours, by length. One with no room is
  **reported as unplaced**, never guessed.
- Transcribe mode cuts Whisper's segments (up to 30 s) into lines at pauses over 0.6 s and at a
  42-character natural break.

**The sanity pass (`src/lyrics/align-result.ts`, lyrics-spec §4).**
- The aligner's whitespace runs are mapped onto our tokens (a "—" joins its word). Words the model
  could not place (digits and symbols are outside its alphabet) are filled by length between their
  neighbours.
- **Rejected, and left as they were:** a line where fewer than half its words aligned, words out of
  order, a word with no length, or a line landing where the vocal stem shows no singing.
- Confidence is the mean word score, which feeds the editor's heat and the low-confidence check.

**Orchestration (`src/ml/lyrics-align.ts`, plain Node).**
- Finds the track's **vocal stem** (the stem job's FLAC). Without one it returns `needs-stems` rather
  than aligning the mix. Refuses a language with no provisioned alignment model (English only for
  now) with lyrics-spec §4's fallback: tap-to-sync.
- The flow: transcribe, then match or cut into lines, then align, then the sanity pass. Results are
  mapped to timeline ticks through the clip placement.
- The main process runs it through the **GPU queue** (M28), with progress and cancel, and reports
  whether the tier is installed (`lyricsAlignAvailable`).

**Studio.** The drawer has an **Align to the vocals** section:
- **Align the lyrics** times every *unlocked* line, word by word. **Locked lines are never sent,
  so they can never change** (§4).
- **Transcribe…** replaces the lines with a transcription as a starting point, asking first.
- Progress by stage, and Cancel.
- Without stems it offers to separate first, then continues. Without the tier it says which
  `npm run setup` to run.
- It **autosaves first** (ui-spec §10 names re-aligning lyrics as a risky operation).
- The result toast counts lines aligned, low-confidence lines, lines refused by the sanity check
  (with reasons) and lines not found. Refused and unplaced lines are left **selected** in the Lines
  tab for manual timing.
- Explicit, never automatic (D34): it is offered in the toast when lyrics text arrives from a file.
  After an LRC import the toast suggests refining with it — offered, never forced (D37).

**Measured on a real song** (one of the owner's own, read in place; its stems were separated by the
smoke's `stemsUi`), 2:48:
- Transcription (Whisper medium) took **7.9 s** and gave 22 coherent lines ("Neon signs flicker, they
  bend and go / Like secrets spilled in a late night show").
- Aligning those 22 lines took **4.9 s**: 22 aligned, 0 rejected, 0 unplaced, word scores mostly
  0.6–0.9.
- The weak spots are the ones the spec predicts: a one-word "I" came out 20 ms long at confidence
  0.07 (the checklist flags it), and one phrase was split mid-sentence at a breath. PROJECT.md §4's
  "30–60 s for a 4-minute vocal stem" estimate is beaten by a wide margin.

**Verified here:**
- `npm run check`: **1002 tests in 82 files**. New ones cover matching (similarity, monotonic
  alignment, windows, gap placement, unplaced, stray clusters, transcript to lines), the sanity pass,
  and the orchestrator with a fake sidecar and real FFmpeg (needs-stems, language refusal, windows on
  the timeline, transcribe mode, rejections).
- **`tests/golden/lyrics-align-gpu.test.ts`** runs the real sidecar on the RTX 3060. The sidecar
  starts with the lyrics imports (no deadlock); instrumental audio produces no invented words; forced
  alignment keeps every word inside its window; the sidecar stays healthy.
- `npm run setup -- --verify` passes offline for **core, stems and lyrics**; the Demucs GPU test
  passes after the lyrics install.
- `npm run golden` **29/29**, `--smoke` **22/22**. The standard `lyricsUi` check also asserts that
  alignment is offered and disabled without a track.
- **`PULSEFORGE_SMOKE_ALIGN=1`** (opt-in, needs a project with audio, stems and lyrics) presses
  Align in the real window. Run on the song project it returned "Aligned 5 lines to the vocals" with
  all five timed: the whole path from the button through IPC, the GPU queue, WhisperX and back
  through the undo stack.

**Not done:** alignment models for other languages (wav2vec2 per language, PROJECT.md §3); Whisper
`large-v3` as the quality option (D8, "one click away"); a soft-subtitle track in exports
(lyrics-spec §10); manual syllable splitting (D36, Should).

### 4.56 Groundwork for the auto-director (P7 step 1) — curve source, whole-frame chain, a silent drop fixed

Three things the director needs before it can write a project that stays editable.

**The `curve` modulation source (`src/engine/core/modulation.ts`).**
- A piecewise-linear value over the timeline: `source.points` is a sorted list of `{ ticks, value }`
  in timeline ticks. Linear between points, flat before the first and after the last. Two points on
  one tick make a step, not a division by zero. `sampleCurve(points, t)` is pure (binary search).
- The arranger uses it for **section intensity** and **drop impulses** (auto-director-spec §6). The
  spec expects keyframes there, and keyframes (S1) do not exist yet. A curve is an ordinary binding,
  editable, removable and listed in the matrix. This is recorded as a deviation in ROADMAP §4.
- It is 0..1 by construction, so `inputRange: 'auto'` leaves it alone. A curve with no points is
  reported as an issue and kept, not guessed at.
- In the document it is `SourceSpec.points`, which is empty for every other source. It is saved only
  when non-empty, so no existing file changes. Parsing sorts it. Presets without the field are
  normalised.
- It is offered as "Curve" in the binding editor's source list. There is no point editor yet: a
  curve is authored by the director, and its points are visible through save and load.

**The whole-frame (global) effect chain in the studio.**
- The engine has always run `globalEffects` after compositing, with `global.effects.<id>.params.<key>`
  as the binding target. Until now it had no UI. The director's POST slot goes there, so it has to be
  editable.
- `GLOBAL_OWNER = 'global'` in `commands.ts`. The eight effect and modulation commands (add, remove,
  move, enable, set a param, add, remove or update a binding) accept it as an owner and edit
  `document.globalEffects` and `globalModulations`. The same commands, the same undo.
- Modulation authoring understands the path: `parseTarget`, `effectParamTarget`, `describeTarget`
  ("Global › Bloom › Intensity") and `allBindings` (the matrix lists global bindings; its → jump
  opens the whole-frame inspector).
- **"Whole frame"** sits at the top of the layer list, above every layer, because its effects run
  after all of them. Selecting it, or selecting nothing, shows the global effect chain and its
  modulation in the inspector. The row counts its effects.

**Fixed: bindings stored on a group were silently dropped.** `toRenderProject` passed module-layer
bindings to the engine, but the engine's group spec carries none. A binding on a group's own effect
or transform was saved, shown and never evaluated. Bindings are indexed by target path, not owner,
so the snapshot now carries every group's bindings (nested ones included) with the global ones.
This is a regression test in `tests/project/snapshot.test.ts`.

**Verified here:**
- `npm run check`: **1009 tests**. New: the curve's sampling, steps, `auto` range and empty-curve
  issue; a curve saving, sorting and loading; the global chain through the ordinary commands;
  global target paths; group bindings reaching the engine.
- `npm run golden` 29/29 identical.
- `--smoke` **23/23**. New `globalChain`: Whole frame → the global inspector, add Vignette there, the
  row says "1 effect", undo removes it.

### 4.57 The director and its seven templates (P7 step 2) — M21, auto-director-spec §1–§9, §11

The pipeline, as pure TypeScript in `src/director/`, with no UI yet (that is step 3):

```
classify (digest.ts) → match (match.ts) → palette (palette.ts) → populate + calibrate (direct.ts,
calibrate.ts) → arrange (arrange.ts) → guardrails (direct.ts) → an ordinary ProjectDocument + log
```

`direct(input, options)` is a pure function of the track's analysis, the project, the templates,
the module library and a seed. The same inputs give the same bytes, **ids included**: ids come from
a seeded id source (timestamp 0, bytes from `hash32`), never the clock.

**Templates (`src/director/template.ts`, `templates/builtin/*.json`).**
- Hand-authored JSON, `formatVersion: 1`, in the spec's §4 shape: affinity, aspects, palette rule,
  slots with weighted candidates, intent-only modulations, arrangement, variation, budget.
- Every field is validated. Every problem is reported with its path: a misspelt key, an unknown
  axis, a target naming a missing slot or effect. Nothing is silently defaulted.
- Deliberate differences from the spec's sketch (also in ROADMAP §4):
  - Section states use this build's labels (intro, build, main, breakdown, outro). The spec's
    "chorus" is `main`, and its "drop" is the separate `drop` entry, placed on the digest's drops.
  - A modulation `target` may list alternatives; the first that resolves wins. Candidates do not
    share parameter names: a radial's `length` is a bar visualizer's `maxHeight`.
  - The budget is numeric: gpuCost low 1, medium 2, high 4, scaled by pixel count relative to 1080p.
  - Tokens in parameter values: `$title`, `$logo`, `$backgroundImage` and `$seed`.
- `template-store.ts` reads built-ins from `templates/builtin/` and the user's templates from a user
  folder; a user template wins an id collision. A file that does not parse is listed as a problem.
- **The seven** (§11): Neon Pulse, Neon Grid, Minimal Type, Minimal Mono, Cinematic Depth,
  Cinematic Particles, Lyric Focus. All use only installed modules and parse with zero issues.

**Matching (`match.ts`).**
- Soft scoring:
  - inside a preferred range scores 1, falling off linearly outside it;
  - "tolerate" costs a little outside its range;
  - "avoid" cuts the score to a fifth.
- **Axes the digest could not measure are left out, not scored as a guess.**
- Condition bonuses: Lyric Focus gets +0.8 with timed lyrics and −0.5 without.
- Availability comes first (D29). A missing candidate module is substituted by the installed module
  of the same kind sharing its tags, and the log says so. A required slot with no module makes the
  template unavailable, with the reason.

**Palette (`palette.ts`).**
- `generate-from-style`: a hue from a style axis over the template's arc, plus seeded jitter, then
  a harmony (analogous, complementary, triad, duotone, mono). Saturation comes from energy and
  background lightness from darkness. Light templates put ink on paper.
- Contrast is enforced last and always wins (§5.3):
  - text against the background must reach the template's minimum WCAG ratio;
  - the primary must reach 3:1 (WCAG non-text contrast).
- Lightness moves until both pass, and each fix is logged.

**Populate and calibrate.**
- Slot resolution follows §5.1: filter candidates by what is installed, the slot's condition, the
  candidate's `needs` and `minStyle`, then make a seeded weighted choice. Only declared parameters
  are written; an unknown key is logged as a template mistake.
- **Calibration (`calibrate.ts`, §5.2)** uses `inputRange: 'auto'`, which is exactly the spec's
  "p10 → nothing, p90 → full deflection" at compile time. The director chooses only the *amount*:
  - subtle 8%, medium 25%, strong 60% of the soft range;
  - held under the soft maximum;
  - multiply factors capped at ×1.25, ×1.6 or ×2.5, because a small base would otherwise give a
    ×13 factor;
  - response maps to envelope times: snappy 5/120 ms, smooth 40/400 ms, slow 200/1500 ms.
- The source's measured p10/p50/p90 go in the log.
- A flat source, or an amount that rounds to nothing, is not written (§7).
- A missing stem falls back to the mix, said in the log.

**Arrangement (`arrange.ts`, §6, D32).**
- Section boundaries map to the timeline (lead-in and trim), snap to the beat grid, and are thinned
  by **anti-chaos**: no change within 8 s of the last, and at most 2 layers entering or leaving at
  one boundary.
- **Anti-monotony** pushes neighbouring sections apart when they would look the same.
- What it writes is ordinary bindings on the `curve` source:
  - **section intensity** is multiplied into the template's intensity targets:
    `floor + (1 − floor) · intensity`, and a build ramps into what follows;
  - **presence** is an opacity curve that fades optional layers in and out on boundaries; the layer's
    time range spans its first entry to its last exit;
  - **drops** are a spike on the transient nearest the detected drop.
- The title's time range ends before the first vocal segment, or at the end of the intro without
  vocals.
- Fades to and from black are a "Fade" layer on top, with an opacity curve.

**Layer opacity is now a modulation target** (`layers.<id>.opacity`, engine.ts). The engine skips a
layer faded to 0. It is described and edited like any parameter (`OPACITY_SPEC`), and the
inspector's Opacity slider has the ∿ button. It has a GPU test (`opacity-modulation-gpu.test.ts`).
Golden frames are unchanged.

**Guardrails (§7).**
- The budget and layer cap drop the lowest-priority optional slots, and the log says which and why.
- Duplicate effects in the whole-frame chain: the first is kept.
- Occlusion: generated layers under a full-frame opaque layer are removed.
- Lyrics versus the hero: the hero moves up and shrinks.
- The 9:16 safe area: text and logos are nudged by an aspect override.
- Contrast is handled by the palette step.
- Zero bindings are handled by calibration.

**The director's record (`document.director`, saved with the project).**
- The current roll: master seed, template, a seed per aspect (palette, layout, motion), locks, the
  palette it ended with, and a one-line summary.
- A history of up to 10 earlier rolls.
- The **decision log as data**: step, sentence, and the facts behind it (data-formats §5).
- A **fingerprint of everything it wrote** (canonical JSON, 53-bit hash).

**Rerolls never lose your work (§9).**
- On the next run, a layer, global effect or global binding still matching its fingerprint is
  replaced.
- One that no longer matches was edited: it is kept and keeps filling its slot.
- Layers you added stay next to the layer they sat above.
- Locks:
  - *palette* keeps the palette verbatim, your edits included;
  - *layout* keeps the template and its seed, so the same modules come back in the same slots;
  - *motion* keeps the modulation seed;
  - *template* keeps the template.
- `surprise()` redraws a roll, up to 5 times, while it resolves to the same template, hero, hue
  family and accents as the previous one (diversity enforcement).
- A restore from the history reproduces the roll's seeds and palette exactly.

**Verified here:**
- `npm run check`: **1057 tests**. New: `tests/director/direct.test.ts` and `tests/director/parts.test.ts`.
  They run on a song-shaped fixture built from the reference beat track, with quiet and loud parts,
  so section detection finds structure.
- **Every** built-in template makes a project that saves and reloads byte-identically with no issues:
  every binding target resolves, and the engine compiles every binding with no issues.
- The same seed gives the same bytes. Amounts stay inside the soft range with no zero bindings.
- Intensity curves are sorted, and the title leaves. Contrast meets each template's minimum.
- Cinematic Depth at 4K logs a budget drop. Lyric Focus wins with timed lyrics.
- Reroll keeps an edited hero and a user layer and replaces the rest. The palette and layout locks
  work, Surprise me differs, and the history holds 10 rolls, restorable.
- Unit tests cover anti-chaos, beat snap, anti-monotony, presence fades, drops on onsets, the title
  hold, lead-in mapping, contrast enforcement, seeded palettes, affinity and veto, unmeasured axes,
  availability and tag substitution (D29), calibration bands, caps and refusals, and fingerprints.
- `npm run golden` 29/29 identical.

**Not yet:**
- the studio's Auto panel, Generate on import (D9), the history strip's thumbnails, and the
  contact-sheet check (§10.4) — step 3;
- `derive-from-image` palettes;
- "Extract as template" (§10.2);
- palette shifts at chorus and drop (§6), which need keyframed palette roles.

### 4.58 The Auto drawer, Surprise me and the contact sheet (P7 step 3) — M21, M22 complete; D9

**The Auto drawer** (`src/ui/components/AutoPanel.tsx`; top bar **✦ Auto**). Top to bottom:
- **Template**: every template ranked for this track, with a score bar and a tooltip saying why.
  The best match and the current one are marked. An unavailable template is greyed and says what it
  is missing (D29). Any available one can be picked.
- **Generate project** (or **Generate again**) uses the picked template and the project's own seed,
  so generating twice with the same template gives the same project.
- **Surprise me**, with four **Keep** locks (Template, Palette, Layout, Motion; Layout implies
  Template) and **Try other templates** (roulette among the top matches). The seed is drawn fresh
  in the UI, the one place randomness is allowed, and recorded in the roll, so every result stays
  reproducible.
- **Rolls**: the current roll and up to ten earlier ones as thumbnails. The thumbnails are drawn on
  the preview's stills engine, one frame from the middle of the loudest section. A roll loaded from
  disk is re-derived and drawn on demand; until then it shows its palette as swatches. Clicking a
  roll restores it exactly.
- **Why it looks like this**: the decision log in plain language, grouped by step (the track,
  template, palette, layers, modulation, arrangement, guardrails in amber, kept from before).
- Template problems (files that did not parse, parse issues with hover detail), **Reload
  templates**, **Open templates folder**, and a line saying that everything generated is ordinary
  and edits survive rerolls.

Generate, Surprise me and a restore are each **one undo step** (`applyDirection`, commands.ts). It
replaces the look (layers, both global lists, palette, seed) and the director's record, and leaves
audio, lyrics, assets, canvas and name alone. After a roll, a stopped preview **seeks to the
loudest moment**: a generated project fades in from black, so its first frame would greet the new
look with a black preview (found in the UI tour's screenshots).

**Offered on import (D9).** When a track lands in a project with no layers and no director record,
the audio section shows "Make a project from this track?" with **✦ Auto…** and a dismiss button. It
is offered, never forced, and the drawer is always in the top bar.

**Plumbing:**
- The analysis payload now carries **onset times** and each section's **energy**. The digest's
  drops depend on the energy, and it had been dropped on the way to the renderer.
- The store's `Section` is the analysis type.
- Templates are listed by IPC (`listTemplates`, `revealTemplates`). Built-ins come from
  `templates/builtin/`, the user's from Documents/Pulseforge/Templates (`PULSEFORGE_TEMPLATES`
  overrides it). The main process reads the files (`template-store.ts`); the studio parses them
  (`template-library.ts`, pure).
- `src/ui/director.ts` builds the director's input from the studio. The vocal segments come from
  the vocal stem when stems exist, which is what times the title to the first vocal.

**Layer opacity in the studio.** The engine records a modulated opacity's live value, so the
Opacity slider shows its live marker like any modulated parameter.

**The contact sheet (`npm run contact-sheet -- <folder>`, §10.4, §12).** It runs every template (or
`--templates id,id`) on every track in a folder and renders one still each at the middle of the
loudest section, through the Electron frame harness. It writes `out/contact-sheet/`: one PNG per
tile, and `index.html`, a grid with each track's reading, BPM, sections and best match, and each
tile's summary and guardrail count.
- Tracks are read in place; analysis is cached under `cache/contact-sheet-analysis/`.
- `renderFrames` now takes a precomputed analysis, so one track's analysis serves all its tiles.
- Three tracks × seven templates took about 50 s.

**What the first contact sheet found, and what changed** (three of the owner's tracks, read in
place):
- **Neon Grid** was blown out to flat pink: the camera sat below the terrain once bass drove its
  amplitude, and glow, grid and bloom stacked up. The camera is now higher (height 6, look height
  1), amplitude and glow lower, and bloom tighter. The triad harmony made the sun lime-green; a new
  **`split` harmony** (+90°, −110°) gives synthwave's magenta, orange and cyan.
- **Minimal Type**: the sound line ran through the title. The line moved down and the title up and
  smaller.
- **Cinematic Depth**: the object crowded the frame; the camera stands further back (distance 7.5).
- **Cinematic Particles**: a candidate set `flare` at its soft maximum, so its modulation had no
  room and was refused (the guardrail worked, the template was wrong). It is now 1.
- The calibration log showed a multiplying binding on a small base at ×13; the caps in §4.57 came
  from this.
- After the fixes every column reads as intended on all three tracks. Neon Pulse, Minimal Mono and
  Cinematic Particles were right the first time.

**Verified here:**
- `npm run check`: **1059 tests**. New: `tests/director/template-store.test.ts` (a user template
  replacing a built-in by id; a broken file listed as a problem; a missing folder is empty).
- `npm run golden` 29/29.
- `--smoke` **24/24**. New **`autoUi`** runs the whole path in the real window:
  - the import dialog answers with the smoke's own song (a minute of the reference beat track shaped
    into sections, written to `out/smoke-song.wav`);
  - the drawer ranks seven templates;
  - Generate is one undo step, writes a decision log and adds layers;
  - Surprise me adds a second roll, and a thumbnail is drawn;
  - restoring the first roll works;
  - three undos return to the layers it started with.
- `modulationUi` now clicks a module parameter's ∿, since Opacity has one too.
- `PULSEFORGE_UI_TOUR=1` adds `10a`–`10c` (generated, rolls, log) at both window sizes.

**Not done (Could-level parts of the spec):**
- `derive-from-image` palettes (§5.3);
- "Extract as template" (§10.2);
- palette shifts at chorus and drop (§6), which need keyframed palette roles;
- camera kicks as drop impulses beyond what the templates target;
- a starter pack of background images (D31: the user's own images are used).

### 4.59 The Settings screen (operability step 1) — M36, PROJECT.md §8.16, ui-spec §8

**The settings file** (`src/shell/settings-store.ts`). It grew from one field to twelve on the same
discipline:
- every field has a default;
- a wrong value in the file falls back to its default and is reported;
- unknown keys are kept;
- a newer file is never written over.

Each field has one validator, shared by the file reader and by `validateSettingsPatch`, which checks
patches from the studio. **A bad patch is refused with the reason** rather than defaulted, and the
screen shows the reason beside the control. Adding fields is not breaking (data-formats §2.3), so
the version stays 1.

| Setting | Default | Where it acts |
|---|---|---|
| `theme` | dark | chrome tokens (`:root[data-theme]`); light and "follow Windows" |
| `autosaveMinutes` | 1 | the autosave interval (M1) |
| `previewScale` | 1 | the preview's quality when a session starts |
| `stemModel` | htdemucs | new projects' analysis settings (D8) |
| `whisperModel` | faster-whisper-medium | transcription (M26), from `vendor/models/whisper/` |
| `defaultExportPreset` | first | the preset the export dialog opens on |
| `tapLatencyMs` | not calibrated | tap-to-sync (D33); resettable here |
| `logLevel`, `cacheRoot`, `cacheCeilingGb`, `lowDiskWarningGb`, `scratchDir` | info, beside the app, 20 GB, 5 GB, cache/scratch | stored now; acted on by steps 2 (M33) and 3 (M34) |

**The screen** (`SettingsDialog.tsx`; ⚙ in the top bar, **Ctrl+,**, Esc closes).
- Every change saves as it is made; there is no Apply button to forget.
- **General**: theme, autosave interval, preview quality at start.
- **Audio & models**: stem model and transcription model, listing what is installed (a saved choice
  that is not installed is shown as such, not dropped), and tap latency with Reset.
- **Export**: the default preset.
- **Setup & repair**:
  - **Verify installation** runs `npm run setup -- --verify`;
  - **Repair core / stems / lyrics** runs `--tier <tier>`, which keeps finished work and fetches what
    is missing or damaged;
  - both run under Electron's own Node (`ELECTRON_RUN_AS_NODE`, Node 24, which runs the setup's
    TypeScript directly), with colour codes stripped and the output streamed into the screen, one
    run at a time, cancellable.
- **Environment**: versions, the GPU in use, the vendored binaries (a missing one in red) and the
  settings file with Open folder.
- **Keyboard**: a reference of the shortcuts that exist.

**Shown rather than chosen, and why** (ROADMAP §4):
- The GPU: Chromium picks the device for WebGL, and the one in use is reported.
- The keyboard map: a reference; remapping is not built.

**Fixed along the way:**
- The environment report said "Pulseforge 44.3.0", Electron's version: unpackaged, `app.getVersion()`
  reports Electron's. It now reads `package.json`.
- For the light theme:
  - the timeline canvas draws its bands and lanes from tokens, and redraws on a theme change;
  - button hover, primary hover and the selected lyric line became tokens.

**Verified here:**
- `npm run check` **1061 tests**. New: field-by-field reading with defaults and reports, and refused
  patches (range, relative path, unknown key, a model name with `..`).
- `--smoke` **25/25**. New `settingsUi`:
  - the screen opens from the top bar;
  - autosave set to 5 is saved to the smoke's own settings file;
  - light and dark themes switch the document's theme;
  - the environment names the GPU (the RTX 3060, driver 32.0.16.1714);
  - **Verify runs the real setup verification from the app and reports "Everything installed checks
    out"**;
  - Esc closes the screen.
- The UI tour adds `11a-settings` and `11b-light-theme` at both sizes.

### 4.60 Storage (operability step 2) — M33, PROJECT.md §8.14

**One cache root.** Analysis, stems, video frames, preset thumbnails and scratch now all live under
one folder: a setting, by default `<repo>/cache`.
- The app used to keep its analysis in the Electron profile (`%APPDATA%\Electron\cache\analysis`)
  while the CLI and the contact sheet used `<repo>/cache`, so the same track was analysed twice. Now
  all three share one cache, and a track analysed by one is a hit for the others.
- The old profile location is not read any more. The Storage section shows what is left there (72 MB
  on this machine) with **Clear it**.
- Every path is resolved per use, the render queue's included, so a changed root applies at once.
  What is already cached stays where it was; it is all rebuildable.
- The scratch folder is its own setting (default: inside the cache).

**The model (`src/cache/cache-store.ts`, plain Node).**
- A **track** unit is a track's analysis and stems together: they are made from, and only useful
  with, the same audio.
- A **video** unit is one clip's extracted frames.
- **Preset thumbnails** and **scratch** are one unit each.
- Anything else under the root is listed as **other**, never ignored.
- The cache is keyed by content hashes, so a small **usage index** (`usage.json`) records each
  hash's file name and when it was last used. The studio updates it when it analyses a track or
  prepares a video. It is itself rebuildable: without it, units are still listed, by hash, with
  their newest file time.
- Actions:
  - remove units, clear a category, "keep the last N tracks", and clear everything;
  - **what the studio is using this session is never removed** (the track last analysed and the
    videos prepared);
  - every path is checked to lie inside the root before anything is deleted.
- **The LRU size limit** (default 20 GB, a setting; 0 for none) evicts least recently used units
  until the cache fits. It runs a few seconds after any cache write (debounced) and once at start.
  If what is in use alone is over the limit, it says so rather than evicting it.
- **Low disk**: free space on the cache's drive (`statfs`) below the warning (default 5 GB, a
  setting) is reported.
- Both reach the studio as a warning toast and the log; nothing happens silently.

**The Storage section** (Settings):
- the cache folder with Choose / Use the default / Open, and the scratch folder;
- the size limit and the low-disk threshold;
- the total against the limit, free space (red when low), a bar per category with Clear;
- keep-the-last-N and Clear everything;
- up to 50 items biggest first (name, what it holds, e.g. "analysis 1.5 MB · stems 104 MB", last
  used, size, and ✕), with **in use** items badged and not removable;
- the old-location notice.

Every destructive action asks first and reports what it freed and what it kept.

**The smoke has its own cache root** (`out/smoke-cache`, written into its own settings file before
the window opens), because its storage check clears everything and must never clear the owner's.

**Verified here:**
- `npm run check` **1067 tests**. New `tests/cache/cache-store.test.ts`:
  - analysis and stems grouped per track and named from the index, biggest first, by category;
  - an unknown folder is listed;
  - clearing skips the protected;
  - keep-the-last-N works;
  - the LRU order under a limit, with the protected skipped;
  - deletion outside the root is refused;
  - a damaged index is ignored.
- `--smoke` **26/26**. New `storageUi`: the breakdown lists the smoke song as in use; Clear
  everything frees the rest and keeps it.
- The UI tour adds `11c-storage`.

### 4.61 Logs and diagnostics (operability step 3) — M34, PROJECT.md §8.15, ui-spec §7, §11

**The log (`src/shell/logger.ts`, plain Node).**
- Format: one JSON object per line, `{"t","level","scope","msg","data"?}`, in the profile's `logs`
  folder (`PULSEFORGE_LOGS` overrides it; the smoke uses its own).
- Rotation: by size, `pulseforge.log` → `.1` … keeping five files of up to 5 MB.
- Level: the setting (error · warn · info · debug), applied at once.
- Writes are synchronous appends, because the line lost in a crash is the one that was needed. A log
  that cannot be written never throws into the work being logged.
- A line that is not JSON is kept as text when the log is read back.

**What goes in:**
- **Everything the main process says on the console**, scoped by its existing `[tag]` (so
  "[render-queue] could not start" is scope `render-queue`). No call site changed.
- **The studio's own console**: warnings and errors always, info at debug level
  (`console-message`), and a renderer that dies (`render-process-gone`).
- The app's start (version, Electron, the GPU).
- Every render job's transitions, with the error and report path when it fails.
- Setup runs and their exit codes.
- Cache evictions and low-disk warnings.
- Each "copy diagnostics".

**Copy diagnostics (`src/shell/diagnostics.ts`, pure).** One plain-text block to the clipboard:
the environment and GPU, the failed job when there is one (label, status, output, report path,
error), the settings, the cache at a glance, and the log's last 200 lines. Nothing is sent anywhere.
- **Settings → Diagnostics**: log detail, the log file's path and size, Open log folder, Copy
  diagnostics.
- **Failed render jobs** have **Copy diagnostics** in the queue (ui-spec §7).

Already there before this step: the per-render report beside each output (§4.5) and the startup
environment report, now also in Settings → Environment.

**Found by this step's smoke runs:** `recoveryDialog` failed in two of five runs. It runs last, after
the new heavy checks (setup verify, cache clearing, the upkeep scan), and its restore-and-snapshot
window was 2–3 s. Both halves now wait up to 10 s and say which half failed if it ever does again;
five runs since, all green.

**Verified here:**
- `npm run check` **1072 tests**. New `tests/shell/logger.test.ts`: JSON lines and level filtering;
  rotation keeping three files, and the tail read across it; non-JSON lines kept; an unwritable
  folder never throws; scope splitting; the diagnostics text.
- `--smoke` **27/27**. New `diagnosticsUi`: Settings shows the smoke's log path; Copy diagnostics
  reports success; the main process confirms that the clipboard holds the report and that the log
  file has the app's start, the copy, and a warning emitted by the studio page itself (renderer
  console capture).

### 4.62 The extras tier, the per-project stem model, the offline rebuild check (P1 remainder) — M2, D8

**The extras tier** (`setup/manifest.ts`, `setup/steps/extras.ts`). D8 says "fast by default,
quality one click away", so these are installed only when named: `npm run setup -- --tier extras
[--extras <list>]`, or one at a time from Settings. A plain `npm run setup` never fetches them.

| Extra | Files | Size | Pinned how |
|---|---|---|---|
| `htdemucs_ft` | four fine-tuned Demucs models + `htdemucs_ft.yaml` from the package | 337 MB | Demucs's published prefixes matched; full SHA-256 recorded and pinned |
| `whisper-large-v3` | CTranslate2 model, config, preprocessor config (128 mel bins), tokenizer, vocabulary, at one Hugging Face revision | 3.1 GB | model.bin = the published LFS SHA-256; the small files' git blob ids matched that revision's tree |
| `align-fr`, `-de`, `-es`, `-it` | torchaudio VoxPopuli wav2vec2 bundles, the ones WhisperX uses for these languages | 378 MB each | no checksum published; sizes matched the server; SHA-256 recorded and pinned |

- Like every tier: every file is pinned by URL and full SHA-256 before setup will download it.
- After installing, each model is **loaded offline on the GPU the way the app loads it**:
  - `htdemucs_ft`: `get_model` from the vendored repo, 4 models;
  - `large-v3`: `WhisperModel` in float16, 128 mel bins;
  - each language: `whisperx.load_align_model` from `vendor/models/align` (43, 32, 35 and 37 symbols).
- `--verify` checks every installed extra as well. The whole verify, with all six extras, took 1 min 48 s.
- **Licence: the four VoxPopuli alignment models are CC BY-NC 4.0 (non-commercial)**, per
  torchaudio's own documentation. English (fairseq, MIT) is not affected. Settings says so on each
  one; recorded in ROADMAP §4 for the owner.
- Not provisioned, and said where it matters:
  - alignment for other languages (WhisperX gets them from Hugging Face repos at ~1.2 GB each, in its
    cache layout); they keep tap-to-sync, and the refusal message says which languages are installed;
  - MilkDrop presets (listed for this tier in PROJECT.md §3): there is no MilkDrop renderer to use them.

**Measured on the RTX 3060** (one of the owner's songs, 2:48, read in place):

| | Time | GPU memory above the desktop's (658 MiB) |
|---|---|---|
| `htdemucs` separation + stem analysis | 22.7 s | ~0.85 GB |
| `htdemucs_ft` separation + stem analysis | **39.4 s (1.7×)** | ~0.9 GB (the four models run one after another) |
| Whisper `medium` transcription (model load included) | 12.6 s | ~2.8 GB |
| Whisper `large-v3` transcription (model load included) | 15.7 s | ~4.7 GB |

- PROJECT.md §4 had estimated `htdemucs_ft` at "roughly 4×" and 4–7 GB; it is 1.7× and under 1 GB.
  PROJECT.md is updated.
- `large-v3` is not simply better. On this song it caught the opening line medium missed ("City
  lights are whispering low…"), but it split lines less cleanly (lower case, no punctuation, a lone
  "city"). Medium stays the default; Settings describes the trade honestly.

**In the studio:**
- Settings → Audio & models has **Optional models**: each extra with its size, what it is for (with
  the measurements), its licence where non-commercial, and **Install**. Install runs setup for that
  one extra, with the output shown, then refreshes.
- The transcription model list shows only complete installs.
- Word alignment lists its installed languages. Alignment now **reads the languages from the
  installed model files** (`installedAlignLanguages`) instead of a fixed `['en']`. Asking for an
  uninstalled language says where to get it: an extra, or the lyrics tier for English.
- **The Audio panel's stems section offers the model per project** (htdemucs — fast, htdemucs_ft —
  finer, about 1.7× the time) once both are installed, or a link to install it:
  - `setStemModel` is an undoable command;
  - the studio then re-analyses under the new cache key;
  - stems made by the other model stay cached, so switching back is instant.

**The offline rebuild check** (`npm run setup -- --rebuild-check`, `setup/steps/rebuild-check.ts`;
also a button in Settings).
- `--verify` proves the installed files are intact; this proves **they can be made again with no
  network**, which is the P1 exit criterion and the "Python env rots" risk.
- What it does:
  1. checks the kept archives (FFmpeg, Python, uv, Inter) against their pins;
  2. extracts a fresh interpreter from the kept Python archive into a scratch folder;
  3. installs both locks from `vendor/wheelhouse/` alone, with uv offline, Hugging Face offline, and
     every proxy variable pointed at a closed local port, so a hidden download fails the check;
  4. imports torch (with CUDA), Demucs, WhisperX, faster-whisper and CTranslate2, and loads htdemucs
     from the vendored models;
  5. deletes the scratch folder whatever happens. The live environment is never touched.
- Measured: **a 4.4 GB environment rebuilt in 103 s** (stems 49 s, lyrics 26 s): torch
  2.13.0+cu130 on the RTX 3060, demucs 4.1.0, whisperx 3.4.5, CTranslate2 on 1 CUDA device.
- PROJECT.md asks for this "in CI". There is no CI for this repo, so it is a command and a Settings
  button (ROADMAP §4).

**Verified here:**
- `npm run check` **1085 tests**: alignment languages from installed files, and the refusal messages
  for English and for an extra language.
- `npm run setup -- --tier extras` installs and loads all six; `--verify` passes with them; and
  `--rebuild-check` passes.
- `--smoke` **28/28**. New `extrasUi`: Settings lists the six optional models; where `htdemucs_ft` is
  installed, the Audio panel offers both models, switching is one undo step ("Stem model:
  htdemucs_ft") that re-analyses, and undo goes back.

### 4.63 Keyframes: spec, model, commands, engine (P8 step 1) — S1, module-spec §5 step 3

**The spec** (`docs/keyframes-spec.md`), as ROADMAP §3 required before building. module-spec had
fixed where keyframes act (step 3: they replace the base and any aspect override, and modulation
rides on top). The new spec settles what it left open:
- the targets: params, effect params, the whole-frame chain, opacity, and transform x/y/scale/rotation;
- the model and file format;
- interpolation per type (numbers ease; colours ease in linear light; everything discrete holds);
- the easings: linear, hold, easeIn, easeOut, easeInOut and a custom cubic Bézier, owned by the key
  they leave from;
- the editing UI;
- what duplicate, delete and presets do.

The choices marked **(proposed)** are in ROADMAP §4 for the owner.

**The model.**
- `document.automation`: tracks `{id, target, enabled, keyframes[{id, ticks, value, easing}]}`.
  This is the slot reserved since v1, so it is no longer a reserved key.
- Key times are timeline ticks. Keys are sorted, at most one per tick; a duplicate tick in a file is
  reported and resolved to the later one.
- A malformed easing falls back to linear, with an issue.
- A track on a missing layer is **kept and reported** (CLAUDE.md #4).
- Saved only when there are tracks, so every earlier file keeps its bytes.

**The commands** (`src/project/automation-commands.ts`), all undoable:
- `setKeyframe` creates the track if needed, updates a key at the same tick, and a new key takes
  the easing of the key before it. A slider drag at one moment merges into one undo step.
- `moveKeyframes`: a moved key replaces a key it lands on; clamped at 0; a drag merges into one
  undo step.
- `setKeyframeTime`, `setKeyframeValue`, `setKeyframeEasing`.
- `removeKeyframes`: a track left empty goes too.
- `setTrackEnabled`, `removeTrack`.
- **Deleting a layer removes its tracks, and duplicating one copies them** onto the copy with new
  ids, in the same undo step.

**The engine** (`src/engine/core/automation.ts`, engine.ts).
- `sampleTrack` is a pure function of the keys and t:
  - it holds before the first key and after the last;
  - it uses a binary search for the segment;
  - the cubic Bézier is solved by 40 fixed bisection steps, so no iteration count depends on the
    data (determinism, CLAUDE.md #1).
- Colours blend in linear light: black to white is `#bcbcbc` in the middle, not `#808080`.
- The render project gets `automation` (enabled tracks with keys; palette links resolved in the
  snapshot, as for parameters). The engine indexes it once per snapshot and, per frame:
  - replaces keyed module and effect parameters in the stored values **before** `resolveParams`, so
    modulation applies on top and clamping and coercion happen once at the end;
  - replaces opacity before its modulation;
  - replaces the five transform fields before the layer matrix is built.
- Golden frames are unchanged.

**Verified here:**
- `npm run check` **1104 tests**:
  - `tests/engine/automation.test.ts`: easing endpoints and shapes, overshoot, the linear-light
    colour midpoint, discrete hold, a single key, determinism across evaluation orders, indexing;
  - `tests/project/automation.test.ts`: every command, easing inheritance, move-onto-replace,
    delete and duplicate of a layer, the file round-trip, the parse issues, and the snapshot with
    palette links.
- GPU (`tests/golden/keyframes-gpu.test.ts`): a layer's colour key (red → blue), its x (left →
  right) and its opacity (held, then gone) each show in the rendered pixels at their times.
- `npm run golden` 29/29.

**Next (P8 step 2):** the inspector's keyframe diamonds, auto-key and the easing curve editor; then
the timeline's automation lanes.

### 4.64 Keyframes in the studio (P8 step 2) — S1 complete, keyframes-spec §5, ui-spec §3–§4

**The inspector** (`src/ui/components/Keyframes.tsx`, Inspector.tsx).
- Every animatable control has a diamond ◆. That means float, int, bool, enum and colour module and
  effect parameters (a module opts one out with `animatable: false`, now in `ParamSpec`), plus
  **Opacity** and the **transform** sliders.
  - The diamond is hollow when the target is not animated, half when it is but the playhead is not
    on a key, and solid on a key.
  - Clicking it keys the value shown at the playhead, or removes the key there.
  - ◀ ▶ jump the playhead to the previous or next key and select it.
- **Auto-key:** an animated control shows its keyed value at the playhead, and editing it sets a key
  there (a new one, or the one under the playhead) instead of the base. A drag at one moment is one
  undo step. The base and aspect overrides are kept, and return when the track is removed.
- A control subscribes to the playhead only once it is animated, so playback does not re-render the
  inspector sixty times a second.
- **The Keyframes section** lists the selected layer's tracks (or the whole frame's, with nothing
  selected). Each track has an on/off switch, its keys as chips, and ✕ to remove the track. A picked
  key opens the **key editor**:
  - time in seconds;
  - the value;
  - easing: Linear, Hold, Ease in, Ease out, Ease in and out, or Custom curve;
  - a **160 px curve editor** with the two Bézier handles (y may overshoot, −0.5 to 1.5);
  - Delete.
  It notes that the last key's easing has nothing to lead into yet.

**The timeline** (Timeline.tsx).
- Under each animated layer, a row per track: the parameter's name, a line through its keys, the keys
  as diamonds (accent when selected). The whole frame's tracks come after the layers.
- Click a key to select it and seek to it (Shift adds or removes); click empty space to seek.
- Drag to move the selection, snapping the grabbed key to beats and the playhead (Shift: no snap).
- **Alt-drag copies**; **Delete** removes the selected keys.
- A drag is computed from the document as it stood when the drag began, so dragging past another key
  never deletes it on the way, and the whole drag is one undo step.

**Two bugs found by the smoke check, both fixed:**
- **The studio went blank** ("Maximum update depth exceeded" in the Keyframes section). Its store
  selector returned a freshly filtered array on every call, so the store kept notifying. It now
  selects the stable list and filters in render. The other `filter` selector in the studio returns a
  number, which is safe.
- **The first key landed at 0 s.** A control that is not animated does not follow the playhead (by
  design), so its idea of "now" was 0. Keying now reads the real playhead at the moment of the edit.

**Verified here:**
- `npm run check` **1104 tests**.
- `--smoke` **29/29**. New `keyframeUi` works on a new Bars layer:
  - its first parameter's diamond keys it at the playhead (solid);
  - after seeking to 2 s it shows "animated", and moving its slider auto-keys a second key;
  - the section lists two chips, a picked chip opens the key editor, and Ease in and out shows the
    curve editor;
  - Delete removes the selected key.
- The UI tour adds `12-keyframes`. It first had the Auto drawer covering the inspector, and the recovery check had already replaced the animated project. The tour now closes the drawer and animates a Bars layer of its own (keys at 5 s and 20 s, ease in and out). The shot shows the Keyframes section, the key editor with its curve, and the timeline row with both diamonds (§4.65).

### 4.65 Masking (P8 step 3) — S7, compositor-spec §5

**What it does.**
- Any layer can mask another. The masked layer shows only where its mask layer is (**alpha**), or
  as much as the mask layer is bright there (**luma**, read from its premultiplied colour, so it is
  already weighted by coverage).
- **Invert** flips it. **Feather** softens the edge, as a blur radius of 0 to 25% of the frame's short side.
- **The mask is in canvas space.** The source is drawn into a frame-sized target exactly as it would
  be drawn in the picture (its module, effects, transform and opacity), and the target layer is
  multiplied by it where it is composited. So a shape masks what is under it on screen, after both
  layers' transforms (proposed; ROADMAP §4).
- **A mask source is hidden from the picture** unless **Also show it** is on: using a shape as a
  mask would otherwise also draw it.
- **Solo** hides a mask source from the picture but not from the layers it masks.
- A group can be masked, and can be a mask.

**Rules, reported rather than guessed (CLAUDE.md #4):**
- A **cycle** (A masks B masks … A) is refused when the mask is set (`setLayerMask` walks the chain),
  and if one arrives in a file, the engine ignores that mask with a warning.
- A mask pointing at a layer that is not there is noted in the snapshot and in the load issues; the
  layer renders unmasked.
- A mask source that is **off** leaves its target unmasked. One that is **not on screen at this
  moment** (outside its time range, or faded to 0) is an empty mask: the target is hidden, or fully
  shown when inverted.

**How.**
- `LayerMaskSpec` and `maskOnly` go in the render project.
- The engine builds a mask's source through the ordinary layer path: `buildLayers` was split into
  `buildOne`, which a mask calls. A cycle guard sits along the chain.
- The compositor has `renderMask`: it draws the source into a transparent frame-sized target and
  applies the feather as two separable 17-tap Gaussian passes. The fixed taps keep it deterministic
  and constant in cost.
- `maskValue()` is in both layer shaders (the plain and the separable-blend one), so every blend
  mode masks.
- In the document, the existing `maskLayerId` is joined by `mask: {channel, invert, feather}` and
  `maskSourceVisible`. Both are saved only when not at their defaults, so every earlier file keeps
  its bytes; a feather out of range is clamped with an issue.
- **Inspector → Mask:**
  - "Masked by" (any other layer);
  - Use: its shape or its brightness;
  - Invert;
  - Feather;
  - on a source, which layers it masks, and **Also show it**.

**Not done (compositor-spec §5's optional `maskMode`):** `stencil-in` and `stencil-out` are exactly
alpha and inverted alpha here, so no separate mode was added.

**Verified here:**
- `npm run check` **1109 tests**:
  - `tests/project/mask.test.ts`: setting, self and cycle refusal, the options with the feather
    clamp, the source visibility, the round-trip, and pre-S7 bytes unchanged;
  - the snapshot test: the mask carried, the source mask-only unless shown, a missing source noted.
- GPU (`tests/golden/mask-gpu.test.ts`), red masked by a half-frame box:
  - alpha shows only the left half, and the box itself is not drawn;
  - invert shows the right half;
  - luma of a dark (#202020) box lets through a little red;
  - a 0.25 feather is soft at the edge and full in the middle;
  - a shown source is drawn too.
- `npm run golden` 29/29: the new shader branch is off for unmasked layers.
- `--smoke` **30/30**. New `maskUi`: an Orb masked by a Bars layer is one undo step ("Set mask"),
  the options appear, and the Bars layer's inspector offers "Also show it".

### 4.66 Motion blur (P8 step 4) — S10, export-spec §9

**What it does.** An export option. Each frame becomes the average of `k` subframes spread across
the shutter, so fast motion smears the way a film camera's does. 8 samples at a 180° shutter is the
default (the film-like one in export-spec §9). The preview never blurs.

- **Export dialog:** a **Motion blur** tick box, then 4, 8 or 16 samples and a 90°, 180°, 270° or
  360° shutter, with a note that the render takes about `k` times as long. A queued job's label
  ends in "· motion blur".
- **CLI:** `--motion-blur` (8 at 180°), `--blur-samples N` (2–32) and `--shutter DEG` (1–360); either
  of the last two turns it on. Out-of-range values are refused with the fix.
- **The render report** records `motionBlur: {samples, shutterDegrees}`, or `null` when off
  (export-spec §9: "reported in the render report").

**How.**
- **Timing** (`subframeTimes` in `core/time.ts`): subframe `j` of `k` sits at
  `t + ((j + ½)/k − ½) · (shutter/360) / fps`, the middle of its slice of the open shutter, centred
  on the frame's own time as the spec's `t ± (shutter/2)/fps` says. It is derived from the frame
  index, and its tick is the frame's start tick plus the rounded offset. Nothing accumulates between
  frames.
- **Engine:** the body of `renderFrame` became `buildScene(t, tick)`, which returns the frame's
  layers and global chain at any time. The engine option `motionBlur` either builds one scene (as
  before), or hands `k` lazy builds to the compositor. Warnings and parameter issues repeated by
  subframes are listed once.
- **Compositor:** `composite` was split into `linear` (layers and global chain into RGBA16F) and
  `writeOutput` (tone map, transfer, dither, row order). `compositeAccumulated` composites each
  subframe in linear light and adds it, times its weight, into an **RGBA32F** running sum. The sum
  ping-pongs between two targets through a one-line shader: float32 blending is an extension, and a
  half-float sum would round on every step. The sum then goes through the one output pass, so the
  tone curve and dither apply once, to the blurred picture.
- **Plumbing:** `EngineOptions.motionBlur` ← `ExportRequest` ← the spike `ExportConfig` and
  `FramesConfig` ← `runExportSpike` / `renderFrames` ← `renderDocument` ← the queued job
  (`RenderJob.motionBlur`, optional, so older queue files load as "off") ← `RenderRequest`, validated
  in the main process.

**Decisions (ROADMAP §4):**
- **A subframe before the timeline starts is held at 0**, so frame 0 is only blurred forwards.
- **Subframes keep the frame's index.** `ctx.time.frameIndex` is the same for all of them, and only
  `t` moves. So a video layer shows its one decoded frame (the footage has its own motion blur), and
  grain and dither patterns keyed on the frame stay put.
- **Weights are equal** (a box shutter). With 4, 8 or 16 samples the weights are powers of two and
  sum exactly, so **a picture that does not move is byte-identical** to the unblurred render.

**Not done:** spatial supersampling (2× SSAA, the other half of export-spec §9) is a separate item;
S10 asks only for motion blur.

**Measured here** (`out/scene3d/shapes.pvproj`, the 3D shapes scene plus bloom, 1080p60, 6 s,
H.264): **167.4 fps** sharp, **86.8 fps** with 8 samples. So 8× the scene work costs 1.9× the wall
time on a light scene, because readback and encode are a large share of a sharp frame. A heavy scene
approaches `k`×, which is why the dialog says "about".

**Verified here:**
- `npm run check` **1116 tests**:
  - `tests/engine/time.test.ts`: subframe times and ticks for 4 samples at 180°; the clamp at 0;
    repeatability at 59.94; the range checks;
  - `tests/export/queue.test.ts`: a job's motion blur survives a restart, and one without is off;
  - `tests/cli/render-args.test.ts`: off by default, `--motion-blur`, samples and shutter, refusals.
- GPU (`tests/golden/motion-blur-gpu.test.ts`), an 8 px box moving 128 px/s at 10 fps:
  - sharp, it covers only its own pixels;
  - blurred, the pixels 5 px ahead and behind are partly covered and match within 2 codes (centred
    shutter), and nothing lies beyond the shutter's reach;
  - the blurred frame is identical run to run;
  - a still project renders byte-identical with and without blur.
- `npm run golden` 29/29: the unblurred path's output did not change.
- A real render (`npm run render -- … --motion-blur`), which passed verification with the setting in
  its report.
- `--smoke` **30/30**, and **31/31** with `PULSEFORGE_SMOKE_RENDER`:
  - `exportDialog` now ticks Motion blur and sees the sample and shutter choices come alive;
  - `queuedRender` queues its render with 4-sample blur and checks the job's report records it.
  - One of three smoke runs this step missed `recoveryDialog` (the dialog was not offered in time).
    This is the known timing flake from §4.61, and the two runs after it passed. **Open item:** if it
    recurs, move the check earlier or widen its wait again.

### 4.67 The 6-stem model (P8 step 5) — S6

**What it does.** `htdemucs_6s` is an optional model, like `htdemucs_ft`. It splits guitar and piano
out of what the four-stem models call "other". Once it is installed (Settings → Audio & models →
Optional models, or `npm run setup -- --tier extras --extras htdemucs_6s`, 52 MB), a project picks
it in the Audio panel's stem model picker. Separating then gives **drums, bass, vocals, other,
guitar and piano**, each analysed and usable as a layer's Source or a modulation's stem, like the
other four.

**How.**
- **Setup:** a new extra, `htdemucs_6s`. One weights file, pinned by SHA-256 (recorded from a
  download whose published prefix `34c22ccb` matched). Its yaml is copied from the demucs package,
  now through a shared `placeDemucsYaml` that `htdemucs_ft` uses too. After install it is loaded
  offline the way the sidecar loads it, and it reports its six sources. `--verify` covers it.
- **Stem names:** `STEMS` gains `guitar` and `piano`, **appended**, so a drop-in shader's
  `select:stem` index keeps its meaning (the authoring guide now lists the indices).
  `STEM_CHOICES` (modulation) and the inspector's Source list follow.
- **Which stems a model makes:** `src/analysis/stem-models.ts` (pure) has `stemsForModel`. The stem
  job marks, expects and reports exactly those stems: a model that leaves one out gets it marked
  failed with the reason. The studio calls the stems **ready** only when every one the project's
  model makes is in. Before, "ready" meant "at least four", which a six-stem project would have
  passed with two missing.
- **Nothing silently dropped:** a binding on guitar in a project on a four-stem model is kept, and
  reports the stem as not analysed (the existing modulation issue). Each model's stems are a
  separate cache entry (the model is part of the settings hash), so switching back and forth never
  mixes them.
- **Audio panel:** the picker describes it ("six stems, adds guitar and piano"). The Separate
  button's tooltip names the stems it will make. With no optional model installed, the hint now
  points at "install a model" rather than only `htdemucs_ft`.

**Measured on the RTX 3060** (the same 2:48 song as §4.62, read in place, fresh cache):

| | Time | Whole-GPU memory peak (desktop ~658 MiB) |
|---|---|---|
| `htdemucs` separation + analysis of 4 stems | 22.5 s | 1386 MiB |
| `htdemucs_6s` separation + analysis of 6 stems | **28.5 s (1.27×)** | 1514 MiB |

**Verified here:**
- `npm run check` **1119 tests**:
  - `tests/ml/stems.test.ts` (fake sidecar): six stems cached and analysed, with guitar and piano
    FLACs kept; a model that leaves stems out has them marked failed with the reason.
  - `tests/golden/stems-gpu.test.ts`: real Demucs through the supervised sidecar on the GPU. The
    6-stem model returns six analysed stems that the cache serves with the mix.
- `npm run setup -- --verify`: all seven extras load offline, including `htdemucs_6s` with its six
  sources.
- `npm run golden` 29/29.
- `--smoke` **30/30**. `extrasUi` expects seven optional models, and checks that an installed
  `htdemucs_6s` is offered in the stem model picker.
- The first `npm run check` of this step had one test file time out in setup (302 s, 24 tests
  skipped). The two full runs after it passed 1119/1119, and no stray Electron, Python or FFmpeg
  process was left. It did not recur; noted in case it does.

### 4.68 Batch mode (P8 step 6) — S13, export-spec §12

**What it does.** "Drop 10 tracks in, auto-direct and render them all overnight." Every track
becomes its own project, auto-directed exactly as Generate does it and saved as `<name>.pvproj` in
the output folder (so it can be opened and changed later), and a video beside it.

- **In the studio:**
  - **Batch…** in the top bar, or **drop audio files anywhere on the window**, opens the Batch
    dialog. It shows the tracks (add more, remove, clear), the export preset, the template ("Best
    match for each track", or one for all), a seed, **Separate stems first**, **Motion blur**, and
    the output folder.
  - **Start** hands the batch to the main process and opens the render queue. Each track is queued
    for rendering the moment it is directed, so the first video renders while the rest are still
    being directed. Renders go ahead of stem separation on the GPU (M28).
  - The queue drawer shows the batch: how many tracks are directed, which one is being directed,
    every track that failed or was skipped with the reason, and any notes (stems that could not be
    separated). **Cancel batch** stops directing more tracks. Renders already queued stay, and can
    be cancelled one by one.
- **When everything is finished** (every queued render done and no batch still directing): a
  desktop notification ("3 renders finished, 1 failed") and a toast. With **Shut down when done**
  ticked in the queue drawer, Windows is asked to shut down after **two minutes**. A banner says so,
  with **Cancel shutdown** (`shutdown /a`). The tick clears once it has fired, so it never carries
  over into later work.
- **CLI:** `npm run batch -- <tracks or folders…> -o <folder>`:
  - `--preset` (default `youtube-1080p`), `--template`, `--seed`, `--stems`, `--motion-blur`;
  - `--seconds N` for a quick look at a batch;
  - `--direct-only` to write the projects and render nothing.
  - It directs every track first, so a bad file shows up in the first minute rather than at 3 a.m.,
    then renders them one after another.
  - It writes `batch-report.json` in the output folder: every track, its template and summary, its
    notes, its status and any error, and the render time. The exit code is 1 if any track failed.

**How.**
- `src/batch/plan.ts` (pure, shared by the dialog, the main process and the CLI):
  - each track's name is its file name, cleaned of characters Windows refuses, with "name (2)" for
    a repeat;
  - its project and video paths;
  - its seed, `hash32(batch seed, name)`: the same batch gives the same looks, and each track differs.
- `src/batch/direct-track.ts` (Node), for one track:
  - optionally separates stems; a failure there becomes a note, and the track is directed from the
    mix alone;
  - decodes and analyses through the studio's analysis cache (a track the studio has seen is a hit);
  - creates the project **at the preset's canvas**, so a Shorts batch is laid out for vertical;
  - runs `direct` with the vocal segments, as the studio's Generate does;
  - writes the project with its paths stored relative where they can be.
- `src/shell/batch-service.ts` (Node, directing and queueing injected): one batch at a time, request
  validation, a status per track (waiting, directing, queued, failed, skipped), and cancel. It also
  has `completionWatcher`, which fires once when the work runs out. Last session's finished jobs
  count as history, and the moment between two directed tracks does not count as finished.
- **Main process:** the real `directTrack`, with templates and drop-in modules re-read per track,
  and stems through the GPU queue and the sidecar. It enqueues into the existing render queue, so a
  batch's renders snapshot, persist, retry and report like any other. Shutdown runs `shutdown.exe`
  from System32 by absolute path. In smoke mode the call is recorded instead.
- **Preload:** `webUtils.getPathForFile` gives a dropped file its path. The page never sees the
  file system otherwise.

**Decisions (ROADMAP §4):**
- **A drop of audio files opens the Batch dialog**, even for one file. The dialog is where the
  output folder and preset are chosen, and "Import audio" stays the way to put a track into the
  open project.
- **A folder given to the CLI is read one level deep**, not recursively. A music library's subfolders
  are usually albums, and rendering all of them by accident would be an overnight mistake.
- **The shutdown waits two minutes**, cancellable from the banner or with `shutdown /a`.

**Not done:** export-spec §14's free-space precheck before each render (estimated size against the
disk) is still open, for single renders as well as batches.

**Measured here** (the CLI on the owner's music folder):
- Directing all 11 tracks took 0.2–5.4 s each; a cache hit is 0.2 s. They got varied looks: Minimal
  Type, Cinematic Particles and Cinematic Depth, in gold, pink, magenta, orange and cyan.
- Two tracks as 10-second Shorts: 28 s end to end, both videos verified.

**Verified here:**
- `npm run check` **1132 tests**:
  - `tests/batch/batch.test.ts`:
    - the plan: names, paths, collisions and seeds;
    - the CLI's arguments and refusals;
    - track collection from files and folders, and what it skips;
    - `directTrack` end to end with FFmpeg: a failed stem separation becomes a note, and the project
      opens with no issues, at the preset's shape, with its seed, layers, director roll and track.
  - `tests/shell/batch-service.test.ts`:
    - every track queued in order;
    - a failure marked and the batch carries on;
    - cancel skips the rest, and one batch runs at a time;
    - bad requests refused;
    - the completion watcher fires once, not for history, and not while directing.
- `npm run golden` 29/29.
- `--smoke` **32/32**, and **33/33** with `PULSEFORGE_SMOKE_RENDER`:
  - `batchUi`: Batch… opens the dialog, which starts empty and cannot start. A drop of a file with
    no path on disk is answered with a toast. Escape closes it, and the queue drawer offers "Shut
    down when done".
  - `batchRun`: the smoke song is batched from the main process into its own folder; the project
    opens with layers and a director roll, and its render is queued. With the smoke render it
    renders to a verified file, and "shut down when done" requests `shutdown /s` (recorded, not run).
- The UI tour adds `13-batch`: the dialog with two tracks.

---

## 5. Measured results

The full report is `docs/validation/p0-full-report.md`; the summary table is in PROJECT.md §4. Key points:

- **Determinism:** engine frames, export raw frames (NV12 and 10-bit) and bit-exact MP4 bytes are identical across processes.
- **Readback:** sync beats async PBO through ANGLE; GPU NV12 is fastest (1080p 197 fps, 4K 58 fps on the bars project).
- **Throughput (six-layer bars, 60 s):** H.264 1080p60 209 fps, 4K60 56 fps (NVENC-bound); HEVC 10-bit 98 / 27 fps.
- **NVENC p5:** 1080p H.264 199 / HEVC ~275 fps; 4K H.264 61 / HEVC ~92 fps. AV1 unavailable (Ampere).
- **Colour:** GPU NV12, swscale and HEVC 10-bit all within 1.2 code values of expected; black luma 16 / 64; all four tags present.
- **Stems:** `htdemucs` 4-min track in 8.6 s (28× realtime), 0.54 GB peak allocated; Python start + model load ~4 s.
- **3D scenes (M37, CLI, 1080p60, one scene layer + one effect):** shape + bloom 193 fps, terrain + bloom
  177 fps, bar city + depth of field 155 fps (§4.43).
- **Sync:** flash on the expected frame for 18/18 clicks; video−audio 6.67 ms (designed sub-frame rounding at a 1.01 s phase). Analysis sees clicks 5.8 ms early (centred FFT window).

---

## 6. Decisions made during implementation

- **D48** tone shoulder, knee 0.9 (owner). **D49** sRGB OETF, tagged BT.709 (owner).
- **D39 resolved** → GPU NV12 for 8-bit 4:2:0; swscale for 10-bit/4:4:4. **D50** sync readback default.
- **D40** CQ values unchanged pending real-footage quality checks; HEVC is faster than H.264 at 4K.
- uv has no download command → pip fills the wheelhouse. torch on `cu130` (driver R580+).
- FFmpeg 8 needs `setparams` to keep colour tags on filtered frames.
- **D51** (owner, 2026-09-14) settles the look-ahead sign: positive means "looks ahead", default
  **+30 ms**, sampling `source(t + lookAheadMs)`. D23's "−30 ms" describes the lag being
  compensated, not the stored field — read literally against modulation-spec §4 it would have
  increased the lag rather than cancelling it.
- Envelope `mode: linear` is specified only as "symmetric smoothing"; implemented as a single
  time constant of `(attack + release) / 2`, so switching modes does not jump.
- **M37 (§4.43):** one Three.js `WebGLRenderer` per GL context, shared and reference-counted;
  scenes render to their own 4× MSAA RGBA16F target with a float depth texture and are copied into
  the layer target. Three's colour management and tone mapping are off (linear in, linear out —
  the engine tone-maps once). Depth effects are gated by a new `capabilities.needsDepth` and
  refused (reported) on any layer that is not `scene3d`; the studio does not offer them there.
  The 3D field of view applies to the frame's **short side**, so 9:16 shows the same subject.
  `three` is pinned to an exact version: an upgrade can change pixels, and the host reads one
  Three internal (`properties.get(texture).__webglTexture`).

---

## 7. Known gaps, debts and open questions

- **Tone shoulder touches fully saturated colours** (#ffffff → luma 232 instead of 235; pure primaries ~250/255).
  Owner kept D48 knowing the knee; flag again if palette-exact output becomes a requirement.
- `htdemucs_ft` not provisioned or measured (manifest entry needed: it is a bag of 4 models, each weight file pinned).
- HEVC 10-bit export is ~2× slower than H.264 because it reads RGBA10 and converts on the CPU; a GPU P010 path
  (16-bit samples packed like NV12) would likely close the gap.
- Still not rendered, and noted by `toRenderProject` rather than dropped: **masks** (S7), and the
  non-separable HSL blend modes (hue, saturation, colour, luminosity), which the document does not
  offer yet. The ten separable modes landed in §4.47; group compositing (M38) in §4.39.
- Modulation UI (§4.46) does not yet have: the source sparkline/scope, copy-paste of bindings,
  right-click on a control (the ∿ button does the same job), bindings on the **global** effect chain,
  or keyframes. Stem sources are offered but read "not analysed" until stems are wired (M5).
- Presets: the store (§4.19, §4.25) and the browser (§4.44) are done. A preset that uses an image,
  font or video stores the project's asset **id**, not the file; applied to another project the
  asset is missing and the layer says so (D6's "referenced" is not yet cross-project).
- Schema choice worth flagging: `transform` stores `scaleX`/`scaleY` rather than PROJECT.md §7's
  single `scale`, because stretched backgrounds need non-uniform scale. Not a spec conflict —
  §7 sketches the shape, it does not pin field names.
- `quality: 'preview'` plumbed but unused. Unknown modules warn instead of drawing a placeholder.
- Export: the queue landed (§4.23); still no disk-space precheck, thumbnails, motion blur, SSAA or audio stream-copy.
- Frame hashing runs on the render thread (fine for validation; move to a worker if used in long exports).
- The supervised sidecar (§4.24) now runs Demucs for the studio (§4.48). **The CLI's analysis cache is
  `ROOT/cache`, the studio's (and its render queue's) is `%APPDATA%/Electron/cache/analysis`**, so stems
  separated in the studio are used by the studio's renders but not by `npm run render`. One cache
  root for both is part of M33.
- **Flaky under load:** once, a full `npm run check` straight after a smoke run took 190 s and one GPU
  test failed with "Electron exited without writing a result" (`effects-gpu`, bloom). Two reruns of
  the suite and three of that file passed. Suspect too many concurrent Electron GPU children; if it
  recurs, cap vitest workers for `tests/golden/`.
- **IPC reads any path the renderer names** (`readAudio`, `loadImage`, `readProject`). The renderer is
  sandboxed and loads only our bundle, so this is not reachable today. M35 kept it that way: drop-in
  modules are JSON + GLSL and no JS from `modules/` runs (§4.42). If JS modules are ever allowed,
  these should accept only paths the user picked or the project references.
- **Three.js internals:** `scene3d/host.ts` reads `renderer.properties.get(texture).__webglTexture`
  to copy a scene and hand on its depth. Re-check on any Three upgrade (the scene3d GPU tests and
  the `scene3d` golden entry fail loudly if it breaks).
- **Modules sample `audioSeconds` outside the clip** (§4.52): in a lead-in it clamps to the file's first
  sample, past a trimmed out-point it keeps reading the file, so a visualizer can react during a
  lead-out to music that is not playing. Modulation reads silence there since §4.52; modules should get
  an "audible" flag or a silenced analysis view.
- `--smoke` with a project on the command line: `layerAdded` and `textLayer` assume the smoke's own
  empty project (they expect exactly one new layer) and fail there. The recovery and lyrics checks skip
  themselves in that case since §4.54; `layerAdded` should do the same.
- A quit while a render is running cancels the render first, *then* the window asks about unsaved
  changes; answering Cancel keeps the app open with the render already cancelled.

---

## 8. P2 — Engine: done (PROJECT.md §10)

Goal: *"Engine renders a multi-layer project from a hand-written JSON file, headlessly, correctly at
16:9 / 9:16 / 1:1. Golden-frame tests green. The engine/shell import boundary is lint-enforced."*
**All four clauses hold.**

1. ✅ **Project document v1** (`src/project/`) — §4.7
2. ✅ **Layout & aspect system** — §4.8
3. ✅ **Param resolution + modulation evaluator** — §4.10
4. ✅ **Effect chain contract + bloom and vignette** — §4.11
5. ✅ **Golden frames** — §4.12
6. ✅ **Headless render CLI** — §4.13

---

## 9. P3 — Studio: done (PROJECT.md §10)

> **Verified on the RTX machine, 2026-09-15.** All five items below have now run here.
> 1. ✅ `npm run check` — 527 tests pass (the laptop's note said 519; the count had drifted).
> 2. ✅ `npm run golden` — **15/15 byte-identical**. The cache, sections and beat-time changes
>    moved no pixel, as predicted.
> 3. ✅ `npm run render` twice on the same audio — second run reports `Analysis: cache hit`, and
>    the two MP4s are **byte-identical**, so the cache round-trip does not perturb the analysis.
> 4. ✅ `npm run validate -- --only 7` — stems pass: htdemucs 8.6 s, 27.9× realtime, 0.54 GB peak,
>    22 progress events. The `cmd_separate` → `_separate(args, context)` refactor is sound.
> 5. ✅ Serve mode, after fixing a **deadlock that made it unusable** — see §4.24.

Goal: *"Load audio, trim/fade, add/edit layers, live preview on the audio master clock, timeline,
undo/redo, aspect switcher, save/load."* The Shimga-style UI (ui-spec.md).

The engine is ready for it: the studio's job is to build `ProjectDocument`s and call
`toRenderProject` + `renderFrame`, which is exactly what `npm run render` and `npm run golden`
already do headlessly.

Suggested order (each a commit, STATUS updated each time):

1. ✅ **App shell** — see §4.14.
2. ✅ **Command/undo stack** — see §4.15.
3. ✅ **Analysis pipeline** — see §4.4. The on-disk cache tree is still outstanding.
4. ✅ **Preview clock** — see §4.16.
5. ✅ **React studio** — see §4.27.

Also outstanding from earlier phases: P1's lyrics/extras tiers, `htdemucs_ft` and the
offline-rebuild CI job; the GPU P010 path for HEVC 10-bit (§7).

*The rest of this section is the plan as it stood on 2026-09-15, kept for the record; it has since
been overtaken by P4 (§10).*

**Work that does not need a GPU** is now largely done — §4.16 through §4.26 were all built on a
non-NVIDIA laptop. What is left there is thin and mostly blocked on the engine rather than on
effort:

- **Auto-director templates** (auto-director-spec §4–5). Pure logic, but the templates pick from
  the module library, and that library is one visualizer and two effects. Writing affinity
  scoring and slot resolution now means writing them against almost nothing to choose from; the
  slot mechanism only earns its keep once there are modules to fill it.
- **Per-stem peaks** — a few lines, but nothing produces stems yet.
- **Unicode and font fallback** (S17) — there is no text engine to extend.
- **More effect modules** (M12 wants ten, two exist). The shaders can be *written* here but only
  *seen* on the RTX machine, and an unverified shader is worse than none.

Everything else that matters now needs the GPU: P3 step 5 (the React studio), masks and group
compositing, wiring the render queue to `runExport`, wiring the supervised sidecar to the GPU job
queue, and verifying the items listed below.

Checked and *not* needed: the modulation `derived/` envelope cache. `compileModulation` already
precomputes envelopes across the whole track and caches them in memory (§4.10), so the
determinism requirement in modulation-spec §5 is met; an on-disk copy would only save startup
time.

---

## 10. P4 — Library: done (PROJECT.md §10)

Goal: *"10+ visualizers, 10+ effects, backgrounds (incl. video frame cache, M39), text, logo,
palette system, layer groups (M38), Three.js scene layers (M37), preset save/load, asset library
(M40), `modules/` drop-in folder + authoring guide."* **Every clause holds** (steps 1–16, §1):

| Clause | Where |
|---|---|
| 10+ visualizers (M11) — 10, plus 3 sources, text and 3 scenes | §4.28, §4.29 |
| 10+ effects (M12) — 10, plus depth of field | §4.30, §4.31, §4.43 |
| Backgrounds incl. video (M14, M39) | §4.35, §4.41 |
| Text (M16, M32) and logo (M15) | §4.38, §4.40 |
| Palette (M17) | §4.32 |
| Layer groups (M38) | §4.39 |
| Three.js scene layers (M37) | §4.43 |
| Preset save/load (M25) and browser (S8) | §4.19, §4.25, §4.44 |
| Asset library (M40) | §4.37 |
| `modules/` + authoring guide (M35) | §4.42, `docs/module-authoring.md` |

Two audits ran during the phase (§4.36 and the checks built into each step); the smoke check grew
from 8 to 18 end-to-end checks of the real studio, each confirmed to fail when its feature breaks.

What comes next is in `docs/ROADMAP.md` §3.
