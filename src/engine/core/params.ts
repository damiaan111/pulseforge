// Parameter schema and value resolution (module-spec §3, §5) — the P0 subset.
//
// Resolution order is fixed: base → aspect override → automation → modulation → clamp →
// type coercion. P0 implements base, clamp and coercion; the other stages slot in between
// without changing this function's contract.
//
// Nothing is silently dropped (CLAUDE.md constraint 4): unknown keys are preserved and
// reported, and values of the wrong type are reported before falling back to the default.

import { parseHexColor } from './color.ts';

interface ParamCommon {
  readonly key: string;
  readonly label: string;
  readonly group: string;
  readonly description?: string;
  readonly modulatable?: boolean;
  readonly aspectOverridable?: boolean;
}

export interface FloatParam extends ParamCommon {
  readonly type: 'float';
  readonly default: number;
  readonly min: number;
  readonly max: number;
  readonly softMin?: number;
  readonly softMax?: number;
  readonly unit?: string;
  readonly scale?: 'linear' | 'log' | 'exp';
  /** How a size is measured (module-spec §6). */
  readonly space?: 'fraction' | 'canvas' | 'pixels';
}

export interface IntParam extends ParamCommon {
  readonly type: 'int';
  readonly default: number;
  readonly min: number;
  readonly max: number;
}

export interface BoolParam extends ParamCommon {
  readonly type: 'bool';
  readonly default: boolean;
}

export interface EnumParam extends ParamCommon {
  readonly type: 'enum';
  readonly default: string;
  readonly options: readonly { readonly value: string; readonly label: string }[];
}

export interface ColorParam extends ParamCommon {
  readonly type: 'color';
  /** sRGB hex, straight alpha. */
  readonly default: string;
  readonly allowAlpha?: boolean;
  readonly paletteRole?: string;
}

export const STEMS = ['mix', 'drums', 'bass', 'vocals', 'other'] as const;
export type Stem = (typeof STEMS)[number];

export interface StemParam extends ParamCommon {
  readonly type: 'select:stem';
  readonly default: Stem;
}

export type ParamSpec = FloatParam | IntParam | BoolParam | EnumParam | ColorParam | StemParam;
export type ParamValue = number | boolean | string;
export type ParamValues = Readonly<Record<string, ParamValue>>;

export interface ParamIssue {
  readonly key: string;
  readonly problem: 'unknown-key' | 'wrong-type' | 'invalid-value';
  readonly detail: string;
}

export interface ResolvedParams {
  readonly values: Readonly<Record<string, ParamValue>>;
  /** Stored keys the schema doesn't declare. Kept so saving round-trips them untouched. */
  readonly unknown: Readonly<Record<string, unknown>>;
  readonly issues: readonly ParamIssue[];
}

function resolveOne(spec: ParamSpec, stored: unknown, issues: ParamIssue[]): ParamValue {
  if (stored === undefined) return spec.default;
  const wrongType = (expected: string): ParamValue => {
    issues.push({ key: spec.key, problem: 'wrong-type', detail: `expected ${expected}, got ${JSON.stringify(stored)}; using default` });
    return spec.default;
  };

  switch (spec.type) {
    case 'float': {
      if (typeof stored !== 'number' || !Number.isFinite(stored)) return wrongType('a finite number');
      return Math.min(spec.max, Math.max(spec.min, stored));
    }
    case 'int': {
      if (typeof stored !== 'number' || !Number.isFinite(stored)) return wrongType('a finite number');
      // Clamp, then coerce (module-spec §5 steps 5–6).
      return Math.round(Math.min(spec.max, Math.max(spec.min, stored)));
    }
    case 'bool':
      return typeof stored === 'boolean' ? stored : wrongType('a boolean');
    case 'enum': {
      if (typeof stored !== 'string') return wrongType('a string');
      if (spec.options.some((o) => o.value === stored)) return stored;
      issues.push({ key: spec.key, problem: 'invalid-value', detail: `"${stored}" is not one of ${spec.options.map((o) => o.value).join(', ')}; using default` });
      return spec.default;
    }
    case 'color': {
      if (typeof stored !== 'string') return wrongType('a hex colour string');
      const parsed = parseHexColor(stored);
      if (parsed === undefined || (parsed.a < 1 && spec.allowAlpha !== true)) {
        issues.push({ key: spec.key, problem: 'invalid-value', detail: `"${stored}" is not a valid${spec.allowAlpha === true ? '' : ' opaque'} hex colour; using default` });
        return spec.default;
      }
      return stored;
    }
    case 'select:stem': {
      if (typeof stored !== 'string') return wrongType('a stem name');
      if ((STEMS as readonly string[]).includes(stored)) return stored;
      issues.push({ key: spec.key, problem: 'invalid-value', detail: `"${stored}" is not a stem (${STEMS.join(', ')}); using default` });
      return spec.default;
    }
  }
}

export function resolveParams(schema: readonly ParamSpec[], stored: Readonly<Record<string, unknown>>): ResolvedParams {
  const issues: ParamIssue[] = [];
  const values: Record<string, ParamValue> = {};
  for (const spec of schema) {
    values[spec.key] = resolveOne(spec, stored[spec.key], issues);
  }
  const declared = new Set(schema.map((s) => s.key));
  const unknown: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(stored)) {
    if (!declared.has(key)) {
      unknown[key] = value;
      issues.push({ key, problem: 'unknown-key', detail: 'not declared by this module version; preserved, ignored for rendering' });
    }
  }
  return { values, unknown, issues };
}

/** Typed accessors for module code, after resolution. */
export function num(values: ParamValues, key: string): number {
  const value = values[key];
  if (typeof value !== 'number') throw new TypeError(`param ${key} is not a number`);
  return value;
}

export function str(values: ParamValues, key: string): string {
  const value = values[key];
  if (typeof value !== 'string') throw new TypeError(`param ${key} is not a string`);
  return value;
}
