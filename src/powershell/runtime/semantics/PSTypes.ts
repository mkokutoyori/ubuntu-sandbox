import { PSChar, PSNumber, kindName, numericKindOf, type NumericKind } from './PSNumber';

export type TypeSpec =
  | { readonly kind: 'numeric'; readonly numeric: NumericKind }
  | { readonly kind: 'char' }
  | { readonly kind: 'string' }
  | { readonly kind: 'bool' }
  | { readonly kind: 'object' }
  | { readonly kind: 'array'; readonly element: TypeSpec | null }
  | { readonly kind: 'named'; readonly name: string };

const NUMERIC_ALIASES: Readonly<Record<string, NumericKind>> = {
  byte: 'byte', sbyte: 'sbyte', int16: 'int16', short: 'int16', uint16: 'uint16', ushort: 'uint16',
  int: 'int32', int32: 'int32', uint32: 'uint32', uint: 'uint32', long: 'int64', int64: 'int64',
  uint64: 'uint64', ulong: 'uint64', float: 'single', single: 'single', double: 'double', decimal: 'decimal',
};

export const ARRAY_ELEMENT_TYPE = '__elementType__';

export function parseTypeName(text: string): TypeSpec {
  const trimmed = text.trim();
  let name = (trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed).trim().toLowerCase();
  if (name.endsWith('[]')) {
    const inner = name.slice(0, -2);
    return { kind: 'array', element: inner === '' ? null : parseTypeName(inner) };
  }
  if (name.startsWith('system.') && !name.startsWith('system.management.') && !name.startsWith('system.collections')) {
    name = name.slice('system.'.length);
  }
  const numeric = NUMERIC_ALIASES[name];
  if (numeric !== undefined) return { kind: 'numeric', numeric };
  if (name === 'char') return { kind: 'char' };
  if (name === 'string') return { kind: 'string' };
  if (name === 'bool' || name === 'boolean') return { kind: 'bool' };
  if (name === 'object') return { kind: 'object' };
  if (name === 'array') return { kind: 'array', element: null };
  return { kind: 'named', name };
}

export function typeSpecName(spec: TypeSpec): { name: string; fullName: string } {
  switch (spec.kind) {
    case 'numeric': return kindName(spec.numeric);
    case 'char': return { name: 'Char', fullName: 'System.Char' };
    case 'string': return { name: 'String', fullName: 'System.String' };
    case 'bool': return { name: 'Boolean', fullName: 'System.Boolean' };
    case 'object': return { name: 'Object', fullName: 'System.Object' };
    case 'array': {
      const element = spec.element === null ? { name: 'Object', fullName: 'System.Object' } : typeSpecName(spec.element);
      return { name: `${element.name}[]`, fullName: `${element.fullName}[]` };
    }
    default: return { name: spec.name, fullName: spec.name };
  }
}

export function elementTypeOf(array: unknown[]): TypeSpec | null {
  const tag = (array as unknown as Record<string, unknown>)[ARRAY_ELEMENT_TYPE];
  return typeof tag === 'string' ? parseTypeName(tag) : null;
}

export function tagArray<T extends unknown[]>(array: T, element: TypeSpec): T {
  Object.defineProperty(array, ARRAY_ELEMENT_TYPE, {
    value: typeSpecName(element).fullName.replace(/^System\./, ''), enumerable: false, configurable: true,
  });
  return array;
}

export function specEquals(a: TypeSpec, b: TypeSpec): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'numeric') return a.numeric === (b as typeof a).numeric;
  if (a.kind === 'array') {
    const other = b as typeof a;
    if (a.element === null || other.element === null) return a.element === other.element;
    return specEquals(a.element, other.element);
  }
  if (a.kind === 'named') return a.name === (b as typeof a).name;
  return true;
}

export function isScalarInstance(value: unknown, spec: TypeSpec): boolean | null {
  switch (spec.kind) {
    case 'numeric': return numericKindOf(value) === spec.numeric;
    case 'char': return value instanceof PSChar;
    case 'string': return typeof value === 'string';
    case 'bool': return typeof value === 'boolean';
    case 'object': return value !== null && value !== undefined;
    case 'array': {
      if (!Array.isArray(value)) return false;
      const actual = elementTypeOf(value);
      if (spec.element === null) return true;
      if (actual === null) return spec.element.kind === 'object';
      return specEquals(actual, spec.element) || spec.element.kind === 'object';
    }
    default: return null;
  }
}

export function describeScalarType(value: unknown): { name: string; fullName: string } | null {
  if (typeof value === 'number' || value instanceof PSNumber) return kindName(numericKindOf(value) as NumericKind);
  if (value instanceof PSChar) return typeSpecName({ kind: 'char' });
  if (typeof value === 'string') return typeSpecName({ kind: 'string' });
  if (typeof value === 'boolean') return typeSpecName({ kind: 'bool' });
  if (Array.isArray(value)) return typeSpecName({ kind: 'array', element: elementTypeOf(value) });
  return null;
}
