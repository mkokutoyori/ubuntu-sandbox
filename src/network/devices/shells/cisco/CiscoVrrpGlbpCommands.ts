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

interface Ctx {
  r(): Router;
  getSelectedInterface(): string | null;
}

/** Master/Active while the real interface is up (lone speaker). */
function isUp(router: Router, iface: string): boolean {
  const p = router._getPortsInternal().get(iface);
  return !!p && p.getIsUp() && p.isConnected();
}

function applyVrrp(repo: FhrpRepository, iface: string, args: string[]): string {
  const group = parseInt(args[0], 10);
  if (Number.isNaN(group)) return '% Invalid VRRP group';
  const g = repo.ensureVrrp(iface, group);
  const rest = args.slice(2);
  switch (args[1]) {
    case 'ip': g.vip = rest[0] ?? null; return '';
    case 'priority': g.priority = parseInt(rest[0], 10) || g.priority; return '';
    case 'preempt':
      g.preempt = true;
      if (rest[0] === 'delay' && rest[1] === 'minimum') {
        g.preemptDelay = parseInt(rest[2], 10) || undefined;
      }
      return '';
    case 'timers': {
      const n = rest.filter((t) => /^\d+$/.test(t)).map(Number);
      if (n.length) g.advertiseSec = n[0];
      return '';
    }
    case 'authentication': {
      const i = rest.indexOf('key-string');
      g.authMd5 = i >= 0 ? rest[i + 1] : rest[rest.length - 1];
      return '';
    }
    case 'track':
      g.trackDecr.push({
        target: rest[0],
        decrement: rest.indexOf('decrement') >= 0
          ? parseInt(rest[rest.indexOf('decrement') + 1], 10) || 10 : 10,
      });
      return '';
    case 'description': g.description = rest.join(' '); return '';
    case 'address-family': return '';
    default: return '';
  }
}

function applyGlbp(repo: FhrpRepository, iface: string, args: string[]): string {
  const group = parseInt(args[0], 10);
  if (Number.isNaN(group)) return '% Invalid GLBP group';
  const g = repo.ensureGlbp(iface, group);
  const rest = args.slice(2);
  switch (args[1]) {
    case 'ip': g.vip = rest[0] ?? null; return '';
    case 'priority': g.priority = parseInt(rest[0], 10) || g.priority; return '';
    case 'preempt': g.preempt = true; return '';
    case 'load-balancing': g.loadBalancing = rest[0] || g.loadBalancing; return '';
    case 'weighting':
      if (/^\d+$/.test(rest[0] || '')) g.weighting = parseInt(rest[0], 10);
      return '';
    case 'name': g.name = rest.join(' '); return '';
    case 'timers': case 'forwarder': case 'authentication': return '';
    default: return '';
  }
}

function vrrpDetail(router: Router, g: VrrpGroup): string {
  const state = isUp(router, g.iface) ? 'Master' : 'Init';
  return [
    `${g.iface} - Group ${g.group}`,
    `  State is ${state}`,
    `  Virtual IP address is ${g.vip ?? 'unknown'}`,
    `  Advertisement interval ${g.advertiseSec} sec`,
    `  Preemption ${g.preempt ? 'enabled' : 'disabled'}`,
    `  Priority is ${g.priority}`,
    g.description ? `  Description is "${g.description}"` : null,
  ].filter((l): l is string => l !== null).join('\n');
}

function glbpDetail(router: Router, g: GlbpGroup): string {
  const state = isUp(router, g.iface) ? 'Active' : 'Disabled';
  return [
    `${g.iface} - Group ${g.group}`,
    `  State is ${state}`,
    `  Virtual IP address is ${g.vip ?? 'unknown'}`,
    `  Hello time 3 sec, hold time 10 sec`,
    `  Preemption ${g.preempt ? 'enabled' : 'disabled'}`,
    `  Active is local`,
    `  Priority ${g.priority} (configured)`,
    `  Weighting ${g.weighting} (configured ${g.weighting})`,
    `  Load balancing: ${g.loadBalancing}`,
    g.name ? `  Group name is "${g.name}"` : null,
  ].filter((l): l is string => l !== null).join('\n');
}

export function buildVrrpGlbpInterfaceCommands(
  trie: CommandTrie, ctx: Ctx, repo: FhrpRepository,
): void {
  trie.registerGreedy('vrrp', 'VRRP configuration', (a) => {
    const i = ctx.getSelectedInterface();
    if (!i) return '% No interface selected';
    return a.length ? applyVrrp(repo, i, a) : '% Incomplete command.';
  });
  trie.registerGreedy('no vrrp', 'Remove VRRP group', (a) => {
    const i = ctx.getSelectedInterface();
    if (i && /^\d+$/.test(a[0] || '') && a.length === 1) {
      repo.removeVrrp(i, parseInt(a[0], 10));
    }
    return '';
  });
  trie.registerGreedy('glbp', 'GLBP configuration', (a) => {
    const i = ctx.getSelectedInterface();
    if (!i) return '% No interface selected';
    return a.length ? applyGlbp(repo, i, a) : '% Incomplete command.';
  });
  trie.registerGreedy('no glbp', 'Remove GLBP group', (a) => {
    const i = ctx.getSelectedInterface();
    if (i && /^\d+$/.test(a[0] || '') && a.length === 1) {
      repo.removeGlbp(i, parseInt(a[0], 10));
    }
    return '';
  });
}

export function registerVrrpGlbpShowCommands(
  trie: CommandTrie, ctx: Ctx, repo: FhrpRepository,
): void {
  trie.registerGreedy('show vrrp', 'Display VRRP state', (a) => {
    const groups = repo.allVrrp();
    if (a.includes('brief')) {
      const rows = ['Interface          Grp Pri Time  Own Pre State   Master addr     Group addr'];
      for (const g of groups) {
        rows.push(
          `${g.iface.slice(0, 18).padEnd(19)}${String(g.group).padEnd(4)}` +
          `${String(g.priority).padEnd(4)}    -   ${g.preempt ? 'Y' : 'N'}   ` +
          `${(isUp(ctx.r(), g.iface) ? 'Master' : 'Init').padEnd(8)}` +
          `${'local'.padEnd(16)}${g.vip ?? 'unknown'}`);
      }
      return rows.join('\n');
    }
    return groups.length
      ? groups.map((g) => vrrpDetail(ctx.r(), g)).join('\n') : '';
  });

  trie.registerGreedy('show glbp', 'Display GLBP state', (a) => {
    const groups = repo.allGlbp();
    if (a.includes('brief')) {
      const rows = ['Interface   Grp  Fwd Pri State    Address         Active router   Standby router'];
      for (const g of groups) {
        rows.push(
          `${g.iface.slice(0, 11).padEnd(12)}${String(g.group).padEnd(5)}` +
          `-   ${String(g.priority).padEnd(4)}` +
          `${(isUp(ctx.r(), g.iface) ? 'Active' : 'Disabled').padEnd(9)}` +
          `${(g.vip ?? 'unknown').padEnd(16)}${'local'.padEnd(16)}unknown`);
      }
      return rows.join('\n');
    }
    return groups.length
      ? groups.map((g) => glbpDetail(ctx.r(), g)).join('\n') : '';
  });
}
