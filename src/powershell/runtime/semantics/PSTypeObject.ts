import type { PSValue } from '../PSEnvironment';

const VALUE_TYPES = new Set([
  'Byte', 'SByte', 'Int16', 'UInt16', 'Int32', 'UInt32', 'Int64', 'UInt64', 'Single', 'Double', 'Decimal',
  'Char', 'Boolean', 'DateTime', 'TimeSpan', 'Guid',
]);

const PRIMITIVES = new Set([
  'Byte', 'SByte', 'Int16', 'UInt16', 'Int32', 'UInt32', 'Int64', 'UInt64', 'Single', 'Double', 'Char', 'Boolean',
]);

function namespaceOf(fullName: string): string {
  const stripped = fullName.replace(/\[\]$/, '');
  const index = stripped.lastIndexOf('.');
  return index < 0 ? '' : stripped.slice(0, index);
}

function baseTypeOf(name: string): { Name: string; FullName: string } {
  if (name.endsWith('[]')) return { Name: 'Array', FullName: 'System.Array' };
  if (VALUE_TYPES.has(name)) return { Name: 'ValueType', FullName: 'System.ValueType' };
  if (name === 'Object') return { Name: '', FullName: '' };
  return { Name: 'Object', FullName: 'System.Object' };
}

export function makeTypeObject(name: string, fullName: string): PSValue {
  const array = name.endsWith('[]');
  const base = baseTypeOf(name);
  const record: Record<string, PSValue> = {
    Name: name,
    FullName: fullName,
    Namespace: namespaceOf(fullName),
    BaseType: base.FullName === '' ? null : ({ Name: base.Name, FullName: base.FullName, toString: () => base.FullName } as unknown as PSValue),
    IsPrimitive: PRIMITIVES.has(name),
    IsValueType: VALUE_TYPES.has(name),
    IsArray: array,
    IsEnum: false,
    IsClass: !VALUE_TYPES.has(name) && !array,
    IsInterface: false,
    IsSealed: name === 'String' || VALUE_TYPES.has(name),
    toString: () => fullName,
    getelementtype: () => (array ? makeTypeObject(name.slice(0, -2), fullName.slice(0, -2)) : null),
    gettype: () => makeTypeObject('RuntimeType', 'System.RuntimeType'),
  } as unknown as Record<string, PSValue>;
  return record as unknown as PSValue;
}
