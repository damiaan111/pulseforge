# Keyframe Automation — specification (S1)

> Companion to [module-spec.md](module-spec.md) §3.1 (`animatable`), §4 (paths) and §5 (the value
> pipeline), [ui-spec.md](ui-spec.md) §3–§4 and [data-formats-spec.md](data-formats-spec.md).
> Status: written 2026-09-25 at the start of P8, as ROADMAP §3 asked ("needs a short spec first").
> The choices marked **(proposed)** are the ones module-spec left open; they are listed in ROADMAP §4
> for the owner to confirm.

---

## 0. What it is for

Changes the music does not cause. A title that slides in, a camera that pushes in over a verse, a
colour that shifts for the last chorus, a logo that fades out. Modulation answers "move with the
sound"; keyframes answer "be *this* at *that* moment". Both exist on the same parameter at once:
the keyframes set where the value sits, and the modulation moves it around that.

---

## 1. Where it sits in the value pipeline (module-spec §5, unchanged)

```
1. base            ← stored in the project
2. aspect override ← if one exists for the active aspect, REPLACES base
3. automation      ← the keyframe track at time t, if any, REPLACES the result of 1–2
4. modulation      ← applied in binding order
5. clamp           6. type coercion
```

A keyframed parameter's stored base and aspect overrides are kept, not deleted. They come back if
the track is disabled or removed. Keyframes are **not per aspect** (proposed): one track per target
applies to every aspect. Per-aspect animation is rare, and doubling the timeline for it is not worth
the confusion D44 warns about.

---

## 2. Targets

Anything with a path (module-spec §4), with the same addressing as modulation:

| Path | What |
|---|---|
| `layers.<id>.params.<key>` | a module parameter declared `animatable` (the default for every type) |
| `layers.<id>.effects.<eid>.params.<key>` | an effect parameter on a layer's chain |
| `global.effects.<eid>.params.<key>` | an effect parameter on the whole frame |
| `layers.<id>.opacity` | the layer's opacity |
| `layers.<id>.transform.<x \| y \| scaleX \| scaleY \| rotationDeg>` | the layer's placement (proposed; the most common thing to animate) |

A track whose target no longer exists is **kept and reported** (CLAUDE.md #4), like a binding.

---

## 3. The model

```
Document.automation: AutomationTrack[]      // the slot reserved since v1 (data-formats §2.2)

AutomationTrack {
  id        // opaque, never reused
  target    // a path from §2
  enabled   // off: the base value shows again; the keys are kept
  keyframes: Keyframe[]   // sorted by ticks; at most one per tick
  extra
}

Keyframe {
  id
  ticks     // TIMELINE ticks (1/48000 s, integers), like lyric times — trimming the audio does not
            // move them
  value     // number | boolean | string (enum, colour "#rrggbb" or a palette link "@role", asset id)
  easing    // how the value travels from THIS key to the next (the outgoing segment)
  extra
}

easing: "linear" | "hold" | "easeIn" | "easeOut" | "easeInOut"
      | { cubic: [x1, y1, x2, y2] }        // x in [0, 1], y in [-1, 2] (overshoot allowed)
```

The easing belongs to the key it leaves from, as in every animation tool people already know. The
named easings are cubic Béziers: easeIn (0.42, 0, 1, 1), easeOut (0, 0, 0.58, 1) and easeInOut
(0.42, 0, 0.58, 1). **linear** is a straight line; **hold** keeps the value until the next key.

---

## 4. Evaluation (deterministic, from t alone)

- Before the first key: the first key's value. After the last: the last key's value.
- Between key *a* and key *b*: `u = (t − a.t) / (b.t − a.t)`, eased by *a*'s easing into `e`, then
  interpolated **by type**:

| Type | Between keys |
|---|---|
| float | `a + (b − a) · e` |
| int | as float, rounded at step 6 |
| color | in **linear light** (proposed), per channel, then back to sRGB. The engine composites in linear light, so a fade through the middle does not dip dark. Palette links resolve before interpolating |
| bool, enum, string, asset, stem | hold: *a*'s value until *b* |

- The cubic Bézier is solved for `x = u` by bisection to 1e-7 in a fixed number of steps. No
  iteration count depends on the data, so preview and export agree to the bit.
- An empty track, or a disabled one, does nothing. A track with one key is that constant value.

---

## 5. Editing (ui-spec §3–§4)

**Inspector.**
- Every animatable control has a **keyframe diamond** ◆:
  - hollow: not animated;
  - half: animated, no key at the playhead;
  - solid: a key at the playhead.
- Clicking it adds a key at the playhead with the current value, or removes the key that is there.
- Beside it, ◀ ▶ jump the playhead to the previous or next key.
- **Auto-key:** once a parameter is animated, changing it sets a key at the playhead (new or
  updated) rather than the base. Without a track, a change edits the base as before.
- A **Keyframes** section lists the selected layer's tracks. A selected key shows its time, value,
  easing preset, and a small **curve editor** with the two Bézier handles.

**Timeline.**
- An **automation lane** under each animated layer, one row per track.
- Keys are diamonds. Drag to move them: they snap to beats and the playhead, not with Shift.
- Delete removes the selected keys. Alt-drag copies.
- Key times are timeline ticks, so moving a layer's time range does not move its keys (proposed:
  simple and predictable; "move the keys with the layer" is a modifier on the layer drag, later).

Every key edit is an undoable command; a drag is one undo step.

---

## 6. Presets, duplication and the auto-director

- **Duplicate layer**: its tracks are copied with the new ids.
- **Delete layer**: its tracks go with it (they are part of the layer the user deleted), in the
  same undo step.
- **Presets**: keyframes are timeline-specific, so presets do not carry them (proposed).
- **The auto-director** keeps writing arrangement as `curve` modulation (ROADMAP §4). Converting it
  to keyframes is a follow-up, not part of S1.

---

## 7. What this does not cover

Per-aspect keyframes, keyframing modulation bindings' own settings, expressions, and motion paths
drawn on the canvas. Each would be its own request.
