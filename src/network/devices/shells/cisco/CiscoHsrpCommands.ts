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
import { hsrpMaxGroup, HSRP_V1_MAX_GROUP } from '../../../hsrp/types';

interface HsrpCtx {
  r(): Router;
  getSelectedInterface(): string | null;
}

function groupState(router: Router, g: HsrpGroup): string {
  const agent = (router as unknown as { getHsrpAgent?: () => import('../../../hsrp/HsrpAgent').HsrpAgent }).getHsrpAgent?.();
  const live = agent?.getGroup(g.iface, g.group);
  if (live) {
    const s = live.state;
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  const port = router._getPortsInternal().get(g.iface);
  return port && port.getIsUp() && port.isConnected() ? 'Active' : 'Init';
}

function activeRouterLabel(router: Router, g: HsrpGroup): string {
  const agent = (router as unknown as { getHsrpAgent?: () => import('../../../hsrp/HsrpAgent').HsrpAgent }).getHsrpAgent?.();
  const live = agent?.getGroup(g.iface, g.group);
  if (live?.state === 'active') return 'local';
  return live?.activeRouterIp ?? 'unknown';
}

function standbyRouterLabel(router: Router, g: HsrpGroup): string {
  const agent = (router as unknown as { getHsrpAgent?: () => import('../../../hsrp/HsrpAgent').HsrpAgent }).getHsrpAgent?.();
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
      `${g.iface.slice(0, 11).padEnd(12)}${String(g.group).padEnd(5)}` +
      `${String(g.priority).padEnd(4)}${g.preempt ? 'P' : ' '} ` +
      `${state.padEnd(8)} ${activeRouterLabel(router, g).padEnd(15)} ` +
      `${standbyRouterLabel(router, g).padEnd(15)} ${g.vip ?? 'unknown'}`);
  }
  return rows.join('\n');
}

function applyStandby(repo: FhrpRepository, iface: string, args: string[], router: Router): string {
  const agent = (router as unknown as { getHsrpAgent?: () => import('../../../hsrp/HsrpAgent').HsrpAgent }).getHsrpAgent?.();
  if (args[0] === 'version') {
    const v = args[1] === '2' ? 2 : 1;
    // Real IOS refuses to fall back to version 1 while groups above 255
    // exist on the interface (their number no longer fits the v1 packet).
    if (v === 1) {
      const tooBig = repo.forInterface(iface)
        .filter((g) => g.group > HSRP_V1_MAX_GROUP);
      if (tooBig.length > 0) {
        return `% Cannot change to version 1 while group numbers above ${HSRP_V1_MAX_GROUP} exist`;
      }
    }
    repo.setInterfaceVersion(iface, v);
    agent?.setVersion(iface, v);
    return '';
  }
  if (args[0] === 'use-bia' || args[0] === 'delay') return '';

  const group = parseInt(args[0], 10);
  if (Number.isNaN(group)) return '% Invalid standby group';
  // Real IOS bounds the group number by HSRP version: <0-255> in v1,
  // <0-4095> in v2.
  const ifaceVersion = repo.interfaceVersion(iface);
  const maxGroup = hsrpMaxGroup(ifaceVersion);
  if (group < 0 || group > maxGroup) {
    return `% Group number out of range. Valid range is 0-${maxGroup} for HSRP version ${ifaceVersion}`;
  }
  const g = repo.ensure(iface, group);
  agent?.ensureGroup(iface, group, g.version);
  const kw = args[1];
  const rest = args.slice(2);
  switch (kw) {
    case 'ip':
      if (rest[1] === 'secondary') g.secondary.push(rest[0]);
      else {
        g.vip = rest[0] ?? null;
        if (g.vip) agent?.setVip(iface, group, g.vip);
      }
      return '';
    case 'priority':
      g.priority = parseInt(rest[0], 10) || g.priority;
      agent?.setPriority(iface, group, g.priority);
      return '';
    case 'preempt':
      g.preempt = true;
      if (rest[0] === 'delay' && rest[1] === 'minimum') {
        g.preemptDelay = parseInt(rest[2], 10) || undefined;
      }
      agent?.setPreempt(iface, group, true);
      return '';
    case 'timers': {
      const nums = rest.filter((t) => /^\d+$/.test(t)).map(Number);
      if (nums.length >= 2) {
        g.helloSec = nums[0]; g.holdSec = nums[1];
        agent?.setTimers(iface, group, g.helloSec, g.holdSec);
      }
      return '';
    }
    case 'authentication': {
      const idx = rest.indexOf('key-string');
      const keyStr = idx >= 0 ? rest[idx + 1] : rest[rest.length - 1];
      if (rest[0] === 'md5') g.authMd5 = keyStr; else { g.authText = keyStr; agent?.setAuth(iface, group, keyStr); }
      return '';
    }
    case 'track': {
      const decrIdx = rest.indexOf('decrement');
      const target = rest[0];
      const decrement = decrIdx >= 0 ? parseInt(rest[decrIdx + 1], 10) || 10 : 10;
      g.trackDecr.push({ target, decrement });
      agent?.addTrack(iface, group, target, decrement);
      return '';
    }
    case 'name':
      g.name = rest.join(' ');
      return '';
    case 'mac-address':
      return '';
    case 'follow':
      g.follow = rest[0];
      return '';
    default:
      return '';
  }
}

export function buildHsrpInterfaceCommands(
  trie: CommandTrie, ctx: HsrpCtx, repo: FhrpRepository,
): void {
  trie.registerGreedy('standby', 'HSRP configuration', (args) => {
    const iface = ctx.getSelectedInterface();
    if (!iface) return '% No interface selected';
    if (args.length === 0) return '% Incomplete command.';
    return applyStandby(repo, iface, args, ctx.r());
  });
  trie.registerGreedy('no standby', 'Remove HSRP configuration', (args) => {
    const iface = ctx.getSelectedInterface();
    if (!iface) return '% No interface selected';
    const group = parseInt(args[0], 10);
    if (!Number.isNaN(group) && args.length === 1) repo.remove(iface, group);
    return '';
  });
}

export function registerHsrpShowCommands(
  trie: CommandTrie, ctx: HsrpCtx, repo: FhrpRepository,
): void {
  trie.registerGreedy('show standby', 'Display HSRP state', (args) => {
    const router = ctx.r();
    const all = repo.all();
    if (args.includes('brief')) {
      return renderBrief(router, all);
    }
    // `show standby <iface> [grp]` filters; bare/all → every group.
    const ifArg = args.find((a) => /[A-Za-z]+\d/.test(a));
    let groups = all;
    if (ifArg) groups = all.filter((g) => g.iface.toLowerCase().includes(ifArg.toLowerCase()));
    if (!groups.length) return '';
    return groups.map((g) => renderDetail(router, g)).join('\n');
  });
}
