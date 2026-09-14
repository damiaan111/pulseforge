# Module & Parameter Schema — detailed specification

> Companion to [PROJECT.md](../PROJECT.md) §8.17. Design spec, not implementation.
> Status: draft for review. Last updated: 2026-09-14.

---

## 0. Why this is the first thing to design

Five separate systems all address this one shape:

| System | What it needs from the schema |
|---|---|
| **Inspector UI** | Generate controls automatically from parameter declarations |
| **Modulation matrix** | Enumerate what can be targeted, and the legal value range |
| **Keyframe automation** | Same, plus interpolation rules per type |
| **Presets** | Serialise and restore values, across module versions |
| **Auto-director** | Discover modules by capability and set values programmatically |
| **Plugin folder** | Load third-party modules without a rebuild |

Get the shape wrong and all six get reworked. Get it right and adding the 40th effect costs
one file and zero UI code. This document defines that shape.

**Design goals, in priority order:**
1. **Declarative.** A module describes *what* it has; the app decides how to present it.
2. **Deterministic by construction.** The contract should make non-determinism awkward to write.
3. **Resolution- and aspect-independent by default.** The wrong thing should be hard.
4. **Stable across versions.** A project from a year ago opens correctly.
5. **Boring to author.** A new effect should be obvious to write from one example.

---

## 1. Module kinds

| Kind | Produces | Consumes | Examples |
|---|---|---|---|
| `visualizer` | RGBA texture | analysis, params | bars, circular, particles, terrain |
| `effect` | RGBA texture | one input texture, params | bloom, glitch, kaleidoscope |
| `source` | RGBA texture | asset, params | image, video, gradient, solid |
| `scene3d` | RGBA texture (+depth) | analysis, params | reactive geometry, tunnel, point cloud |
| `text` | RGBA texture + metrics | string, font, params | title, lyrics, credits |

All kinds share the same manifest and parameter schema; they differ only in their render
signature and in whether they receive an input texture. **One schema language, five bindings** —
this is what keeps the inspector, presets and modulation uniform across every layer type.

---

## 2. Module manifest

```
ModuleManifest {
  id            "core.visualizer.bars"   // reverse-DNS, permanent, never reused
  version       "1.2.0"                  // semver; minor = params added, major = breaking
  kind          "visualizer" | "effect" | "source" | "scene3d" | "text"
  name          "Bars"                   // display name, may change freely
  description   "Frequency bars with configurable shape and spacing"
  category      "spectrum"               // groups the browser
  tags          ["bars","spectrum","2d","neon"]
  author        "core"
  thumbnail     "thumb.png" | generated
  capabilities  {
    needsAnalysis     true
    needsInput        false     // effects: true
    supportsAspect    true      // declares it reflows correctly
    stateful          false      // true ⇒ must implement checkpoint/restore (§7)
    gpuCost           "low" | "medium" | "high"   // hint for the performance HUD
  }
  paramsSchemaVersion  3        // for migrations (§9)
  params        [ … ]           // §3
  presets       [ … ]           // optional built-in starting points
}
```

**`id` is permanent and is what projects store.** `name` is cosmetic. Renaming a module must
never break a saved project — this separation is the entire reason for the reverse-DNS id.

---

## 3. Parameter types

### 3.1 Common fields (every parameter)

```
key           "barCount"        // stable identifier; the storage key; never renamed (§9)
label         "Bar count"       // display; free to change
type          ParamType
default       <type-appropriate>
group         "Shape"           // inspector section
order         10                // sort within group
description   "How many bars…"  // tooltip / help
modulatable   true              // may be a modulation target
animatable    true              // may carry keyframes
aspectOverridable  false        // may differ per aspect ratio (§6)
visibleWhen   { param: "mode", equals: "radial" }   // conditional display
advanced      false             // hidden behind "show advanced"
```

### 3.2 The type catalogue

| Type | Value | Extra fields | Inspector control |
|---|---|---|---|
| `float` | number | `min`, `max`, `step`, `unit`, `scale: linear\|log\|exp`, `softMin/softMax` | slider + numeric entry |
| `int` | integer | `min`, `max`, `step` | stepper slider |
| `bool` | boolean | — | toggle |
| `enum` | string | `options: [{value,label,icon?}]` | segmented / dropdown |
| `color` | RGBA | `allowAlpha`, `paletteRole` | swatch + picker, palette-linked |
| `gradient` | stop list | `minStops`, `maxStops` | gradient editor |
| `vec2` | {x,y} | `space: fraction\|pixels\|canvas`, per-axis min/max, `linked` | XY pad + fields |
| `angle` | degrees | `min`, `max`, `wrap` | dial |
| `curve` | control points | `presets` | curve editor |
| `asset` | ref | `accept: image\|video\|audio\|lut\|font`, `required` | file picker + preview |
| `font` | family + variant | — | font picker with fallback display |
| `text` | string | `multiline`, `maxLength` | text field |
| `band` | band selector | — | band picker (sub/bass/…/custom Hz range) |
| `blend` | blend mode | — | blend dropdown |
| `select:module` | module id | `kind`, `tags` | module picker (for wrapper modules) |

**Deliberately absent:** free-form objects and arrays of arbitrary shape. Everything must be
introspectable, or the inspector, modulation matrix and preset system can't reason about it.
A module wanting structured data declares a `group` of typed params instead.

### 3.3 Ranges, soft limits and modulation headroom

`min`/`max` are **hard** clamps; `softMin`/`softMax` bound the *slider* while allowing typed or
modulated values beyond. This matters constantly in practice: a glow intensity slider that feels
right over 0–2 must still permit a modulation to push it to 8 on a drop, without the UI making
0–8 the everyday range and rendering the useful part of the slider a sliver.

**`scale: log` is required for anything perceptually logarithmic** — frequency, blur radius,
glow, scale factors. A linear frequency slider spends 90% of its travel in a range nobody wants.

---

## 4. Parameter addressing

```
layers.<layerId>.params.<key>
layers.<layerId>.effects.<effectId>.params.<key>
layers.<layerId>.transform.scale
global.effects.<effectId>.params.<key>
palette.colors.<index>
```

Rules:
- **Ids are stable and opaque.** Generated once, never reused, never derived from names.
- Paths are how modulations, keyframes, presets and the auto-director all refer to values. One addressing scheme, no parallel systems.
- A path pointing at something that no longer exists is **reported, never silently dropped** — a modulation that vanishes without explanation is a bug the user will chase for an hour.

---

## 5. Value resolution pipeline

The single most important rule in this document: **the order in which a parameter's final value
is computed.** Every subsystem must agree on it, or preview, export and the inspector disagree.

```
1. base            ← stored in the project
2. aspect override ← if one exists for the active aspect (§6), REPLACES base
3. automation      ← keyframes at time t, if any, REPLACE the result of 1–2
4. modulation      ← applied in binding order, each add / multiply / replace
5. clamp           ← to [min, max]
6. type coercion   ← int rounding, angle wrapping, color clamping
```

Notes that prevent real bugs:

- **Automation replaces rather than offsets.** If a parameter is keyframed, the keyframes *are* the base value; modulation then rides on top. Any other choice makes "why isn't my keyframe doing anything" a permanent support question.
- **Multiple modulations on one parameter apply in explicit binding order**, not by source or arbitrary order. The matrix panel shows and lets you reorder them. `replace` mode ends the chain for the bindings before it.
- **Clamping happens once, at the end.** Intermediate values may legally exceed the range; only the final value is clamped. Otherwise a `multiply` after an `add` behaves differently depending on how close the base sat to the limit.
- **The resolved value is computed per frame from `t` alone** — never accumulated frame to frame. This is the determinism contract at parameter level.
- The inspector displays **base** as the slider position and **resolved** as a live overlay, so it's always visible which is which.

---

## 6. Resolution & aspect independence

Rules a module must follow to survive 1080p → 4K and 16:9 → 9:16:

- **No pixel constants.** Sizes are fractions of a reference dimension, declared per parameter via `space`:
  - `fraction` — 0..1 of canvas width/height
  - `canvas` — relative to the canvas's smaller/larger dimension or diagonal (module declares which)
  - `pixels` — **at a declared reference resolution**, scaled automatically; never raw device pixels
- **Aspect is an input, not an accident.** The render context supplies `aspect`, and modules are expected to adapt — a bar visualizer should use fewer, wider bars in vertical, not 128 hairlines.
- **`aspectOverridable: true`** marks parameters worth overriding per aspect (counts, positions, sizes). Colours and blend modes generally aren't.
- Line widths, blur radii and glow sizes scale with resolution, or 4K exports look thin and weak compared to the 1080p preview — the single most common way this goes wrong.

---

## 7. Render contract

```
RenderContext {
  time      { t, duration, progress, fps, frameIndex }
  canvas    { width, height, aspect, dpr, referenceScale }
  analysis  (source, feature, t) → value        // mix or any stem; interpolated
  palette   (role) → color
  prng      (…keys) → number                    // seeded; the ONLY randomness
  gl        WebGL2 context + framebuffer pool + shader cache
  input     texture | null                      // effects only
  resources module-scoped allocations
  quality   { preview | final, scale, samples }
}
```

Lifecycle: `init(gl, manifest)` → `resize(w, h)` → `render(ctx, params)` → `dispose()`.

**Hard rules — these are what the conformance test checks (§11):**
1. `render` is a **pure function of `(ctx, params)`**. Same inputs, same pixels, always.
2. No `Date.now()`, `performance.now()`, `Math.random()`, or reads of wall-clock time.
3. No mutable module-level state between frames — unless `stateful: true`, and then:
   - the simulation steps at a **fixed internal timestep** from `t=0`
   - `checkpoint(t)` / `restore(state)` are implemented so seeking doesn't drift
   - the checkpoint interval is declared; the engine handles fast-forwarding on seek
4. No network, no filesystem — assets arrive through `asset` params, resolved by the host.
5. `quality.preview` may reduce cost (fewer particles, cheaper blur) but **must not change composition** — the preview may be grainier, never different.
6. Allocation happens in `init`/`resize`, not per frame. The framebuffer pool is the host's job.

Rule 5 is subtler than it reads: "fewer particles" changes the image. The correct approach is
to reduce *fidelity within a stable structure* — same emitter positions, same seed, same
distribution, lower count — so the preview is recognisably the final frame at lower quality.

---

## 8. Effect chain contract

- An effect receives `input` (the layer's rendered texture) and returns a new texture. It must not write to its input.
- Multi-pass effects request scratch targets from the pool; they are recycled, never held.
- Effects declare `expandsBounds` (glow and blur bleed outside the source) so the compositor can allocate padding rather than clipping the halo at the layer edge.
- Effects declare whether they are `premultiplied` and operate in **linear space**; the compositor converts once at the end (PROJECT.md S11). Doing bloom in sRGB is the classic reason glows look muddy.
- Chain order is explicit and reorderable in the UI, with per-effect bypass and solo.

---

## 9. Versioning & migration

Modules evolve; projects must not break.

- **Adding a parameter** — minor bump; old projects use its default. Always safe.
- **Removing a parameter** — never delete outright. Mark `deprecated: true`, keep it loading, ignore it in render. Projects keep opening.
- **Renaming a key** — forbidden. Add the new key and declare `aliasOf` so old values migrate on load.
- **Changing semantics** (units, range, meaning) — major bump plus a `migrate(from, values) → values` function. This is the only case that needs real work, and the `paramsSchemaVersion` field exists for it.
- **Unknown modules on load** (a plugin that isn't installed) — the layer is preserved intact, rendered as a visible placeholder, and flagged. **Never silently dropped.** Saving must round-trip the unknown layer's data untouched, or opening a project on a machine missing one plugin quietly destroys it.

---

## 10. Preset serialisation

```
Preset {
  formatVersion, id, name, tags, thumbnail
  scope     "layer" | "project"
  module    { id, version, paramsSchemaVersion }
  values    { <key>: <value> }        // only non-defaults, keeping presets small and diffable
  effects   [ … ]
  modulations [ … ]                   // relative paths, rebound on apply
  assets    "embedded" | "referenced"  // PROJECT.md open question 3
  palette   included? role mappings?
}
```

- Presets store **only what differs from defaults**, so a later default improvement propagates to existing presets rather than being frozen out.
- Applying a preset to a layer of a different module type is offered as "replace module", with the values that map across carried over by key.
- Modulation bindings in a preset use paths relative to the preset root and are rebound on apply.

---

## 11. Conformance test suite

Every module — built-in or dropped into `modules/` — is run through this automatically. It is
the mechanism that keeps the determinism contract real rather than aspirational:

1. **Determinism** — render frame at `t=7.3` twice, compare bytes. Then render frames 0→N sequentially and compare frame N against a direct jump to N (catches hidden accumulation).
2. **Seek stability** — for `stateful` modules, checkpoint/restore round-trip matches sequential playback within tolerance.
3. **Resolution independence** — render at 1080p and at 4K downscaled; compare structurally. Catches pixel constants.
4. **Aspect handling** — render at 16:9 and 9:16; assert no clipping, no degenerate geometry, and that `supportsAspect` isn't a lie.
5. **Schema round-trip** — serialise all params, reload, compare. Every declared type survives.
6. **Range safety** — render at min and max of every parameter, and at extremes of modulation, without NaN, crash, or shader error.
7. **Resource hygiene** — allocations after `dispose` return to zero; no per-frame allocation growth over 300 frames.
8. **Cost declaration** — measured GPU time roughly matches the declared `gpuCost` band.

A module failing 1, 2 or 5 is **blocked from export** (it would produce unreproducible video)
while still usable in preview, clearly flagged. Failures in 3, 4, 6–8 are warnings.

---

## 12. Plugin folder

- `modules/<name>/module.json` + code + optional thumbnail; scanned at startup, listed with source and version.
- **Trust model: none.** Plugins are local files the user placed there deliberately, on a private single-user machine. No sandbox is planned — but a plugin that throws is caught, disabled, and reported rather than taking the app down.
- Failures are surfaced per module: compile errors with the shader source line, schema errors naming the offending field.
- Dev mode watches the folder and hot-reloads, preserving current parameter values where keys still match.

---

## 13. Inspector generation rules

How each declaration becomes UI, so authoring a module is enough to get a good panel:

- Params render grouped by `group`, ordered by `order`, groups collapsible and remembered per module.
- `advanced: true` hides behind a disclosure — the default panel stays short.
- `visibleWhen` drives conditional display; a hidden param keeps its value and still renders (no surprise resets when you toggle a mode back).
- Every `modulatable` param gets a right-click affordance and, once bound, a live overlay showing resolved vs base, plus a badge to open the binding.
- Every `animatable` param gets a keyframe diamond aligned to the timeline.
- `color` params bound to a `paletteRole` show the link and update with the global palette; unlinking is one click.
- Units render in the field; log-scaled sliders are marked, so a non-linear slider isn't mistaken for a broken one.

---

## 14. Worked example — `core.visualizer.bars`

Illustrative declaration, showing the conventions rather than the full parameter list:

```
id: "core.visualizer.bars", kind: "visualizer", paramsSchemaVersion: 1
capabilities: { needsAnalysis: true, supportsAspect: true, stateful: false, gpuCost: "low" }

Group "Source"
  source      select:stem   default "mix"          // mix | drums | bass | vocals | other
  band        band          default "full"
  smoothing   float 0..1    default 0.6   unit "×"   desc "Attack/release on bar heights"

Group "Shape"
  mode        enum          default "linear"       // linear | radial | mirrored
  barCount    int   8..256  default 64   aspectOverridable: true
  barWidth    float 0..1    default 0.7  unit "×"  desc "Fraction of available slot"
  cornerRadius float 0..0.5 default 0.1
  minHeight   float 0..0.3  default 0.01 space "fraction"
  maxHeight   float 0..1    default 0.6  space "fraction"  aspectOverridable: true
  radius      float 0..0.5  default 0.25 space "canvas"    visibleWhen mode == "radial"

Group "Appearance"
  fill        gradient      default <palette primary→secondary>
  glow        float 0..4    softMax 1.5  scale "log"  default 0.4
  glowColor   color         paletteRole "glow"
```

Points the example is making:
- `barCount` and `maxHeight` are `aspectOverridable` — vertical wants fewer, taller bars.
- `glow` has `softMax: 1.5` with a hard max of 4, leaving modulation headroom without wasting slider travel, and is log-scaled because glow is perceptually logarithmic.
- `radius` only appears in radial mode, and keeps its value when you switch away and back.
- `source` exposes stems as a first-class choice, so per-instrument reactivity is one dropdown, not a modulation setup.
- Colours default to palette roles, so the global palette reskins this module for free.

---

## 15. Open questions for this spec

1. **Asset embedding in presets** — embedded (portable, large) or referenced (small, breakable)? Also PROJECT.md open question 3; answering it here settles both.
2. **Sub-parameters / repeatable groups** — some modules genuinely want a variable-length list (multiple emitters, several text lines). Options: forbid it and require fixed slots (simple, limiting); allow arrays of a declared group shape (flexible, complicates modulation paths). Worth deciding before particles and multi-line text are built.
3. **Should `text` modules expose per-word/per-character params**, or is that internal to the lyrics system? Affects whether karaoke styling is modulatable per word.
4. **Module-declared presets vs a global preset library** — both, or just one?
5. **Does `quality.preview` need a strict pixel-difference budget** in the conformance test, or is "structurally similar" enough?

---

## 16. What this unlocks

With this in place, the remaining subsystems become mostly mechanical:

- **Modulation matrix** — enumerate `modulatable` params, read ranges, apply at step 4 of §5.
- **Keyframes** — enumerate `animatable` params, interpolate per type, apply at step 3.
- **Auto-director** — query modules by `capabilities` and `tags`, set values through the same paths a human would, producing a project indistinguishable from a hand-built one.
- **Preset browser** — read manifests, render thumbnails, filter by tag.
- **Plugin folder** — same manifest, different origin.

None of those need a bespoke integration. That is the whole point of doing this first.
