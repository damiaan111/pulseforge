# Compositor, Layers & 3D Integration — detailed specification

> Closes audit gaps on **M7** (WebGL2 compositor), **M37** (Three.js layers), **M14** (video
> background), **M17** (palette system) and **S7** (masking).
> Companion to [module-spec.md](module-spec.md) §7–8 and [export-spec.md](export-spec.md).
> Design spec, not implementation. Status: draft for review. Last updated: 2026-09-14.

---

## 0. What the compositor is

The thing that turns a stack of layers into one frame. Everything else — modules, modulation,
the auto-director — produces inputs to this. It is also where the two mistakes that quietly
ruin image quality live: **compositing in the wrong colour space**, and **getting alpha
premultiplication backwards**. Both are cheap to get right up front and miserable to retrofit,
because fixing them later changes the appearance of every existing project.

---

## 1. Frame construction

```
for each layer, bottom → top:
    1. acquire a render target from the pool (sized to layer bounds + effect padding)
    2. module renders into it            (module-spec §7)
    3. effect chain runs, ping-ponging targets   (module-spec §8)
    4. mask applied, if any              (§5)
    5. transform + opacity + blend into the composite target   (§3)
    6. release targets back to the pool
→ global effect chain over the composite
→ colour transform to output space       (§2)
→ present (preview) or read back (export)
```

**All intermediate targets are `RGBA16F`.** Half-float is not a luxury here: bloom, feedback and
additive blending routinely exceed 1.0, and 8-bit intermediates clip those highlights to flat
white and band the dark gradients the neon look depends on. 16F at 4K is 66 MB per target, which
the 12 GB card absorbs comfortably (PROJECT.md §4).

Rendering *into* `RGBA16F` is not core WebGL2: it requires **`EXT_color_buffer_float`**. That is a
Khronos-ratified extension supported by every current desktop driver, not a vendor extension — but
it is required, so the engine checks for it at context creation and fails with a specific message
rather than falling back to 8-bit and quietly changing every project's look.

---

## 2. Colour pipeline

```
module output (linear, premultiplied)
   → effects (linear)
   → blend (linear)
   → global effects (linear)
   → tone/gamut handling          (hue-preserving highlight shoulder — D48)
   → OETF encode (sRGB, for preview and export — D49)
   → 8/10-bit quantise + optional dither
```

- **Everything composites in linear light.** Blending, blur, bloom and gradients are all physically wrong in sRGB space — the classic symptom is glows that look grey and muddy instead of bright, and gradients with a dark band through the middle.
- Textures from images and video are **decoded to linear on upload** (sRGB texture formats, or an explicit conversion), never used raw.
- Colour parameters are authored in sRGB (that's what a colour picker means) and converted to linear at use.
- **Dither before quantising** to 8-bit. Smooth dark gradients over a large canvas band visibly without it, and this project's default look is exactly that.
- The final encode differs by destination (export-spec §6); the compositor itself is destination-agnostic.

---

## 3. Alpha and blending

- **Premultiplied alpha throughout.** Straight alpha breaks under filtering and blending — bilinear sampling of a straight-alpha texture bleeds colour from fully transparent texels, giving dark or bright fringes on every scaled or blurred edge.
- Modules declare their output convention; the compositor premultiplies on ingest if needed, once.
- Blend modes, in premultiplied form: `normal`, `add`, `screen`, `multiply`, `overlay`, `soft-light`, `hard-light`, `color-dodge`, `color-burn`, `darken`, `lighten`, `difference`, `exclusion`, `hue`, `saturation`, `color`, `luminosity`.
- `add` and `screen` are the workhorses for glow-heavy looks and are the reason 16F matters.
- Separable blend modes run in one pass; the non-separable HSL family needs the backdrop, so it reads the composite target (which must not also be the write target — ping-pong).

---

## 4. Render target pool

- Targets are pooled by `(width, height, format, samples)` and recycled; never allocated per frame (module-spec §7 rule 6).
- **Effect padding**: effects declaring `expandsBounds` (blur, glow) get a padded target so the halo isn't clipped at the layer's edge — a visible and commonly-shipped bug in lesser tools.
- Pool size is capped by a VRAM budget; exceeding it fails loudly with a specific message rather than degrading silently (export-spec §14).
- The pool reports high-water usage into the render report (PROJECT.md M34).

---

## 5. Masking (S7)

- Any layer can act as a mask for another: `mask: { sourceLayerId, channel: alpha|luma, invert, feather }`.
- The mask layer renders normally (including its own effects), then modulates the target's alpha.
- Mask layers are excluded from the visible composite unless also explicitly enabled — otherwise using a shape as a mask would also draw the shape, which is never what's wanted.
- Cycles (A masks B masks A) are rejected at bind time.
- Optional `maskMode: alpha | luma | stencil-in | stencil-out` for the common cases.

## 6. Layer groups

**Confirmed for v1 (D3 → M38).** Apply one glow to three layers together, animate a group as a
unit. Groups make the parameter addressing scheme hierarchical, which is exactly why deciding
this now mattered: retrofitting nesting into paths later would have touched presets, modulation
and the auto-director simultaneously.

- A group renders its children into its own target, then applies the group's transform, opacity, blend and effects to that result.
- Transforms compose parent → child. Modulation paths nest (`layers.<groupId>.children.<id>.params.x`).
- A group with a single child and no effects is collapsed at render time — free abstraction, no cost.

---

## 7. 3D scene layers (M37)

The gap this section closes: how a Three.js scene participates in a 2D compositor without
breaking determinism or the effect chain.

### 7.1 Integration model
- **One shared WebGL2 context.** Three.js is constructed over the engine's existing context rather than creating its own — two contexts would mean copying textures between them every frame.
- A `scene3d` module renders into a pooled `RGBA16F` target with its own depth buffer, and hands back a texture. From the compositor's perspective it is an ordinary layer: transform, opacity, blend, effects, masking all apply unchanged.
- **State hygiene is mandatory.** Three.js mutates global GL state (blend, depth, cull, bound framebuffers, vertex arrays). The wrapper saves and restores state around every 3D render, or the next 2D layer draws with whatever state Three left behind — a bug class that presents as random, layer-order-dependent corruption and is genuinely nasty to diagnose. `renderer.resetState()` after each scene render, plus explicit re-binding on the 2D side.

### 7.2 Determinism
Three.js is perfectly capable of determinism, but its conveniences are not:
- **No `clock.getDelta()`, no `requestAnimationFrame` timing.** Scene time comes from the engine's `t`.
- Animation mixers, if used, are driven by setting absolute time, never by advancing a delta.
- Physics-like behaviour (springs, damping) must be either closed-form or fixed-timestep with checkpoints (module-spec §7 rule 3).
- Scene graph randomness — instance positions, particle seeds — uses the engine's seeded PRNG, not `Math.random()`.
- Three's own post-processing (`EffectComposer`) is **not used**; post goes through the engine's effect chain so preview and export share one path and effects compose with 2D layers.

### 7.3 Camera & reactivity
- The camera is a parameter set like any other — position, target, FOV, roll — so it is modulatable and keyframable. "Camera kick on the drop" is a modulation binding, not special-cased code.
- Declared camera rigs (orbit, dolly, handheld-with-seeded-noise, look-at-target) reduce the parameter surface for common moves.
- **Depth of field** needs the depth buffer, so the 3D module exposes depth as a second output that DOF-capable effects can consume. Effects declare whether they require depth; requesting it from a 2D layer is a schema error, not a runtime surprise.

### 7.4 Cost
Scene3D layers declare `gpuCost: high`, participate in the auto-director's budget (auto-director-spec §5.1), and are the first thing dropped when a project exceeds budget at 4K.

---

## 8. Video layers (M14, M39 — D4)

Video backgrounds are the one input whose natural API is fundamentally at odds with deterministic
rendering: `HTMLVideoElement` decodes on a wall clock, seeking is approximate, and "which frame
am I on" is genuinely not answerable with confidence.

**The design: decouple decode from render entirely.**

- On import, the video is **pre-extracted to a frame cache at the project's fps** — FFmpeg decodes to a folder of compressed frames (or an intermediate all-keyframe file) keyed by `(videoHash, fps, resolution)`.
- Rendering frame `n` reads cached frame `map(n)`. Exact, deterministic, seekable, identical in preview and export.
- Cost: disk. A 4-minute 1080p all-intra intermediate is a few GB — which is why this lives under cache management (PROJECT.md M33) with its size clearly attributed.
- Loop, speed, in/out trim and fit modes operate on the cached sequence.
- **Preview optimisation**: a lower-resolution proxy sequence for editing, with the full one used on export.
- Live `HTMLVideoElement` playback is *not* used for rendering at all — not even in preview — because preview and export must agree.

This is more work than dropping a `<video>` into a texture, and it's the only approach that keeps
the core guarantee intact.

---

## 9. Palette system (M17)

- A project palette is an ordered list of colours plus **role assignments**: `primary`, `secondary`, `accent`, `glow`, `background`, `text`, `textShadow`.
- Any `color` parameter may be **linked to a role** rather than holding a literal (module-spec §3.2). Changing the palette updates every linked parameter at once — the "reskin in one click" requirement.
- Links survive preset application; a preset carries role *links*, so applying it adopts the current project palette instead of importing foreign colours.
- Palette generation and harmony rules live in auto-director-spec §5.3; contrast enforcement for text is shared with lyrics legibility (lyrics-spec §7).
- Manual override: unlink a single parameter without breaking the rest.
- Palettes are saveable/loadable independently of projects, and importable from an image.

---

## 10. Render order & culling

- Layers render bottom-to-top in project order; groups recurse.
- **Skipped**: disabled layers, layers outside their time range, zero-opacity layers, and layers fully occluded by an opaque layer above (the auto-director already prunes these — §7 of its spec — but a hand-built project can create them too).
- Solo mode renders only soloed layers (plus any masks they reference).
- Skips are counted in the render report, so "why is this layer invisible" has an answer.

---

## 11. Open questions — resolved

All settled in [decisions.md](decisions.md):
- **Layer groups: yes, full, in v1** (D3 → M38). §6 is normative, not speculative.
- **Video frame cache: yes** (D4 → M39), with proxy sequences for preview.
- **Tone mapping: filmic / ACES-like** (D7), realised as a hue-preserving highlight shoulder (D48). Single fixed curve in v1; the pipeline stays able to swap it.
- **Output transfer: sRGB for preview and export** (D49).
- **Preview stays dithered 8-bit**; 10-bit is an export format only (D17).
- **Depth is 3D-only** — 2D layers do not declare synthetic depth (D18).

---

## 12. Dependencies

- **[module-spec.md](module-spec.md) §7–8** — render contract and effect chain.
- **[export-spec.md](export-spec.md) §4–6** — readback, colour conversion, output encoding.
- **[auto-director-spec.md](auto-director-spec.md) §5.3, §7** — palette generation, GPU budget.
- **PROJECT.md §4** — VRAM budget; M33 cache (video frame cache); M34 render report.
