import type { StpAgent } from '@/network/stp/StpAgent';

const VRP_HELLO_SEC = 2;
const VRP_FORWARD_DELAY_SEC = 15;
const VRP_MAX_AGE_SEC = 20;
const VRP_DEFAULT_PRIORITY = 32768;

export function vrpStpRegionLines(agent: StpAgent | undefined): string[] {
  const region = agent?.getMstRegion();
  if (!region) return [];
  if (!region.name && region.revision === 0 && region.instances.size === 0) return [];
  const out = ['stp region-configuration'];
  if (region.name) out.push(` region-name ${region.name}`);
  if (region.revision !== 0) out.push(` revision-level ${region.revision}`);
  for (const [id, vlans] of [...region.instances].sort((a, b) => a[0] - b[0])) {
    out.push(` instance ${id} vlan ${vlans}`);
  }
  out.push(' active region-configuration');
  return out;
}

export function vrpStpGlobalLines(agent: StpAgent | undefined): string[] {
  if (!agent) return [];
  const out: string[] = [];
  const mode = agent.getMode();
  if (mode !== 'mstp') out.push(`stp mode ${mode}`);

  const roles = new Map(agent.getConfiguredRootRoles());
  for (const [instance, role] of roles) {
    out.push(`stp instance ${instance} root ${role}`);
  }
  if (!roles.has(0) && agent.getVlanPriority(1) !== VRP_DEFAULT_PRIORITY) {
    out.push(`stp priority ${agent.getVlanPriority(1)}`);
  }
  for (const [instance, priority] of agent.getConfiguredMstInstancePriorities()) {
    if (instance === 0 || roles.has(instance)) continue;
    out.push(`stp instance ${instance} priority ${priority}`);
  }

  const global = agent.getGlobalStp();
  if (global.bpduGuardGlobal) out.push('stp bpdu-protection');
  if (global.portfastDefault) out.push('stp edged-port default');
  if (agent.getPathcostMethod() !== 'long') out.push('stp pathcost-standard dot1d-1998');

  const hello = agent.getVlanHelloSec(1);
  if (hello !== VRP_HELLO_SEC) out.push(`stp timer hello ${hello * 100}`);
  const forwardDelay = agent.getVlanForwardDelaySec(1);
  if (forwardDelay !== VRP_FORWARD_DELAY_SEC) {
    out.push(`stp timer forward-delay ${forwardDelay * 100}`);
  }
  const maxAge = agent.getVlanMaxAgeSec(1);
  if (maxAge !== VRP_MAX_AGE_SEC) out.push(`stp timer max-age ${maxAge * 100}`);

  if (!agent.isEnabledStp()) out.push('stp disable');
  return out;
}
