// The camera rig shared by every 3D scene (M37, compositor-spec §7.3).
//
// The camera is parameters like anything else — distance, height, field of view, roll — so it is
// modulatable and animatable, and "camera kick on the drop" is a modulation binding or the kick
// amount below, never special-cased code. A rig reduces those parameters to the common moves:
//
//   orbit     circles the subject at `speed` degrees per second
//   dolly     pushes in and pulls out, one cycle every 360 / `speed` seconds
//   static    holds the start angle
//   handheld  static, with seeded drift (the `shake` amount, at least a little)
//
// `cameraPose` is a pure function of (params, t, kick, prng, aspect): closed-form motion only,
// no springs or damping carried between frames, so a scrubbed frame and a played one agree.

import type { FloatParam, EnumParam, ParamSpec, ParamValues } from '../../core/params.ts';
import { num, str } from '../../core/params.ts';
import type { Prng } from '../../core/prng.ts';

export const CAMERA_RIGS = ['orbit', 'dolly', 'static', 'handheld'] as const;
export type CameraRig = (typeof CAMERA_RIGS)[number];

export interface CameraDefaults {
  readonly rig?: CameraRig;
  readonly distance: number;
  readonly height: number;
  readonly lookHeight?: number;
  readonly fov?: number;
  readonly speed?: number;
}

/** The camera's parameters, with scene-specific defaults. Grouped under "Camera" in the inspector. */
export function cameraParams(defaults: CameraDefaults): ParamSpec[] {
  const rig: EnumParam = {
    key: 'rig', label: 'Move', group: 'Camera', type: 'enum', default: defaults.rig ?? 'orbit',
    options: [
      { value: 'orbit', label: 'Orbit' },
      { value: 'dolly', label: 'Dolly' },
      { value: 'static', label: 'Static' },
      { value: 'handheld', label: 'Handheld' },
    ],
  };
  const float = (spec: Omit<FloatParam, 'type' | 'group'>): FloatParam => ({ ...spec, type: 'float', group: 'Camera' });
  return [
    rig,
    float({ key: 'distance', label: 'Distance', default: defaults.distance, min: 0.5, max: 60, softMax: 30, unit: 'units' }),
    float({ key: 'height', label: 'Height', default: defaults.height, min: -30, max: 30, softMin: -10, softMax: 15, unit: 'units' }),
    float({ key: 'lookHeight', label: 'Look at height', default: defaults.lookHeight ?? 0, min: -20, max: 20, unit: 'units', advanced: true }),
    float({
      key: 'fov', label: 'Field of view', default: defaults.fov ?? 50, min: 10, max: 110, unit: '°',
      description: 'Across the shorter side of the frame, so a vertical cut shows the same subject',
    }),
    float({ key: 'speed', label: 'Speed', default: defaults.speed ?? 12, min: -180, max: 180, softMin: -60, softMax: 60, unit: '°/s' }),
    float({ key: 'angle', label: 'Start angle', default: 0, min: -180, max: 180, unit: '°' }),
    float({ key: 'roll', label: 'Roll', default: 0, min: -180, max: 180, softMin: -30, softMax: 30, unit: '°' }),
    float({ key: 'shake', label: 'Shake', default: 0, min: 0, max: 1, description: 'Seeded handheld drift' }),
    float({ key: 'kick', label: 'Beat kick', default: 0.3, min: 0, max: 1, description: 'Pushes in on each beat' }),
  ];
}

export interface CameraPose {
  readonly position: readonly [number, number, number];
  readonly target: readonly [number, number, number];
  /** Vertical field of view in degrees, for this aspect. */
  readonly fov: number;
  /** Roll about the view axis, radians. */
  readonly roll: number;
}

const DEG = Math.PI / 180;

/**
 * Smooth seeded noise in -1..1: random values at integer steps of `x`, cosine-interpolated.
 * Keyed on the project seed, so "Surprise me" changes the drift and a render reproduces it.
 */
export function driftNoise(prng: Prng, key: string, x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const a = prng('camera-drift', key, i) * 2 - 1;
  const b = prng('camera-drift', key, i + 1) * 2 - 1;
  const w = (1 - Math.cos(f * Math.PI)) / 2;
  return a + (b - a) * w;
}

/**
 * The camera for time `t` (timeline seconds). `kick` is this frame's beat envelope, 0..1.
 * `aspect` is width / height: the field of view applies to the shorter side.
 */
export function cameraPose(params: ParamValues, t: number, kick: number, prng: Prng, aspect: number): CameraPose {
  const rig = str(params, 'rig') as CameraRig;
  const speed = num(params, 'speed');
  let angle = num(params, 'angle') * DEG;
  let distance = num(params, 'distance');
  if (rig === 'orbit') angle += speed * t * DEG;
  if (rig === 'dolly') distance *= 1 - 0.4 * (0.5 - 0.5 * Math.cos(speed * t * DEG));
  // The kick pushes in rather than zooming: it reads as the camera reacting, not the lens.
  distance *= 1 - 0.18 * num(params, 'kick') * Math.min(1, Math.max(0, kick));
  distance = Math.max(0.05, distance);

  const height = num(params, 'height');
  const lookHeight = num(params, 'lookHeight');
  const shake = rig === 'handheld' ? Math.max(0.35, num(params, 'shake')) : num(params, 'shake');
  let position: [number, number, number] = [Math.sin(angle) * distance, height, Math.cos(angle) * distance];
  let target: [number, number, number] = [0, lookHeight, 0];
  let roll = num(params, 'roll') * DEG;
  if (shake > 0) {
    // Two rates per axis, like a hand: a slow sway and a faster tremor.
    const sway = (key: string) => driftNoise(prng, key, t * 0.35) + 0.35 * driftNoise(prng, `${key}-fast`, t * 1.7);
    const reach = shake * 0.06 * Math.hypot(distance, height - lookHeight);
    position = [position[0] + sway('px') * reach, position[1] + sway('py') * reach, position[2] + sway('pz') * reach];
    target = [target[0] + sway('tx') * reach * 0.5, target[1] + sway('ty') * reach * 0.5, target[2]];
    roll += sway('roll') * shake * 2.5 * DEG;
  }

  const fov = Math.min(170, Math.max(1, num(params, 'fov')));
  // Three's fov is vertical. On a portrait frame the width is the short side, so widen the
  // vertical angle until the horizontal one equals the chosen field of view.
  const vertical = aspect >= 1 ? fov : 2 * Math.atan(Math.tan((fov * DEG) / 2) / aspect) / DEG;
  return { position, target, fov: Math.min(170, vertical), roll };
}
