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

interface HsrpCtx {
  r(): Router;
  getSelectedInterface(): string | null;
}

/** Real operational state of a group, derived from the live port. */
function groupState(router: Router, g: HsrpGroup): 'Active' | 'Init' {
  const port = router._getPortsInternal().get(g.iface);
  // A lone simulated speaker owns the group while its interface is up.
  return port && port.getIsUp() && port.isConnected() ? 'Active' : 'Init';
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
    `  Active router is ${state === 'Active' ? 'local' : 'unknown'}`,
    '  Standby router is unknown',
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
      `${state.padEnd(8)} ${(state === 'Active' ? 'local' : 'unknown').padEnd(15)} ` +
      `${'unknown'.padEnd(15)} ${g.vip ?? 'unknown'}`);
  }
  return rows.join('\n');
}

/** Parse and apply one `standby …` line on the selected interface. */
function applyStandby(repo: FhrpRepository, iface: string, args: string[]): string {
  // Interface-wide forms (no leading group number).
  if (args[0] === 'version') {
    const v = args[1] === '2' ? 2 : 1;
    repo.setInterfaceVersion(iface, v);
    return '';
  }
  if (args[0] === 'use-bia' || args[0] === 'delay') return '';

  const group = parseInt(args[0], 10);
  if (Number.isNaN(group)) return '% Invalid standby group';
  const g = repo.ensure(iface, group);
  const kw = args[1];
  const rest = args.slice(2);
  switch (kw) {
    case 'ip':
      if (rest[1] === 'secondary') g.secondary.push(rest[0]);
      else g.vip = rest[0] ?? null;
      return '';
    case 'priority':
      g.priority = parseInt(rest[0], 10) || g.priority;
      return '';
    case 'preempt':
      g.preempt = true;
      if (rest[0] === 'delay' && rest[1] === 'minimum') {
        g.preemptDelay = parseInt(rest[2], 10) || undefined;
      }
      return '';
    case 'timers': {
      const nums = rest.filter((t) => /^\d+$/.test(t)).map(Number);
      if (nums.length >= 2) { g.helloSec = nums[0]; g.holdSec = nums[1]; }
      return '';
    }
    case 'authentication': {
      const idx = rest.indexOf('key-string');
      const keyStr = idx >= 0 ? rest[idx + 1] : rest[rest.length - 1];
      if (rest[0] === 'md5') g.authMd5 = keyStr; else g.authText = keyStr;
      return '';
    }
    case 'track': {
      const decrIdx = rest.indexOf('decrement');
      g.trackDecr.push({
        target: rest[0],
        decrement: decrIdx >= 0 ? parseInt(rest[decrIdx + 1], 10) || 10 : 10,
      });
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
    return applyStandby(repo, iface, args);
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
