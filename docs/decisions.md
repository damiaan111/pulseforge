# Decision Log

> Every open question across all specifications, resolved. **This document is authoritative** —
> where a spec's "open questions" section disagrees, this wins.
> Decisions marked 🧑 were made by the owner; 🤖 are defaults I chose, and any of them can be
> overridden by saying so.
> Last updated: 2026-09-14.

---

## 1. Scope & product

| # | Question | Decision | Rationale |
|---|---|---|---|
| D1 🧑 | Runtime shell | **Electron** | Bundled Chromium guarantees identical WebGL2 behaviour dev↔prod; trivial FFmpeg bundling. Tauri's system WebView breaks "same pixels everywhere". |
| D2 🧑 | Project name | **Pulseforge** | Repo `pulseforge`, CLI `pulseforge render …`, app title Pulseforge. |
| D3 🧑 | Layer groups | **Full groups in v1** | Nesting with shared transform/opacity/effects. Promotes to must-have **M38**. |
| D4 🧑 | Video backgrounds | **Yes, with frame cache** | Pre-extracted to project fps for determinism (compositor §8). Promotes to must-have **M39**. |
| D5 🧑 | Output formats | **MP4 only (H.264 8-bit + HEVC 10-bit master)** | No alpha, no ProRes, no VP9, no PNG sequence. **Removes the entire CPU-encoder path** — a real scope cut. Alpha moves to Won't-have. |
| D6 🧑 | Asset handling | **Referenced + managed library** | Library of backgrounds/logos/fonts; projects reference by path+hash with relink; "collect files" for archiving. Promotes to must-have **M40**. |
| D7 🧑 | Tone mapping | **Filmic / ACES-like** | Highlights roll off keeping hue instead of blowing to white. Single fixed curve in v1; the pipeline stays able to swap it. |
| D8 🧑 | Quality defaults | **Fast by default, quality on demand** | `htdemucs` + Whisper `medium` on import; `htdemucs_ft` + `large-v3` one click away. Protects the "drop a track and look" loop. |
| D9 🧑 | Auto-director placement | **Offered on import, panel always available** | Never forced, never buried. |

---

## 2. Data model & formats

| # | Question | Decision | Rationale |
|---|---|---|---|
| D10 🤖 | Tick rate | **1/48000 s integer ticks** | Sample-accurate; exact frame boundaries at integer fps that divide 48000 (24/25/30/50/60/120); no float drift. NTSC rates (59.94 = 800.8 ticks/frame) are not tick-exact, so frame time always derives from the rational fps (export-spec §2). |
| D11 🤖 | Analysis rate | **240 Hz** | 4 samples per frame at 60 fps — headroom for look-ahead and quantisation precision. 120 Hz would save little and cost accuracy at the edges. |
| D12 🤖 | Spectrum storage | **256 log-spaced bins cached; full FFT recomputed on demand** | Full bins dominate cache size and only the spectrogram module needs them. |
| D13 🤖 | Project thumbnail | **Cached, not embedded** | Keeps `.pvproj` small and diffable; regenerating after a cache clear is cheap. |
| D14 🤖 | Multi-audio room in the format | **No speculative design** | `audio` stays a single object. A future array is a normal migration (data-formats §2). Designing for an unbuilt feature costs more than migrating later. |
| D15 🤖 | Repeatable parameter groups | **Allowed, constrained** | Arrays of one declared group shape with indexed addressing (`params.emitters[2].rate`), a declared max count, and no nesting beyond one level. Needed for particle emitters and multi-line text. Groups (D3) already made addressing hierarchical, so the cost is small — but unbounded nesting would make modulation paths unreadable. |
| D16 🤖 | Module-declared presets vs global library | **Both** | Modules ship starting presets; the user library stores saved ones. Different purposes. |

---

## 3. Rendering & compositing

| # | Question | Decision | Rationale |
|---|---|---|---|
| D17 🤖 | Preview bit depth | **Dithered 8-bit preview; 10-bit HEVC export** | A 10-bit preview path costs real complexity to catch banding that dithering mostly prevents anyway. |
| D18 🤖 | Depth output from 2D layers | **No — depth is 3D-only in v1** | Synthetic depth for fake DOF is a nice idea and a second half-working depth system. |
| D19 🤖 | Preview vs final pixel-diff budget | **Structural similarity only, no strict budget** | Conformance test 3 uses an SSIM threshold. A strict per-pixel budget would ban legitimate quality reductions. |
| D20 🤖 | Force `quality: final` on export | **Yes, forced** | Trusting module authors to opt in is how a preview shortcut silently ships in a 4K render. |

---

## 4. Modulation

| # | Question | Decision | Rationale |
|---|---|---|---|
| D21 🤖 | `multiply` semantics | **`acc *= (1 + out)` default, plus an explicit `scale` sub-mode** | The default makes 0 mean "no change", which is what people expect; `scale` covers genuine halving. |
| D22 🤖 | Envelope sharing | **Per-binding, deduplicated by cache key** | Identical settings already share a derived track (modulation §5), so a second UI concept buys nothing. |
| D23 🤖 | Look-ahead default | **On: −30 ms lag compensation** | Hits land on the beat rather than behind it. Exposed as "Timing" with a visible value, so the behaviour is discoverable rather than mysterious. |
| D24 🤖 | `pitch` as a source | **Deferred to Could-have** | Monophonic pitch tracking per stem is real work for a niche use. |
| D25 🤖 | Modulating discrete parameters | **Allowed, marked advanced** | Threshold semantics for bool/enum/int. Enables "switch blend mode on the drop"; flagged because it's also an easy way to make something look broken. |
| D26 🤖 | Matrix graph view | **List in v1; graph is Could-have** | The list is faster to work in. The graph photographs better, which is not a reason. |

---

## 5. Auto-director

| # | Question | Decision | Rationale |
|---|---|---|---|
| D27 🤖 | Percentile reference distribution | **Hand-tuned shipped constants** | Learning from a personal corpus would make output depend on machine history, which fights determinism and reproducibility. Revisit as a Could-have. |
| D28 🤖 | Section detection quality | **Energy-novelty in v1; `librosa`/`madmom` refinement promoted to Should (S16)** | The arranger leans on sections, the Python env already ships, so the upgrade is cheap. Acceptable for neon/cinematic material; matters more if you write acoustic music. |
| D29 🤖 | Template needs a missing module | **Substitute by tag; if none, template is unavailable with a stated reason** | Silent substitution of an unrelated module would be worse than saying so. |
| D30 🤖 | Does the director style lyrics? | **Placement and palette roles only** | Styling stays with the lyrics system, so a reroll never discards typography you chose. |
| D31 🤖 | Background image pool | **Starter pack + a user folder** | Both; the "random background" button draws from whatever is available. |
| D32 🤖 | Arrangement granularity | **Section-level, with the anti-monotony and anti-chaos rules as specified** | Minimum ~8 s between scene changes already prevents restlessness; acts emerge naturally from that clamp. |

---

## 6. Lyrics

| # | Question | Decision | Rationale |
|---|---|---|---|
| D33 🤖 | Tap latency calibration | **Global, stored in settings, re-calibratable** | Latency is a property of the person and input device, not the session. One calibration, reusable forever. |
| D34 🤖 | Auto-run alignment on paste | **Explicit action, offered via toast** | Never spend minutes of GPU time without being asked — but do offer it the moment it becomes possible. |
| D35 🤖 | Duet / overlapping lines | **`role` on a single track in v1; second track is Could-have** | Covers backing vocals and ad-libs without doubling the layout problem. |
| D36 🤖 | Manual syllable splitting | **v1.x (Should)** | Within-word interpolation handles almost everything; melisma is the rare exception. |
| D37 🤖 | `.lrc` import re-alignment | **Offer, never force** | Imported LRCs are commonly 200–500 ms off, but some are right and overwriting them would be rude. |
| D38 🤖 | Per-word styling | **Per-line overrides in v1; per-word is Could-have** | Per-word emphasis is available through `wordActive` modulation instead. |

---

## 7. Export

| # | Question | Decision | Rationale |
|---|---|---|---|
| D39 🤖 | GPU NV12 conversion | **Build RGBA path first behind an interface; decide from P0 numbers** | It roughly halves PCIe traffic, but "necessary" depends on measured readback cost. The interface makes it a swap, not a rewrite. |
| D40 🤖 | Default quality | **CQ 17 for 8-bit H.264; CQ 19 for the 10-bit HEVC master** | Dark neon gradients band easily; the extra bitrate is cheap locally. Revisit after P0's encoder matrix. |
| D41 🤖 | Determinism self-check | **Off by default; automatic for ranges under 30 s; always in CI** | Free where it's cheap, opt-in where it isn't. |
| D42 🤖 | Partial re-render | **v1.x (Should)** | Needs the stateful warm-up path (export §8) to be solid first. |
| D43 🤖 | Frame-server mode | **Could-have** | Cheap once the pump exists, and nothing depends on it. |

---

## 8. UI

| # | Question | Decision | Rationale |
|---|---|---|---|
| D44 🤖 | Aspect switcher behaviour | **Implicit editing, unmissable indicator, explicit "edit base" toggle** | Fast in the common case; the badge and border make the risky case visible. |
| D45 🤖 | Preset thumbnails | **Pre-rendered on save; live preview-with-my-audio later** | Pre-rendered is instant and good enough to choose from. |
| D46 🤖 | Node-graph view | **Could-have** | The layer list plus modulation matrix covers the need. |
| D47 🤖 | Multi-window | **Could-have** | Nice on a second monitor, not load-bearing. |

---

## 9. Requirement changes from these decisions

**New must-haves:**
- **M38** Layer groups: nesting with shared transform, opacity, blend and effect chain; hierarchical parameter addressing; group collapse when trivial (D3).
- **M39** Video layers via deterministic frame cache, with proxy sequences for preview and cache-size attribution (D4).
- **M40** Managed asset library: backgrounds, logos, fonts; path+hash references; missing-asset detection and relink; "collect files" (D6).

**Promoted:** S16 `librosa`/`madmom` — now includes structural/section refinement (D28).

**Demoted / removed:**
- Alpha export, ProRes, VP9, PNG sequence → **Won't-have (W7)**. Removes the CPU encoder path entirely (D5).
- `pitch` modulation source, second lyric track, per-word styling, node graph, multi-window, frame-server → Could-have.

**Net scope effect:** three must-haves added, one whole subsystem (CPU/alpha encoding) removed. Roughly neutral, with the removal being the larger simplification — it takes an entire second encoding path, its format matrix and its performance expectations out of v1.

---

## 10. What remains genuinely unknown

Not decisions — measurements. All of these wait on P0's validation script (export-spec §17) run on the RTX 3060:

1. Readback throughput, sync vs async, at 1080p and 4K — through WebGL2/ANGLE and including the frame transport into FFmpeg's stdin (export-spec §4.2) → sets pipeline depth, which process owns the export pipe, and whether D39 flips to NV12.
2. NVENC encode speed across the preset/codec matrix → confirms D40 and the export-time estimates.
3. End-to-end render fps on a representative project at 1080p60 and 4K60 → the number that determines whether 4K is comfortable or a compromise.
4. `htdemucs` vs `htdemucs_ft` wall time and peak VRAM → confirms D8 and the GPU queue's budgets.
5. Shader compile behaviour on NVIDIA vs the Intel dev machine → the first real test of PROJECT.md §14.
6. Whether identical raw frames also yield identical MP4 files with bit-exact muxing on NVENC (export-spec §0, §17) → determines whether file-level hashes are usable in CI or only frame hashes.

Every performance figure in PROJECT.md §4 is a placeholder until that report exists.
