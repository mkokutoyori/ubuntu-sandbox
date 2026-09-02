/**
 * CiscoVrrpGlbpCommands — VRRP (`vrrp …`) and GLBP (`glbp …`) interface
 * config + their `show` families, projecting the REAL FhrpRepository
 * state. Router-only (switches are L2); mirrors CiscoHsrpCommands.
 */
import type { CommandTrie } from '../CommandTrie';
import type { Router } from '../../Router';
import type {
  FhrpRepository, VrrpGroup, GlbpGroup,
} from '../../inspection/config/FhrpRepository';
import { getVrrpAgent, getGlbpAgent } from '../../../equipment/RouterServiceCapabilities';
import { IPAddress } from '../../../core/types';
import { CISCO_ERRORS } from '../cli-utils';
import {
  VRRP_DEFAULT_PRIORITY, VRRP_DEFAULT_ADVERTISE_SEC,
  GLBP_DEFAULT_PRIORITY, GLBP_DEFAULT_WEIGHTING, GLBP_DEFAULT_LOAD_BALANCING,
} from '../../../fhrp/runningConfig';

interface Ctx {
  r(): Router;
  getSelectedInterface(): string | null;
}

/** Master/Active while the real interface is up (lone speaker). */
function isUp(router: Router, iface: string): boolean {
  const p = router._getPortsInternal().get(iface);
  return !!p && p.getIsUp() && p.isConnected();
}

function vrrpState(router: Router, g: VrrpGroup): string {
  const agent = getVrrpAgent(router);
  const live = agent?.getGroup(g.iface, g.group);
  if (live) return live.state.charAt(0).toUpperCase() + live.state.slice(1);
  return isUp(router, g.iface) ? 'Master' : 'Init';
}

function vrrpMasterIp(router: Router, g: VrrpGroup): string {
  const agent = getVrrpAgent(router);
  const live = agent?.getGroup(g.iface, g.group);
  if (live?.state === 'master') return 'local';
  return live?.masterIp ?? 'unknown';
}

function vrrpDetail(router: Router, g: VrrpGroup): string {
  const state = vrrpState(router, g);
  return [
    `${g.iface} - Group ${g.group}`,
    `  State is ${state}`,
    `  Virtual IP address is ${g.vip ?? 'unknown'}`,
    `  Master Router is ${vrrpMasterIp(router, g)}`,
    `  Advertisement interval ${g.advertiseSec} sec`,
    `  Preemption ${g.preempt ? 'enabled' : 'disabled'}`,
    `  Priority is ${g.priority}`,
    g.description ? `  Description is "${g.description}"` : null,
  ].filter((l): l is string => l !== null).join('\n');
}

function glbpState(router: Router, g: GlbpGroup): string {
  const agent = getGlbpAgent(router);
  const live = agent?.getGroup(g.iface, g.group);
  if (live) return live.avgState.charAt(0).toUpperCase() + live.avgState.slice(1);
  return isUp(router, g.iface) ? 'Active' : 'Disabled';
}

function glbpActiveIp(router: Router, g: GlbpGroup): string {
  const agent = getGlbpAgent(router);
  const live = agent?.getGroup(g.iface, g.group);
  if (live?.avgState === 'active') return 'local';
  return live?.avgIp ?? 'unknown';
}

function glbpDetail(router: Router, g: GlbpGroup): string {
  const state = glbpState(router, g);
  const agent = getGlbpAgent(router);
  const live = agent?.getGroup(g.iface, g.group);
  const forwarders = live ? [...live.forwarders.values()].sort((a, b) => a.forwarderNumber - b.forwarderNumber) : [];
  const lines = [
    `${g.iface} - Group ${g.group}`,
    `  State is ${state}`,
    `  Virtual IP address is ${g.vip ?? 'unknown'}`,
    `  Hello time ${live?.helloSec ?? 3} sec, hold time ${live?.holdSec ?? 10} sec`,
    `  Preemption ${g.preempt ? 'enabled' : 'disabled'}`,
    `  Active is ${glbpActiveIp(router, g)}`,
    `  Priority ${g.priority} (configured)`,
    `  Weighting ${g.weighting} (configured ${g.weighting})`,
    `  Load balancing: ${g.loadBalancing}`,
    g.name ? `  Group name is "${g.name}"` : null,
  ].filter((l): l is string => l !== null);
  for (const f of forwarders) {
    lines.push(`  Forwarder ${f.forwarderNumber}`);
    lines.push(`    State is ${f.state.charAt(0).toUpperCase() + f.state.slice(1)}`);
    lines.push(`    MAC address is ${f.vmac} (${f.ownerIp === (live ? (router._getPortsInternal().get(g.iface)?.getIPAddress()?.toString() ?? '') : '') ? 'configured' : 'learnt'})`);
    lines.push(`    Owner ID is ${f.ownerIp ?? 'unknown'}`);
    lines.push(`    Redirection enabled`);
    lines.push(`    Preemption disabled`);
    lines.push(`    Priority ${f.priority} (default)`);
    lines.push(`    Weighting ${f.weighting} (default ${f.weighting})`);
  }
  return lines.join('\n');
}

export function registerVrrpGlbpShowCommands(
  trie: CommandTrie, ctx: Ctx, lireRepo: () => FhrpRepository,
): void {
  trie.registerGreedy('show vrrp', 'Display VRRP state', (a) => {
    const groups = lireRepo().allVrrp();
    if (a.includes('brief')) {
      const rows = ['Interface          Grp Pri Time  Own Pre State   Master addr     Group addr'];
      for (const g of groups) {
        rows.push(
          `${g.iface.slice(0, 18).padEnd(19)}${String(g.group).padEnd(4)}` +
          `${String(g.priority).padEnd(4)}    -   ${g.preempt ? 'Y' : 'N'}   ` +
          `${vrrpState(ctx.r(), g).padEnd(8)}` +
          `${vrrpMasterIp(ctx.r(), g).padEnd(16)}${g.vip ?? 'unknown'}`);
      }
      return rows.join('\n');
    }
    return groups.length
      ? groups.map((g) => vrrpDetail(ctx.r(), g)).join('\n') : '';
  });

  trie.registerGreedy('show glbp', 'Display GLBP state', (a) => {
    const groups = lireRepo().allGlbp();
    if (a.includes('brief')) {
      const rows = ['Interface   Grp  Fwd Pri State    Address         Active router   Standby router'];
      for (const g of groups) {
        rows.push(
          `${g.iface.slice(0, 11).padEnd(12)}${String(g.group).padEnd(5)}` +
          `-   ${String(g.priority).padEnd(4)}` +
          `${glbpState(ctx.r(), g).padEnd(9)}` +
          `${(g.vip ?? 'unknown').padEnd(16)}${glbpActiveIp(ctx.r(), g).padEnd(16)}unknown`);
      }
      return rows.join('\n');
    }
    return groups.length
      ? groups.map((g) => glbpDetail(ctx.r(), g)).join('\n') : '';
  });
}
