import { tryIpToUint32 } from '../../../core/ip';
import type { FirewallSession } from './SessionTable';
import type { FlowKey } from './FlowKey';

export type SessionFamily = 'ipv4' | 'ipv6';

export function familyOfAddress(address: string): SessionFamily {
  return tryIpToUint32(address) === null ? 'ipv6' : 'ipv4';
}

export function familyOfFlow(flow: FlowKey): SessionFamily {
  return familyOfAddress(flow.sourceIP);
}

export function sessionFamily(session: FirewallSession): SessionFamily {
  return familyOfFlow(session.c2s);
}
