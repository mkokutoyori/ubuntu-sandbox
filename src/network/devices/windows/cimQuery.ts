import { hasWildcard } from '@/powershell/runtime/PSWildcard';

function cimNotFoundByProperty(
  cimClass: string, property: string, wanted: string,
): string {
  const relation = hasWildcard(wanted) ? 'matching' : 'equal to';
  return `No ${cimClass} objects found with property '${property}' ${relation} '${wanted}'.`
    + '  Verify the value of the property and retry.';
}

function cimNotFoundByQuery(cimClass: string, query: string): string {
  return `No matching ${cimClass} objects found by ${query}. Verify query parameters and retry.`;
}

function cimQueryDescription(criteria: Array<[string, readonly string[] | undefined]>): string {
  const parts = criteria
    .filter((entry): entry is [string, readonly string[]] => entry[1] !== undefined)
    .map(([property, values]) => `${property} = '${values.join(', ')}'`);
  return parts.length > 0 ? parts.join(', ') : 'the specified criteria';
}

export function cimNotFound(
  cimClass: string, criteria: Array<[string, readonly string[] | undefined]>,
): string {
  const granular = criteria.find(([, values]) => values !== undefined && values.length === 1);
  if (granular !== undefined) {
    return cimNotFoundByProperty(cimClass, granular[0], granular[1]![0]);
  }
  return cimNotFoundByQuery(cimClass, cimQueryDescription(criteria));
}
