# Specification Coverage Audit

> Every requirement in [PROJECT.md](../PROJECT.md) §9, checked against where it is actually
> specified. Re-run after the decision log closed all outstanding questions.
> Last updated: 2026-09-14.

**Result: all 40 must-haves are specified; every open question is now resolved.** Three gaps were found and closed by writing
[compositor-spec.md](compositor-spec.md) and [data-formats-spec.md](data-formats-spec.md);
two remaining items are specified but carry open decisions that should be settled before their
phase starts.

---

## 1. Must-have coverage

| # | Requirement | Specified in | Depth |
|---|---|---|---|
| M1 | Shell, project I/O, autosave, crash recovery, schema migration | ui-spec §10 · **data-formats §1–2** | ✅ full |
| M2 | Self-contained setup | PROJECT §3 · ui-spec §8 | ✅ full |
| M3 | Audio import, waveform, transport | PROJECT §8.1/§8.10 · ui-spec §3/§5 | ✅ full |
| M4 | Analysis pipeline & cache | PROJECT §8.1 · **data-formats §4** | ✅ full |
| M5 | Stem separation | PROJECT §3/§8.1 · data-formats §4.4 | ✅ full |
| M6 | Determinism contract | module-spec §7 · export-spec §2 | ✅ full |
| M7 | WebGL2 compositor | **compositor-spec §1–4** | ✅ full |
| M8 | Undo/redo | ui-spec §10 | ✅ full |
| M9 | Layer system | PROJECT §6 · ui-spec §4 · compositor §6 | ✅ full |
| M10 | Schema-driven params | module-spec §3, §13 | ✅ full |
| M11 | ≥10 visualizer modules | PROJECT §8.3 · module-spec §14 | ✅ catalogue + example |
| M12 | ≥10 effects | PROJECT §8.4 · module-spec §8 | ✅ catalogue + contract |
| M13 | Modulation matrix | modulation-spec (all) | ✅ full |
| M14 | Background layer incl. video | **compositor-spec §8** | ✅ full — confirmed for v1 (D4/M39) |
| M15 | Logo/watermark layer | PROJECT §8.2 · module-spec | ✅ trivial case of layer system |
| M16 | Text layer | PROJECT §8.13 · lyrics-spec §7 | ✅ full |
| M17 | Global palette system | **compositor-spec §9** · auto-director §5.3 | ✅ full |
| M18 | Lyrics editor & import | lyrics-spec §1–2 | ✅ full |
| M19 | Tap-to-sync | lyrics-spec §3, §5 | ✅ full |
| M20 | Karaoke word-fill | lyrics-spec §6 | ✅ full |
| M21 | Auto-director | auto-director-spec (all) | ✅ full |
| M22 | Surprise me | auto-director-spec §9 | ✅ full |
| M23 | Deterministic renderer + NVENC | export-spec (all) | ✅ full |
| M24 | Export presets + queue | export-spec §11–12 · ui-spec §7 | ✅ full |
| M25 | Preset save/load | module-spec §10 · data-formats §3 | ✅ full — referenced + library (D6/M40) |
| M26 | WhisperX alignment | lyrics-spec §4 | ✅ full |
| M27 | ML sidecar lifecycle | PROJECT §3 | ✅ adequate |
| M28 | Global GPU job queue | PROJECT §4 | ✅ adequate |
| M29 | Audio clip model | PROJECT §8.10 · data-formats §1.3 | ✅ full |
| M30 | Layout & aspect system | PROJECT §8.11 · module-spec §6 | ✅ full |
| M31 | Preview clock | PROJECT §8.12 · export-spec §3 | ✅ full |
| M32 | Text rasterisation | PROJECT §8.13 · lyrics-spec §6.2 | ✅ full |
| M33 | Cache & disk management | PROJECT §8.14 · data-formats §4.5 | ✅ full |
| M34 | Diagnostics & render reports | PROJECT §8.15 · export-spec §15 | ✅ full |
| M35 | Module authoring + plugin folder | module-spec §12 | ✅ full |
| M36 | Settings screen | PROJECT §8.16 · ui-spec §8 | ✅ full |
| M37 | Three.js 3D layers | **compositor-spec §7** | ✅ full |

## 2. Should-have coverage

| # | Requirement | Status |
|---|---|---|
| S1 | Keyframe automation | ⚠️ **Slot reserved, mechanism unspecified.** module-spec §5 defines *where* it applies in the value pipeline and §3.1 marks params `animatable`, but interpolation per type, easing curves and the keyframe editor are not specified. Needs a short spec before P8. |
| S2 | GLSL shader layer | Covered by module-spec as a module kind; shader-specific UX unspecified (acceptable — it's one module) |
| S6 | 6-stem model | PROJECT §3 — a config change |
| S7 | Masking | ✅ compositor-spec §5 |
| S8 | Preset browser | ✅ ui-spec §5 |
| S9 | Markers & sections | ✅ ui-spec §3 |
| S10 | Motion blur | ✅ export-spec §9 |
| S11 | Colour management | ✅ compositor-spec §2 · export-spec §6 |
| S12 | Performance HUD | ✅ PROJECT §8.15 · compositor §4 |
| S13 | Batch mode | ✅ export-spec §12 |
| S14 | CLI | ✅ export-spec §18 |
| S15 | Karaoke export | ✅ export-spec §7 |
| S16 | librosa/madmom beat refinement | PROJECT §3 — optional pass |
| S17 | Unicode & font fallback | ⚠️ Deferred by choice; M32 must be built to accommodate it |
| S18 | Draft/proxy mode | ✅ ui-spec §2 · compositor §8 |
| S19 | Collect files | ✅ data-formats §1.2 |

---

## 3. Gaps found and closed

**1. The compositor itself (M7) — the most significant gap.**
Effects and modules were well specified, but the thing that *combines* layers was not: blend
mode semantics, intermediate precision, alpha convention, target pooling. Two decisions here
change the appearance of every project and are painful to fix later — compositing must happen in
**linear light** (sRGB blending makes glows grey and muddy), and alpha must be **premultiplied**
(straight alpha bleeds fringes under any filtering or scaling). Both are now fixed in
compositor-spec §2–3, along with `RGBA16F` intermediates, which matter because additive blending
and bloom routinely exceed 1.0 and 8-bit clips them to flat white.

**2. Three.js integration (M37) — a must-have with no spec at all.**
Promoted to must-have two turns ago because "cinematic" is a target aesthetic, but nothing said
how a 3D scene coexists with a 2D compositor. The sharp edge: **Three.js mutates global GL
state**, so without save/restore around every scene render, subsequent 2D layers draw with
whatever blend and depth state Three left behind — presenting as random, layer-order-dependent
corruption that is genuinely nasty to diagnose. Also specified: no `clock.getDelta()`, no Three
`EffectComposer` (post goes through the engine's chain so preview and export share one path), and
depth exposed as a second output so DOF can consume it.

**3. Project schema versioning and the analysis cache format (M1, M4).**
Module-level parameter migration was covered; the *document* level was not, nor was the cache's
binary layout or — more importantly — its key. The load-bearing detail: **`analysisVersion` must
be part of the cache key**, or fixing an onset-detection bug leaves every existing project using
the old results, and you lose an afternoon to "it's still doing the old thing". Also settled:
integer ticks at 1/48000 s rather than floats, migrations as an ordered chain of pure functions
with committed fixture files, and a refusal to half-open documents from a newer version.

---

## 4. Open decisions — now closed

All resolved in [decisions.md](decisions.md) (47 decisions). The two items previously flagged here:
- **M14 video backgrounds** — confirmed for v1 with the frame cache (D4 → **M39**).
- **M25 preset assets** — referenced, backed by a managed asset library (D6 → **M40**).

Three new must-haves arrived with those answers (M38 groups, M39 video, M40 asset library), and
one entire subsystem left: alpha/ProRes/PNG-sequence export and the whole CPU encoding path are
now Won't-haves (D5 → W7).

**S1 keyframe automation** remains the one Should-have whose mechanism is unspecified —
interpolation per parameter type, easing, and the editing model. It needs a short spec before P8.
Nothing is blocked: the value pipeline already reserves its slot and the addressing exists.

---

## 5. Consistency checks across documents

Cross-cutting invariants, verified to be stated consistently everywhere they appear:

| Invariant | Documents | Consistent |
|---|---|---|
| Time is a parameter; no wall-clock reads | PROJECT §5, module §7, modulation §8, compositor §7.2 | ✅ |
| Seeded PRNG is the only randomness | module §7, auto-director §8, modulation §8 | ✅ |
| Timeline time ≠ audio time; one mapping | PROJECT §8.10, data-formats §1.3, modulation §15 | ✅ |
| Preview and export share one renderer | PROJECT §5, export §3, compositor §8 | ✅ |
| Stems are load-bearing, not optional | PROJECT M5, modulation §2.1, lyrics §4, auto-director §2 | ✅ |
| Parameter addressing is one scheme | module §4, modulation §1, auto-director §5, compositor §6 | ✅ |
| Nothing is silently dropped on load | module §9, modulation §13, data-formats §1.2/§2.2 | ✅ |
| Caches are always rebuildable | PROJECT §8.14, data-formats §4.5 | ✅ |
| Percentile calibration is shared code | modulation §7, auto-director §5.2 | ✅ |

One thing worth noting: layer **groups** (compositor §6) affect parameter addressing, which
several documents depend on. The spec assumes groups exist in the addressing scheme even if the
UI ships later — retrofitting nesting into paths afterwards would touch presets, modulation and
the auto-director simultaneously. That decision is flagged in ui-spec §14.6 and compositor §11.1
and should be confirmed, not left to drift.

---

## 6. Document map

| Document | Covers |
|---|---|
| [PROJECT.md](../PROJECT.md) | Vision, decisions, hardware, architecture, requirements, milestones, risks |
| [module-spec.md](module-spec.md) | Module manifest, parameter types, value pipeline, render contract, versioning, presets, conformance |
| [modulation-spec.md](modulation-spec.md) | Bindings, sources, signal chain, envelopes, musical time, calibration, accumulation, recipes |
| [auto-director-spec.md](auto-director-spec.md) | TrackDigest, StyleVector, templates, slot resolution, arrangement, guardrails, reroll |
| [export-spec.md](export-spec.md) | Frame timing, readback, encoding, colour, audio, queue, verification, P0 validation |
| [lyrics-spec.md](lyrics-spec.md) | Lyrics model, input routes, tap-to-sync, alignment, karaoke rendering, validation |
| [ui-spec.md](ui-spec.md) | Layout, canvas, timeline, inspector, panels, shortcuts, state, errors, performance |
| [compositor-spec.md](compositor-spec.md) | Frame construction, colour, alpha/blending, pooling, masking, groups, 3D, video, palette |
| [data-formats-spec.md](data-formats-spec.md) | Project file, versioning/migration, analysis cache, reports, settings |

---

## 7. Verdict

The plan is **complete enough to build from**. Every must-have has a specification; the
cross-document invariants agree; the remaining open questions are choices, not unknowns, and none
of them block P0.

The one thing no amount of further specification can produce is measurement. Readback throughput,
NVENC speed, stem timings and shader cost on the RTX 3060 are all still estimates, and several
design defaults (readback depth, NV12-on-GPU, default CQ, stem model choice) are explicitly
waiting on them. P0's validation script (export-spec §17) exists to produce those numbers.

**Next step is code, not more planning.**
