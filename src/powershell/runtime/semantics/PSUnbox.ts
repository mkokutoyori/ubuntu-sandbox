import { PSChar, PSNumber } from './PSNumber';
import type { PSValue } from '../PSEnvironment';

export function unboxScalar(value: PSValue): PSValue {
  if (value instanceof PSNumber) return value.kind === 'int64' || value.kind === 'uint64' ? Number(value.value) : value.toNumber();
  if (value instanceof PSChar) return value.toString();
  return value;
}

export function unboxDeep(value: PSValue): PSValue {
  if (value instanceof PSNumber || value instanceof PSChar) return unboxScalar(value);
  if (Array.isArray(value)) {
    if (!value.some(item => item instanceof PSNumber || item instanceof PSChar || Array.isArray(item))) return value;
    return value.map(unboxDeep);
  }
  return value;
}

export const PASS_THROUGH_CMDLETS: ReadonlySet<string> = new Set([
  'where-object', 'foreach-object', 'select-object', 'sort-object', 'write-output', 'out-null',
  'tee-object', 'group-object', 'out-string', 'out-host', 'write-host', 'format-table', 'format-list',
  'get-member', 'compare-object', 'add-member', 'new-object', 'should',
]);
