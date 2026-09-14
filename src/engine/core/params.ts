// Parameter schema and value resolution (module-spec §3, §5).
//
// The order is fixed, and every subsystem must agree on it or the inspector, the preview and
// the export disagree:
//
//   1. base            stored in the project
//   2. aspect override applied upstream, in src/project/snapshot.ts (it is per-canvas)
//   3. automation      keyframes REPLACE the result of 1–2  — reserved (S1), not implemented
//   4. modulation      bindings applied in order            — `options.modulate`
//   5. clamp           to [min, max], ONCE, at the end
//   6. type coercion   int rounding, bool/enum thresholds
//
// Clamping at the end is the subtle one: intermediate values may legally exceed the range, so
// a `multiply` after an `add` behaves the same wherever the base happened to sit relative to
// the limit. Clamping early makes that silently depend on the base value.
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
  /** Hidden behind the inspector's "show advanced" disclosure (module-spec §13). */
  readonly advanced?: boolean;
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
  readonly step?: number;
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

/** Step 1: the stored value, type-checked but deliberately not yet clamped. */
function baseValue(spec: ParamSpec, stored: unknown, issues: ParamIssue[]): ParamValue {
  if (stored === undefined) return spec.default;
  const wrongType = (expected: string): ParamValue => {
    issues.push({ key: spec.key, problem: 'wrong-type', detail: `expected ${expected}, got ${JSON.stringify(stored)}; using default` });
    return spec.default;
  };

  switch (spec.type) {
    case 'float':
    case 'int': {
      if (typeof stored !== 'number' || !Number.isFinite(stored)) return wrongType('a finite number');
      return stored;
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

/**
 * Steps 5–6: clamp once, then coerce to the type. Separate from step 1 so modulation can ride
 * on an unclamped base and only the final value is bounded.
 */
function clampAndCoerce(spec: ParamSpec, value: ParamValue): ParamValue {
  switch (spec.type) {
    case 'float':
      return Math.min(spec.max, Math.max(spec.min, value as number));
    case 'int':
      return Math.round(Math.min(spec.max, Math.max(spec.min, value as number)));
    default:
      return value;
  }
}

/**
 * Modulating a discrete parameter (D25, "allowed, marked advanced"). The modulated value is a
 * number, so each type needs a stated rule rather than an implicit cast:
 *  - bool: false/true become 0/1, and anything at or above 0.5 comes back true.
 *  - enum: the option *index* is modulated, then rounded and clamped to the option list.
 * Colours and stem pickers have no meaningful numeric axis and are left alone, reported.
 */
function modulateDiscrete(spec: ParamSpec, value: ParamValue, modulate: (base: number) => number, issues: ParamIssue[]): ParamValue {
  switch (spec.type) {
    case 'float':
    case 'int':
      return modulate(value as number);
    case 'bool':
      return modulate(value === true ? 1 : 0) >= 0.5;
    case 'enum': {
      const index = spec.options.findIndex((o) => o.value === value);
      const modulated = Math.round(modulate(index < 0 ? 0 : index));
      const clamped = Math.min(spec.options.length - 1, Math.max(0, modulated));
      return spec.options[clamped]?.value ?? spec.default;
    }
    default:
      issues.push({
        key: spec.key,
        problem: 'invalid-value',
        detail: `a ${spec.type} parameter has no numeric axis to modulate; the binding is kept and has no effect`,
      });
      return value;
  }
}

export interface ResolveOptions {
  /**
   * Step 4. Given a parameter key and its base value, returns the modulated value —
   * unclamped, because clamping happens once afterwards. Omit for an unmodulated resolve.
   */
  readonly modulate?: (key: string, base: number) => number;
  /** Keys that actually carry a binding, so unmodulated parameters skip the call entirely. */
  readonly modulated?: ReadonlySet<string>;
}

export function resolveParams(
  schema: readonly ParamSpec[],
  stored: Readonly<Record<string, unknown>>,
  options: ResolveOptions = {},
): ResolvedParams {
  const issues: ParamIssue[] = [];
  const values: Record<string, ParamValue> = {};
  for (const spec of schema) {
    let value = baseValue(spec, stored[spec.key], issues);
    const { modulate, modulated } = options;
    if (modulate !== undefined && (modulated === undefined || modulated.has(spec.key))) {
      if (spec.modulatable === false) {
        issues.push({ key: spec.key, problem: 'invalid-value', detail: 'this parameter is declared non-modulatable; the binding is kept and has no effect' });
      } else {
        value = modulateDiscrete(spec, value, (base) => modulate(spec.key, base), issues);
      }
    }
    values[spec.key] = clampAndCoerce(spec, value);
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
