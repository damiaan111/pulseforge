import { describe, expect, it } from 'vitest';
import { formatShaderLog } from '../../src/engine/render/gl.ts';

describe('formatShaderLog', () => {
  it('shows the offending source line with context', () => {
    const source = ['#version 300 es', 'precision highp float;', 'out vec4 c;', 'void main() { c = vec3(1.0); }', ''].join('\n');
    const report = formatShaderLog('bars.frag', source, "ERROR: 0:4: '=' : cannot convert from 'const highp 3-component vector of float' to 'out highp 4-component vector of float'\n");
    expect(report).toContain('Shader "bars.frag" failed to compile:');
    expect(report).toContain('>    4 | void main() { c = vec3(1.0); }');
    expect(report).toContain('     3 | out vec4 c;');
  });

  it('keeps log lines without a location', () => {
    expect(formatShaderLog('x', 'void main(){}', 'Internal driver error')).toContain('Internal driver error');
  });
});
