# Writing a Pulseforge module

A module is a folder in `modules/` holding two files: `module.json` describes it, `shader.frag`
draws it. Pulseforge reads the folder when it starts, and again whenever something in it changes,
so you can edit a shader with the studio open and see the result on the next frame.

The inspector panel, presets and modulation targets are generated from `module.json` — you write
no UI code. The worked example is `modules/example-pulse-rings/`; `modules/_template/` is a
minimal starting point (folders beginning with `_` or `.` are not loaded, so copy it and drop the
underscore).

---

## 1. The quick version

1. Copy `modules/_template` to `modules/my-rings`.
2. In `module.json`, change `id` to something of your own — `you.visualizer.my-rings`.
3. Edit `shader.frag`. Save.
4. The studio reloads it: your module appears under **Add layer**. If it fails, the **Modules**
   line in the left rail says why, naming the folder, the field or the shader line.
5. Before you rely on it in an export, run `npm run modules:check` (§6).

---

## 2. `module.json`

```json
{
  "id": "example.visualizer.pulse-rings",
  "version": "1.0.0",
  "kind": "visualizer",
  "name": "Pulse rings",
  "description": "What it does, in one line.",
  "category": "examples",
  "tags": ["rings"],
  "shader": "shader.frag",
  "params": [ … ]
}
```

| Field | Required | Notes |
|---|---|---|
| `id` | yes | Lowercase and dotted (`you.visualizer.name`). **Permanent**: projects store it. `core.` is reserved. |
| `version` | yes | Yours to bump. |
| `kind` | yes | `visualizer` or `source` draw a layer; `effect` processes the layer beneath it. |
| `name` | yes | What the **Add layer** button says. |
| `shader` | no | Defaults to `shader.frag`. Must be a file in this folder. |
| `description`, `category`, `tags` | no | Shown in the UI and used by the preset browser later. |
| `params` | no | Your controls — §3. |

## 3. Parameters

Each parameter becomes a control in the inspector **and** a uniform in your shader called
`u_<key>`. The key must be a plain identifier.

| `type` | Extra fields | Uniform | Notes |
|---|---|---|---|
| `float` | `min`, `max`, optional `softMin`/`softMax`, `unit` | `float` | Slider. |
| `int` | `min`, `max` | `float` | Arrives as a float: `int(u_count)` in the shader. |
| `bool` | — | `bool` | Checkbox. |
| `enum` | `options: [{ value, label }]` | `int` | The **index** of the chosen option, in declaration order. |
| `color` | optional `paletteRole` | `vec3` | Already converted to **linear** light. Link to a palette role (`primary`, `accent`, `glow`, …) and the project palette recolours it. |
| `select:stem` | — | `int` | The first one also decides which stem the audio uniforms describe. |

Common fields: `key`, `label`, `group` (inspector section), `default`, and optionally
`description`, `visibleWhen: { "param": "mode", "equals": "rings" }`, `advanced: true` (behind
"Show advanced"), `aspectOverridable: true` (can differ per aspect ratio), `modulatable: false`
(refuse audio modulation).

Every parameter can be driven by audio through the modulation system unless you say otherwise —
you do not have to wire that up; the engine resolves modulation before your shader runs.

## 4. The shader

Write GLSL ES 3.00 — WebGL2 — declarations and `void main()`. **No `#version` line**: the
prelude supplies it, along with everything below.

| Name | Type | Meaning |
|---|---|---|
| `u_resolution` | `vec2` | Layer size in pixels. |
| `u_time` | `float` | Timeline seconds for this frame. |
| `u_frame` | `int` | Frame index. |
| `u_scale` | `float` | Pixels per canvas unit for the layer's scale reference. **Size things with this**, not with pixels. |
| `u_rms`, `u_peak`, `u_onset`, `u_beat`, `u_centroid` | `float` | Audio features of the chosen stem, 0..1-ish. |
| `pf_spectrum(x)` | `float` | The spectrum at position `x` in 0..1 (low to high), smoothly interpolated. |
| `pf_bin(i)`, `u_bins` | | Raw spectrum bins. |
| `pf_uv()` | `vec2` | This pixel in 0..1, **top-left origin**, like every coordinate in Pulseforge. |
| `pf_hash(a, b)` | `float` | A deterministic 0..1 value from two integers, keyed on the project seed. |
| `pf_input(uv)` | `vec4` | *Effects only*: the layer beneath, at a top-left-origin `uv`. Premultiplied. |
| `u_<key>` | | Your parameters. |
| `outColor` | `vec4` | Write your result here: **linear light, premultiplied alpha** — `vec4(rgb * a, a)`. |

A canvas-unit position centred on the layer, which keeps shapes the same size when the canvas
changes shape:

```glsl
vec2 p = (pf_uv() - 0.5) * u_resolution / u_scale;
```

### The rules

These are what make a render reproducible a year from now. The prelude makes most of them
impossible to break, and `npm run modules:check` catches the rest.

1. **Time comes from `u_time` / `u_frame`, nothing else.** There is no clock to read, and a shader
   cannot keep state between frames — so any frame renders the same whether it was played to or
   scrubbed to.
2. **Randomness comes from `pf_hash`.** It is seeded by the project, so "Surprise me" can change
   it and a render can reproduce it.
3. **Size in canvas units (`u_scale`), not pixels.** A module written on a 16:9 canvas must still
   work on 9:16 and 1:1, and at 4K as well as in the preview.
4. **Output linear, premultiplied colour.** Colour parameters are already linear. Multiply rgb by
   alpha yourself.
5. **Sample textures outside branches** that vary per pixel: implicit derivatives are undefined
   inside them in GLSL ES 3.00.

## 5. When it does not work

- **It is missing from Add layer.** Look at the **Modules** line in the left rail: every folder
  that failed to load is listed with the reason — a missing file, invalid JSON, a field named with
  what is wrong with it.
- **The layer draws nothing and an engine note says the module is broken.** The shader did not
  compile. The note gives the error with **your file's line number** (the prelude is not counted)
  and the line itself. Fix and save; the studio reloads it.
- **Changes do not show.** Save the file; the folder is watched. **Reload** in the Modules line
  re-reads it by hand.

A broken module never takes the rest of the project down: its layers are skipped and reported,
and everything else renders.

## 6. `npm run modules:check`

The conformance test. For every module in `modules/` it renders on the GPU and checks:

| Check | Passes when |
|---|---|
| params | the declared defaults resolve cleanly and survive a JSON round trip |
| compile | the shader compiles |
| determinism | the same frames rendered twice, in different orders, are byte-identical |
| reflow | it draws something at 16:9, 9:16 and 1:1 |

It exits non-zero if anything fails, and writes the details to `out/modules-check.json`.
`npm run modules:check -- <folder>` checks another folder.

## 7. What a drop-in module cannot do (yet)

Drop-in modules are **data**: a schema and a shader. No JavaScript from `modules/` runs — the
studio's renderer is sandboxed, and a shader cannot reach the clock, the network or the disk,
which is what makes a drop-in module deterministic by construction. So a drop-in module cannot:
take image, font or video assets; keep state between frames (particle systems that simulate); or
use several passes. The built-in modules in `src/engine/modules/` can, and are the reference for
anything that needs more.
