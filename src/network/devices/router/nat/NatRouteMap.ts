export const NAT_ROUTE_MAP_PREFIX = 'route-map:';

export interface NatRouteMapClause {
  readonly action: 'permit' | 'deny';
  readonly seq: number;
  readonly match: readonly string[];
}

export interface NatRouteMapContext {
  readonly aclPermits: (aclId: string) => boolean;
  readonly egressInterface: string | undefined;
}

function lineSatisfied(line: string, context: NatRouteMapContext): boolean {
  const words = line.trim().split(/\s+/);
  if (words[0] === 'ip' && words[1] === 'address' && words[2] !== 'prefix-list') {
    return words.slice(2).some((acl) => context.aclPermits(acl));
  }
  if (words[0] === 'interface') {
    return context.egressInterface !== undefined
      && words.slice(1).some((name) => name.toLowerCase() === context.egressInterface!.toLowerCase());
  }
  return false;
}

export function natRouteMapPermits(
  clauses: readonly NatRouteMapClause[] | undefined, context: NatRouteMapContext,
): boolean {
  if (clauses === undefined) return false;
  const ordered = [...clauses].sort((a, b) => a.seq - b.seq);
  for (const clause of ordered) {
    if (clause.match.every((line) => lineSatisfied(line, context))) return clause.action === 'permit';
  }
  return false;
}
