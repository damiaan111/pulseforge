# Build status — handoff document

> **Read this first in any new session.** It records what exists, what does not, how it works,
> how to verify it, and what to do next. Update it at the end of every step, in the same commit.
> Last updated: 2026-09-15 — **P0, P2 and P3 complete**. The studio runs: open a project, import
> audio, edit layers through a schema-generated inspector, scrub a timeline, undo, switch aspect,
> save. The laptop sessions' work is verified here (§9), which found and fixed a serve-mode
> deadlock (§4.24). The engine renders headlessly at 16:9 / 9:16 / 1:1,
> golden frames are green, and `npm run render` produces an MP4 from a project file.
>
> Also built, ahead of the milestone that needs them, because they are pure logic and a
> non-NVIDIA machine can do them (§4.16–§4.26): the preview clock, the on-disk analysis cache,
> waveform peaks, section detection, presets and their store, the render queue, the supervised
> ML sidecar, and the auto-director's classification layer. A code audit (§4.22) fixed five bugs.
>
> **P3 is complete.** Next: P4 — Library (§10): the module catalogue, which is the thing the
> studio is currently short of.

---

## 1. Where we are

| Milestone | State |
|---|---|
| Planning (PROJECT.md, docs/*-spec.md, decisions D1–D50) | ✅ complete |
| **P0 — Spike** | ✅ **complete** — `npm run validate` passes 8/8; measurements in PROJECT.md §4 and `docs/validation/p0-full-report.md` |
| P1 — Provisioning | 🔶 core + stems tiers work; lyrics/extras tiers, `htdemucs_ft`, offline-rebuild CI job not started |
| **P2 — Engine** | ✅ **complete** — all six steps done (see §4.7–§4.13, §8) |
| **P3 — Studio** | ✅ **complete** — all five steps done (see §4.14–§4.27, §9) |
| **P4 — Library** | 🔶 in progress — M11 ✅, M12 ✅, M17 ✅, effect chain in the studio ✅, render pipeline shared by CLI and queue ✅, render queue UI ✅, background layer M14 ✅ (§4.28–§4.35); remaining in §4.33 |
| P5 … P8 | ⬜ not started |

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
| 8 | Background layer (M14): solid/gradient/image, fit modes, Ken Burns; image assets end to end | ✅ | (this commit) |

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

**Starting a new session:** open Claude Code in `D:\pulseforge` and say: *"Read CLAUDE.md and docs/STATUS.md,
run `npm run check` and `npm run golden`, then continue with the next open item in §4.33. Keep
STATUS.md updated and commit after each step."*

---

## 2. Environment (the RTX machine)

- Repo: `D:\pulseforge` (must stay on D:, C: has ~19 GB free). Git branch `main`, no remote.
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
| `npm install` | dev deps (TypeScript 6.0, ESLint 10, Vitest 5, Electron 44.3.0, esbuild 0.28.2) | once |
| `npm run check` | typecheck + lint + 519 tests (FFmpeg/Python tests skip without `vendor/`; the GPU layout test skips without Electron) | ~15 s |
| `npm run setup` | provision `vendor/`; `--plan`, `--verify`, `--relock`, `--from <dir>`, `--tier` | first run ~10 min |
| `npm run validate` | the eight P0 checks → `out/validate/report.md` + `report.json`; `--quick` (~5 min), `--only 2,4,8` | ~11 min full |
| `npm run dev` | bundle and launch the app; extra args open a project (`-- song.pvproj`) | ~15 s |
| `npm run build` | bundle the app to `dist/app/` without launching | ~1 s |
| `npm run dev -- --smoke` | launch, self-check the security posture, screenshot to `out/smoke.png`, exit | ~5 s |
| `npm run render` | `-- <project.pvproj> -o <out.mp4>`; `--aspect`, `--size`, `--codec`, `--audio`, `--seconds`, `--quiet` | seconds |
| `npm run golden` | re-render the golden set and compare with the committed references; `--update`, `--only <name>` | ~40 s |
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
round-tripped untouched).

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

### 4.9 Spike and validation harness (`spike/`)
- `harness.ts` (bundle + run Electron), `electron/{main,renderer,protocol}.ts` (determinism and export modes; export config carries the whole `RenderProject`).
- `lib/determinism-run.ts` (`runDeterminismSpike`), `lib/export-run.ts` (`runExportSpike`).
- `validate.ts` + `validate/`: `context.ts`, `media.ts` (FFmpeg decode helpers), `projects.ts` (pattern, click, heavy projects; click track), `checks-render.ts` (2 determinism, 3 readback, 4 colour), `checks-system.ts` (1 environment, 5 encoders, 6 throughput, 7 stems, 8 sync).

---

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

**Not yet, and deliberately named rather than implied:** no on-canvas transform handles, no
timeline drag or zoom, no modulation matrix panel, no preset browser, no export dialog (the
queue exists in `src/export/queue.ts` but nothing wires it to the UI), no keyframes, no lyrics
panel, no Auto panel. The library is still one visualizer and two effects, so the inspector has
little to show; that is P4's job, not a gap in the generation.

---

## 5. Measured results

The full report is `docs/validation/p0-full-report.md`; the summary table is in PROJECT.md §4. Key points:

- **Determinism:** engine frames, export raw frames (NV12 and 10-bit) and bit-exact MP4 bytes are identical across processes.
- **Readback:** sync beats async PBO through ANGLE; GPU NV12 is fastest (1080p 197 fps, 4K 58 fps on the bars project).
- **Throughput (six-layer bars, 60 s):** H.264 1080p60 209 fps, 4K60 56 fps (NVENC-bound); HEVC 10-bit 98 / 27 fps.
- **NVENC p5:** 1080p H.264 199 / HEVC ~275 fps; 4K H.264 61 / HEVC ~92 fps. AV1 unavailable (Ampere).
- **Colour:** GPU NV12, swscale and HEVC 10-bit all within 1.2 code values of expected; black luma 16 / 64; all four tags present.
- **Stems:** `htdemucs` 4-min track in 8.6 s (28× realtime), 0.54 GB peak allocated; Python start + model load ~4 s.
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

---

## 7. Known gaps, debts and open questions

- **Tone shoulder touches fully saturated colours** (#ffffff → luma 232 instead of 235; pure primaries ~250/255).
  Owner kept D48 knowing the knee; flag again if palette-exact output becomes a requirement.
- `htdemucs_ft` not provisioned or measured (manifest entry needed: it is a bag of 4 models, each weight file pinned).
- HEVC 10-bit export is ~2× slower than H.264 because it reads RGBA10 and converts on the CPU; a GPU P010 path
  (16-bit samples packed like NV12) would likely close the gap.
- Still not rendered, and noted by `toRenderProject` rather than dropped: **masks** (S7) and
  **group compositing** (M38 — a group's own transform, opacity, blend and effects applied to its
  composited children). Blend modes beyond normal/add/screen fall back with a note. What a group
  says about *visibility* — enabled, soloed, time range — does now reach its children (§4.20).
- Two effects exist (bloom, vignette) against M12's target of ten.
- Presets and their on-disk store landed (§4.19, §4.25); the *browser* UI and thumbnails (S8) have not.
- Schema choice worth flagging: `transform` stores `scaleX`/`scaleY` rather than PROJECT.md §7's
  single `scale`, because stretched backgrounds need non-uniform scale. Not a spec conflict —
  §7 sketches the shape, it does not pin field names.
- One visual module plus two test modules. No effects, masks, groups, text, palette roles, aspect overrides, modulation.
- `quality: 'preview'` plumbed but unused. Unknown modules warn instead of drawing a placeholder.
- Export: the queue landed (§4.23); still no disk-space precheck, thumbnails, motion blur, SSAA or audio stream-copy.
- Frame hashing runs on the render thread (fine for validation; move to a worker if used in long exports).
- The supervised sidecar landed (§4.24); nothing calls it yet, and its Python half is unverified on a GPU machine.

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

Not yet: autosave, crash recovery, multi-select editing, keyframes.

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

---

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

---

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

---

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
folder on disk.

---

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

---

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

---

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

---

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
export UI (ui-spec §7).

---

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

---

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

---

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

---

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

---

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

---

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

---

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

---

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

---

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
3. **Asset library** (M40): the data model exists (§4.35: `document.assets`, hash, reported missing /
   changed files). Still to do: an asset panel, relink (by path, and by hash search in a folder),
   removing unused assets, storing paths relative to the project on save.
4. **Text layer** (M16, M32): deterministic glyph rasterisation at target resolution, per-word metrics.
5. **Logo layer** (M15) — an image layer with reactive pulse, cheap once 2–3 exist.
6. **Group compositing** (M38): group transform/opacity/blend/effects over composited children.
7. **Video layers** (M39): frame cache at project fps.
8. **Three.js scene layers** (M37): shared context, state save/restore, depth output.
9. **Preset browser UI** (S8) and **`modules/` drop-in folder + authoring guide** (M35).

---

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

---

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
