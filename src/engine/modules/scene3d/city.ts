// core.scene3d.city — a city of bars (M37).
//
// PROJECT.md §8's "instanced bar city": a grid of towers, one draw call for all of them, each
// tower's height the spectrum at its band. Three layouts decide which tower hears which band:
//
//   downtown  bass in the middle, highs at the outskirts — a skyline that swells from the centre
//   history   bands across, time along: the city is a 3D spectrogram, scrolling like the terrain
//   scatter   each tower draws its band from the seeded PRNG, so the city looks built, not graphed
//
// Heights are a pure function of the frame: the current spectrum for downtown and scatter, and for
// history the spectrum on a fixed time grid with the rows slid by the elapsed fraction — the same
// construction as the terrain, so neither carries anything from one frame to the next.

import {
  BoxGeometry, Color, DirectionalLight, HemisphereLight, InstancedMesh, Matrix4, MeshStandardMaterial, Scene,
} from 'three';
import { sampleTrackInto } from '../../core/analysis.ts';
import type { ModuleManifest } from '../../core/module.ts';
import { num, str } from '../../core/params.ts';
import { cameraParams } from './camera.ts';
import { linearColour, reactivityParams, scene3dModule, type SceneContent } from './scene-module.ts';

const MAX_SIDE = 48;
const SPACING = 1.2;

export const cityManifest: ModuleManifest = {
  id: 'core.scene3d.city',
  version: '0.1.0',
  kind: 'scene3d',
  name: 'Bar city',
  description: 'A grid of towers, each rising with its part of the spectrum',
  category: '3d',
  tags: ['3d', 'bars', 'city', 'skyline', 'spectrum', 'instanced'],
  capabilities: { needsAnalysis: true, needsInput: false, supportsAspect: true, stateful: false, gpuCost: 'high' },
  paramsSchemaVersion: 1,
  params: [
    ...reactivityParams('beat'),
    {
      key: 'layout', label: 'Layout', group: 'City', type: 'enum', default: 'downtown',
      options: [
        { value: 'downtown', label: 'Downtown (bass in the middle)' },
        { value: 'history', label: 'History (time runs back)' },
        { value: 'scatter', label: 'Scatter' },
      ],
    },
    { key: 'size', label: 'Blocks per side', group: 'City', type: 'int', default: 20, min: 4, max: MAX_SIDE },
    { key: 'height', label: 'Height', group: 'City', type: 'float', default: 5, min: 0.2, max: 30, softMax: 12, unit: 'units' },
    { key: 'base', label: 'Base height', group: 'City', type: 'float', default: 0.15, min: 0, max: 5, unit: 'units' },
    { key: 'width', label: 'Tower width', group: 'City', type: 'float', default: 0.75, min: 0.1, max: 1 },
    { key: 'jitter', label: 'Variety', group: 'City', type: 'float', default: 0.35, min: 0, max: 1, description: 'Seeded differences between towers' },
    { key: 'flow', label: 'Rows per second', group: 'City', type: 'float', default: 8, min: 0.5, max: 60, visibleWhen: { param: 'layout', equals: 'history' } },
    { key: 'low', label: 'Low colour', group: 'Look', type: 'color', default: '#3a7bff', paletteRole: 'primary' },
    { key: 'high', label: 'Peak colour', group: 'Look', type: 'color', default: '#ff2d95', paletteRole: 'accent' },
    { key: 'glow', label: 'Glow', group: 'Look', type: 'float', default: 0.8, min: 0, max: 4, softMax: 2 },
    { key: 'fade', label: 'Horizon', group: 'Look', type: 'float', default: 70, min: 10, max: 150, unit: 'units' },
    ...cameraParams({ distance: 24, height: 13, lookHeight: 1, fov: 45, speed: 8 }),
  ],
};

function buildCity(): SceneContent {
  const scene = new Scene();
  const geometry = new BoxGeometry(1, 1, 1);
  geometry.translate(0, 0.5, 0);
  const uniforms = { pf_glow: { value: 0 }, pf_fade: { value: 70 } };
  const material = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.45, metalness: 0.2 });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform float pf_glow;
uniform float pf_fade;`)
      // vColor is the tower's instance colour, which already carries its level.
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
totalEmissiveRadiance += vColor.rgb * pf_glow;`)
      .replace('#include <dithering_fragment>', `#include <dithering_fragment>
gl_FragColor *= 1.0 - smoothstep(pf_fade * 0.6, pf_fade, length(vViewPosition));`);
  };
  material.customProgramCacheKey = () => 'pulseforge.scene3d.city';

  const mesh = new InstancedMesh(geometry, material, MAX_SIDE * MAX_SIDE);
  // Three culls an instanced mesh by the bounds of instance 0 unless told otherwise, and towers
  // move every frame; culling a whole city because one tower left the frame is not an option.
  mesh.frustumCulled = false;
  scene.add(mesh);

  const sky = new HemisphereLight(0xffffff, 0x000000, 0.45);
  const key = new DirectionalLight(0xffffff, 1.8);
  key.position.set(5, 9, 4);
  scene.add(sky, key);

  const matrix = new Matrix4();
  const colour = new Color();
  const lowColour = new Color();
  const highColour = new Color();
  let row = new Float32Array(0);
  let rows = new Float32Array(0);

  return {
    scene,
    update({ ctx, params, spectrum, source, level }) {
      const side = Math.min(MAX_SIDE, Math.max(1, Math.round(num(params, 'size'))));
      const layout = str(params, 'layout');
      const height = num(params, 'height');
      const base = num(params, 'base');
      const width = num(params, 'width') * SPACING;
      const jitter = num(params, 'jitter');
      lowColour.setRGB(...linearColour(str(params, 'low')));
      highColour.setRGB(...linearColour(str(params, 'high')));
      const bins = spectrum.length;

      // Spectrum at a fractional band, linearly interpolated between bins.
      const at = (values: Float32Array, offset: number, band: number): number => {
        if (bins === 0) return 0;
        const x = Math.min(1, Math.max(0, band)) * (bins - 1);
        const i = Math.floor(x);
        const f = x - i;
        return (values[offset + i] ?? 0) * (1 - f) + (values[offset + Math.min(bins - 1, i + 1)] ?? 0) * f;
      };

      // History: one row of the grid per step back in time, slid by the elapsed part of a step.
      let slide = 0;
      if (layout === 'history') {
        const step = 1 / Math.max(0.5, num(params, 'flow'));
        const newest = Math.floor(ctx.audioSeconds / step) * step;
        slide = (ctx.audioSeconds - newest) / step;
        if (rows.length !== side * bins) rows = new Float32Array(side * bins);
        if (row.length !== bins) row = new Float32Array(bins);
        for (let k = 0; k < side && source !== undefined && bins > 0; k += 1) {
          sampleTrackInto(source.spectrum, newest - k * step, row);
          rows.set(row, k * bins);
        }
        if (source === undefined) rows.fill(0);
      }

      const half = (side - 1) / 2;
      let index = 0;
      for (let z = 0; z < side; z += 1) {
        for (let x = 0; x < side; x += 1) {
          const variety = 1 + jitter * (ctx.prng('city', x, z) - 0.5);
          let value: number;
          let px = (x - half) * SPACING;
          let pz = (z - half) * SPACING;
          if (layout === 'history') {
            value = at(rows, z * bins, side === 1 ? 0 : x / (side - 1));
            // Newest row nearest the camera's default side (+z), moving back.
            pz = (half - z - slide) * SPACING;
          } else if (layout === 'scatter') {
            value = at(spectrum, 0, ctx.prng('city-band', x, z));
          } else {
            const reach = Math.hypot(x - half, z - half) / Math.max(1, Math.hypot(half, half));
            value = at(spectrum, 0, reach);
          }
          if (layout !== 'history') {
            // A little seeded offset so the grid does not read as graph paper.
            px += (ctx.prng('city-x', x, z) - 0.5) * jitter * 0.3 * SPACING;
            pz += (ctx.prng('city-z', x, z) - 0.5) * jitter * 0.3 * SPACING;
          }
          const h = Math.max(0.001, base + value * height * variety);
          matrix.makeScale(width, h, width);
          matrix.setPosition(px, 0, pz);
          mesh.setMatrixAt(index, matrix);
          const heat = Math.min(1, value * (0.6 + 0.4 * level) * 1.4);
          colour.copy(lowColour).lerp(highColour, heat).multiplyScalar(0.35 + heat);
          mesh.setColorAt(index, colour);
          index += 1;
        }
      }
      mesh.count = index;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
      uniforms.pf_glow.value = num(params, 'glow');
      uniforms.pf_fade.value = num(params, 'fade');
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      mesh.dispose();
    },
  };
}

export const cityModule = scene3dModule(cityManifest, buildCity);
