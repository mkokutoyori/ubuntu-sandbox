import type { PimSnoopingConfig } from './types';

/**
 * Ce que `show running-config` doit rendre du snooping PIM.
 *
 * Il ne rendait RIEN : `ip pim snooping` s'acceptait, l'agent le
 * retenait, et la configuration relue n'en portait pas trace — donc un
 * export de topologie perdait le reglage, et le reimport rendait un
 * commutateur qui ne surveille plus le PIM sans qu'un mot le dise. La
 * vue `show ip pim snooping` le montrait pendant ce temps : deux vues
 * d'un seul etat qui se contredisaient.
 *
 * PIM est eteint par defaut, a l'inverse d'IGMP : c'est donc la forme
 * POSITIVE qui s'ecrit, la ou son voisin ecrit la negation.
 */
export function pimSnoopingRunningConfigLines(config: PimSnoopingConfig): string[] {
  const lines: string[] = [];
  if (config.enabled) lines.push('ip pim snooping');

  for (const vlan of [...config.vlans.keys()].sort((a, b) => a - b)) {
    const state = config.vlans.get(vlan);
    if (!state) continue;
    lines.push(state.enabled
      ? `ip pim snooping vlan ${vlan}`
      : `no ip pim snooping vlan ${vlan}`);
  }
  return lines;
}
