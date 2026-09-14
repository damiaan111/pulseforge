# Modulation System — detailed specification

> Companion to [PROJECT.md](../PROJECT.md) §8.5, [module-spec.md](module-spec.md) §5,
> and [auto-director-spec.md](auto-director-spec.md) §5.2.
> Design spec, not implementation. Status: draft for review. Last updated: 2026-09-14.

---

## 0. What this system is for

Every visualizer ever made can draw bars that move. The difference between "audio-reactive" and
*good* audio-reactive is almost entirely in this layer: **which feature drives which parameter,
how the signal is shaped, and how it feels in time.**

Three failure modes to design against, all of them common in tools like this:

1. **The pulse problem.** Everything is driven by overall loudness, so the whole frame breathes in unison and reads as one dumb throb. The fix is stems and bands — different elements reacting to different instruments.
2. **The mush problem.** Over-smoothed signals that lag the music, so nothing lands on the beat and the video feels slightly drunk. The fix is proper envelopes plus **look-ahead**, which an offline renderer can do and a live one cannot (§6.3).
3. **The spaghetti problem.** Twenty bindings, no way to see what is driving what, one parameter quietly fighting itself. The fix is the matrix panel, explicit ordering, and per-binding solo (§9).

The system also has a hard constraint the UI must never violate: **it has to stay deterministic.**
Naïve smoothing is stateful, and stateful smoothing breaks seeking. §5 is the answer to that, and
it's the most important section here.

---

## 1. The binding

```
ModulationBinding {
  id            stable, opaque
  enabled       bool
  bypass        bool          // temporary, not saved with presets
  solo          bool          // UI state: hear/see this one alone
  label         string?       // optional user name, e.g. "kick pump"

  source        SourceSpec        // §2
  target        "layers.<id>.params.<key>"   // module-spec §4 addressing

  // --- signal shaping, applied in the order of §4 ---
  inputRange    { min, max } | "auto"    // auto = percentile calibration (§7)
  curve         CurveSpec               // §4.2
  envelope      { attack, release, mode }  // §5
  quantise      QuantiseSpec?           // §6.2
  lookAhead     ms                      // §6.3, may be negative or positive

  amount        number        // signed; bipolar allowed
  offset        number
  invert        bool
  mode          "add" | "multiply" | "replace"
  order         int           // explicit evaluation order among bindings on one target
  clampOutput   { min, max }? // optional per-binding clamp, before accumulation
}
```

Stored on the layer that owns the target (PROJECT.md §6), so copying a layer copies its
modulations, and a layer preset carries its reactivity with it — which is what makes presets
feel alive rather than static.

---

## 2. Source catalogue

### 2.1 Audio sources
Every audio source takes a `stem` selector — `mix | drums | bass | vocals | other` (plus
`guitar | piano` with the 6-stem model). This is the single biggest quality multiplier in the
system and the antidote to the pulse problem.

| Source | Value | Character | Typical use |
|---|---|---|---|
| `band` | 0..1 | Energy in a frequency range (named band or custom Hz) | The workhorse. Bass→scale, highs→glow |
| `rms` | 0..1 | Smooth loudness | Overall intensity, slow drift |
| `peak` | 0..1 | Fast loudness | Sharper than RMS, still continuous |
| `onset` | 0..1 impulse | Transient detection, decays | Hits, bursts, kicks — the punchiest source |
| `beat` | 0..1 pulse | From the beat grid, not the audio | Perfectly regular, immune to detection noise |
| `centroid` | 0..1 | Spectral brightness | Hue shifts, "openness" |
| `flux` | 0..1 | Rate of spectral change | Texture, busyness, glitch amount |
| `stereoWidth` | 0..1 | Stereo spread | Width of visual elements — a subtle, underused one |
| `pitch` | 0..1 | Dominant pitch of a stem (Could-have) | Melodic colour mapping |

**`onset` vs `beat` is a choice worth understanding**, and the UI should explain it: `onset`
follows what actually happened (including ghost notes, fills, syncopation) and can misfire;
`beat` follows the grid (machine-perfect, but ignores that the drummer dropped out for a bar).
Onset for feel, beat for reliability. Most good results use both on different parameters.

### 2.2 Generators
| Source | Params | Notes |
|---|---|---|
| `lfo` | shape (sine/tri/saw/square/noise/S&H), rate, phase, `sync` | Rate in Hz **or** musical division (1/4, 1/2, 1, 2, 4 bars) locked to the beat grid |
| `ramp` | start, end, over (track/section/bar) | Linear progress — intros, slow reveals |
| `random` | per (beat/bar/section), smooth | Seeded; see §8 |
| `noise` | scale, octaves, seed | Smooth 1D value noise — organic drift |

### 2.3 Structural sources
| Source | Value | Use |
|---|---|---|
| `progress` | 0..1 over the track | Slow global evolution |
| `sectionIndex` / `sectionProgress` | discrete / 0..1 | Per-section behaviour |
| `energyEnvelope` | 0..1 | The TrackDigest energy curve — the arc of the song |
| `isDrop` / `isBuild` | impulse / 0..1 | Structural accents |

### 2.4 Lyric sources
| Source | Value | Use |
|---|---|---|
| `lyricActive` | 0/1 | Something is being sung right now |
| `lineProgress` | 0..1 | Progress through the current line |
| `wordActive` | impulse | Fires on each word — karaoke-synced accents |

These make the whole frame respond to the vocal line, not just the lyrics layer: dimming the
visualizer while words are on screen is a cheap, very effective legibility trick.

### 2.5 Chaining
`parameter` — the **resolved** value of another parameter. Enables one gesture driving several
things with variation. Cycles are detected at bind time and rejected with an explanation; the
evaluation order is a topological sort of the dependency graph (§9.3).

### 2.6 External (deferred — PROJECT.md C3/C4)
MIDI CC / note input, MIDI file import. Mentioned here only so the source interface is designed
to accommodate a sampled-over-time track rather than assuming audio analysis.

---

## 3. What a source actually returns

Every source resolves to `(t) → number`, and **every source must be a pure function of `t`**.
No exceptions, because the whole rendering contract depends on it.

Sources come from three places:
- **Precomputed tracks** in the AnalysisCache (bands, rms, onsets, centroid…) sampled at the analysis rate (240 Hz) with linear interpolation on read.
- **Closed-form functions** (`lfo`, `ramp`, `progress`) evaluated directly from `t`.
- **Derived tracks** computed once and cached when a binding is created or edited — envelopes, quantised signals, percentile statistics (§5, §7).

The third category is what makes the design work, and it's covered next.

---

## 4. The per-binding signal chain

Applied in exactly this order. Every stage is optional but the order is fixed, because a
different order means different results and the inspector, engine and export must agree.

```
1. sample      source(t + lookAhead)        → raw
2. normalise   map inputRange → 0..1        → n      (clamped, or soft-knee)
3. curve       apply shape                  → c
4. envelope    attack/release smoothing     → e      (precomputed, §5)
5. quantise    snap to musical grid         → q      (§6.2)
6. invert      1 - q, if set                → i
7. scale       i * amount + offset          → v
8. clampOutput optional per-binding clamp   → out
```

Then the target's accumulator combines `out` with the running value according to `mode` (§9).

### 4.1 Normalisation
`inputRange` maps a raw feature to 0..1. Defaults matter here — most sources are already 0..1
nominally but occupy only a fraction of that range in real music. `"auto"` triggers percentile
calibration (§7), which is what makes a binding feel right without hand-tuning.

### 4.2 Curves
A curve reshapes 0..1 → 0..1. Presets plus a free editor:

| Curve | Effect | Use |
|---|---|---|
| `linear` | none | Default |
| `exp` / `pow(k)` | emphasise the top | Only the loudest hits register |
| `log` | emphasise the bottom | Quiet detail becomes visible |
| `s-curve` | soft ends, steep middle | Punchier without clipping |
| `threshold(t, soft)` | gate | Fires only above a level — near-binary triggers |
| `stepped(n)` | quantise value | Chunky, digital-looking motion |
| custom | control points | Anything else |

`threshold` deserves highlighting: it turns a continuous source into a trigger, which is how you
get an element that appears only on the loudest hits rather than wobbling constantly.

---

## 5. Envelopes — and the determinism trap

**The trap:** the obvious way to smooth a signal is a one-pole IIR filter updated per frame —
`y += (x - y) * k`. It's stateful. Its output depends on every frame that came before, which
means the value at `t=90s` differs depending on whether you played from the start or seeked
there. That silently breaks the determinism contract, and it breaks it in the most expensive
possible way: the preview and the export disagree, and only on some frames.

**The solution: envelopes are precomputed, not accumulated.**

- When a binding is created or its envelope parameters change, the engine computes the smoothed signal **once, across the whole track**, at the analysis rate, and caches it as a derived track keyed by `(source, attack, release, mode)`.
- At render time, an envelope lookup is a sample-and-interpolate — a pure function of `t`, identical whether reached by playback or by seeking.
- The cost is a one-off pass over a few hundred thousand samples: milliseconds. The benefit is that the hardest determinism problem in the system disappears rather than being managed.
- Derived tracks are shared: ten bindings using `drums.onset` with the same envelope settings share one cached track.

**Envelope semantics:**
- `attack` — time to rise toward a higher value (ms). Short = punchy, long = swelling.
- `release` — time to fall (ms). The parameter that most determines "feel". Too short: flicker. Too long: mush.
- `mode: peak` (envelope follower, never falls faster than release — the musical default) or `mode: linear` (symmetric smoothing).

Sensible defaults, exposed as named presets because raw milliseconds mean nothing to most people:
`snappy` 5/120 ms · `punchy` 2/250 ms · `smooth` 40/400 ms · `slow` 200/1500 ms · `glacial` 1000/4000 ms.

---

## 6. Musical time

### 6.1 The beat grid
`beat`, quantisation, and synced LFOs all reference the grid from the AnalysisCache, including
tempo drift (a grid of beat times, not a single BPM). Manual tap-tempo and a phase offset
correct it, and everything downstream follows automatically — a detail that matters enormously
for live-played music, where a fixed BPM slowly drifts out of phase with the track.

### 6.2 Quantisation
`quantise` snaps a signal's *timing* to musical divisions:
- `division` — 1/16 … 4 bars
- `mode: trigger` (fire only on grid positions) or `hold` (hold the value until the next division)
- `swing` — offset alternate subdivisions, for shuffled material
- `humanise` — a small seeded random offset, so machine-perfect timing can be softened deliberately

This is how you get changes that land musically rather than whenever the audio happened to peak
— particularly good on colour/scene changes, which look accidental when they land off-grid.

### 6.3 Look-ahead — the offline advantage
Because the entire track is analysed before rendering, a binding can sample the source at
`t + lookAhead` with a **negative** value, i.e. *before* the event.

This solves a real problem: onset detection and envelope attack both introduce a few tens of
milliseconds of lag, so "reacting" visuals always land slightly late — perceptible as sloppiness
even when nobody can say why. A small negative look-ahead (−20 to −60 ms) makes hits land
exactly on the beat. Larger values let elements *anticipate* — a glow that swells just before the
drop, which is otherwise impossible to build by reacting.

A live VJ tool cannot do this at all. It's worth surfacing prominently in the UI as "Timing",
with a default that already compensates for detection lag.

---

## 7. Auto-calibration

`inputRange: "auto"` computes the source's percentile distribution across the track and maps
**p10 → 0** and **p90 → 1** (configurable percentiles), rather than using the theoretical range.

Why this matters: a compressed master's `bass.band` might only ever occupy 0.55–0.85 of its
nominal range. Mapped linearly, the modulation barely moves; auto-calibrated, it uses the full
visual range. This is the same mechanism the auto-director uses (auto-director-spec §5.2) —
shared code, one behaviour.

- Recalibration triggers on: source change, stem change, audio change, or an explicit "recalibrate" action.
- The UI shows the computed range and allows overriding it manually — auto as the default, not a cage.
- A "calibrate to selection" action uses only the time range currently selected on the timeline, for when one section should define the norm.

---

## 8. Randomness & determinism

- Every random source derives from `hash(projectSeed, bindingId, eventIndex)` — where `eventIndex` is the beat/bar/section number, not a counter. Seeking to bar 64 gives the value bar 64 always had.
- `noise` is closed-form value noise over `t`, seeded identically.
- Re-rolling a random source is an explicit action that changes the binding's sub-seed, so results are stable until deliberately changed.
- **Nothing in this system reads wall-clock time or frame counters.** Ever.

---

## 9. Accumulation — multiple bindings on one parameter

### 9.1 Modes
Starting from the base value (module-spec §5 steps 1–3):
- `add` — `acc += out`
- `multiply` — `acc *= (1 + out)`, so 0 means no change (a plain multiply by a source that reaches 0 would collapse the parameter to nothing, which is almost never wanted)
- `replace` — `acc = out`, discarding everything before it in the order

### 9.2 Ordering
Bindings apply in explicit `order`, shown and reorderable in the matrix panel. Order is visible
because `add`-then-`multiply` and `multiply`-then-`add` genuinely differ, and a user chasing that
difference without being able to see the order would have a miserable time.

### 9.3 Chained parameters
Bindings whose source is another parameter create a dependency graph, topologically sorted per
frame. Cycles are rejected at bind time with a message naming the cycle.

### 9.4 Clamping
Only the final accumulated value is clamped to the parameter's hard range (module-spec §5 step 5).
Per-binding `clampOutput` is available for the occasional case where one contribution must be
bounded independently.

### 9.5 Solo & bypass
Solo isolates one binding on a target; bypass disables it temporarily. Both are UI state and are
**not** saved into presets — a preset shipping with half its modulations bypassed would be a
confusing gift.

---

## 10. UI

The system is only as good as its legibility. Concretely:

- **Right-click any modulatable slider → "Add modulation"**, with a shortlist of likely sources for that parameter type (a scale parameter offers drum onset first; a hue parameter offers centroid).
- **Live overlay on the slider**: base value as the handle, resolved value as a moving ring/bar, with the modulated range shown as a faint band. At a glance: where it sits, where it's going, how far it can travel.
- **Binding editor** (popover): source picker with a live scrolling preview of the source signal, curve editor, envelope presets plus raw values, timing/look-ahead, amount with bipolar slider, mode, and a live before/after readout.
- **Matrix panel**: every binding in the project, grouped by target or by source, with enable/solo/bypass, order, amount, and a sparkline of each source. This is the view that prevents spaghetti.
- **Source monitor**: a small scope showing the selected source over the last few seconds, so "is this stem actually doing anything here?" is answerable without guessing.
- **Copy/paste bindings** between parameters and layers, with paths rebound on paste.
- **Recipes**: one-click presets that create a fully configured binding (§11), because most uses are one of a dozen known gestures.
- **Dead-binding warnings**: if a binding's calibrated contribution is imperceptible (under ~1% of the parameter's range), flag it. Invisible modulations are a common source of "why isn't this working".

---

## 11. Recipe cookbook

Shipped as one-click presets. They double as documentation of what good settings look like:

| Recipe | Source | Chain | Target |
|---|---|---|---|
| **Kick pump** | `drums.onset` | threshold 0.3, snappy env, −30 ms | scale, `add`, +0.15 |
| **Bass glow** | `bass.band`, auto | s-curve, smooth env | glow, `add`, medium |
| **Vocal bloom** | `vocals.rms`, auto | exp curve, smooth env | bloom intensity, `multiply` |
| **Hat sparkle** | `drums.band` (8–16 kHz) | threshold, punchy env | particle emit rate |
| **Hue drift** | `mix.centroid`, auto | linear, slow env | hue shift, `add`, ±20° |
| **Build riser** | `isBuild` | linear | blur + scale, `add` |
| **Drop flash** | `isDrop` | impulse, snappy | exposure, `add`, short |
| **Beat strobe** | `beat` 1/4 | square, no env, quantised | opacity, `multiply` |
| **Lyric dim** | `lyricActive` | 200 ms env | visualizer opacity, `multiply`, −0.4 |
| **Breathing** | `lfo` sine, 2 bars | — | scale, `add`, ±0.03 |

The last one is a reminder that not everything should be audio-driven. A slow LFO under an
otherwise reactive composition is what stops static moments feeling dead — and a frame where
*everything* reacts to audio is exhausting to watch.

---

## 12. Performance

- Source tracks and derived envelope tracks are precomputed; per-frame cost per binding is an interpolated lookup plus a handful of arithmetic ops. Hundreds of bindings are affordable.
- Derived tracks are deduplicated by `(source, envelope, quantise)` and reference-counted.
- Memory: one derived track at 240 Hz for a 5-minute song is ~72 k floats (~288 KB). Cap the cache and evict least-recently-used; they're cheap to recompute.
- Evaluation happens once per frame per target, before any GPU work, in the engine's pure layer — so it's identical in preview and export, and testable on the dev laptop without a GPU.

---

## 13. Serialisation & presets

- Bindings serialise with their layer. In layer presets, target paths are relative to the preset root and rebound on apply.
- A binding whose source references a stem that hasn't been separated yet is preserved and marked pending, not dropped — stems may still be processing (PROJECT.md M5).
- Missing targets after a module version change follow module-spec §9: reported, never silently removed.

---

## 14. Open questions

1. **Should `multiply` mode be `acc *= (1 + out)` or plain `acc *= out`?** §9.1 argues for the former, but it makes "multiply by 0.5 to halve it" impossible without a negative amount. Possibly both, as an explicit sub-mode.
2. **Per-binding vs per-target envelopes.** Sharing one envelope across several bindings from the same source is cheaper and often what's wanted, but it's a second concept in the UI.
3. **Should look-ahead default to a nonzero lag compensation?** It's the right answer for feel, but "the visuals fire before the audio" is surprising if you don't know it's happening. Default on with a visible control, probably.
4. **How much does `pitch` as a source buy?** It's a real implementation cost (monophonic pitch tracking per stem) for a use case — melodic colour mapping — that may be niche.
5. **Modulating discrete parameters** (enums, booleans, ints) — allow with thresholds, or restrict modulation to continuous types? Allowing it enables "switch blend mode on the drop", which is fun and also an easy way to make something look broken.
6. **Does the matrix panel need a graph view** (sources on the left, targets on the right, curves between), or is a grouped list enough? The graph looks impressive in screenshots; the list is usually faster to work in.

---

## 15. Dependencies

- **[module-spec.md](module-spec.md) §5** — this system is step 4 of the value resolution pipeline. `modulatable`, ranges and soft ranges all come from the parameter schema.
- **PROJECT.md §8.1** — all audio sources are AnalysisCache reads; stems are load-bearing throughout.
- **PROJECT.md §8.10** — sources are sampled in timeline time, mapped through the audio offset.
- **[auto-director-spec.md](auto-director-spec.md) §5.2** — the director emits ordinary bindings, using the same auto-calibration described in §7. Nothing it produces is special.
