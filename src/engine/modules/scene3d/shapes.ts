// core.scene3d.shapes — a lit shape whose surface is pushed out by the spectrum (M37).
//
// Reactive geometry, the first of PROJECT.md §8's 3D looks: a sphere, torus or knot, displaced
// along its normals by the spectrum on the GPU, pulsing with the chosen feature and lit by a key
// and a rim light in the palette's colours. Each surface point listens to one part of the
// spectrum, chosen from its position so the displacement is continuous across the mesh's UV
// seams — a crack along a seam is the classic mistake with this effect.
//
// Faceted shading (the default) takes its normals from screen-space derivatives, which is what
// makes displaced geometry light correctly without recomputing normals every frame.

import {
  Color, DirectionalLight, HemisphereLight, IcosahedronGeometry, Mesh, MeshStandardMaterial, Scene,
  TorusGeometry, TorusKnotGeometry, type BufferGeometry,
} from 'three';
import type { ModuleManifest } from '../../core/module.ts';
import { num, str, type ParamValues } from '../../core/params.ts';
import { cameraParams } from './camera.ts';
import {
  SCENE_SPECTRUM_GLSL, SpectrumTexture, linearColour, reactivityParams, scene3dModule, spectrumUniforms,
  syncSpectrumUniforms, type SceneContent,
} from './scene-module.ts';

export const shapesManifest: ModuleManifest = {
  id: 'core.scene3d.shapes',
  version: '0.1.0',
  kind: 'scene3d',
  name: 'Reactive shape',
  description: 'A lit 3D shape whose surface is pushed out by the spectrum',
  category: '3d',
  tags: ['3d', 'geometry', 'sphere', 'torus', 'cinematic'],
  capabilities: { needsAnalysis: true, needsInput: false, supportsAspect: true, stateful: false, gpuCost: 'high' },
  paramsSchemaVersion: 1,
  params: [
    ...reactivityParams('beat'),
    {
      key: 'shape', label: 'Shape', group: 'Shape', type: 'enum', default: 'sphere',
      options: [{ value: 'sphere', label: 'Sphere' }, { value: 'torus', label: 'Torus' }, { value: 'knot', label: 'Knot' }],
    },
    { key: 'size', label: 'Size', group: 'Shape', type: 'float', default: 1.4, min: 0.1, max: 6, softMax: 3, unit: 'units' },
    { key: 'displace', label: 'Displacement', group: 'Shape', type: 'float', default: 0.45, min: 0, max: 2, softMax: 1, description: 'How far the spectrum pushes the surface out' },
    { key: 'ripples', label: 'Ripples', group: 'Shape', type: 'int', default: 5, min: 0, max: 24, description: 'Waves around the surface' },
    { key: 'pulse', label: 'Pulse', group: 'Shape', type: 'float', default: 0.15, min: 0, max: 1, description: 'Grows the shape with the driving feature' },
    { key: 'spin', label: 'Spin', group: 'Shape', type: 'float', default: 18, min: -180, max: 180, softMin: -60, softMax: 60, unit: '°/s' },
    { key: 'tilt', label: 'Tilt', group: 'Shape', type: 'float', default: 20, min: -90, max: 90, unit: '°' },
    { key: 'color', label: 'Colour', group: 'Look', type: 'color', default: '#3a7bff', paletteRole: 'primary' },
    { key: 'rim', label: 'Rim light', group: 'Look', type: 'color', default: '#ff2d95', paletteRole: 'accent' },
    { key: 'glow', label: 'Glow', group: 'Look', type: 'float', default: 0.6, min: 0, max: 4, softMax: 2, description: 'Self-illumination with the driving feature' },
    { key: 'metalness', label: 'Metalness', group: 'Look', type: 'float', default: 0.25, min: 0, max: 1 },
    { key: 'roughness', label: 'Roughness', group: 'Look', type: 'float', default: 0.35, min: 0.02, max: 1 },
    { key: 'faceted', label: 'Faceted', group: 'Look', type: 'bool', default: true },
    { key: 'wireframe', label: 'Wireframe', group: 'Look', type: 'bool', default: false },
    ...cameraParams({ distance: 5.5, height: 1.2, fov: 45, speed: 10 }),
  ],
};

const SHAPES = ['sphere', 'torus', 'knot'] as const;
type Shape = (typeof SHAPES)[number];

const DEG = Math.PI / 180;

function createGeometry(shape: Shape): BufferGeometry {
  switch (shape) {
    case 'sphere':
      return new IcosahedronGeometry(1, 14);
    case 'torus':
      return new TorusGeometry(0.9, 0.36, 64, 192);
    case 'knot':
      return new TorusKnotGeometry(0.75, 0.24, 320, 40);
  }
}

function buildShapes(): SceneContent {
  const scene = new Scene();
  const spectrum = new SpectrumTexture();
  const uniforms = {
    ...spectrumUniforms(spectrum),
    pf_shape: { value: 0 },
    pf_amount: { value: 0 },
    pf_ripples: { value: 0 },
    pf_time: { value: 0 },
  };
  const material = new MeshStandardMaterial();
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
uniform int pf_shape;
uniform float pf_amount;
uniform float pf_ripples;
uniform float pf_time;
${SCENE_SPECTRUM_GLSL}`)
      .replace('#include <begin_vertex>', `
vec3 transformed = vec3(position);
float pf_band;
float pf_wave;
if (pf_shape == 0) {
  // Sphere: latitude picks the band, mirrored — bass round the equator, highs at both poles,
  // so the shape stays balanced instead of growing a lump on one side.
  vec3 pf_n = normalize(position);
  pf_band = abs(pf_n.y);
  pf_wave = sin(atan(pf_n.z, pf_n.x) * pf_ripples + pf_time * 1.3);
} else if (pf_shape == 1) {
  // Torus: the angle around the ring picks the band, mirrored so both halves agree.
  pf_band = abs(atan(position.y, position.x)) / PI;
  pf_wave = sin(uv.y * 2.0 * PI * pf_ripples + pf_time * 1.3);
} else {
  // Knot: distance along the knot, folded so the two ends meet on the same band.
  pf_band = abs(uv.x * 2.0 - 1.0);
  pf_wave = sin(uv.y * 2.0 * PI * pf_ripples + pf_time * 1.3);
}
// A tube is thinner than the sphere's radius, so it takes half the push or it tears into fins.
float pf_scale = pf_shape == 0 ? 1.0 : 0.5;
transformed += normal * pf_spectrumRow(pf_band, 0) * pf_amount * pf_scale * (0.65 + 0.35 * pf_wave);
`);
  };
  material.customProgramCacheKey = () => 'pulseforge.scene3d.shapes';

  const geometries = new Map<Shape, BufferGeometry>();
  const mesh = new Mesh(createGeometry('sphere'), material);
  geometries.set('sphere', mesh.geometry);
  scene.add(mesh);

  const sky = new HemisphereLight(0xffffff, 0x000000, 0.35);
  const key = new DirectionalLight(0xffffff, 2.2);
  key.position.set(3, 4, 5);
  const rim = new DirectionalLight(0xffffff, 3);
  rim.position.set(-4, 1.5, -4);
  scene.add(sky, key, rim);

  const scratch = new Color();

  return {
    scene,
    update({ params, t, spectrum: current, level }) {
      const shape = str(params, 'shape') as Shape;
      let geometry = geometries.get(shape);
      if (geometry === undefined) {
        geometry = createGeometry(shape);
        geometries.set(shape, geometry);
      }
      mesh.geometry = geometry;

      const data = spectrum.begin(current.length, 1);
      data.set(current.length > 0 ? current : [0]);
      spectrum.commit();
      syncSpectrumUniforms(uniforms, spectrum);
      uniforms.pf_shape.value = SHAPES.indexOf(shape);
      uniforms.pf_amount.value = num(params, 'displace');
      uniforms.pf_ripples.value = num(params, 'ripples');
      uniforms.pf_time.value = t;

      const size = num(params, 'size') * (1 + num(params, 'pulse') * level);
      mesh.scale.setScalar(size);
      mesh.rotation.set(num(params, 'tilt') * DEG, num(params, 'spin') * t * DEG, 0);

      setMaterial(material, params, level, scratch);
      rim.color.setRGB(...linearColour(str(params, 'rim')));
    },
    dispose() {
      for (const geometry of geometries.values()) geometry.dispose();
      material.dispose();
      spectrum.dispose();
    },
  };
}

function setMaterial(material: MeshStandardMaterial, params: ParamValues, level: number, scratch: Color): void {
  const colour = linearColour(str(params, 'color'));
  material.color.setRGB(...colour);
  material.emissive.copy(scratch.setRGB(...colour));
  material.emissiveIntensity = num(params, 'glow') * level;
  material.metalness = num(params, 'metalness');
  material.roughness = num(params, 'roughness');
  const faceted = params['faceted'] === true;
  const wireframe = params['wireframe'] === true;
  if (material.flatShading !== faceted || material.wireframe !== wireframe) {
    material.flatShading = faceted;
    material.wireframe = wireframe;
    material.needsUpdate = true;
  }
}

export const shapesModule = scene3dModule(shapesManifest, buildShapes);
