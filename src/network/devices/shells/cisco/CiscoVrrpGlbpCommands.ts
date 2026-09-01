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

function applyVrrp(repo: FhrpRepository, iface: string, args: string[], router: Router): string {
  const agent = getVrrpAgent(router);
  const group = parseInt(args[0], 10);
  // RFC 5798 : le VRID tient sur un octet et 0 n'en est pas un. La borne
  // est celle du protocole, pas d'une plateforme.
  if (Number.isNaN(group) || group < 1 || group > 255) return '% Invalid VRRP group';
  const g = repo.ensureVrrp(iface, group);
  agent?.ensureGroup(iface, group);
  const rest = args.slice(2);
  switch (args[1]) {
    case 'ip':
      if (rest[0] !== undefined && !IPAddress.isValid(rest[0])) {
        return CISCO_ERRORS.INVALID_INPUT;
      }
      g.vip = rest[0] ?? null;
      if (g.vip) agent?.setVip(iface, group, g.vip);
      return '';
    case 'priority':
      g.priority = parseInt(rest[0], 10) || g.priority;
      agent?.setPriority(iface, group, g.priority);
      return '';
    case 'preempt': {
      g.preempt = true;
      // Le delai etait range sur cette facade et lu par le SEUL
      // affichage : `preempt delay minimum` etait accepte, rendu, et
      // n'a jamais retarde une prise de role. Il atteint desormais
      // l'agent, qui est la seule chose qui decide.
      let delai: number | undefined;
      if (rest[0] === 'delay' && rest[1] === 'minimum') {
        const n = parseInt(rest[2], 10);
        delai = Number.isFinite(n) && n > 0 ? n : undefined;
        g.preemptDelay = delai;
      }
      agent?.setPreempt(iface, group, true, delai);
      return '';
    }
    case 'timers': {
      const n = rest.filter((t) => /^\d+$/.test(t)).map(Number);
      if (n.length) { g.advertiseSec = n[0]; agent?.setAdvertiseSec(iface, group, n[0]); }
      return '';
    }
    case 'authentication': {
      // `vrrp <n> authentication md5 key-string <cle>` ou la forme en
      // texte simple. La cle etait rangee sur cette facade et lue par
      // personne : l'authentification VRRP etait donc inerte sur IOS
      // alors qu'elle fonctionne sur VRP depuis le lot V16.
      const i = rest.indexOf('key-string');
      g.authMd5 = i >= 0 ? rest[i + 1] : rest[rest.length - 1];
      const mode = rest.includes('md5') ? 'md5' : 'simple';
      agent?.setAuth(iface, group, mode, g.authMd5);
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

function applyGlbp(repo: FhrpRepository, iface: string, args: string[], router: Router): string {
  const agent = getGlbpAgent(router);
  const group = parseInt(args[0], 10);
  if (Number.isNaN(group)) return '% Invalid GLBP group';
  const g = repo.ensureGlbp(iface, group);
  agent?.ensureGroup(iface, group);
  const rest = args.slice(2);
  switch (args[1]) {
    case 'ip':
      if (rest[0] !== undefined && !IPAddress.isValid(rest[0])) {
        return CISCO_ERRORS.INVALID_INPUT;
      }
      g.vip = rest[0] ?? null;
      if (g.vip) agent?.setVip(iface, group, g.vip);
      return '';
    case 'priority':
      g.priority = parseInt(rest[0], 10) || g.priority;
      agent?.setPriority(iface, group, g.priority);
      return '';
    case 'preempt': {
      g.preempt = true;
      // Le delai n'etait meme pas ANALYSE cote GLBP : `glbp <n> preempt
      // delay minimum 30` etait avale par le mot-cle et la valeur
      // disparaissait sans laisser de trace, pas meme sur la facade.
      let delai: number | undefined;
      if (rest[0] === 'delay' && rest[1] === 'minimum') {
        const n = parseInt(rest[2], 10);
        delai = Number.isFinite(n) && n > 0 ? n : undefined;
        g.preemptDelay = delai;
      }
      agent?.setPreempt(iface, group, true, delai);
      return '';
    }
    case 'load-balancing': {
      const mode = rest[0] || g.loadBalancing;
      g.loadBalancing = mode;
      if (mode === 'round-robin' || mode === 'weighted' || mode === 'host-dependent') {
        agent?.setLoadBalancing(iface, group, mode);
      }
      return '';
    }
    case 'weighting':
      if (rest[0] === 'track') {
        const target = rest[1];
        const decrement = rest.indexOf('decrement') >= 0
          ? parseInt(rest[rest.indexOf('decrement') + 1], 10) || 10 : 10;
        if (target) agent?.addTrack(iface, group, target, decrement);
        return '';
      }
      if (/^\d+$/.test(rest[0] || '')) {
        g.weighting = parseInt(rest[0], 10);
        agent?.setWeighting(iface, group, g.weighting);
      }
      return '';
    case 'name': g.name = rest.join(' '); return '';
    case 'timers': {
      const n = rest.filter((t) => /^\d+$/.test(t)).map(Number);
      if (n.length >= 2) agent?.setTimers(iface, group, n[0], n[1]);
      return '';
    }
    case 'authentication': {
      // Elle etait acceptee et JETEE — pas meme rangee sur la facade —
      // donc `glbp <n> authentication md5 key-string …` n'avait aucune
      // trace nulle part : ni effet, ni configuration rendue.
      const iKey = rest.indexOf('key-string');
      const md5 = rest[0] === 'md5';
      const cle = iKey >= 0 ? rest[iKey + 1] : rest[rest.length - 1];
      g.authMd5 = cle;
      agent?.setAuth(iface, group, md5 ? 'md5' : 'text', cle);
      return '';
    }
    case 'forwarder': return '';
    default: return '';
  }
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

export function buildVrrpGlbpInterfaceCommands(
  trie: CommandTrie, ctx: Ctx, lireRepo: () => FhrpRepository,
): void {
  trie.registerGreedy('vrrp', 'VRRP configuration', (a) => {
    const i = ctx.getSelectedInterface();
    if (!i) return '% No interface selected';
    return a.length ? applyVrrp(lireRepo(), i, a, ctx.r()) : '% Incomplete command.';
  });
  trie.registerGreedy('no vrrp', 'Remove VRRP group', (a) => {
    const i = ctx.getSelectedInterface();
    if (!i || !/^\d+$/.test(a[0] || '')) return '';
    const group = parseInt(a[0], 10);
    if (a.length === 1) { lireRepo().removeVrrp(i, group); return ''; }
    const g = lireRepo().ensureVrrp(i, group);
    const agent = getVrrpAgent(ctx.r());
    switch (a[1]) {
      case 'preempt':
        g.preempt = false; g.preemptDelay = undefined;
        agent?.setPreempt(i, group, false);
        return '';
      case 'priority':
        g.priority = VRRP_DEFAULT_PRIORITY;
        agent?.setPriority(i, group, VRRP_DEFAULT_PRIORITY);
        return '';
      case 'ip':
        g.vip = null;
        return '';
      case 'timers':
        g.advertiseSec = VRRP_DEFAULT_ADVERTISE_SEC;
        return '';
      case 'description':
        g.description = undefined;
        return '';
      default:
        return CISCO_ERRORS.INVALID_INPUT;
    }
  });
  trie.registerGreedy('glbp', 'GLBP configuration', (a) => {
    const i = ctx.getSelectedInterface();
    if (!i) return '% No interface selected';
    return a.length ? applyGlbp(lireRepo(), i, a, ctx.r()) : '% Incomplete command.';
  });
  trie.registerGreedy('no glbp', 'Remove GLBP group', (a) => {
    const i = ctx.getSelectedInterface();
    if (!i || !/^\d+$/.test(a[0] || '')) return '';
    const group = parseInt(a[0], 10);
    if (a.length === 1) { lireRepo().removeGlbp(i, group); return ''; }
    const g = lireRepo().ensureGlbp(i, group);
    const agent = getGlbpAgent(ctx.r());
    switch (a[1]) {
      case 'preempt':
        g.preempt = false; g.preemptDelay = undefined;
        agent?.setPreempt(i, group, false);
        return '';
      case 'priority':
        g.priority = GLBP_DEFAULT_PRIORITY;
        agent?.setPriority(i, group, GLBP_DEFAULT_PRIORITY);
        return '';
      case 'ip':
        g.vip = null;
        return '';
      case 'weighting':
        g.weighting = GLBP_DEFAULT_WEIGHTING;
        return '';
      case 'load-balancing':
        g.loadBalancing = GLBP_DEFAULT_LOAD_BALANCING;
        return '';
      case 'name':
        g.name = undefined;
        return '';
      default:
        return CISCO_ERRORS.INVALID_INPUT;
    }
  });
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
