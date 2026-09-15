# Build status — handoff document

> **Read this first in any new session.** It records what exists, what does not, how it works,
> how to verify it, and what to do next. Update it at the end of every step, in the same commit.
> Last updated: 2026-09-15 — **P0 and P2 complete**, P3 steps 1–4 of 5 done: the engine renders
> multi-layer projects headlessly at 16:9 / 9:16 / 1:1, golden frames are green, `npm run render`
> produces an MP4 from a project file, the preview clock is in place, and analysis is cached on
> disk. Next: P3 step 5, the React studio (§9).

---

## 1. Where we are

| Milestone | State |
|---|---|
| Planning (PROJECT.md, docs/*-spec.md, decisions D1–D50) | ✅ complete |
| **P0 — Spike** | ✅ **complete** — `npm run validate` passes 8/8; measurements in PROJECT.md §4 and `docs/validation/p0-full-report.md` |
| P1 — Provisioning | 🔶 core + stems tiers work; lyrics/extras tiers, `htdemucs_ft`, offline-rebuild CI job not started |
| **P2 — Engine** | ✅ **complete** — all six steps done (see §4.7–§4.13, §8) |
| **P3 — Studio** | 🔶 **in progress** — steps 1–4 of 5 done (see §9) |
| P4 … P8 | ⬜ not started |

P3 steps:

| # | Step | State | Commit |
|---|---|---|---|
| 1 | App shell: safe process layout, typed IPC, project I/O | ✅ | `cab80a0` |
| 2 | Command/undo stack (M8) | ✅ | `59000e0` |
| 3 | Analysis pipeline: features, onsets, beat grid (M4) | ✅ | `05471d4` |
| 4 | Preview clock (M31) | ✅ | `f3153e8` |
| 5 | React studio (ui-spec) | ⬜ | |

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
run `npm run check` and `npm run golden`, then continue with §9 (P3 step 4). Keep STATUS.md updated
and commit after each step."*

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

---

## 3. Commands

| Command | What it does | Time |
|---|---|---|
| `npm install` | dev deps (TypeScript 6.0, ESLint 10, Vitest 5, Electron 44.3.0, esbuild 0.28.2) | once |
| `npm run check` | typecheck + lint + 344 tests (FFmpeg/Python tests skip without `vendor/`; the GPU layout test skips without Electron) | ~10 s |
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
- Not yet: stems analysis, sections, workers, quantisation and beat-synced LFO rates (which now
  have a grid to use).

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
  composited children). Blend modes beyond normal/add/screen fall back with a note.
- Two effects exist (bloom, vignette) against M12's target of ten.
- No presets yet (M25). (Undo/commands landed in P3 step 2, §4.15.)
- Schema choice worth flagging: `transform` stores `scaleX`/`scaleY` rather than PROJECT.md §7's
  single `scale`, because stretched backgrounds need non-uniform scale. Not a spec conflict —
  §7 sketches the shape, it does not pin field names.
- One visual module plus two test modules. No effects, masks, groups, text, palette roles, aspect overrides, modulation.
- `quality: 'preview'` plumbed but unused. Unknown modules warn instead of drawing a placeholder.
- Export: no queue, pause/resume, disk-space precheck, thumbnails, motion blur, SSAA, audio stream-copy.
- Frame hashing runs on the render thread (fine for validation; move to a worker if used in long exports).
- The sidecar is spawned per command; M27 needs a supervised long-lived process with cancellation.

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
`npm run render` itself has not been executed since. Typecheck, lint and 375 tests pass. On the
RTX machine, run it twice on the same audio and confirm the second says `cache hit` — and that
`npm run golden` is still green, since the analysis path feeding the engine changed shape.

Not yet: stem sources in the tree (nothing produces them yet), `peaks/`, `derived/`,
`sections.json`, and the app's own cache root — the CLI uses `<repo>/cache/`, the app will want
its user-data directory (M33).

---

---

## 9. Next: P3 — Studio (PROJECT.md §10)

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
5. **React studio** (ui-spec): canvas, timeline, schema-generated inspector, aspect switcher.
   The clock is ready for it: drive `tick()` from the render loop, hand `frame.timelineSeconds`
   to `renderFrame`, and apply `seekAudioTo` / `pauseAudio` to the audio element.

Also outstanding from earlier phases: P1's lyrics/extras tiers, `htdemucs_ft` and the
offline-rebuild CI job; the GPU P010 path for HEVC 10-bit (§7).

**Work that does not need a GPU**, for a session on a machine without one: more effect modules
toward M12's ten (two exist), the waveform peak pyramid the timeline needs (ui-spec §3), masks
and group compositing in `toRenderProject` (§7), presets (M25), and `sections.json` for the
auto-director.
