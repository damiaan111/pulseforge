// Colour conventions (compositor-spec §2–3).
//
// - Colour parameters are authored in sRGB (what a picker means) and converted to linear at use.
// - Everything composites in linear light, premultiplied.
// - Output: tone map → OETF → dither → quantise, once, at the end.

export interface RGBA {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

/** IEC 61966-2-1 sRGB decode. */
export function srgbToLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

export function linearToSrgb(value: number): number {
  return value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
}

/** ITU-R BT.709 OETF. */
export function linearToBt709(value: number): number {
  return value < 0.018 ? 4.5 * value : 1.099 * value ** 0.45 - 0.099;
}

/** Parses #rgb, #rrggbb or #rrggbbaa into straight-alpha sRGB components in 0..1. */
export function parseHexColor(hex: string): RGBA | undefined {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(hex.trim());
  const digits = match?.[1];
  if (digits === undefined) return undefined;
  const full = digits.length === 3 ? [...digits].map((d) => d + d).join('') : digits;
  const byte = (i: number) => parseInt(full.slice(i, i + 2), 16) / 255;
  return { r: byte(0), g: byte(2), b: byte(4), a: full.length === 8 ? byte(6) : 1 };
}

/** sRGB straight-alpha colour → linear premultiplied, ready for the compositor. */
export function toLinearPremultiplied(color: RGBA): RGBA {
  return {
    r: srgbToLinear(color.r) * color.a,
    g: srgbToLinear(color.g) * color.a,
    b: srgbToLinear(color.b) * color.a,
    a: color.a,
  };
}

// ---------------------------------------------------------------------------
// Tone mapping (D7: filmic, highlights roll off keeping hue, single fixed curve).
//
// Implemented as a hue-preserving shoulder: the largest channel passes through a curve
// that is exactly linear up to TONEMAP_KNEE and rolls off exponentially towards 1.0 above
// it; all channels are scaled by the same ratio. Ordinary colours below the knee are left
// exactly as authored, and overdriven glows compress towards the hue's brightest
// displayable version rather than clipping per channel to white.
// ---------------------------------------------------------------------------

export const TONEMAP_KNEE = 0.9;

export function tonemapScalar(x: number): number {
  if (x <= TONEMAP_KNEE) return Math.max(x, 0);
  const span = 1 - TONEMAP_KNEE;
  return TONEMAP_KNEE + span * (1 - Math.exp(-(x - TONEMAP_KNEE) / span));
}

export function tonemap(r: number, g: number, b: number): [number, number, number] {
  const peak = Math.max(r, g, b);
  if (peak <= TONEMAP_KNEE) return [Math.max(r, 0), Math.max(g, 0), Math.max(b, 0)];
  const scale = tonemapScalar(peak) / peak;
  return [Math.max(r * scale, 0), Math.max(g * scale, 0), Math.max(b * scale, 0)];
}

/** GLSL twin of the tone curve and OETFs. Kept beside the TS versions so they change together. */
export const COLOR_GLSL = /* glsl */ `
const float PF_TONEMAP_KNEE = ${TONEMAP_KNEE.toFixed(6)};
vec3 pf_tonemap(vec3 c) {
  c = max(c, vec3(0.0));
  float peak = max(c.r, max(c.g, c.b));
  if (peak <= PF_TONEMAP_KNEE) return c;
  float span = 1.0 - PF_TONEMAP_KNEE;
  float mapped = PF_TONEMAP_KNEE + span * (1.0 - exp(-(peak - PF_TONEMAP_KNEE) / span));
  return c * (mapped / peak);
}
vec3 pf_linear_to_srgb(vec3 c) {
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
  return mix(hi, lo, vec3(lessThanEqual(c, vec3(0.0031308))));
}
vec3 pf_linear_to_bt709(vec3 c) {
  vec3 lo = c * 4.5;
  vec3 hi = 1.099 * pow(c, vec3(0.45)) - 0.099;
  return mix(hi, lo, vec3(lessThan(c, vec3(0.018))));
}
`;
