// WebGL2 plumbing with loud failures (CLAUDE.md "development split"):
// GLSL ES 3.00 only, required extensions probed up front, and shader errors reported
// with the offending source line rather than rendering a black layer.

export class RenderSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RenderSetupError';
  }
}

export class ShaderCompileError extends Error {
  readonly label: string;
  readonly log: string;
  constructor(label: string, log: string, report: string) {
    super(report);
    this.name = 'ShaderCompileError';
    this.label = label;
    this.log = log;
  }
}

/** Formats a driver info log with the source lines it refers to (ANGLE/NVIDIA: "ERROR: 0:12: ..."). */
export function formatShaderLog(label: string, source: string, log: string): string {
  const lines = source.split('\n');
  const out = [`Shader "${label}" failed to compile:`];
  for (const entry of log.split('\n').map((l) => l.trim()).filter(Boolean)) {
    out.push(`  ${entry}`);
    const match = /^(?:ERROR|WARNING):\s*\d+:(\d+):/.exec(entry);
    const lineNumber = match?.[1] !== undefined ? Number(match[1]) : undefined;
    if (lineNumber !== undefined) {
      for (let n = Math.max(1, lineNumber - 1); n <= Math.min(lines.length, lineNumber + 1); n++) {
        out.push(`    ${n === lineNumber ? '>' : ' '} ${String(n).padStart(4)} | ${lines[n - 1] ?? ''}`);
      }
    }
  }
  return out.join('\n');
}

export interface ContextInfo {
  readonly renderer: string;
  readonly vendor: string;
  readonly version: string;
  readonly shadingLanguageVersion: string;
  readonly maxTextureSize: number;
  readonly maxRenderbufferSize: number;
  readonly extensions: readonly string[];
}

/** Checks everything the compositor depends on; throws a specific message otherwise. */
export function requireContextFeatures(gl: WebGL2RenderingContext): ContextInfo {
  // Rendering into RGBA16F needs EXT_color_buffer_float (compositor-spec §1). Without it
  // we fail rather than fall back to 8-bit and quietly change every project's appearance.
  if (gl.getExtension('EXT_color_buffer_float') === null) {
    throw new RenderSetupError(
      'WebGL2 context lacks EXT_color_buffer_float, required for RGBA16F compositing. ' +
        'Update the GPU driver; on a hybrid-GPU laptop make sure the NVIDIA GPU is used.',
    );
  }
  const debug = gl.getExtension('WEBGL_debug_renderer_info');
  return {
    renderer: String(debug !== null ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)),
    vendor: String(debug !== null ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR)),
    version: String(gl.getParameter(gl.VERSION)),
    shadingLanguageVersion: String(gl.getParameter(gl.SHADING_LANGUAGE_VERSION)),
    maxTextureSize: Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)),
    maxRenderbufferSize: Number(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE)),
    extensions: gl.getSupportedExtensions() ?? [],
  };
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string, label: string): WebGLShader {
  const shader = gl.createShader(type);
  if (shader === null) throw new RenderSetupError(`Could not create shader "${label}" (context lost?)`);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS) !== true) {
    const log = gl.getShaderInfoLog(shader) ?? '(no info log)';
    gl.deleteShader(shader);
    throw new ShaderCompileError(label, log, formatShaderLog(label, source, log));
  }
  return shader;
}

export function createProgram(
  gl: WebGL2RenderingContext,
  label: string,
  vertexSource: string,
  fragmentSource: string,
): WebGLProgram {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vertexSource, `${label}.vert`);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource, `${label}.frag`);
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (gl.getProgramParameter(program, gl.LINK_STATUS) !== true) {
    const log = gl.getProgramInfoLog(program) ?? '(no info log)';
    gl.deleteProgram(program);
    throw new ShaderCompileError(label, log, `Program "${label}" failed to link:\n  ${log}`);
  }
  return program;
}

export function uniformLocation(gl: WebGL2RenderingContext, program: WebGLProgram, name: string): WebGLUniformLocation {
  const location = gl.getUniformLocation(program, name);
  if (location === null) throw new RenderSetupError(`Uniform "${name}" not found (unused uniforms are optimised away)`);
  return location;
}

/** One triangle covering the viewport; uv spans 0..1 over the visible area. */
export const FULLSCREEN_VERT = /* glsl */ `#version 300 es
out vec2 v_uv;
void main() {
  vec2 p = vec2(float((gl_VertexID & 1) << 2), float((gl_VertexID & 2) << 1));
  v_uv = p * 0.5;
  gl_Position = vec4(p - 1.0, 0.0, 1.0);
}
`;

export function drawFullscreenTriangle(gl: WebGL2RenderingContext, vao: WebGLVertexArrayObject): void {
  gl.bindVertexArray(vao);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.bindVertexArray(null);
}
