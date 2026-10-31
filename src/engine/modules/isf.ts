// Interactive Shader Format (https://isf.video): a GLSL fragment shader whose first comment is a JSON
// header naming its inputs. Pure text handling, so the folder scan, the validator and the engine read
// a file the same way; shader-module.ts does the compiling.
//
// What differs from the other dialects, and what the wrapper here does about it:
//
//  - **ISF owns `main()` and writes GLSL 1.x.** The prelude maps `gl_FragColor`, `texture2D` and
//    `varying` onto GLSL ES 3.00 and renames the author's `main`, so a generated `main()` can run
//    code on both sides of it. Nothing rewrites the author's text: desktop GLSL that ES 3.00 refuses
//    (`float x = 1;`) is a compile error on the author's own line, not a guess.
//  - **Inputs are bare uniforms**: `uniform float amount;`, not `u_amount`. So `scale` is a fine name
//    here though it clashes with `u_scale` in the other dialects, and the names that do clash are ISF's
//    own and the ones GLSL ES 3.00 keeps for itself.
//  - **A `long` is its VALUES**, not an index: a list of 1, 2, 4 uploads 4 for the third entry. The
//    enum parameter stores the value as a string, so the uniform can be rebuilt from it.
//  - **A `color` is a display-referred vec4**, where the other dialects get a linear vec3. It has to
//    be: the shader does its arithmetic on display colours.
//  - **Colour.** ISF shaders read and write display-referred, straight-alpha colour, and the compositor
//    works in linear, premultiplied light. So the conversion happens once on each side: every read of
//    the input goes through `pf_isf_read`, the final colour through the decode in `main()`. A shader
//    that passes its input through therefore changes nothing. Neither side clamps above 1, or the
//    round trip would cut highlights off.
//
// Refused, each with its reason, never dropped: inputs with no uniform in the module schema (point2D,
// images other than `inputImage`, audio), imported images, persistent buffers (state carried between
// frames, which would make a frame depend on the frames before it: CLAUDE.md #1) and multiple passes.
// A `.vs` file is refused by the folder scan, the only place that sees the neighbouring files.

import type { ParamSpec } from '../core/params.ts';

export interface ParsedIsf {
  /** `inputImage` makes it an effect; anything else makes its own picture. */
  readonly kind: 'source' | 'effect';
  readonly description?: string;
  readonly version?: string;
  readonly categories: readonly string[];
  readonly params: readonly ParamSpec[];
  /** Why this file cannot run here, as sentences. Empty means it can be compiled. */
  readonly refusals: readonly string[];
}

const GROUP = 'ISF';

/** The identifiers an input cannot take: what the wrapper defines, and GLSL ES 3.00's reserved words. */
const RESERVED_NAMES = new Set([
  'RENDERSIZE', 'TIME', 'TIMEDELTA', 'DATE', 'FRAMEINDEX', 'PASSINDEX', 'main', 'isf_FragNormCoord', 'vv_FragNormCoord',
  'gl_FragColor', 'texture2D', 'varying', 'outColor', 'IMG_SIZE', 'IMG_PIXEL', 'IMG_NORM_PIXEL', 'IMG_THIS_PIXEL', 'IMG_THIS_NORM_PIXEL',
  'active', 'attribute', 'centroid', 'common', 'const', 'filter', 'flat', 'in', 'inline', 'input', 'invariant', 'layout', 'out', 'output',
  'packed', 'partition', 'precision', 'resource', 'sample', 'shared', 'smooth', 'texture', 'uniform',
]);

export function isfNameReserved(name: string): boolean {
  return RESERVED_NAMES.has(name) || /^(u_|pf_|gl_)/.test(name);
}

const finite = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined);

function hexByte(value: number): string {
  return Math.round(Math.min(1, Math.max(0, value)) * 255).toString(16).padStart(2, '0');
}

function hexColor(value: unknown): string {
  const parts = Array.isArray(value) ? value.map((v) => finite(v) ?? 0) : [];
  const [r = 0, g = r, b = r, a = 1] = parts;
  return `#${hexByte(r)}${hexByte(g)}${hexByte(b)}${hexByte(a)}`;
}

function numberRange(input: Readonly<Record<string, unknown>>): { min: number; max: number; default: number } {
  const given = finite(input['DEFAULT']);
  const min = finite(input['MIN']) ?? Math.min(0, given ?? 0);
  let max = finite(input['MAX']) ?? Math.max(1, given ?? 1);
  if (!(min < max)) max = min + 1;
  return { min, max, default: Math.min(max, Math.max(min, given ?? min)) };
}

function longParam(input: Readonly<Record<string, unknown>>, key: string, label: string): ParamSpec {
  const values = Array.isArray(input['VALUES']) ? input['VALUES'].map((v) => finite(v)).filter((v) => v !== undefined) : [];
  if (values.length === 0) {
    const range = numberRange(input);
    return { key, label, group: GROUP, type: 'int', ...range, default: Math.round(range.default), step: 1 };
  }
  const labels: readonly unknown[] = Array.isArray(input['LABELS']) ? input['LABELS'] : [];
  const options = values.map((value, i) => ({ value: String(value), label: text(labels[i]) ?? String(value) }));
  const wanted = String(finite(input['DEFAULT']) ?? values[0]);
  return { key, label, group: GROUP, type: 'enum', default: options.some((o) => o.value === wanted) ? wanted : String(values[0]), options };
}

/** One input as a parameter, or the sentence saying why it cannot be one. `inputImage` is neither: it is the layer's input. */
function inputParam(input: Readonly<Record<string, unknown>>): ParamSpec | string | null {
  const key = input['NAME'];
  const type = input['TYPE'];
  if (typeof key !== 'string' || key === '') return `an input has no NAME: ${JSON.stringify(input)}`;
  const label = text(input['LABEL']) ?? key;
  switch (type) {
    case 'float':
      return { key, label, group: GROUP, type: 'float', ...numberRange(input) };
    case 'long':
      return longParam(input, key, label);
    case 'bool':
    case 'event':
      return { key, label, group: GROUP, type: 'bool', default: input['DEFAULT'] === true || (finite(input['DEFAULT']) ?? 0) > 0 };
    case 'color':
      return { key, label, group: GROUP, type: 'color', default: hexColor(input['DEFAULT']), allowAlpha: true };
    case 'image':
      if (key === 'inputImage') return null;
      return `image input "${key}": only inputImage has a texture here; the module schema has no other image uniform`;
    case 'point2D':
      return `point2D input "${key}": the module schema has no uniform type for a point`;
    case 'audio':
    case 'audioFFT':
      return `${type} input "${key}": an ISF audio image has no equivalent here`;
    default:
      return `input "${key}" has the unknown type "${String(type)}"`;
  }
}

function header(source: string): { value: Readonly<Record<string, unknown>> } | { problem: string } {
  const comment = /\/\*([\s\S]*?)\*\//.exec(source)?.[1];
  if (comment === undefined) return { problem: 'no ISF header: the file must open with a /*{ JSON }*/ comment' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(comment);
  } catch (first) {
    try {
      // Hand-written headers often carry a trailing comma, which ISF's own editors tolerate.
      parsed = JSON.parse(comment.replace(/,(\s*[}\]])/g, '$1'));
    } catch {
      return { problem: `the ISF header is not valid JSON: ${(first as Error).message}` };
    }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { problem: 'the ISF header must be a JSON object' };
  return { value: parsed as Readonly<Record<string, unknown>> };
}

function passRefusals(json: Readonly<Record<string, unknown>>): string[] {
  const refusals: string[] = [];
  const passes: readonly unknown[] = Array.isArray(json['PASSES']) ? json['PASSES'] : [];
  const persistent = passes.flatMap((pass) => {
    const p = pass as Readonly<Record<string, unknown>> | null;
    return p?.['PERSISTENT'] === true || p?.['PERSISTENT'] === 1 ? [String(p['TARGET'])] : [];
  });
  const declared = json['PERSISTENT_BUFFERS'];
  if (declared !== undefined) {
    persistent.push(...(Array.isArray(declared) ? declared.map(String) : Object.keys(declared as object)));
  }
  if (persistent.length > 0) refusals.push(`PERSISTENT buffer "${[...new Set(persistent)].join('", "')}": state kept between frames would make a frame depend on the ones before it`);
  if (passes.length > 1) {
    refusals.push(`${passes.length} PASSES: only a single pass is supported`);
  } else if (persistent.length === 0) {
    const pass = passes[0] as Readonly<Record<string, unknown>> | null | undefined;
    if (pass?.['TARGET'] !== undefined) refusals.push(`pass target "${String(pass['TARGET'])}": a single pass draws straight to the layer`);
  }
  return refusals;
}

/** Reads a file's header. Pure, and never throws: whatever is wrong comes back in `refusals`. */
export function parseIsf(source: string): ParsedIsf {
  const found = header(source);
  if ('problem' in found) return { kind: 'source', categories: [], params: [], refusals: [found.problem] };
  const json = found.value;

  const refusals = passRefusals(json);
  const params: ParamSpec[] = [];
  let effect = false;
  const inputs: readonly unknown[] = Array.isArray(json['INPUTS']) ? json['INPUTS'] : [];
  for (const input of inputs) {
    const fields = (input ?? {}) as Readonly<Record<string, unknown>>;
    const param = inputParam(fields);
    if (param === null) effect = true;
    else if (typeof param === 'string') refusals.push(param);
    else params.push(param);
  }
  const imported = json['IMPORTED'];
  if (imported !== undefined && Object.keys(imported as object).length > 0) refusals.push('IMPORTED image: a shader cannot bring its own image files here');

  const description = [text(json['DESCRIPTION']), text(json['CREDIT'])].filter((part) => part !== undefined).join(' — ');
  const version = text(json['VSN']);
  const categories = Array.isArray(json['CATEGORIES']) ? json['CATEGORIES'].flatMap((c) => text(c) ?? []) : [];
  return {
    kind: effect ? 'effect' : 'source',
    ...(description === '' ? {} : { description }),
    ...(version === undefined ? {} : { version }),
    categories,
    params,
    refusals,
  };
}

function uniformType(spec: ParamSpec): string {
  switch (spec.type) {
    case 'bool': return 'bool';
    case 'int':
    case 'enum': return 'int';
    case 'color': return 'vec4';
    default: return 'float';
  }
}

/**
 * Goes after the shared prelude. `u_time` and the like are reused rather than declared twice, which
 * is also why TIME is the timeline's time and DATE is fixed but for `.w`, as `iDate` is for Shadertoy:
 * the wall clock must not reach a shader (CLAUDE.md #1).
 */
export function isfPrelude(kind: 'visualizer' | 'source' | 'effect', params: readonly ParamSpec[]): string {
  const inputs = params.map((p) => `uniform ${uniformType(p)} ${p.key};`).join('\n');
  return `uniform float pf_isf_timedelta;
vec4 pf_isf_color;
vec2 isf_FragNormCoord;
vec3 pf_isf_encode(vec3 c) {
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
  return mix(hi, lo, vec3(lessThanEqual(c, vec3(0.0031308))));
}
vec3 pf_isf_decode(vec3 c) {
  vec3 lo = c / 12.92;
  vec3 hi = pow((c + 0.055) / 1.055, vec3(2.4));
  return mix(hi, lo, vec3(lessThanEqual(c, vec3(0.04045))));
}
vec4 pf_isf_display(vec4 c) {
  float a = clamp(c.a, 0.0, 1.0);
  return vec4(a > 0.0 ? pf_isf_encode(max(c.rgb, vec3(0.0)) / a) : vec3(0.0), a);
}
vec4 pf_isf_read(sampler2D image, vec2 uv) { return pf_isf_display(texture(image, uv)); }
vec4 pf_isf_read(sampler2D image, vec2 uv, float bias) { return pf_isf_display(texture(image, uv, bias)); }
#define gl_FragColor pf_isf_color
#define texture2D pf_isf_read
#define varying in
#define vv_FragNormCoord isf_FragNormCoord
#define RENDERSIZE u_resolution
#define TIME u_time
#define TIMEDELTA pf_isf_timedelta
#define FRAMEINDEX u_frame
#define PASSINDEX 0
#define DATE vec4(2000.0, 1.0, 1.0, u_time)
#define IMG_SIZE(image) vec2(textureSize(image, 0))
#define IMG_NORM_PIXEL(image, uv) pf_isf_read(image, uv)
#define IMG_PIXEL(image, xy) pf_isf_read(image, (xy) / IMG_SIZE(image))
#define IMG_THIS_NORM_PIXEL(image) pf_isf_read(image, isf_FragNormCoord)
#define IMG_THIS_PIXEL(image) pf_isf_read(image, isf_FragNormCoord)
${kind === 'effect' ? '#define inputImage u_input\n#define _inputImage_imgSize IMG_SIZE(u_input)\n#define _inputImage_imgRect vec4(0.0, 0.0, 1.0, 1.0)\n#define _inputImage_flip false' : ''}
${inputs}
#define main pf_isf_main
`;
}

/** After the author's code: runs it at this pixel and turns its display colour into linear, premultiplied light. */
export const ISF_MAIN = `
#undef main
void main() {
  isf_FragNormCoord = gl_FragCoord.xy / u_resolution;
  pf_isf_color = vec4(0.0, 0.0, 0.0, 1.0);
  pf_isf_main();
  float a = clamp(pf_isf_color.a, 0.0, 1.0);
  outColor = vec4(pf_isf_decode(max(pf_isf_color.rgb, vec3(0.0))) * a, a);
}
`;
