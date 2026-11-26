// The 3D camera rig (M37, compositor-spec §7.3): closed-form, seeded, and aspect-aware.

import { describe, expect, it } from 'vitest';

import { resolveParams, type ParamValues } from '../../src/engine/core/params.ts';
import { createPrng } from '../../src/engine/core/prng.ts';
import { cameraParams, cameraPose, driftNoise } from '../../src/engine/modules/scene3d/camera.ts';

const SPECS = cameraParams({ distance: 10, height: 2, fov: 50, speed: 30 });

function params(overrides: Record<string, unknown> = {}): ParamValues {
  const resolved = resolveParams(SPECS, overrides);
  expect(resolved.issues).toEqual([]);
  return resolved.values;
}

const prng = createPrng(7);
const distanceOf = (pose: { position: readonly number[] }) => Math.hypot(pose.position[0]!, pose.position[2]!);

describe('camera rig', () => {
  it('orbits at the set speed, starting from the start angle', () => {
    const p = params({ rig: 'orbit', kick: 0 });
    const start = cameraPose(p, 0, 0, prng, 16 / 9);
    expect(start.position[0]).toBeCloseTo(0);
    expect(start.position[2]).toBeCloseTo(10);
    expect(start.position[1]).toBe(2);
    // 30 °/s for 3 s is a quarter turn: the camera is now on the +x side.
    const quarter = cameraPose(p, 3, 0, prng, 16 / 9);
    expect(quarter.position[0]).toBeCloseTo(10);
    expect(quarter.position[2]).toBeCloseTo(0);
  });

  it('holds still on the static rig', () => {
    const p = params({ rig: 'static', angle: 45, kick: 0 });
    expect(cameraPose(p, 0, 0, prng, 1)).toEqual(cameraPose(p, 12.5, 0, prng, 1));
  });

  it('dollies in and back out over one cycle', () => {
    const p = params({ rig: 'dolly', kick: 0 });
    // 30 °/s: half a cycle at 6 s (closest), a full cycle at 12 s (back where it began).
    expect(distanceOf(cameraPose(p, 0, 0, prng, 1))).toBeCloseTo(10);
    expect(distanceOf(cameraPose(p, 6, 0, prng, 1))).toBeCloseTo(6);
    expect(distanceOf(cameraPose(p, 12, 0, prng, 1))).toBeCloseTo(10);
  });

  it('pushes in on the beat by the kick amount', () => {
    const p = params({ rig: 'static', kick: 1 });
    expect(distanceOf(cameraPose(p, 0, 1, prng, 1))).toBeCloseTo(10 * (1 - 0.18));
    expect(distanceOf(cameraPose(p, 0, 0, prng, 1))).toBeCloseTo(10);
  });

  it('keeps the field of view on the short side of the frame', () => {
    const p = params({ fov: 50 });
    expect(cameraPose(p, 0, 0, prng, 16 / 9).fov).toBeCloseTo(50);
    // Portrait: three's fov is vertical, so it widens until the horizontal angle is 50°.
    const tall = cameraPose(p, 0, 0, prng, 9 / 16).fov;
    const horizontal = 2 * Math.atan(Math.tan((tall * Math.PI) / 360) * (9 / 16)) * (180 / Math.PI);
    expect(horizontal).toBeCloseTo(50);
  });

  it('drifts on the handheld rig, reproducibly, and differently for another seed', () => {
    const p = params({ rig: 'handheld', kick: 0 });
    const a = cameraPose(p, 4.2, 0, createPrng(7), 1);
    const again = cameraPose(p, 4.2, 0, createPrng(7), 1);
    const other = cameraPose(p, 4.2, 0, createPrng(8), 1);
    expect(again).toEqual(a);
    expect(other).not.toEqual(a);
    // It is drift, not teleporting: within a few percent of the reach.
    expect(Math.abs(a.position[0])).toBeLessThan(1.5);
  });

  it('drift noise is smooth and in range', () => {
    let previous = driftNoise(prng, 'x', 0);
    for (let x = 0.01; x < 10; x += 0.01) {
      const value = driftNoise(prng, 'x', x);
      expect(Math.abs(value)).toBeLessThanOrEqual(1);
      // Cosine interpolation between steps: no jumps between neighbouring samples.
      expect(Math.abs(value - previous)).toBeLessThan(0.05);
      previous = value;
    }
  });
});
