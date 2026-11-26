# Auto-Director & Template System — detailed specification

> Companion to [PROJECT.md](../PROJECT.md) §8.6 and [module-spec.md](module-spec.md).
> Design spec, not implementation. Status: draft for review. Last updated: 2026-09-14.

---

## 0. The problem this has to solve

One click: audio file in, complete and good-looking music video project out — fully editable,
nothing black-box.

**The failure mode is specific and worth naming up front: procedural mush.** Systems like this
usually fail the same way — they randomise parameters within safe ranges and produce output
that is technically varied and uniformly mediocre. Every result looks like the same tasteful
compromise, because averaging a design space lands in the middle of it, and the middle is dull.

The two design principles that follow from that:

1. **Taste lives in hand-authored templates, not in the algorithm.** The code's job is analysis, matching, calibration and arrangement. The *look* comes from templates a human designed. Ten excellent templates beat a thousand procedural permutations.
2. **Randomness is structured, never free.** "Surprise me" swaps between coherent authored alternatives and reroll axes the template declares safe. It never dices individual sliders, because that is exactly how you get mush.

A useful test for every decision below: *would a person who knows what they're doing have made
this choice?* If the answer depends on measurement, automate it. If it depends on taste, put it
in a template.

---

## 1. Pipeline

```
audio ──► [1] ANALYSE ────► TrackDigest       (facts about the track)
              │
              ▼
          [2] CLASSIFY ───► StyleVector       (what kind of track this is)
              │
              ▼
          [3] MATCH ──────► Template          (which authored look suits it)
              │
              ▼
          [4] POPULATE ───► layers, palette, modulations (calibrated to THIS track)
              │
              ▼
          [5] ARRANGE ────► scheduling across the song's structure
              │
              ▼
          [6] VALIDATE ───► legibility, performance, determinism guardrails
              │
              ▼
       ProjectDocument + DecisionLog  ← a plain, ordinary, fully editable project
```

Steps 1–2 are measurement. Step 3 is matching. Steps 4–5 are where authored intent meets
measured reality. Step 6 catches the results that are technically valid but visually broken.

---

## 2. TrackDigest — the facts

Derived from the AnalysisCache (PROJECT.md §8.1), summarising a whole track rather than
per-frame values:

```
TrackDigest {
  duration, bpm, bpmConfidence, beatGrid, timeSignatureGuess
  energy        { curve, mean, peak, dynamicRange, crestFactor }
  spectrum      { centroidMean, brightness, bassWeight, airWeight }
  transients    { density, sharpness }        // percussive vs sustained
  stereo        { widthMean, monoCompatible }
  stems         { drumsPresence, bassPresence, vocalPresence, otherPresence,
                  vocalCoverage,              // fraction of track with vocals
                  vocalSegments[] }           // where singing actually happens
  structure     { sections[], drops[], quietest[], loudest[] }
  onsets        { perBar, regularity }        // steady 4-on-floor vs rubato
}
```

Two of these carry more weight than their size suggests:

- **`structure.sections`** is what lets the video have an arc instead of one static look for four minutes. Derived from the energy/timbre novelty curve; imperfect, and that's fine — approximate section boundaries still beat none.
- **`stems.vocalSegments`** tells the director where to put text and where the frame is free. Placing a lyric layer is a different decision on an instrumental intro than over a chorus.

---

## 3. StyleVector — what kind of track this is

A small, interpretable set of normalised axes. Interpretable matters: when a result looks wrong,
you need to be able to read *why* it chose what it chose.

```
StyleVector {
  tempo          0..1   // from bpm, perceptual not linear (90→140 matters more than 160→200)
  energy         0..1   // loudness + transient density
  brightness     0..1   // spectral centroid, air content
  density        0..1   // busy vs sparse arrangement
  organic        0..1   // 0 = electronic/quantised, 1 = live/rubato
  vocalWeight    0..1   // instrumental → vocal-led
  dynamics       0..1   // compressed/flat → wide dynamic range
  darkness       0..1   // bass weight vs air, minor-ish timbre
}
```

Each axis is computed by an explicit, documented rule — no learned model, nothing opaque.
`organic` for example comes from beat-grid deviation and onset regularity: a quantised
electronic track sits near 0, a live band with a breathing tempo near 1.

**Percentile normalisation, not absolutes.** Axes are scaled against a reference distribution of
typical music, so "high energy" means high relative to music generally, not relative to this
track's own range. Normalising within the track would rate a quiet ambient piece's loudest
moment as maximum energy, and the director would then treat it like a festival banger.

---

## 4. Template format

The core authored artifact. Declarative, human-written, human-readable, version-controlled.

```
Template {
  id            "tpl.neon.pulse"
  name          "Neon Pulse"
  description   "Circular spectrum, heavy bloom, dark field. Synthwave/EDM."
  author, version, thumbnail, previewVideo?

  affinity {
    // Which tracks this suits. Soft scoring, not hard gates.
    prefer   { energy: [0.6,1.0], tempo: [0.5,1.0], organic: [0.0,0.4] }
    tolerate { vocalWeight: any, dynamics: [0.0,0.7] }
    avoid    { organic: [0.8,1.0] }     // hard-ish veto
    weight   1.0                         // global bias when scoring
  }

  aspects  ["16:9", "9:16", "1:1"]       // which it's designed for

  palette {
    strategy   "derive-from-image" | "generate-from-style" | "fixed" | "user"
    harmony    "analogous" | "complementary" | "triad" | "duotone"
    baseHue    { from: "brightness", range: [280, 330] }   // style-driven
    saturation { range: [0.7, 1.0] }
    background { lightness: [0.04, 0.12] }
    roles      { primary, secondary, accent, glow, text, textShadow }
    contract   { minTextContrast: 4.5 }   // enforced in step 6
  }

  slots [
    { role: "BACKDROP",  required: true,
      candidates: [ { module: "core.source.gradient", weight: 3 },
                    { module: "core.source.image", weight: 2, needs: "backgroundImage" },
                    { module: "core.scene3d.field", weight: 1, minStyle: { energy: 0.7 } } ] },

    { role: "HERO",      required: true,
      candidates: [ { module: "core.visualizer.circular", weight: 4 },
                    { module: "core.visualizer.rings",    weight: 2 },
                    { module: "core.visualizer.bars", weight: 2, params: { mode: "mirrored" } } ],
      params: { glow: 0.8, source: "mix" },
      transform: { anchor: "center", scale: 0.55 },
      aspectOverrides: { "9:16": { transform: { scale: 0.8, y: 0.38 } } } },

    { role: "ACCENT",    required: false, probability: 0.6,
      candidates: [ { module: "core.visualizer.particles", weight: 3,
                      params: { source: "drums", emitOn: "onset" } } ] },

    { role: "TEXT",      required: false, condition: "hasTitle",
      candidates: [ { module: "core.text.title", weight: 1 } ] },

    { role: "LYRICS",    required: false, condition: "hasLyrics" },
    { role: "LOGO",      required: false, condition: "hasLogo" },

    { role: "POST",      required: true,
      effects: [ { module: "core.fx.bloom",  params: { intensity: 0.6 } },
                 { module: "core.fx.vignette", params: { amount: 0.35 } },
                 { module: "core.fx.grain",  params: { amount: 0.06 }, probability: 0.5 } ] }
  ]

  modulations [
    { target: "HERO.params.scale",      source: { stem: "drums", feature: "onset" },
      mode: "add", intensity: "medium", response: "snappy" },
    { target: "HERO.params.glow",       source: { stem: "mix", band: "high" },
      mode: "add", intensity: "subtle", response: "smooth" },
    { target: "BACKDROP.params.hueShift", source: { stem: "bass", feature: "rms" },
      mode: "add", intensity: "subtle", response: "slow" },
    { target: "POST.bloom.intensity",   source: { feature: "energy" },
      mode: "multiply", intensity: "medium", response: "smooth" }
  ]

  arrangement {
    intro    { layers: ["BACKDROP","TEXT"], intensity: 0.3, textHold: "untilFirstVocal" }
    build    { intensity: 0.6 }
    chorus   { intensity: 1.0, addLayers: ["ACCENT"], paletteShift: "accent" }
    drop     { impulse: "flash", cameraKick: 0.4 }
    breakdown{ intensity: 0.4, removeLayers: ["ACCENT"] }
    outro    { intensity: 0.3, fadeOut: true }
  }

  variation {
    // What "Surprise me" is allowed to reroll, and how far.
    rerollable: ["slots.HERO.candidate", "slots.ACCENT.presence",
                 "palette.baseHue", "slots.POST.effects.probability"]
    locked:     ["arrangement", "modulations.response"]
    hueJitter:  30           // degrees
    intensityJitter: 0.15
  }

  budget { maxLayers: 7, maxGpuCost: "high", targetFps: 60 }
}
```

### Why slots and roles instead of concrete layers

A slot is an **abstract role** (`HERO`, `BACKDROP`, `ACCENT`) filled by a weighted choice among
candidate modules. Three benefits, all practical:

- **New modules join existing templates automatically** by declaring matching tags — the library grows without editing every template.
- **"Surprise me" has something meaningful to vary**: swapping the HERO module changes the look substantially while keeping the composition coherent, which is exactly the kind of variation that is fun rather than noisy.
- **Templates stay readable.** A template describes intent; the populator resolves it into layers.

---

## 5. Populate — where measurement meets intent

### 5.1 Slot resolution
1. Filter candidates by availability, aspect support, `minStyle` gates, and asset conditions (`needs: backgroundImage`).
2. Weighted selection using the seeded PRNG.
3. Apply the slot's base params, then the candidate's params, then aspect overrides.
4. Optional slots resolve against `probability` and `condition`.
5. Enforce `budget.maxLayers` and the summed `gpuCost` — drop the lowest-priority optional slots first, and record that in the decision log.

### 5.2 Modulation calibration — *the part that makes it feel right*

Templates declare **intent** (`intensity: "medium"`, `response: "snappy"`), never raw numbers.
The director converts intent to numbers using this track's measured statistics.

The core idea: map the **percentile distribution** of the chosen source onto the parameter's
useful range. Concretely, for a drum-onset source driving `scale`:

- Compute the source's p10 / p50 / p90 over the track.
- Map p10 → no visible effect, p90 → the intensity band's target deflection (subtle ≈ 8%, medium ≈ 25%, strong ≈ 60% of the parameter's soft range).
- Clamp the top so the loudest moment lands near, not beyond, the parameter's soft max.

This is why auto-directed projects don't need sensitivity tuning: a quiet, compressed track and
a loud, dynamic one both end up using the full visual range, because calibration is relative to
what the track actually does. It's also the single highest-leverage piece of this spec — a
correct template with wrong calibration looks broken, while a mediocre template with good
calibration still reads as intentional.

`response` maps to attack/release and smoothing: `snappy` ≈ 5 ms / 120 ms, `smooth` ≈ 40 ms /
400 ms, `slow` ≈ 200 ms / 1.5 s, with beat-quantised options where the template asks for them.

### 5.3 Palette derivation
- **`derive-from-image`** — extract a palette from the chosen background (dominant colours by saturation-weighted clustering), then enforce the harmony rule and role contrast.
- **`generate-from-style`** — base hue from style axes (darkness and brightness drive hue and lightness ranges), then harmony expansion.
- Roles assigned last, with **contrast enforcement**: `text` against its actual backdrop must meet `minTextContrast`. If it fails, adjust lightness until it passes — legibility outranks the palette's aesthetic intent, always.

### 5.4 Text & lyrics placement
- Title/artist text is placed where the composition leaves room, using the slot's anchors — and, when lyrics exist, scheduled to clear before the first vocal segment.
- If lyrics are present, the LYRICS slot takes placement priority over decorative layers and pushes the HERO layer's scale down to make room, rather than overlapping it.

---

## 6. Arrange — giving the video an arc

Using `structure.sections`, each section maps to an arrangement state, which is expressed as
**ordinary keyframes and layer time ranges** — not as a special runtime mode.

- **Intensity** is a single scalar per section driving a small set of parameters (post-effect strength, particle rates, glow, camera motion range). One knob, many parameters, so sections differ visibly but coherently.
- **Layer scheduling** — optional layers enter and leave on section boundaries, snapped to the beat grid.
- **Drops** get an impulse: a short, sharp keyframed spike (flash, scale kick, camera shake) placed exactly on the detected transient.
- **Palette shifts** at chorus/drop, interpolating between role assignments rather than cutting.
- **Anti-monotony rule**: if two consecutive sections resolve to near-identical states, force differentiation on at least one axis. Long tracks are where auto-generated video usually dies of boredom.
- **Anti-chaos rule**: cap the number of simultaneous changes at a boundary, and enforce a minimum time between scene changes (default ~8 s). Without this, a track with noisy section detection strobes.

Everything the arranger produces is a normal keyframe or time range, visible and editable in the
timeline. If it schedules something you dislike, you drag it.

---

## 7. Guardrails (step 6)

Validation before the project is handed over. These catch results that satisfy the rules and
still look wrong:

| Check | Action on failure |
|---|---|
| Text contrast below the template's minimum | Adjust text/shadow lightness until it passes |
| Lyrics overlapping the HERO visualizer's dense region | Shift lyrics anchor or reduce HERO scale |
| Summed `gpuCost` over budget for the target resolution | Drop lowest-priority optional layers, log it |
| More than `maxLayers` | Same |
| Two effects that conflict (e.g. two feedback trails stacked) | Keep the first, drop the second |
| Any layer fully occluded by an opaque layer above it | Remove it — it costs GPU and shows nothing |
| A modulation whose calibrated amount rounds to zero | Remove the binding; it's clutter in the matrix |
| Palette with less than a minimum perceptual distance between primary and background | Push lightness apart |
| Safe-area violation in 9:16 | Apply the aspect override, or nudge the anchor |

---

## 8. Determinism, seeds and the decision log

- Every random choice draws from `hash(seed, decisionPath)` — the same seed and the same track always produce the same project, on any machine.
- **The DecisionLog is saved with the project**, recording each decision: what was chosen, from which candidates, why (the matching score, the measured statistic), and which guardrail fired. It surfaces in the Auto panel as plain language — *"Chose Circular for HERO (weight 4 of 3 candidates). Drum onset → scale calibrated to p90 = 0.23. Dropped Particles: over GPU budget at 4K."*

That log is what makes the feature teachable rather than magic. When a result is wrong, you can
see which step went wrong and fix that step — rather than rerolling and hoping.

---

## 9. Surprise me

Reroll semantics, designed so variation stays coherent:

- **Rerolls the seed**, then re-runs steps 3–6. Only axes listed in `variation.rerollable` change; `variation.locked` axes never do.
- **Per-aspect locks in the UI**: keep palette / keep layout / keep template / keep modulations. Locked aspects are reused verbatim, so you can converge on a result instead of gambling repeatedly.
- **Template roulette toggle**: either reroll within the current template (small variation) or allow a different template from the top-N matches (large variation).
- **Diversity enforcement**: a reroll that resolves to a result too similar to the previous one is rejected and redrawn (bounded retries). Nothing kills the feature faster than pressing the button and seeing the same thing.
- **History strip** of the last ~10 rolls with thumbnails, each restorable. Rolls are cheap to store — they're just a seed plus the template id plus the locks.
- Rerolling **never touches manual edits** to layers the user has modified, unless they explicitly reset them. Losing your own work to a button labelled "surprise me" would be unforgivable.

---

## 10. Template authoring workflow

Templates are the product here, so authoring them must be pleasant:

1. **Build a project by hand** until it looks good on a reference track.
2. **"Extract as template"** — converts the project into a template draft: layers become slots, concrete numbers become intent (`intensity` bands inferred by comparing values against that track's statistics), the palette becomes a strategy, keyframes become arrangement states.
3. **Edit the draft** — add alternative candidates, widen affinity, mark reroll axes, set budgets.
4. **Validate against a test corpus** — run the template across a folder of varied tracks and render a contact sheet of stills at fixed timestamps. This is the only reliable way to see whether a template generalises or was secretly tuned to one song.
5. **Ship it** to `templates/`, scanned like modules.

Step 2 matters more than it looks: hand-authoring a template from scratch in this format is
tedious, and a tedious authoring path means few templates, and few templates means mush.

---

## 11. Initial template set

Matching the three stated aesthetics (PROJECT.md §1), plus deliberate coverage of tempo/energy
extremes so the matcher has somewhere to go for any track:

| Template | Look | Affinity | Notes |
|---|---|---|---|
| **Neon Pulse** | Circular spectrum, heavy bloom, dark field, magenta/cyan | high energy, electronic, fast | The Shimga reference look. Flagship. |
| **Neon Grid** | Perspective grid, horizon sun, scrolling terrain | mid-high energy, synthwave | Same family, different composition. |
| **Minimal Type** | Large typography, thin waveform, off-white/ink, generous space | any energy, low density, vocal-led | Type is the design — leans on M32. |
| **Minimal Mono** | Single circular waveform, monochrome, no effects | low energy, sparse, acoustic | The restraint option; works for ambient/piano. |
| **Cinematic Depth** | Three.js geometry, DOF, slow camera, volumetric light | mid energy, wide dynamics | Leans on M37. Expensive — budget-aware. |
| **Cinematic Particles** | Point cloud reacting to stems, drifting camera | any energy, dense | The "looks expensive" default. |
| **Lyric Focus** | Lyrics as the hero, minimal visualizer, beat-driven type | high vocal coverage, lyrics present | Auto-selected when lyrics exist. |

Seven is enough to prove the system and cover the stated taste. More is better, but only if each
one is genuinely good — that's the whole thesis.

---

## 12. How to tell if it's working

Worth defining now, because "does the auto-director look good?" is otherwise unanswerable:

- **Keep-rate**: across a test corpus, what fraction of first results would you actually use, with at most minor edits? Target ≥ 50% at v1.
- **Roll depth**: how many "Surprise me" presses before you find a keeper? Target ≤ 3.
- **Edit distance**: how many parameters does a user change before exporting? Rising over time means calibration is drifting wrong.
- **Failure visibility**: every rejected or dropped decision appears in the decision log. A silent failure is worse than a visible bad choice.

Contact sheets from step 10.4 are the practical instrument: twenty tracks, one still each, look
at the sheet. Problems are obvious at a glance in a grid, and invisible one track at a time.

---

## 13. Open questions — resolved

Settled in [decisions.md](decisions.md):
- **Percentile reference distribution**: hand-tuned shipped constants; a personal corpus would make output depend on machine history (D27).
- **Section detection**: energy-novelty in v1; `librosa`/`madmom` refinement promoted to Should (D28 → S16).
- **Template needs a missing module**: substitute by tag; if none, the template is unavailable with a stated reason (D29).
- **Lyrics styling**: the director sets placement and palette roles only (D30).
- **Background image pool**: starter pack plus a user folder (D31).
- **Arrangement granularity**: section-level, with the anti-monotony and anti-chaos rules of §6 (D32).

---

## 14. Dependencies on other specs

- **[module-spec.md](module-spec.md)** — slots resolve to modules by id and tag; the director sets values through the same parameter paths a human uses. Nothing here needs a special integration, which is precisely why that spec came first.
- **PROJECT.md §8.11** — aspect overrides in templates rely on the layout system.
- **PROJECT.md §8.1** — TrackDigest is a summarisation layer over the AnalysisCache; stems are load-bearing throughout (`stems.vocalSegments` drives text placement, drum onsets drive most impulse modulations).
- **PROJECT.md M33/M34** — decision logs and contact-sheet runs produce artifacts that need the cache and diagnostics systems.
