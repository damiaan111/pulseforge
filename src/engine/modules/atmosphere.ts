// core.visualizer.nebula / aurora / bokeh / rays / silk — full-frame, music-driven atmospheres.
//
// What the built-in looks were missing was not a hero but something behind it: every template drew
// its ring or its torus on a flat fill, and a flat fill reads as unfinished however good the thing
// in front is. These five fill the frame with slow light that breathes with the track.
//
// They are written as shader modules, the same contract a drop-in module in `modules/` gets
// (docs/module-authoring.md): time is `u_time`, randomness is the seeded hash, sizes are in canvas
// units, output is linear and premultiplied. Nothing here keeps state, so a frame scrubbed to is the
// frame played to. Motion comes from time alone; the music moves brightness, width and warp, never
// the phase, because a phase that followed loudness would need the history of the track.

import type { ModuleDefinition } from '../core/module.ts';
import type { ParamSpec } from '../core/params.ts';
import { shaderModuleDefinition } from './shader-module.ts';

/** Value noise on an integer lattice, keyed on the project seed, and the fbm built from it. */
const NOISE = /* glsl */ `
float at_lattice(vec2 cell) {
  uvec2 q = uvec2(ivec2(cell));
  uint h = q.x * 374761393u + q.y * 668265263u + u_seed * 2246822519u;
  h = (h ^ (h >> 13u)) * 1274126177u;
  return float((h ^ (h >> 16u)) >> 8u) / 16777216.0;
}
float at_noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = p - i;
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = at_lattice(i);
  float b = at_lattice(i + vec2(1.0, 0.0));
  float c = at_lattice(i + vec2(0.0, 1.0));
  float d = at_lattice(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
/** That many octaves of noise, each finer and fainter; normalised so fewer octaves keep the same range. */
float at_fbm(vec2 p, int octaves) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 5; i += 1) {
    if (i >= octaves) break;
    sum += amp * at_noise(p);
    p = mat2(1.6, 1.2, -1.2, 1.6) * p + 17.0;
    amp *= 0.5;
  }
  return sum / (1.0 - amp * 2.0);
}
float at_fbm(vec2 p) { return at_fbm(p, 5) * 0.96875; }
/** Canvas units, centred, x right and y down: 1.0 is the layer's reference length. */
vec2 at_point() { return (pf_uv() - 0.5) * u_resolution / u_scale; }
`;

const SOURCE: ParamSpec = { key: 'source', label: 'Source', group: 'Audio', type: 'select:stem', default: 'mix' };
const react = (fallback: number, description: string): ParamSpec => (
  { key: 'react', label: 'Reactivity', group: 'Audio', type: 'float', default: fallback, min: 0, max: 2, softMax: 1, description }
);
const speed = (fallback: number): ParamSpec => (
  { key: 'speed', label: 'Speed', group: 'Motion', type: 'float', default: fallback, min: -3, max: 3, softMin: 0, softMax: 1.5, unit: '×' }
);
const brightness = (fallback: number): ParamSpec => (
  { key: 'brightness', label: 'Brightness', group: 'Look', type: 'float', default: fallback, min: 0, max: 3, softMax: 1.5 }
);

function atmosphere(id: string, name: string, description: string, tags: readonly string[], params: readonly ParamSpec[], shader: string): ModuleDefinition {
  return shaderModuleDefinition({
    manifest: { id: `core.visualizer.${id}`, version: '1.0.0', kind: 'visualizer', name, description, category: 'atmosphere', tags: ['atmosphere', 'background', ...tags], params },
    shader: NOISE + shader,
    origin: `core.visualizer.${id}`,
  });
}

export const nebulaModule = atmosphere('nebula', 'Nebula', 'Drifting clouds of coloured light that swell with the music', ['clouds', 'space', 'cinematic'], [
  { key: 'colorA', label: 'Deep colour', group: 'Look', type: 'color', default: '#1b1464', paletteRole: 'secondary' },
  { key: 'colorB', label: 'Cloud colour', group: 'Look', type: 'color', default: '#ff2d95', paletteRole: 'primary' },
  { key: 'colorC', label: 'Highlights', group: 'Look', type: 'color', default: '#ffd166', paletteRole: 'accent' },
  brightness(0.8),
  { key: 'size', label: 'Cloud size', group: 'Look', type: 'float', default: 1, min: 0.2, max: 4, unit: '×' },
  { key: 'stars', label: 'Stars', group: 'Look', type: 'float', default: 0.5, min: 0, max: 1 },
  speed(0.4),
  react(0.6, 'How much the clouds brighten with the level and flare on a beat'),
  SOURCE,
], /* glsl */ `
void main() {
  vec2 p = at_point() * 1.6 / u_size;
  float t = u_time * 0.05 * u_speed;
  // Two rounds of domain warping: the first field bends the second, which is what makes smoke, not blobs.
  // The fields that only bend the next one need less detail than the one that is seen.
  vec2 q = vec2(at_fbm(p + vec2(0.0, t), 3), at_fbm(p + vec2(5.2, 1.3 - t), 3)) * 0.96875;
  vec2 r = vec2(at_fbm(p + 2.4 * q + vec2(1.7 + t * 1.3, 9.2), 4), at_fbm(p + 2.4 * q + vec2(8.3, 2.8 - t * 1.1), 4)) * 0.96875;
  float f = at_fbm(p + 2.2 * r);

  float level = 1.0 + u_react * (1.4 * u_rms + 0.6 * u_beat);
  float cloud = smoothstep(0.38, 0.92, f);
  // Mostly deep colour: the cloud colour only where the field is dense, the highlights rarer still.
  vec3 colour = mix(u_colorA * 0.22, u_colorA, smoothstep(0.2, 0.7, length(q)));
  colour = mix(colour, u_colorB, cloud * cloud * 0.85);
  colour += u_colorC * pow(clamp(r.x * f * 1.7, 0.0, 1.0), 4.0) * (0.45 + u_react * 1.5 * u_onset);

  // Stars: one per lattice cell at most, twinkling slowly, hidden where the cloud is thick.
  vec2 grid = at_point() * 42.0;
  vec2 cell = floor(grid);
  float pick = at_lattice(cell + 91.0);
  vec2 offset = vec2(at_lattice(cell + 13.0), at_lattice(cell + 57.0)) - 0.5;
  float d = length(grid - cell - 0.5 - offset * 0.7);
  float twinkle = 0.6 + 0.4 * sin(u_time * (0.6 + pick * 2.0) + pick * 40.0);
  float star = step(0.86, pick) * smoothstep(0.09, 0.0, d) * twinkle * u_stars * (1.0 - cloud * 0.8);
  colour += vec3(star);

  float edge = 1.0 - 0.35 * dot(pf_uv() - 0.5, pf_uv() - 0.5) * 2.0;
  outColor = vec4(max(colour * u_brightness * level * edge, 0.0), 1.0);
}
`);

export const auroraModule = atmosphere('aurora', 'Aurora', 'Curtains of light that ripple across the frame and shimmer with the spectrum', ['curtain', 'northern lights', 'ambient'], [
  { key: 'colorA', label: 'Base colour', group: 'Look', type: 'color', default: '#00e5a0', paletteRole: 'primary' },
  { key: 'colorB', label: 'Top colour', group: 'Look', type: 'color', default: '#7c4dff', paletteRole: 'secondary' },
  { key: 'sky', label: 'Sky', group: 'Look', type: 'color', default: '#03040c', paletteRole: 'background' },
  brightness(1),
  { key: 'height', label: 'Height', group: 'Look', type: 'float', default: 0.5, min: 0.1, max: 1.5, description: 'How tall the curtains stand' },
  { key: 'position', label: 'Position', group: 'Look', type: 'float', default: 0.62, min: 0, max: 1, aspectOverridable: true, description: 'Where the curtains touch down: 0 is the top of the frame' },
  { key: 'curtains', label: 'Curtains', group: 'Look', type: 'int', default: 3, min: 1, max: 5 },
  speed(0.5),
  react(0.7, 'How much the spectrum lights each part of a curtain'),
  SOURCE,
], /* glsl */ `
void main() {
  vec2 uv = pf_uv();
  vec2 p = at_point();
  float t = u_time * 0.12 * u_speed;
  vec3 colour = u_sky * (0.6 + 0.4 * (1.0 - uv.y));
  float glow = 0.0;
  int count = int(u_curtains);
  for (int i = 0; i < 5; i += 1) {
    if (i >= count) break;
    float k = float(i);
    // The curtain's foot: a slow wave across the frame, each curtain on its own phase.
    float foot = (u_position - 0.5) * u_resolution.y / u_scale
      + 0.34 * (at_fbm(vec2(p.x * 0.8 + k * 7.3 + t, k * 3.1 - t * 0.6)) - 0.5) * 2.0 + (k - 1.0) * 0.16;
    float above = foot - p.y;
    // Rays: fine vertical structure that drifts sideways, lit by the spectrum at that place.
    float ray = pow(at_fbm(vec2(p.x * 14.0 + k * 21.0 + t * 2.0, above * 0.6 - t)) * 1.5, 2.5);
    // The spectrum folded back on itself, so the lit places have no seam where it would wrap.
    float band = pf_spectrum(abs(fract(uv.x * 0.7 + k * 0.23) * 2.0 - 1.0) * 0.8);
    float lit = 0.2 + 1.1 * ray + u_react * (1.3 * band + 0.5 * u_rms) * (0.4 + ray);
    float body = smoothstep(0.0, 0.03, above) * exp(-max(above, 0.0) / (u_height * (0.35 + 0.25 * ray)));
    float hem = exp(-abs(above) * 38.0) * 0.55;
    float curtain = (body + hem) * lit / (1.0 + k * 0.45);
    float rise = clamp(above / max(u_height, 0.01), 0.0, 1.0);
    colour += mix(u_colorA, u_colorB, rise) * curtain * 0.55;
    glow += curtain;
  }
  colour += u_colorA * 0.05 * glow * u_beat * u_react;
  outColor = vec4(max(colour * u_brightness, 0.0), 1.0);
}
`);

export const bokehModule = atmosphere('bokeh', 'Bokeh', 'Soft out-of-focus lights drifting at three depths, glowing with the level', ['lights', 'soft', 'cinematic'], [
  { key: 'colorA', label: 'Colour 1', group: 'Look', type: 'color', default: '#ff2d95', paletteRole: 'primary' },
  { key: 'colorB', label: 'Colour 2', group: 'Look', type: 'color', default: '#00e5ff', paletteRole: 'secondary' },
  { key: 'colorC', label: 'Colour 3', group: 'Look', type: 'color', default: '#ffd166', paletteRole: 'accent' },
  brightness(0.9),
  { key: 'density', label: 'Density', group: 'Look', type: 'float', default: 0.55, min: 0, max: 1 },
  { key: 'size', label: 'Size', group: 'Look', type: 'float', default: 1, min: 0.3, max: 3, unit: '×' },
  { key: 'rim', label: 'Rim', group: 'Look', type: 'float', default: 0.5, min: 0, max: 1, description: 'A brighter edge, as a real lens gives an out-of-focus light' },
  speed(0.5),
  react(0.7, 'How much the lights swell and brighten with the level'),
  SOURCE,
], /* glsl */ `
vec4 at_layer(vec2 p, float depth, float cells) {
  // Drift: each depth moves at its own pace, nearer ones faster, which is the parallax.
  vec2 g = p * cells + vec2(u_time * 0.03 * u_speed * (1.0 + depth), -u_time * 0.045 * u_speed * (0.6 + depth)) + depth * 31.7;
  vec3 colour = vec3(0.0);
  float cover = 0.0;
  vec2 base = floor(g);
  for (int y = -1; y <= 1; y += 1) {
    for (int x = -1; x <= 1; x += 1) {
      vec2 cell = base + vec2(float(x), float(y));
      float pick = at_lattice(cell + depth * 113.0);
      if (pick > u_density) continue;
      vec2 centre = cell + 0.5 + (vec2(at_lattice(cell + 3.0 + depth), at_lattice(cell + 71.0 + depth)) - 0.5) * 0.9;
      float seed = at_lattice(cell + 19.0 + depth * 7.0);
      float swell = 1.0 + u_react * 0.35 * u_rms * (0.5 + seed);
      float radius = (0.16 + 0.26 * seed) * u_size * swell;
      float d = length(g - centre) / radius;
      float disc = smoothstep(1.0, 0.9, d);
      float rim = smoothstep(0.72, 0.95, d) * disc * u_rim;
      float pulse = 0.55 + 0.45 * sin(u_time * (0.25 + seed * 0.5) + seed * 50.0);
      float a = disc * (0.16 + 0.22 * rim) * pulse * (1.0 + u_react * (0.9 * u_rms + 0.6 * u_beat * seed));
      vec3 tint = seed < 0.4 ? u_colorA : (seed < 0.75 ? u_colorB : u_colorC);
      colour += tint * a;
      cover += a;
    }
  }
  return vec4(colour, cover);
}
void main() {
  vec2 p = at_point();
  vec4 far = at_layer(p, 0.0, 5.5);
  vec4 mid = at_layer(p, 1.0, 3.4);
  vec4 near = at_layer(p, 2.0, 2.0);
  vec3 colour = far.rgb * 0.5 + mid.rgb * 0.8 + near.rgb;
  float alpha = clamp(far.a * 0.5 + mid.a * 0.8 + near.a, 0.0, 1.0);
  colour *= u_brightness;
  // Additive light over whatever is beneath: alpha only as much as the light itself covers.
  outColor = vec4(max(colour, 0.0), clamp(alpha * u_brightness, 0.0, 1.0) * 0.6);
}
`);

export const raysModule = atmosphere('rays', 'Light rays', 'Beams fanning out from a point of light, flaring on the beat', ['beams', 'god rays', 'stage'], [
  { key: 'colorA', label: 'Core', group: 'Look', type: 'color', default: '#fff1c1', paletteRole: 'accent' },
  { key: 'colorB', label: 'Beams', group: 'Look', type: 'color', default: '#ff2d95', paletteRole: 'primary' },
  brightness(0.9),
  { key: 'x', label: 'Centre X', group: 'Place', type: 'float', default: 0.5, min: -0.5, max: 1.5, aspectOverridable: true },
  { key: 'y', label: 'Centre Y', group: 'Place', type: 'float', default: 0.5, min: -0.5, max: 1.5, aspectOverridable: true },
  { key: 'beams', label: 'Beams', group: 'Look', type: 'float', default: 9, min: 2, max: 40 },
  { key: 'reach', label: 'Reach', group: 'Look', type: 'float', default: 1.1, min: 0.2, max: 4, description: 'How far the light carries, in canvas units' },
  { key: 'core', label: 'Core size', group: 'Look', type: 'float', default: 0.12, min: 0, max: 1 },
  speed(0.5),
  react(0.8, 'How much the beams lengthen with the level and flare on a beat'),
  SOURCE,
], /* glsl */ `
void main() {
  vec2 centre = (vec2(u_x, u_y) - 0.5) * u_resolution / u_scale;
  vec2 d = at_point() - centre;
  float r = length(d);
  float angle = atan(d.y, d.x);
  float t = u_time * 0.08 * u_speed;
  // Angle wraps, so the noise is read on a circle: no seam where the angle jumps from pi to -pi.
  vec2 ring = vec2(cos(angle), sin(angle)) * u_beams * 0.32;
  float fine = at_fbm(ring * 2.3 + vec2(t * 1.7, -t));
  float wide = at_fbm(ring + vec2(-t, t * 0.7) + 40.0);
  float beam = pow(clamp(wide * 1.25 + fine * 0.45 - 0.35, 0.0, 1.0), 2.2);
  float reach = u_reach * (1.0 + u_react * (0.5 * u_rms + 0.35 * u_beat));
  float fall = exp(-r / max(reach * (0.25 + 0.75 * wide), 0.001) * 1.6);
  float light = beam * fall * (1.0 + u_react * 0.8 * u_beat);
  float core = exp(-r / max(u_core * (1.0 + u_react * 0.5 * u_rms), 0.001));
  vec3 colour = (u_colorB * light * 1.4 + u_colorA * (core * 1.2 + light * core)) * u_brightness;
  float alpha = clamp(max(colour.r, max(colour.g, colour.b)), 0.0, 1.0);
  outColor = vec4(max(colour, 0.0), alpha);
}
`);

export const silkModule = atmosphere('silk', 'Silk', 'Slow folds of colour, like dye in water, that the bass pushes around', ['liquid', 'flow', 'marble', 'gradient'], [
  { key: 'colorA', label: 'Colour 1', group: 'Look', type: 'color', default: '#12084a', paletteRole: 'background' },
  { key: 'colorB', label: 'Colour 2', group: 'Look', type: 'color', default: '#ff2d95', paletteRole: 'primary' },
  { key: 'colorC', label: 'Colour 3', group: 'Look', type: 'color', default: '#00e5ff', paletteRole: 'secondary' },
  brightness(0.75),
  { key: 'size', label: 'Fold size', group: 'Look', type: 'float', default: 1, min: 0.2, max: 4, unit: '×' },
  { key: 'folds', label: 'Folds', group: 'Look', type: 'float', default: 0.6, min: 0, max: 1.5, description: 'How far the colour is pulled around' },
  { key: 'sheen', label: 'Sheen', group: 'Look', type: 'float', default: 0.5, min: 0, max: 1, description: 'A bright line along each fold' },
  speed(0.5),
  react(0.6, 'How much the bass pulls the folds and the level lifts the brightness'),
  SOURCE,
], /* glsl */ `
void main() {
  vec2 p = at_point() * 2.2 / u_size;
  float t = u_time * 0.11 * u_speed;
  float bass = pf_spectrum(0.04);
  float pull = u_folds * (1.0 + u_react * 0.5 * bass);
  // Each pass bends the plane with the one before, a little finer every time.
  for (int i = 1; i <= 5; i += 1) {
    float k = float(i);
    p += pull / k * vec2(sin(k * p.y * 1.25 + t * (1.0 + 0.13 * k) + k * 1.7), cos(k * p.x * 1.1 - t * (0.8 + 0.11 * k) + k * 2.3));
  }
  float a = 0.5 + 0.5 * sin(p.x * 1.1 + p.y * 0.7);
  float b = 0.5 + 0.5 * sin(p.y * 1.5 - p.x * 0.4 + 1.9);
  vec3 colour = mix(u_colorA, u_colorB, smoothstep(0.15, 0.9, a));
  colour = mix(colour, u_colorC, smoothstep(0.55, 1.0, b) * 0.75);
  float fold = pow(1.0 - abs(sin(p.x * 1.1 + p.y * 0.7)), 6.0);
  colour += (u_colorB + u_colorC) * 0.5 * fold * u_sheen * (0.5 + u_react * 0.9 * u_onset);
  float level = 1.0 + u_react * (0.7 * u_rms + 0.3 * u_beat);
  outColor = vec4(max(colour * u_brightness * level, 0.0), 1.0);
}
`);

/** The five atmospheres, in the order the Add-layer list shows them. */
export const ATMOSPHERE_MODULES: readonly ModuleDefinition[] = [nebulaModule, auroraModule, bokehModule, raysModule, silkModule];
