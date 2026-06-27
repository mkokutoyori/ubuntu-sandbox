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

function isValidIPv4(addr: string): boolean {
  const parts = addr.split('.');
  if (parts.length !== 4) return false;
  return parts.every(p => {
    const n = parseInt(p, 10);
    return !isNaN(n) && n >= 0 && n <= 255 && String(n) === p;
  });
}

function isValidIPv4Mask(mask: string): boolean {
  if (!isValidIPv4(mask)) return false;
  const parts = mask.split('.').map(p => parseInt(p, 10));
  let binStr = parts.map(p => p.toString(2).padStart(8, '0')).join('');
  return /^1*0*$/.test(binStr);
}

function isValidCidr(s: string): boolean {
  const m = s.match(/^\/?(\d+)$/);
  if (!m) return false;
  const n = parseInt(m[1], 10);
  return n >= 0 && n <= 32;
}

function parseVrf(args: string[]): string | undefined {
  const i = args.findIndex(a => a.toLowerCase() === 'vrf');
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function cidrToMask(cidr: number): string {
  const mask = cidr === 0 ? 0 : (~0 << (32 - cidr)) >>> 0;
  return [(mask >>> 24) & 0xff, (mask >>> 16) & 0xff, (mask >>> 8) & 0xff, mask & 0xff].join('.');
}

function errorMessageFor(reason: string): string {
  switch (reason) {
    case 'duplicate': return 'duplicate static NAT entry';
    case 'local-already-mapped': return 'inside local IP already mapped';
    case 'global-already-mapped': return 'inside global IP already mapped';
    default: return reason;
  }
}

// ─── Global Config Mode ──────────────────────────────────────────────────────

export function buildNATConfigCommands(trie: CommandTrie, ctx: CiscoShellContext): void {
  trie.registerGreedy('ip nat inside source static', 'Configure static NAT translation', (rawArgs) => {
    const args = rawArgs.map(a => a.replace(/^["']|["']$/g, ''));
    if (args.length < 2) return '% Incomplete command.';
    const engine = ctx.r()._getNATEngine();
    const aliasLookup = (router: ReturnType<typeof ctx.r>, name: string): string => {
      const aliases = (router as unknown as { _ipHostAliases?: Map<string, string> })._ipHostAliases;
      return aliases?.get(name) ?? name;
    };
    args[0] = aliasLookup(ctx.r(), args[0]);
    if (args[1]) args[1] = aliasLookup(ctx.r(), args[1]);

    const first = args[0].toLowerCase();
    if (first === 'network') {
      if (args.length < 3) return '% Incomplete command.';
      const local = args[1];
      const global = args[2];
      const maskTok = args[3];
      if (!isValidIPv4(local)) return `% Invalid IP address ${local}.`;
      if (!isValidIPv4(global)) return `% Invalid IP address ${global}.`;
      let prefixLen = 24;
      if (maskTok) {
        if (maskTok.startsWith('/')) {
          if (!isValidCidr(maskTok)) return `% Invalid prefix-length ${maskTok}.`;
          prefixLen = parseInt(maskTok.slice(1), 10);
        } else if (isValidIPv4Mask(maskTok)) {
          prefixLen = maskTok.split('.').map(p => parseInt(p, 10)).reduce((acc, p) => acc + p.toString(2).replace(/0/g, '').length, 0);
        } else {
          return `% Invalid mask ${maskTok}.`;
        }
      }
      const vrf = parseVrf(args);
      const res = engine.addStaticEntry({ localIP: local, globalIP: global, isNetwork: true, prefixLen, vrf });
      return res.ok ? '' : `% ${errorMessageFor(res.reason)}`;
    }

    if (first === 'tcp' || first === 'udp') {
      if (args.length < 5) return '% Incomplete command.';
      const localIP = args[1];
      const localPort = parseInt(args[2], 10);
      const globalIP = args[3];
      const globalPort = parseInt(args[4], 10);
      if (!isValidIPv4(localIP)) return `% Invalid IP address ${localIP}.`;
      if (!isValidIPv4(globalIP)) return `% Invalid IP address ${globalIP}.`;
      if (isNaN(localPort) || localPort < 1 || localPort > 65535) return '% Invalid port number.';
      if (isNaN(globalPort) || globalPort < 1 || globalPort > 65535) return '% Invalid port number.';
      const vrf = parseVrf(args);
      const res = engine.addStaticEntry({ localIP, globalIP, protocol: first as 'tcp' | 'udp', localPort, globalPort, vrf });
      return res.ok ? '' : `% ${errorMessageFor(res.reason)}`;
    }

    if (/^[a-z_]+$/i.test(first) && first !== 'tcp' && first !== 'udp' && first !== 'network') {
      return `% Invalid protocol ${args[0]}.`;
    }

    const localIP = args[0];
    const globalIP = args[1];
    if (!isValidIPv4(localIP)) return `% Invalid IP address ${localIP}.`;
    if (!isValidIPv4(globalIP)) return `% Invalid IP address ${globalIP}.`;
    const vrf = parseVrf(args);
    const rawLocal = rawArgs[0].replace(/^["']|["']$/g, '');
    const rawGlobal = rawArgs[1].replace(/^["']|["']$/g, '');
    const rawConfig = `ip nat inside source static ${rawLocal} ${rawGlobal}`;
    const res = engine.addStaticEntry({ localIP, globalIP, vrf, rawConfig });
    return res.ok ? '' : `% ${errorMessageFor(res.reason)}`;
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

  trie.registerGreedy('ip nat outside source static', 'Configure outside static NAT', (args) => {
    if (args.length < 2) return '% Incomplete command.';
    const outside = args[0], inside = args[1];
    if (!isValidIPv4(outside)) return `% Invalid IP address ${outside}.`;
    if (!isValidIPv4(inside)) return `% Invalid IP address ${inside}.`;
    ctx.r()._getNATEngine().addOutsideStatic({ outsideGlobal: outside, outsideLocal: inside });
    return '';
  });

  trie.registerGreedy('no ip nat outside source static', 'Remove outside static NAT', (args) => {
    if (args.length < 2) return '% Incomplete command.';
    ctx.r()._getNATEngine().removeOutsideStatic(args[0], args[1]);
    return '';
  });

  trie.registerGreedy('no ip nat inside source static network', 'Remove network static NAT', (args) => {
    if (args.length < 2) return '% Incomplete command.';
    ctx.r()._getNATEngine().removeStaticEntry(args[0], args[1]);
    return '';
  });

  trie.register('no ip nat', 'Wipe NAT configuration', () => {
    const engine = ctx.r()._getNATEngine();
    engine.removeAllStaticEntries();
    engine.clearTranslations();
    return '';
  });

  trie.registerGreedy('ip vrf', 'Define VRF (stub)', () => '');
  trie.registerGreedy('no ip vrf', 'Remove VRF (stub)', () => '');

  trie.registerGreedy('ip host', 'Static hostname → IP alias', (args) => {
    if (args.length < 2) return '% Incomplete command.';
    const name = args[0];
    const ip = args[1];
    if (!isValidIPv4(ip)) return `% Invalid IP address ${ip}.`;
    const r = ctx.r() as unknown as { _ipHostAliases?: Map<string, string> };
    (r._ipHostAliases ??= new Map()).set(name, ip);
    return '';
  });

  trie.registerGreedy('ip nat inside source route-map', 'NAT via route-map', (args, raw) => {
    const r = ctx.r() as any;
    (r._ciscoNatRouteMapRules ??= []).push(raw ?? `ip nat inside source route-map ${args.join(' ')}`);
    return '';
  });

  trie.registerGreedy('ip nat translation timeout', 'Set generic NAT timeout', (args) => {
    const s = parseInt(args[0] ?? '', 10);
    if (!isNaN(s)) ctx.r()._getNATEngine().setTimeouts({ tcp: s * 1000, udp: s * 1000, icmp: s * 1000 });
    return '';
  });

  trie.registerGreedy('ip nat translation max-entries', 'Set NAT translation table cap', (args) => {
    const n = parseInt(args[0] ?? '', 10);
    if (!isNaN(n)) (ctx.r() as any)._ciscoNatMaxEntries = n;
    return '';
  });

  trie.registerGreedy('ip nat log translations', 'Enable NAT translation logging', (args) => {
    (ctx.r() as any)._ciscoNatLogTranslations = args.join(' ') || 'syslog';
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
  trie.registerGreedy('clear ip nat translation inside', 'Clear inside NAT translation entries', (_args) => {
    getRouter()._getNATEngine().clearTranslations();
    return '';
  });
  trie.registerGreedy('clear ip nat translation outside', 'Clear outside NAT translation entries', (_args) => {
    getRouter()._getNATEngine().clearTranslations();
    return '';
  });
}

// ─── Show Commands ────────────────────────────────────────────────────────────

export function registerNATShowCommands(trie: CommandTrie, getRouter: () => Router): void {
  trie.register('show ip nat nvi translations', 'Show NVI NAT translations', () => showNATTranslations(getRouter()));
  trie.register('show ip nat translations', 'Display NAT translation table', () => showNATTranslations(getRouter()));
  trie.register('show ip nat translations verbose', 'Display detailed NAT translations', () => showNATTranslationsVerbose(getRouter()));
  trie.register('show ip nat statistics', 'Display NAT statistics', () => showNATStatistics(getRouter()));
}

export function showNATTranslations(router: Router): string {
  const engine = router._getNATEngine();
  const entries = engine.getTranslations();
  const outsideStatic = engine.getOutsideStaticEntries();
  const networkStatic = engine.getStaticEntries().filter(e => e.isNetwork);

  if (entries.length === 0 && outsideStatic.length === 0 && networkStatic.length === 0) {
    return 'No NAT entries.';
  }

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
  for (const ns of networkStatic) {
    const last = ns.localIP.split('.').slice(-1)[0];
    const prefix = ns.globalIP.split('.').slice(0, 3).join('.');
    const exampleGlobal = `${prefix}.${last}`.padEnd(23);
    const exampleLocal = ns.localIP.padEnd(23);
    const mask = cidrToMask(ns.prefixLen ?? 24);
    lines.push(`---  ${exampleGlobal}${exampleLocal}---                    ---`);
    lines.push(`     ${ns.globalIP}/${ns.prefixLen} mask ${mask}   ${ns.localIP}/${ns.prefixLen} mask ${mask}`);
  }
  for (const o of outsideStatic) {
    lines.push(`---  ---                    ---                    ${o.outsideLocal.padEnd(23)}${o.outsideGlobal}`);
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

  for (const e of engine.getStaticEntries()) {
    if (e.rawConfig) { lines.push(e.rawConfig); continue; }
    if (e.isNetwork) {
      lines.push(`ip nat inside source static network ${e.localIP} ${e.globalIP} /${e.prefixLen}`);
    } else if (!e.protocol) {
      lines.push(`ip nat inside source static ${e.localIP} ${e.globalIP}`);
    } else {
      lines.push(`ip nat inside source static ${e.protocol} ${e.localIP} ${e.localPort} ${e.globalIP} ${e.globalPort}`);
    }
  }
  for (const o of engine.getOutsideStaticEntries()) {
    lines.push(`ip nat outside source static ${o.outsideGlobal} ${o.outsideLocal}`);
  }
  const aliases = (router as unknown as { _ipHostAliases?: Map<string, string> })._ipHostAliases;
  if (aliases) {
    for (const [name, ip] of aliases) lines.unshift(`ip host ${name} ${ip}`);
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
