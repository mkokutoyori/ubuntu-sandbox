/**
 * CiscoHsrpCommands — HSRP (`standby …`) interface config + the
 * `show standby` family, projecting the REAL FhrpRepository state.
 *
 * Router-only (the project's switches are L2): kept out of the shared
 * base to avoid shadowing and respect the L2/L3 split.
 */
import type { CommandTrie } from '../CommandTrie';
import type { Router } from '../../Router';
import { FhrpRepository, hsrpVirtualMac, type HsrpGroup }
  from '../../inspection/config/FhrpRepository';
import { hsrpMaxGroup } from '../../../hsrp/types';
import type { SessionParamRanges } from '../EquipmentParamResolver';
import { getHsrpAgent } from '../../../equipment/RouterServiceCapabilities';
import { iosShortInterfaceName } from '@/network/devices/inspection/InterfaceStatusView';
import { CliInvalidInput } from '../cli/CliDiagnostic';
import {
  parseFhrpShowArgs, fhrpShowMatches, fhrpInterfaceResolver, HSRP_SHOW_GRAMMAR,
} from './fhrpShowFilter';

interface HsrpCtx {
  r(): Router;
  getSelectedInterface(): string | null;
}

function groupState(router: Router, g: HsrpGroup): string {
  const agent = getHsrpAgent(router);
  const live = agent?.getGroup(g.iface, g.group);
  if (live) {
    const s = live.state;
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  const port = router._getPortsInternal().get(g.iface);
  return port && port.getIsUp() && port.isConnected() ? 'Active' : 'Init';
}

function activeRouterLabel(router: Router, g: HsrpGroup): string {
  const agent = getHsrpAgent(router);
  const live = agent?.getGroup(g.iface, g.group);
  if (live?.state === 'active') return 'local';
  return live?.activeRouterIp ?? 'unknown';
}

function standbyRouterLabel(router: Router, g: HsrpGroup): string {
  const agent = getHsrpAgent(router);
  const live = agent?.getGroup(g.iface, g.group);
  if (live?.state === 'standby') return 'local';
  return live?.standbyRouterIp ?? 'unknown';
}

function renderDetail(router: Router, g: HsrpGroup): string {
  const state = groupState(router, g);
  const lines = [
    `${g.iface} - Group ${g.group}${g.version === 2 ? ' (version 2)' : ''}`,
    `  State is ${state}`,
    `  Virtual IP address is ${g.vip ?? 'unknown'}`,
    `  Active virtual MAC address is ${hsrpVirtualMac(g.group, g.version)}`,
    `  Hello time ${g.helloSec} sec, hold time ${g.holdSec} sec`,
    `  ${g.preempt ? 'Preemption enabled' : 'Preemption disabled'}` +
      (g.preempt && g.preemptDelay ? `, delay min ${g.preemptDelay} secs` : ''),
    `  Active router is ${activeRouterLabel(router, g)}`,
    `  Standby router is ${standbyRouterLabel(router, g)}`,
    `  Priority ${g.priority} (configured ${g.priority})`,
  ];
  for (const t of g.trackDecr) {
    lines.push(`  Track object ${t.target} state decrement ${t.decrement}`);
  }
  if (g.name) lines.push(`  Group name is "${g.name}" (cfgd)`);
  if (g.follow) lines.push(`  Following group ${g.follow}`);
  return lines.join('\n');
}

function renderBrief(router: Router, groups: HsrpGroup[]): string {
  const rows = [
    '                     P indicates configured to preempt.',
    '                     |',
    'Interface   Grp  Pri P State    Active          Standby         Virtual IP',
  ];
  for (const g of groups) {
    const state = groupState(router, g);
    rows.push(
      // IOS abrège le nom (`Gi0/0`) dans cette vue ; le tronquer donnait
      // `GigabitEthe`, qui ne désigne aucune interface et ne se retape pas.
      `${iosShortInterfaceName(g.iface).slice(0, 11).padEnd(12)}${String(g.group).padEnd(5)}` +
      `${String(g.priority).padEnd(4)}${g.preempt ? 'P' : ' '} ` +
      `${state.padEnd(8)} ${activeRouterLabel(router, g).padEnd(15)} ` +
      `${standbyRouterLabel(router, g).padEnd(15)} ${g.vip ?? 'unknown'}`);
  }
  return rows.join('\n');
}

export function hsrpGroupRange(
  ctx: HsrpCtx, lireRepo: () => FhrpRepository,
): SessionParamRanges {
  return {
    rangeFor: (context) => {
      if (context.path[context.path.length - 1]?.toLowerCase() !== 'standby') return null;
      const iface = ctx.getSelectedInterface();
      if (!iface) return null;
      return [0, hsrpMaxGroup(lireRepo().interfaceVersion(iface))];
    },
  };
}

export function registerHsrpShowCommands(
  trie: CommandTrie, ctx: HsrpCtx, lireRepo: () => FhrpRepository,
): void {
  trie.registerGreedy('show standby', 'Display HSRP state', (args) => {
    const router = ctx.r();
    const verdict = parseFhrpShowArgs(
      args, HSRP_SHOW_GRAMMAR, fhrpInterfaceResolver(router.getPortNames()));
    if ('at' in verdict) throw new CliInvalidInput({ token: verdict.at });
    const groups = lireRepo().all()
      .filter((g) => fhrpShowMatches(g.iface, g.group, verdict));
    if (verdict.brief) return renderBrief(router, groups);
    if (!groups.length) return '';
    return groups.map((g) => renderDetail(router, g)).join('\n');
  });
}
