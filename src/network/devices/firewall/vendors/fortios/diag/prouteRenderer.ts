import { tryIpToUint32, uint32ToIp } from '@/network/core/ip';
import type { PolicyRoute, PolicyRoutePrefix } from '../../../l3/PolicyRouteTable';

export interface ProuteContext {
  readonly vdom: string;
  readonly interfaceIndex: (name: string) => number;
  readonly stamp: (at: number) => string;
}

const ANY_RANGE = '0.0.0.0-255.255.255.255';

function range(prefix: PolicyRoutePrefix): string {
  const network = tryIpToUint32(prefix.network);
  const mask = tryIpToUint32(prefix.mask);
  if (network === null || mask === null) return ANY_RANGE;
  const first = (network & mask) >>> 0;
  const last = (first | (~mask >>> 0)) >>> 0;
  return `${uint32ToIp(first)}-${uint32ToIp(last)}`;
}

function ranges(label: string, prefixes: readonly PolicyRoutePrefix[]): string {
  const rendered = prefixes.length === 0 ? [ANY_RANGE] : prefixes.map(range);
  return `${label}(${rendered.length}): ${rendered.join(' ')}`;
}

function device(name: string | undefined, context: ProuteContext): string {
  if (name === undefined || name.length === 0) return '';
  return `${context.interfaceIndex(name)}(${name})`;
}

function headLine(route: PolicyRoute, context: ProuteContext): string {
  const numeric = Number.parseInt(route.id, 10);
  const hex = Number.isFinite(numeric)
    ? `(0x${numeric.toString(16).padStart(2, '0')})` : '';
  const parts = [
    `id=${route.id}${hex}`,
    `protocol=${route.protocol}`,
    `sport=${route.startSourcePort}-${route.endSourcePort}`,
    `iif=${route.inputDevices.map(name => device(name, context)).join(' ')}`,
    `dport=${route.startPort}-${route.endPort}`,
  ];
  if (route.action === 'deny') parts.push('action=deny');
  else {
    if (route.outputDevice !== undefined) {
      parts.push(`oif=${device(route.outputDevice, context)}`);
    }
    if (route.gateway !== undefined) parts.push(`gwy=${route.gateway}`);
  }
  return parts.join(' ');
}

export function renderPolicyRoutes(
  routes: readonly PolicyRoute[], context: ProuteContext,
): string {
  const lines = [`list route policy info(vf=${context.vdom}):`, ''];
  for (const route of routes) {
    lines.push(headLine(route, context));
    lines.push(ranges('source', route.sourcePrefixes));
    lines.push(ranges('destination', route.destinationPrefixes));
    lines.push(route.lastUsedAt === null
      ? `hit_count=${route.hitCount}`
      : `hit_count=${route.hitCount} last_used=${context.stamp(route.lastUsedAt)}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}
