// Drop-in shader modules (M35, PROJECT.md §8.17, module-spec §12).
//
// A drop-in module is **data**: a manifest (id, name, kind, parameter schema) and a GLSL fragment
// shader. No JavaScript from the modules folder ever runs. That is a deliberate v1 choice, not a
// limitation that went unnoticed:
//
//  - The studio renderer is sandboxed with a strict CSP (src/shell/main.ts). Executing a folder's
//    JavaScript there would mean loosening that — a trust decision module-spec §12 leaves open.
//  - Every built-in module is already one shader plus a schema. A shader and a schema can express
//    the same range of looks, and a shader cannot read the clock, the network or `Math.random`,
//    so a drop-in module is **deterministic by construction** (CLAUDE.md #1).
//  - The same data crosses IPC to the preview and a config file to the export renderer, so both
//    compile the identical source.
//
// The module's shader gets a fixed prelude: resolution, time, frame, the layer's reference scale,
// the audio features and spectrum of a chosen stem, a seeded hash, the input (for effects), and
// one uniform per declared parameter — `u_<key>`. The author writes `main()`.
//
// **Shadertoy dialect** (S2): with `"dialect": "shadertoy"` in module.json — or a bare `.glsl` file
// dropped in the folder — the author writes Shadertoy's `mainImage(out vec4 fragColor, in vec2
// fragCoord)` and reads `iResolution`, `iTime`, `iFrame`, `iChannel0…3` and the rest. The prelude
// declares them (on top of everything above), a generated `main()` after the author's code calls
// `mainImage`, and turns its display-referred colour into the linear, premultiplied light the
// compositor works in. Clock-based inputs become timeline-based: `iDate` is fixed but for `.w`
// (timeline seconds) and `iMouse` is zero, so a Shadertoy shader is as deterministic as any module.
//
// **ISF dialect**: a `.fs` file in the folder, or `"dialect": "isf"` in module.json. See isf.ts.

import type { ModuleDefinition, ModuleInstance, ModuleKind, ModuleManifest, RenderContext } from '../core/module.ts';
import { parseHexColor, srgbToLinear } from '../core/color.ts';
import { STEMS, type ParamSpec, type ParamValues, type Stem } from '../core/params.ts';
import { HASH_GLSL, hash32 } from '../core/prng.ts';
import { FULLSCREEN_VERT, ShaderCompileError, createProgram, drawFullscreenTriangle } from '../render/gl.ts';
import { AnalysisTexture, SPECTRUM_GLSL } from './analysis-texture.ts';
import { ISF_MAIN, isfNameReserved, isfPrelude, parseIsf } from './isf.ts';
import { SHADERTOY_AUDIO_WIDTH, ShadertoyAudioTexture } from './shadertoy-audio.ts';

/** What a drop-in module is, as data. JSON-serialisable, so it crosses IPC and config files. */
export interface ShaderModuleSource {
  readonly manifest: ShaderModuleManifest;
  /** GLSL ES 3.00 fragment code: declarations and `void main()`, without `#version`. */
  readonly shader: string;
  /** Where it came from — a folder name — for messages. */
  readonly origin: string;
}

export interface ShaderModuleManifest {
  readonly id: string;
  readonly version: string;
  readonly kind: ShaderModuleKind;
  readonly name: string;
  readonly description?: string;
  readonly category?: string;
  readonly tags?: readonly string[];
  readonly params?: readonly ParamSpec[];
  /** 'pulseforge' (default): the author writes `main()`. 'shadertoy': `mainImage()`. 'isf': a file with an ISF header. */
  readonly dialect?: ShaderDialect;
  /**
   * Shadertoy only: what `iChannel0…3` read — the audio texture, the layer's input (effects), or
   * nothing (black). Default: audio for visualizers and sources; input then audio for effects.
   */
  readonly channels?: readonly ShadertoyChannel[];
  /** Shadertoy only: 'opaque' (default, as on the site) or 'straight' (fragColor.a is coverage). */
  readonly alpha?: 'opaque' | 'straight';
}

export const SHADER_DIALECTS = ['pulseforge', 'shadertoy', 'isf'] as const;
export type ShaderDialect = (typeof SHADER_DIALECTS)[number];
export const SHADERTOY_CHANNELS = ['audio', 'input', 'none'] as const;
export type ShadertoyChannel = (typeof SHADERTOY_CHANNELS)[number];

export const SHADER_MODULE_KINDS = ['visualizer', 'source', 'effect'] as const;
export type ShaderModuleKind = (typeof SHADER_MODULE_KINDS)[number];

/** Parameter types a shader can take as a uniform. Strings and assets have no uniform form. */
const UNIFORM_PARAM_TYPES = new Set(['float', 'int', 'bool', 'enum', 'color', 'select:stem']);

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*$/;
/** Reverse-DNS-ish: at least two dot-separated segments of lowercase letters, digits and dashes. */
const MODULE_ID = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const RESERVED_UNIFORMS = new Set([
  'resolution', 'time', 'frame', 'scale', 'rms', 'peak', 'onset', 'beat', 'centroid', 'seed', 'input', 'spectrum', 'bins',
]);

/**
 * Everything wrong with a module's data, as sentences naming the field. Empty means it can be
 * compiled. Run before compiling, so a schema mistake reads as one — not as a shader error.
 */
export function validateShaderModule(source: ShaderModuleSource, takenIds: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  const m = source.manifest as Partial<ShaderModuleManifest> | undefined;
  if (m === undefined || typeof m !== 'object') return ['module.json has no manifest object'];
  if (typeof m.id !== 'string' || !MODULE_ID.test(m.id)) {
    problems.push(`id "${String(m.id)}" must be lowercase dotted, like "you.visualizer.rings"`);
  } else if (m.id.startsWith('core.')) {
    problems.push(`id "${m.id}" uses the "core." prefix, which is reserved for built-in modules`);
  } else if (takenIds.has(m.id)) {
    problems.push(`id "${m.id}" is already used by another module`);
  }
  if (typeof m.name !== 'string' || m.name.trim() === '') problems.push('name is missing');
  if (typeof m.version !== 'string' || m.version === '') problems.push('version is missing');
  if (!(SHADER_MODULE_KINDS as readonly string[]).includes(String(m.kind))) {
    problems.push(`kind "${String(m.kind)}" must be one of ${SHADER_MODULE_KINDS.join(', ')}`);
  }
  const dialect = m.dialect ?? 'pulseforge';
  if (!(SHADER_DIALECTS as readonly string[]).includes(String(dialect))) {
    problems.push(`dialect "${String(dialect)}" must be one of ${SHADER_DIALECTS.join(', ')}`);
  } else if (typeof source.shader !== 'string') {
    problems.push('the shader is missing');
  } else if (dialect === 'shadertoy') {
    if (!/void\s+mainImage\s*\(/.test(source.shader)) problems.push('a Shadertoy shader needs "void mainImage(out vec4 fragColor, in vec2 fragCoord)"');
    if (/void\s+main\s*\(\s*(void)?\s*\)/.test(source.shader)) problems.push('a Shadertoy shader must not define main() — the wrapper does');
  } else if (!/void\s+main\s*\(/.test(source.shader)) {
    problems.push('the shader has no "void main()"');
  } else if (dialect === 'isf') {
    problems.push(...isfProblems(source.shader, m));
  }
  if (typeof source.shader === 'string' && /^\s*#version/m.test(source.shader)) {
    problems.push('the shader must not declare #version — the prelude does');
  }
  if (m.channels !== undefined) {
    if (!Array.isArray(m.channels) || m.channels.length > 4 || !m.channels.every((c) => (SHADERTOY_CHANNELS as readonly string[]).includes(String(c)))) {
      problems.push(`channels must be up to four of ${SHADERTOY_CHANNELS.join(', ')}`);
    } else if (m.channels.includes('input') && m.kind !== 'effect') {
      problems.push('only an effect has an input for a channel to read');
    }
  }
  if (m.alpha !== undefined && m.alpha !== 'opaque' && m.alpha !== 'straight') problems.push('alpha must be "opaque" or "straight"');

  const keys = new Set<string>();
  for (const [index, spec] of (m.params ?? []).entries()) {
    const at = `params[${index}]`;
    if (spec === null || typeof spec !== 'object') {
      problems.push(`${at} is not an object`);
      continue;
    }
    if (typeof spec.key !== 'string' || !IDENTIFIER.test(spec.key)) {
      problems.push(`${at}.key "${String(spec.key)}" must be a plain identifier (letters, digits, _)`);
      continue;
    }
    if (keys.has(spec.key)) problems.push(`${at}.key "${spec.key}" is declared twice`);
    keys.add(spec.key);
    if (dialect === 'isf') {
      if (isfNameReserved(spec.key)) problems.push(`${at}.key "${spec.key}" is a name the shader wrapper or GLSL keeps for itself`);
    } else if (RESERVED_UNIFORMS.has(spec.key)) {
      problems.push(`${at}.key "${spec.key}" would clash with the built-in uniform u_${spec.key}`);
    }
    if (!UNIFORM_PARAM_TYPES.has(String(spec.type))) {
      problems.push(`${at} "${spec.key}" has type "${String(spec.type)}", which a shader module cannot take (use float, int, bool, enum, color or select:stem)`);
      continue;
    }
    if (typeof spec.label !== 'string') problems.push(`${at} "${spec.key}" has no label`);
    if (spec.type === 'float' || spec.type === 'int') {
      if (typeof spec.min !== 'number' || typeof spec.max !== 'number' || !(spec.min < spec.max)) {
        problems.push(`${at} "${spec.key}" needs numeric min < max`);
      } else if (typeof spec.default !== 'number' || spec.default < spec.min || spec.default > spec.max) {
        problems.push(`${at} "${spec.key}" default must be a number between min and max`);
      }
    }
    if (spec.type === 'enum') {
      const options = (spec as { options?: unknown }).options;
      if (!Array.isArray(options) || options.length === 0) problems.push(`${at} "${spec.key}" needs options`);
      else if (!options.some((o: { value?: unknown }) => o?.value === spec.default)) problems.push(`${at} "${spec.key}" default is not one of its options`);
    }
    if (spec.type === 'color' && (typeof spec.default !== 'string' || parseHexColor(spec.default) === undefined)) {
      problems.push(`${at} "${spec.key}" default must be a hex colour`);
    }
    // The file is untrusted data, so the check reads the raw value rather than the declared type.
    if (spec.type === 'bool' && typeof (spec as { default?: unknown }).default !== 'boolean') problems.push(`${at} "${spec.key}" default must be true or false`);
    if (spec.type === 'select:stem' && !(STEMS as readonly string[]).includes(String(spec.default))) {
      problems.push(`${at} "${spec.key}" default must be a stem (${STEMS.join(', ')})`);
    }
  }
  return problems;
}

/** What an ISF file's own header refuses, and whether the manifest says what the header says. */
function isfProblems(shader: string, manifest: Partial<ShaderModuleManifest>): string[] {
  const isf = parseIsf(shader);
  const problems = [...isf.refusals];
  if (isf.refusals.length > 0) return problems;
  if (manifest.kind !== isf.kind) problems.push(`kind "${String(manifest.kind)}" disagrees with the ISF header, which makes it a ${isf.kind}`);
  const keys = new Set((manifest.params ?? []).map((p) => p?.key));
  const absent = isf.params.filter((p) => !keys.has(p.key)).map((p) => p.key);
  if (absent.length > 0) problems.push(`the ISF inputs ${absent.join(', ')} are not among params`);
  return problems;
}

/** The manifest the rest of the app sees: the declared fields, with defaults for the rest. */
export function shaderModuleManifest(source: ShaderModuleSource): ModuleManifest {
  const m = source.manifest;
  return {
    id: m.id,
    version: m.version,
    kind: m.kind as ModuleKind,
    name: m.name,
    description: m.description ?? `Drop-in module from modules/${source.origin}`,
    category: m.category ?? 'drop-in',
    tags: m.tags ?? [],
    capabilities: { needsAnalysis: true, needsInput: m.kind === 'effect', supportsAspect: true, stateful: false, gpuCost: 'medium' },
    paramsSchemaVersion: 1,
    params: m.params ?? [],
  };
}

function uniformType(spec: ParamSpec): string {
  switch (spec.type) {
    case 'bool': return 'bool';
    case 'enum': return 'int';
    case 'color': return 'vec3';
    case 'select:stem': return 'int';
    default: return 'float';
  }
}

/** The prelude every drop-in shader is compiled with. Documented in docs/module-authoring.md. */
export function shaderPrelude(kind: ShaderModuleKind, params: readonly ParamSpec[]): string {
  const paramUniforms = params.map((p) => `uniform ${uniformType(p)} u_${p.key};`).join('\n');
  return `#version 300 es
precision highp float;
precision highp int;
uniform vec2 u_resolution;
uniform float u_time;
uniform int u_frame;
uniform float u_scale;
uniform float u_rms;
uniform float u_peak;
uniform float u_onset;
uniform float u_beat;
uniform float u_centroid;
uniform uint u_seed;
${SPECTRUM_GLSL}
${HASH_GLSL}
${kind === 'effect' ? 'uniform sampler2D u_input;\nvec4 pf_input(vec2 uv) { return texture(u_input, vec2(uv.x, 1.0 - uv.y)); }' : ''}
/** This pixel in 0..1, y down (top-left origin), like every coordinate in Pulseforge. */
vec2 pf_uv() { return vec2(gl_FragCoord.x, u_resolution.y - gl_FragCoord.y) / u_resolution; }
/** A deterministic 0..1 value from two integers, keyed on the project seed. */
float pf_hash(int a, int b) { return float(pf_combine32(pf_combine32(u_seed, uint(a)), uint(b)) >> 8u) / 16777216.0; }
${paramUniforms}
out vec4 outColor;
`;
}

/** Shadertoy's inputs, declared after the Pulseforge prelude (whose uniforms stay available too). */
const SHADERTOY_UNIFORMS = `
uniform vec3 iResolution;
uniform float iTime;
uniform float iTimeDelta;
uniform float iFrameRate;
uniform int iFrame;
uniform vec4 iMouse;
uniform vec4 iDate;
uniform float iSampleRate;
uniform vec3 iChannelResolution[4];
uniform float iChannelTime[4];
uniform sampler2D iChannel0;
uniform sampler2D iChannel1;
uniform sampler2D iChannel2;
uniform sampler2D iChannel3;
`;

/**
 * After the author's `mainImage`: call it at this pixel (Shadertoy's origin is bottom-left, as
 * gl_FragCoord's is here) and turn its display-referred colour into linear, premultiplied light.
 */
function shadertoyMain(alpha: 'opaque' | 'straight'): string {
  return `
vec3 pf_st_decode(vec3 c) {
  vec3 lo = c / 12.92;
  vec3 hi = pow((c + 0.055) / 1.055, vec3(2.4));
  return mix(hi, lo, vec3(lessThanEqual(c, vec3(0.04045))));
}
void main() {
  vec4 c = vec4(0.0, 0.0, 0.0, 1.0);
  mainImage(c, gl_FragCoord.xy);
  float a = ${alpha === 'straight' ? 'clamp(c.a, 0.0, 1.0)' : '1.0'};
  outColor = vec4(pf_st_decode(clamp(c.rgb, 0.0, 1.0)) * a, a);
}
`;
}

/** The whole program around the author's code: what goes before it, and what goes after. */
export function shaderWrapping(manifest: ShaderModuleManifest): { readonly prelude: string; readonly suffix: string } {
  // ISF inputs are bare uniforms, declared by its own prelude rather than as `u_<key>`.
  if (manifest.dialect === 'isf') return { prelude: shaderPrelude(manifest.kind, []) + isfPrelude(manifest.kind, manifest.params ?? []), suffix: ISF_MAIN };
  const base = shaderPrelude(manifest.kind, manifest.params ?? []);
  if ((manifest.dialect ?? 'pulseforge') !== 'shadertoy') return { prelude: base, suffix: '' };
  return { prelude: base + SHADERTOY_UNIFORMS, suffix: shadertoyMain(manifest.alpha ?? 'opaque') };
}

/** What `iChannel0…3` read, with the defaults filled in. */
export function shadertoyChannels(manifest: ShaderModuleManifest): readonly ShadertoyChannel[] {
  const declared = manifest.channels ?? (manifest.kind === 'effect' ? ['input', 'audio'] : ['audio']);
  return [0, 1, 2, 3].map((i) => declared[i] ?? 'none');
}

/**
 * Compiles, reporting the author's own line numbers: a GLSL error log counts lines from the top of
 * the whole source, prelude included, which would point every error at the wrong line of their file.
 */
function compile(gl: WebGL2RenderingContext, source: ShaderModuleSource): WebGLProgram {
  const { prelude, suffix } = shaderWrapping(source.manifest);
  const offset = prelude.split('\n').length - 1;
  try {
    return createProgram(gl, source.manifest.id, FULLSCREEN_VERT, prelude + source.shader + suffix);
  } catch (error) {
    if (!(error instanceof ShaderCompileError)) throw error;
    const authorLines = source.shader.split('\n');
    const log = error.log.replace(/(\d+):(\d+)/g, (whole, file: string, line: string) => {
      const own = Number(line) - offset;
      return own >= 1 ? `${file}:${own}` : whole;
    });
    const first = /\d+:(\d+)/.exec(log);
    const lineNo = first?.[1] === undefined ? undefined : Number(first[1]);
    const excerpt = lineNo === undefined ? '' : `\n  ${lineNo} | ${authorLines[lineNo - 1] ?? ''}`;
    throw new ShaderCompileError(source.manifest.id, log, `modules/${source.origin}: the shader does not compile.\n${log}${excerpt}`);
  }
}

/** An ISF input as its shader expects it: see isf.ts for why `long` and `color` differ from the other dialects. */
function uploadIsfParam(gl: WebGL2RenderingContext, location: WebGLUniformLocation, spec: ParamSpec, value: unknown): void {
  switch (spec.type) {
    case 'bool':
      gl.uniform1i(location, value === true ? 1 : 0);
      break;
    case 'int':
    case 'enum':
      gl.uniform1i(location, Math.round(Number(value)) || 0);
      break;
    case 'color': {
      const c = parseHexColor(String(value)) ?? { r: 1, g: 1, b: 1, a: 1 };
      gl.uniform4f(location, c.r, c.g, c.b, c.a);
      break;
    }
    default:
      gl.uniform1f(location, typeof value === 'number' ? value : 0);
  }
}

function createShaderInstance(gl: WebGL2RenderingContext, source: ShaderModuleSource): ModuleInstance {
  const program = compile(gl, source);
  const params = source.manifest.params ?? [];
  // Unused uniforms are optimised away; a missing location is simply not set, never an error.
  const loc = (name: string) => gl.getUniformLocation(program, name);
  const u = {
    resolution: loc('u_resolution'), time: loc('u_time'), frame: loc('u_frame'), scale: loc('u_scale'),
    rms: loc('u_rms'), peak: loc('u_peak'), onset: loc('u_onset'), beat: loc('u_beat'), centroid: loc('u_centroid'),
    seed: loc('u_seed'), spectrum: loc('u_spectrum'), bins: loc('u_bins'), input: loc('u_input'),
  };
  const isf = source.manifest.dialect === 'isf';
  const isfTimeDelta = isf ? loc('pf_isf_timedelta') : null;
  const paramLocations = params.map((p) => ({ spec: p, location: loc(isf ? p.key : `u_${p.key}`) }));
  const stemParam = params.find((p) => p.type === 'select:stem');
  const vao = gl.createVertexArray();
  const analysis = new AnalysisTexture(gl);
  // Shadertoy dialect: the audio texture, a black texture for empty channels, and the channel map.
  const shadertoy = (source.manifest.dialect ?? 'pulseforge') === 'shadertoy';
  const channels = shadertoy ? shadertoyChannels(source.manifest) : [];
  const stAudio = shadertoy && channels.includes('audio') ? new ShadertoyAudioTexture(gl) : null;
  const black = shadertoy ? gl.createTexture() : null;
  if (black !== null) {
    gl.bindTexture(gl.TEXTURE_2D, black);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    gl.bindTexture(gl.TEXTURE_2D, null);
  }
  const st = shadertoy ? {
    resolution: loc('iResolution'), time: loc('iTime'), delta: loc('iTimeDelta'), rate: loc('iFrameRate'), frame: loc('iFrame'),
    mouse: loc('iMouse'), date: loc('iDate'), sampleRate: loc('iSampleRate'),
    channelResolution: loc('iChannelResolution'), channelTime: loc('iChannelTime'),
    channels: [0, 1, 2, 3].map((i) => loc(`iChannel${i}`)),
  } : null;

  return {
    resize() {},

    render(ctx: RenderContext, values: ParamValues) {
      // The first stem parameter chooses what the audio uniforms describe; with none, the mix.
      const stem = (stemParam === undefined ? 'mix' : values[stemParam.key]) as Stem;
      const { bins, features } = analysis.update(ctx, (STEMS as readonly string[]).includes(stem) ? stem : 'mix');

      gl.disable(gl.BLEND);
      gl.useProgram(program);
      gl.uniform2f(u.resolution, ctx.canvas.width, ctx.canvas.height);
      gl.uniform1f(u.time, ctx.time.t);
      gl.uniform1i(u.frame, ctx.time.frameIndex);
      gl.uniform1f(u.scale, ctx.canvas.referenceScale);
      gl.uniform1f(u.rms, features.rms);
      gl.uniform1f(u.peak, features.peak);
      gl.uniform1f(u.onset, features.onset);
      gl.uniform1f(u.beat, features.beat);
      gl.uniform1f(u.centroid, features.centroid);
      gl.uniform1ui(u.seed, hash32(Math.trunc(ctx.prng('shader-module-seed') * 0xffffffff), source.manifest.id) >>> 0);
      analysis.bindTo(0);
      gl.uniform1i(u.spectrum, 0);
      gl.uniform1i(u.bins, bins);
      if (ctx.input !== null) {
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, ctx.input.texture);
        gl.uniform1i(u.input, 1);
      }

      for (const { spec, location } of paramLocations) {
        if (location === null) continue;
        const value = values[spec.key];
        if (isf) {
          uploadIsfParam(gl, location, spec, value);
          continue;
        }
        switch (spec.type) {
          case 'bool':
            gl.uniform1i(location, value === true ? 1 : 0);
            break;
          case 'enum':
            gl.uniform1i(location, Math.max(0, spec.options.findIndex((o) => o.value === value)));
            break;
          case 'select:stem':
            gl.uniform1i(location, Math.max(0, (STEMS as readonly string[]).indexOf(String(value))));
            break;
          case 'color': {
            const c = parseHexColor(String(value)) ?? { r: 1, g: 1, b: 1, a: 1 };
            gl.uniform3f(location, srgbToLinear(c.r), srgbToLinear(c.g), srgbToLinear(c.b));
            break;
          }
          default:
            gl.uniform1f(location, typeof value === 'number' ? value : 0);
        }
      }

      if (isf) gl.uniform1f(isfTimeDelta, ctx.time.fps.den / ctx.time.fps.num);

      if (st !== null) {
        const { width, height } = ctx.canvas;
        const fps = ctx.time.fps.num / ctx.time.fps.den;
        gl.uniform3f(st.resolution, width, height, 1);
        gl.uniform1f(st.time, ctx.time.t);
        gl.uniform1f(st.delta, 1 / fps);
        gl.uniform1f(st.rate, fps);
        gl.uniform1i(st.frame, ctx.time.frameIndex);
        gl.uniform4f(st.mouse, 0, 0, 0, 0);
        // Never the wall clock (CLAUDE.md #1): a fixed date, with the timeline's seconds in .w.
        gl.uniform4f(st.date, 2000, 0, 1, ctx.time.t);
        gl.uniform1f(st.sampleRate, 48_000);
        stAudio?.update(ctx, (STEMS as readonly string[]).includes(stem) ? stem : 'mix');
        const resolutions: number[] = [];
        channels.forEach((channel, i) => {
          // Units 2–5: 0 is the spectrum, 1 the Pulseforge input.
          gl.activeTexture(gl.TEXTURE2 + i);
          const texture = channel === 'audio' ? stAudio?.texture ?? black : channel === 'input' ? ctx.input?.texture ?? black : black;
          gl.bindTexture(gl.TEXTURE_2D, texture);
          gl.uniform1i(st.channels[i] ?? null, 2 + i);
          if (channel === 'audio') resolutions.push(SHADERTOY_AUDIO_WIDTH, 2, 1);
          else if (channel === 'input' && ctx.input !== null) resolutions.push(ctx.input.width, ctx.input.height, 1);
          else resolutions.push(1, 1, 1);
        });
        gl.uniform3fv(st.channelResolution, resolutions);
        gl.uniform1fv(st.channelTime, [ctx.time.t, ctx.time.t, ctx.time.t, ctx.time.t]);
      }

      drawFullscreenTriangle(gl, vao);
      if (st !== null) {
        for (let i = 0; i < 4; i += 1) {
          gl.activeTexture(gl.TEXTURE2 + i);
          gl.bindTexture(gl.TEXTURE_2D, null);
        }
      }
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.useProgram(null);
    },

    dispose() {
      analysis.dispose();
      stAudio?.dispose();
      if (black !== null) gl.deleteTexture(black);
      gl.deleteProgram(program);
      gl.deleteVertexArray(vao);
    },
  };
}

/**
 * Compiles a module's shader on `gl` and throws it away: null when it compiles, else the error with
 * the author's own line numbers. For the studio's "Paste a Shadertoy" dialog, which checks as you type.
 */
export function checkShaderModule(gl: WebGL2RenderingContext, source: ShaderModuleSource): string | null {
  try {
    gl.deleteProgram(compile(gl, source));
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * A bare Shadertoy file dropped in the modules folder (`Plasma Tunnel.glsl`) as a module: a source
 * layer named after the file, with an id made from it. Pure, so the studio's paste dialog and the
 * folder scan agree on both.
 */
export function shadertoyFileSource(fileName: string, shader: string): ShaderModuleSource {
  const name = fileName.replace(/\.(glsl|frag)$/i, '').trim() || 'Shadertoy';
  return {
    manifest: { id: `user.shadertoy.${idSlug(name)}`, version: '1', kind: 'source', name, category: 'shadertoy', tags: ['shadertoy'], dialect: 'shadertoy' },
    shader,
    origin: fileName,
  };
}

function idSlug(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'shader';
}

/**
 * An ISF file (`Plasma.fs`) as a module, named after the file: an effect if it has an `inputImage`,
 * otherwise a source. What it cannot do is `validateShaderModule`'s to say, from the same header.
 * Pure. `idPrefix` keeps a library's ids apart from a person's own files.
 */
export function isfFileSource(fileName: string, shader: string, idPrefix = 'user.isf'): ShaderModuleSource {
  const name = fileName.replace(/\.fs$/i, '').trim() || 'ISF';
  const isf = parseIsf(shader);
  return {
    manifest: {
      id: `${idPrefix}.${idSlug(name)}`, version: isf.version ?? '1', kind: isf.kind, name, category: 'isf',
      tags: ['isf', ...isf.categories.map((c) => c.toLowerCase())], dialect: 'isf', params: isf.params,
      ...(isf.description === undefined ? {} : { description: isf.description }),
    },
    shader,
    origin: fileName,
  };
}

/** A drop-in module as an ordinary module definition — the engine cannot tell it from a built-in. */
export function shaderModuleDefinition(source: ShaderModuleSource): ModuleDefinition {
  return {
    manifest: shaderModuleManifest(source),
    create: (gl) => createShaderInstance(gl, source),
  };
}
