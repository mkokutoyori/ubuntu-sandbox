import type { OSPFRouteType } from './types';

export function normalizeOspfRouteType(value: string | undefined): OSPFRouteType | undefined {
  switch (value) {
    case 'intra-area':
    case 'inter-area':
    case 'external-type1':
    case 'external-type2':
      return value;
    case 'type1-external':
      return 'external-type1';
    case 'type2-external':
      return 'external-type2';
    default:
      return undefined;
  }
}

export function ospfRouteCode(
  routeType: string | undefined,
  isDefault: boolean,
): string {
  const type = normalizeOspfRouteType(routeType);
  const star = isDefault ? '*' : ' ';
  switch (type) {
    case 'external-type1': return `O${star}E1`;
    case 'external-type2': return `O${star}E2`;
    case 'inter-area': return `O${star}IA`;
    default: return isDefault ? 'O*  ' : 'O   ';
  }
}
