export const VDOM_RESOURCES = [
  'session', 'firewall-policy', 'firewall-address', 'firewall-addrgrp', 'custom-service', 'service-group',
  'onetime-schedule', 'recurring-schedule', 'user', 'user-group', 'ipsec-phase1-interface', 'ipsec-phase2-interface',
] as const;

export type VdomResource = typeof VDOM_RESOURCES[number];

export type VdomResourceLimits = Readonly<Partial<Record<VdomResource, {
  readonly maximum: number;
  readonly guaranteed: number;
}>>>;

export function ceilingOf(limits: VdomResourceLimits | undefined, resource: VdomResource): number | undefined {
  const maximum = limits?.[resource]?.maximum;
  return maximum !== undefined && maximum > 0 ? maximum : undefined;
}
