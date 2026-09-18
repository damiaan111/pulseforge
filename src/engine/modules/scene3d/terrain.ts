// core.scene3d.terrain — the music laid out as a landscape (M37).
//
// PROJECT.md §8's "audio-displaced terrain" and, with the scroll turned toward the camera,
// "tunnel flight": a plane whose height across its width is the spectrum and whose depth is the
// recent past. Each row is the spectrum at one moment, so the ground is a 3D spectrogram that
// moves as the song plays.
//
// Deterministic by construction, with no history carried between frames: every frame samples its
// rows straight from the analysis, at times on a fixed grid (`floor(t / step) * step - k * step`),
// and slides the whole surface by the fraction of a row that has elapsed. The ground therefore
// moves smoothly while any single frame is a pure function of its time — scrub to 2:31 and the
// terrain is exactly the one that played there.

import { Mesh, MeshStandardMaterial, PlaneGeometry, Scene, HemisphereLight, DirectionalLight } from 'three';
import { sampleTrackInto } from '../../core/analysis.ts';
import type { ModuleManifest } from '../../core/module.ts';
import { num, str } from '../../core/params.ts';
import { cameraParams } from './camera.ts';
import {
  SCENE_SPECTRUM_GLSL, SpectrumTexture, linearColour, reactivityParams, scene3dModule, spectrumUniforms,
  syncSpectrumUniforms, type SceneContent,
} from './scene-module.ts';

/** How much of the past the ground holds: this many rows over its depth. */
const ROWS = 128;
/** Ground extent in scene units: wide enough to reach the frame's edges at the horizon. */
const WIDTH = 120;
const DEPTH = 80;
/** The near edge sits just behind the default camera, so new rows enter from below the frame. */
const NEAR_EDGE = 16;
const ROW_SPACING = DEPTH / ROWS;

export const terrainManifest: ModuleManifest = {
  id: 'core.scene3d.terrain',
  version: '0.1.0',
  kind: 'scene3d',
  name: 'Terrain',
  description: 'The spectrum as a landscape, with the recent past stretching to the horizon',
  category: '3d',
  tags: ['3d', 'terrain', 'landscape', 'spectrogram', 'synthwave', 'flight'],
  capabilities: { needsAnalysis: true, needsInput: false, supportsAspect: true, stateful: false, gpuCost: 'high' },
  paramsSchemaVersion: 1,
  params: [
    ...reactivityParams('rms'),
    {
      key: 'direction', label: 'Flow', group: 'Ground', type: 'enum', default: 'away',
      options: [
        { value: 'away', label: 'New sound in front, flowing away' },
        { value: 'toward', label: 'New sound at the horizon, rushing in' },
      ],
    },
    { key: 'flow', label: 'Flow speed', group: 'Ground', type: 'float', default: 8, min: 0, max: 60, softMax: 30, unit: 'units/s' },
    { key: 'amplitude', label: 'Height', group: 'Ground', type: 'float', default: 2.2, min: 0, max: 20, softMax: 8, unit: 'units' },
    { key: 'spread', label: 'Spectrum width', group: 'Ground', type: 'float', default: 28, min: 2, max: 120, softMax: 60, unit: 'units', description: 'How wide the band from lows to highs is laid out' },
    { key: 'mirror', label: 'Mirror', group: 'Ground', type: 'bool', default: true, description: 'Lows in the middle, highs to both sides' },
    { key: 'valley', label: 'Valley', group: 'Ground', type: 'float', default: 0.35, min: 0, max: 2, softMax: 1, description: 'Raises hills at the sides, a canyon to fly down' },
    { key: 'low', label: 'Low colour', group: 'Look', type: 'color', default: '#3a7bff', paletteRole: 'primary' },
    { key: 'high', label: 'Peak colour', group: 'Look', type: 'color', default: '#ff2d95', paletteRole: 'accent' },
    { key: 'glow', label: 'Glow', group: 'Look', type: 'float', default: 1, min: 0, max: 4, softMax: 2 },
    { key: 'grid', label: 'Grid lines', group: 'Look', type: 'float', default: 0.8, min: 0, max: 3, softMax: 1.5 },
    { key: 'gridSize', label: 'Grid size', group: 'Look', type: 'float', default: 1.5, min: 0.25, max: 10, unit: 'units', advanced: true },
    { key: 'fade', label: 'Horizon', group: 'Look', type: 'float', default: 60, min: 10, max: 150, unit: 'units', description: 'Distance at which the ground fades out' },
    { key: 'faceted', label: 'Faceted', group: 'Look', type: 'bool', default: true },
    { key: 'wireframe', label: 'Wireframe', group: 'Look', type: 'bool', default: false },
    ...cameraParams({ rig: 'static', distance: 14, height: 5, lookHeight: 0, fov: 55, speed: 6 }),
  ],
};

function buildTerrain(): SceneContent {
  const scene = new Scene();
  const spectrum = new SpectrumTexture();
  const uniforms = {
    ...spectrumUniforms(spectrum),
    pf_away: { value: true },
    pf_frac: { value: 0 },
    pf_amp: { value: 0 },
    pf_spread: { value: 1 },
    pf_mirror: { value: true },
    pf_valley: { value: 0 },
    pf_low: { value: [0, 0, 0] as number[] },
    pf_high: { value: [0, 0, 0] as number[] },
    pf_glow: { value: 0 },
    pf_level: { value: 0 },
    pf_grid: { value: 0 },
    pf_gridSize: { value: 1 },
    pf_fade: { value: 60 },
  };

  // Laid flat, near edge towards +z where the camera stands.
  const geometry = new PlaneGeometry(WIDTH, DEPTH, 240, 192);
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, 0, NEAR_EDGE - DEPTH / 2);

  const material = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, metalness: 0.1 });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
uniform bool pf_away;
uniform float pf_frac;
uniform float pf_amp;
uniform float pf_spread;
uniform bool pf_mirror;
uniform float pf_valley;
uniform float pf_gridSize;
varying float pf_vHeight;
varying vec2 pf_vGrid;
${SCENE_SPECTRUM_GLSL}`)
      .replace('#include <begin_vertex>', `
vec3 transformed = vec3(position);
// Across: the spectrum, lows to highs (or lows in the middle when mirrored).
float pf_x = position.x / (pf_spread * 0.5);
float pf_band = pf_mirror ? abs(pf_x) : pf_x * 0.5 + 0.5;
// Along: time. Row k is the spectrum k steps ago, slid by the part of a step already played.
float pf_row = pf_away
  ? (${NEAR_EDGE.toFixed(1)} - position.z) / ${ROW_SPACING.toFixed(6)} - pf_frac
  : (position.z - ${(NEAR_EDGE - DEPTH).toFixed(1)}) / ${ROW_SPACING.toFixed(6)} - pf_frac;
float pf_s = pf_spectrumAt(pf_band, pf_row);
transformed.y += pf_s * pf_amp + pf_valley * pf_amp * 0.35 * min(pf_x * pf_x, 9.0);
pf_vHeight = pf_s;
pf_vGrid = vec2(position.x, pf_row * ${ROW_SPACING.toFixed(6)}) / pf_gridSize;
`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform vec3 pf_low;
uniform vec3 pf_high;
uniform float pf_glow;
uniform float pf_level;
uniform float pf_grid;
uniform float pf_fade;
varying float pf_vHeight;
varying vec2 pf_vGrid;`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
vec3 pf_colour = mix(pf_low, pf_high, clamp(pf_vHeight, 0.0, 1.0));
diffuseColor.rgb = pf_colour * 0.3;
// Grid lines a pixel or so wide at any distance: the width is measured in screen derivatives.
vec2 pf_cell = abs(fract(pf_vGrid - 0.5) - 0.5) / max(fwidth(pf_vGrid), vec2(1e-4));
float pf_line = 1.0 - min(min(pf_cell.x, pf_cell.y), 1.0);
totalEmissiveRadiance += pf_colour * (pf_glow * (0.1 + pf_vHeight) * (0.5 + pf_level) + pf_grid * pf_line * 1.5);`)
      .replace('#include <dithering_fragment>', `#include <dithering_fragment>
// Fade to transparent, not to a fog colour, so the horizon composites over whatever is beneath.
// Premultiplied: colour and alpha fade together.
gl_FragColor *= 1.0 - smoothstep(pf_fade * 0.6, pf_fade, length(vViewPosition));`);
  };
  material.customProgramCacheKey = () => 'pulseforge.scene3d.terrain';
  const mesh = new Mesh(geometry, material);
  scene.add(mesh);

  const sky = new HemisphereLight(0xffffff, 0x000000, 0.5);
  const key = new DirectionalLight(0xffffff, 1.5);
  key.position.set(-4, 6, 3);
  scene.add(sky, key);

  let bins = 0;
  let row = new Float32Array(0);

  return {
    scene,
    update({ ctx, params, source, level }) {
      const channels = source === undefined ? 1 : Math.max(1, source.spectrum.channels);
      const data = spectrum.begin(channels, ROWS);
      if (channels !== bins) {
        bins = channels;
        row = new Float32Array(channels);
      }
      const flow = num(params, 'flow');
      // Seconds between rows; with no flow the whole ground is the present moment.
      const step = flow > 1e-3 ? ROW_SPACING / flow : 0;
      const now = ctx.audioSeconds;
      const newest = step > 0 ? Math.floor(now / step) * step : now;
      if (source === undefined) {
        data.fill(0);
      } else {
        for (let k = 0; k < ROWS; k += 1) {
          sampleTrackInto(source.spectrum, newest - k * step, row);
          data.set(row, k * channels);
        }
      }
      spectrum.commit();
      syncSpectrumUniforms(uniforms, spectrum);

      uniforms.pf_away.value = str(params, 'direction') !== 'toward';
      uniforms.pf_frac.value = step > 0 ? (now - newest) / step : 0;
      uniforms.pf_amp.value = num(params, 'amplitude');
      uniforms.pf_spread.value = num(params, 'spread');
      uniforms.pf_mirror.value = params['mirror'] === true;
      uniforms.pf_valley.value = num(params, 'valley');
      uniforms.pf_low.value = linearColour(str(params, 'low'));
      uniforms.pf_high.value = linearColour(str(params, 'high'));
      uniforms.pf_glow.value = num(params, 'glow');
      uniforms.pf_level.value = level;
      uniforms.pf_grid.value = num(params, 'grid');
      uniforms.pf_gridSize.value = num(params, 'gridSize');
      uniforms.pf_fade.value = num(params, 'fade');

      const faceted = params['faceted'] === true;
      const wireframe = params['wireframe'] === true;
      if (material.flatShading !== faceted || material.wireframe !== wireframe) {
        material.flatShading = faceted;
        material.wireframe = wireframe;
        material.needsUpdate = true;
      }
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      spectrum.dispose();
    },
  };
}

export const terrainModule = scene3dModule(terrainManifest, buildTerrain, { near: 0.1, far: 200 });
