/**
 * CiscoNATCommands - NAT/PAT command registration for Cisco IOS CLI
 *
 * Supports:
 *   Global config: ip nat inside source static <local> <global>
 *                  ip nat inside source static tcp|udp <local> <lport> <global> <gport>
 *                  ip nat inside source list <acl> interface <if> overload
 *                  ip nat inside source list <acl> pool <name>
 *                  ip nat pool <name> <start> <end> netmask <mask>
 *                  no ip nat inside source static …
 *                  no ip nat pool <name>
 *   Interface:     ip nat inside / ip nat outside / no ip nat inside / no ip nat outside
 *   Privileged:    clear ip nat translation *
 *   Show:          show ip nat translations / show ip nat statistics
 */

import type { Router } from '../../Router';
import type { NatStaticEntry } from '../../router/NATEngine';
import { CommandTrie } from '../CommandTrie';
import type { CiscoShellContext } from './CiscoConfigCommands';

// ─── Global Config Mode ──────────────────────────────────────────────────────

export function buildNATConfigCommands(trie: CommandTrie, ctx: CiscoShellContext): void {
  // ip nat inside source static <localIP> <globalIP>
  // ip nat inside source static tcp|udp <localIP> <localPort> <globalIP> <globalPort>
  trie.registerGreedy('ip nat inside source static', 'Configure static NAT translation', (args) => {
    if (args.length < 2) return '% Incomplete command.';
    const engine = ctx.r()._getNATEngine();

    const proto = args[0].toLowerCase();
    if (proto === 'tcp' || proto === 'udp') {
      // Port forwarding: ip nat inside source static tcp <localIP> <lPort> <globalIP> <gPort>
      if (args.length < 5) return '% Incomplete command.';
      const localIP = args[1];
      const localPort = parseInt(args[2], 10);
      const globalIP = args[3];
      const globalPort = parseInt(args[4], 10);
      if (isNaN(localPort) || isNaN(globalPort)) return '% Invalid port number.';
      engine.addStaticEntry({ localIP, globalIP, protocol: proto as 'tcp' | 'udp', localPort, globalPort });
    } else {
      // Pure IP static NAT: ip nat inside source static <localIP> <globalIP>
      const localIP = args[0];
      const globalIP = args[1];
      engine.addStaticEntry({ localIP, globalIP });
    }
    return '';
  });

  // no ip nat inside source static <localIP> <globalIP>
  trie.registerGreedy('no ip nat inside source static', 'Remove static NAT translation', (args) => {
    if (args.length < 2) return '% Incomplete command.';
    const engine = ctx.r()._getNATEngine();
    const proto = args[0].toLowerCase();
    if (proto === 'tcp' || proto === 'udp') {
      if (args.length < 5) return '% Incomplete command.';
      const localIP = args[1];
      const globalIP = args[3];
      engine.removeStaticEntry(localIP, globalIP);
    } else {
      engine.removeStaticEntry(args[0], args[1]);
    }
    return '';
  });

  // ip nat inside source list <acl> interface <if> overload  (PAT)
  // ip nat inside source list <acl> pool <name>              (pool NAT)
  trie.registerGreedy('ip nat inside source list', 'Configure dynamic NAT/PAT', (args) => {
    if (args.length < 3) return '% Incomplete command.';
    const engine = ctx.r()._getNATEngine();
    const aclId = args[0]; // number or name
    const keyword = args[1]?.toLowerCase();

    if (keyword === 'interface') {
      const ifName = ctx.resolveInterfaceName(args[2]) ?? args[2];
      const isOverload = args[3]?.toLowerCase() === 'overload';
      if (!isOverload) return '% Missing "overload" keyword.';
      engine.addDynamicRule({ aclId, type: 'overload', interfaceName: ifName });
    } else if (keyword === 'pool') {
      const poolName = args[2];
      engine.addDynamicRule({ aclId, type: 'pool', poolName });
    } else {
      return '% Invalid command syntax.';
    }
    return '';
  });

  // no ip nat inside source list <acl>
  trie.registerGreedy('no ip nat inside source list', 'Remove dynamic NAT rule', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    ctx.r()._getNATEngine().removeDynamicRule(args[0]);
    return '';
  });

  // ip nat pool <name> <startIP> <endIP> netmask <mask>
  trie.registerGreedy('ip nat pool', 'Define NAT address pool', (args) => {
    // ip nat pool NAME startIP endIP netmask MASK
    if (args.length < 5) return '% Incomplete command.';
    const [name, startIP, endIP, netmaskKw, endIP2OrMask] = args;
    if (netmaskKw.toLowerCase() !== 'netmask') return '% Expected "netmask" keyword.';
    // args[4] is the mask if args length is 5; prefix-length style not supported here
    const mask = args[4];
    ctx.r()._getNATEngine().addPool({ name, startIP, endIP });
    return '';
  });

  // no ip nat pool <name>
  trie.registerGreedy('no ip nat pool', 'Remove NAT address pool', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    ctx.r()._getNATEngine().removePool(args[0]);
    return '';
  });

  // ip nat translation tcp-timeout <seconds>
  trie.registerGreedy('ip nat translation tcp-timeout', 'Set TCP NAT session timeout', (args) => {
    const s = parseInt(args[0], 10);
    if (isNaN(s) || s < 1) return '% Invalid timeout value.';
    ctx.r()._getNATEngine().setTimeouts({ tcp: s * 1000 });
    return '';
  });

  // ip nat translation udp-timeout <seconds>
  trie.registerGreedy('ip nat translation udp-timeout', 'Set UDP NAT session timeout', (args) => {
    const s = parseInt(args[0], 10);
    if (isNaN(s) || s < 1) return '% Invalid timeout value.';
    ctx.r()._getNATEngine().setTimeouts({ udp: s * 1000 });
    return '';
  });

  // ip nat translation icmp-timeout <seconds>
  trie.registerGreedy('ip nat translation icmp-timeout', 'Set ICMP NAT session timeout', (args) => {
    const s = parseInt(args[0], 10);
    if (isNaN(s) || s < 1) return '% Invalid timeout value.';
    ctx.r()._getNATEngine().setTimeouts({ icmp: s * 1000 });
    return '';
  });

  // ip nat translation syn-timeout <seconds>  (TCP half-open)
  trie.registerGreedy('ip nat translation syn-timeout', 'Set TCP SYN (half-open) timeout', (args) => {
    const s = parseInt(args[0], 10);
    if (isNaN(s) || s < 1) return '% Invalid timeout value.';
    ctx.r()._getNATEngine().setTimeouts({ tcpHalfOpen: s * 1000 });
    return '';
  });
}

// ─── Interface Config Mode ────────────────────────────────────────────────────

export function buildNATInterfaceCommands(trie: CommandTrie, ctx: CiscoShellContext): void {
  trie.register('ip nat inside', 'Mark interface as NAT inside', () => {
    const ifName = ctx.getSelectedInterface();
    if (!ifName) return '% No interface selected.';
    ctx.r()._getNATEngine().setInsideInterface(ifName);
    return '';
  });

  trie.register('ip nat outside', 'Mark interface as NAT outside', () => {
    const ifName = ctx.getSelectedInterface();
    if (!ifName) return '% No interface selected.';
    ctx.r()._getNATEngine().setOutsideInterface(ifName);
    return '';
  });

  trie.register('no ip nat inside', 'Remove NAT inside designation', () => {
    const ifName = ctx.getSelectedInterface();
    if (!ifName) return '% No interface selected.';
    ctx.r()._getNATEngine().removeInsideInterface(ifName);
    return '';
  });

  trie.register('no ip nat outside', 'Remove NAT outside designation', () => {
    const ifName = ctx.getSelectedInterface();
    if (!ifName) return '% No interface selected.';
    ctx.r()._getNATEngine().removeOutsideInterface(ifName);
    return '';
  });
}

// ─── Privileged Mode ──────────────────────────────────────────────────────────

export function registerNATPrivilegedCommands(trie: CommandTrie, getRouter: () => Router): void {
  trie.register('clear ip nat translation *', 'Clear all dynamic NAT translations', () => {
    getRouter()._getNATEngine().clearTranslations();
    return '';
  });
}

// ─── Show Commands ────────────────────────────────────────────────────────────

export function registerNATShowCommands(trie: CommandTrie, getRouter: () => Router): void {
  trie.register('show ip nat translations', 'Display NAT translation table', () => showNATTranslations(getRouter()));
  trie.register('show ip nat translations verbose', 'Display detailed NAT translations', () => showNATTranslationsVerbose(getRouter()));
  trie.register('show ip nat statistics', 'Display NAT statistics', () => showNATStatistics(getRouter()));
}

export function showNATTranslations(router: Router): string {
  const entries = router._getNATEngine().getTranslations();
  if (entries.length === 0) return 'No NAT translations.';

  const header = 'Pro  Inside global          Inside local           Outside local          Outside global';
  const lines = [header];
  for (const e of entries) {
    const proto = e.proto.padEnd(4);
    const ig = e.insideGlobal.padEnd(23);
    const il = e.insideLocal.padEnd(23);
    const ol = e.outsideLocal.padEnd(23);
    const og = e.outsideGlobal;
    lines.push(`${proto} ${ig}${il}${ol}${og}`);
  }
  return lines.join('\n');
}

export function showNATTranslationsVerbose(router: Router): string {
  const entries = router._getNATEngine().getTranslations();
  if (entries.length === 0) return 'No NAT translations.';

  const lines: string[] = [];
  for (const e of entries) {
    lines.push(`Pro  Inside global          Inside local           Outside local          Outside global`);
    lines.push(`${e.proto.padEnd(4)} ${e.insideGlobal.padEnd(23)}${e.insideLocal.padEnd(23)}${e.outsideLocal.padEnd(23)}${e.outsideGlobal}`);
    lines.push(`    create: 0d:00h:00m:00s, use: 0d:00h:00m:00s, left: --`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

export function showNATStatistics(router: Router): string {
  const engine = router._getNATEngine();
  const statics = engine.getStaticEntries().length;
  const dynamic = engine.getDynamicRules().length;
  const pools = engine.getPools().size;
  const total = engine.getTranslationCount();
  const inside = [...engine.getInsideInterfaces()].join(', ') || 'none';
  const outside = [...engine.getOutsideInterfaces()].join(', ') || 'none';
  const counters = engine.getCounters();
  const timeouts = engine.getTimeouts();

  return [
    `Total active translations: ${total} (${statics} static, ${total - statics} dynamic; 0 extended)`,
    `Outside interfaces:  ${outside}`,
    `Inside interfaces:   ${inside}`,
    `Hits: ${counters.hits}  Misses: ${counters.misses}`,
    `Expired translations: ${counters.expired}`,
    `Session timeouts (seconds): tcp ${timeouts.tcp / 1000}  udp ${timeouts.udp / 1000}  icmp ${timeouts.icmp / 1000}  syn ${timeouts.tcpHalfOpen / 1000}`,
    `Dynamic mappings:`,
    ...(dynamic === 0 ? ['-- No dynamic NAT rules configured --'] :
      engine.getDynamicRules().map(r =>
        ` -- Inside Source [acl ${r.aclId}] ${r.type === 'overload' ? 'overload' : `pool ${r.poolName}`}`
      )),
    ...(pools > 0 ? [`Pools: ${pools} configured`] : []),
  ].join('\n');
}

// ─── Running-Config helpers ───────────────────────────────────────────────────

export function runningConfigNAT(router: Router): string[] {
  const engine = router._getNATEngine();
  const lines: string[] = [];

  // NAT pools
  for (const [, pool] of engine.getPools()) {
    lines.push(`ip nat pool ${pool.name} ${pool.startIP} ${pool.endIP} netmask 255.255.255.0`);
  }

  // Static entries
  for (const e of engine.getStaticEntries()) {
    if (!e.protocol) {
      lines.push(`ip nat inside source static ${e.localIP} ${e.globalIP}`);
    } else {
      lines.push(`ip nat inside source static ${e.protocol} ${e.localIP} ${e.localPort} ${e.globalIP} ${e.globalPort}`);
    }
  }

  // Dynamic rules
  for (const r of engine.getDynamicRules()) {
    if (r.type === 'overload') {
      const iface = r.interfaceName ?? [...engine.getOutsideInterfaces()][0] ?? 'GigabitEthernet0/1';
      lines.push(`ip nat inside source list ${r.aclId} interface ${iface} overload`);
    } else if (r.type === 'pool' && r.poolName) {
      lines.push(`ip nat inside source list ${r.aclId} pool ${r.poolName}`);
    }
  }

  // Non-default timeouts
  const t = engine.getTimeouts();
  if (t.tcp !== 86_400_000)       lines.push(`ip nat translation tcp-timeout ${t.tcp / 1000}`);
  if (t.udp !== 300_000)          lines.push(`ip nat translation udp-timeout ${t.udp / 1000}`);
  if (t.icmp !== 60_000)          lines.push(`ip nat translation icmp-timeout ${t.icmp / 1000}`);
  if (t.tcpHalfOpen !== 30_000)   lines.push(`ip nat translation syn-timeout ${t.tcpHalfOpen / 1000}`);

  return lines;
}

export function runningConfigInterfaceNAT(router: Router, ifName: string): string[] {
  const engine = router._getNATEngine();
  const lines: string[] = [];
  if (engine.isInsideInterface(ifName)) lines.push(' ip nat inside');
  if (engine.isOutsideInterface(ifName)) lines.push(' ip nat outside');
  return lines;
}
