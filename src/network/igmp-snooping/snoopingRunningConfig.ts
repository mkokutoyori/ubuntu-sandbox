import { createDefaultSnoopingConfig, type SnoopingConfig } from './types';

const DEFAULTS = createDefaultSnoopingConfig();

export function igmpSnoopingRunningConfigLines(config: SnoopingConfig): string[] {
  const lines: string[] = [];
  if (!config.enabled) lines.push('no ip igmp snooping');
  if (config.querierEnabled) lines.push('ip igmp snooping querier');
  if (config.querierAddress) {
    lines.push(`ip igmp snooping querier address ${config.querierAddress}`);
  }
  if (config.querierIntervalSec !== DEFAULTS.querierIntervalSec) {
    lines.push(`ip igmp snooping querier query-interval ${config.querierIntervalSec}`);
  }

  for (const vlan of [...config.vlans.keys()].sort((a, b) => a - b)) {
    const state = config.vlans.get(vlan);
    if (!state) continue;

    if (!state.enabled) lines.push(`no ip igmp snooping vlan ${vlan}`);
    if (state.querierEnabled) lines.push(`ip igmp snooping vlan ${vlan} querier`);
    for (const port of [...state.staticRouterPorts].sort()) {
      lines.push(`ip igmp snooping vlan ${vlan} mrouter interface ${port}`);
    }
  }
  for (const vlan of [...config.immediateLeave].sort((a, b) => a - b)) {
    lines.push(`ip igmp snooping vlan ${vlan} immediate-leave`);
  }
  return lines;
}
