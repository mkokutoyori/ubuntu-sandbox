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
import { isValidIPv4, isValidSubnetMask, prefixLengthToMaskUint32, uint32ToIp } from '../../../core/ip';

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
  return uint32ToIp(prefixLengthToMaskUint32(cidr));
}

function hasUnmatchedQuote(tokens: string[]): boolean {
  const joined = tokens.join(' ');
  const dq = (joined.match(/"/g) ?? []).length;
  const sq = (joined.match(/'/g) ?? []).length;
  return (dq % 2 !== 0) || (sq % 2 !== 0);
}

function errorMessageFor(reason: string): string {
  switch (reason) {
    case 'duplicate': return 'duplicate static NAT entry';
    case 'local-already-mapped': return 'inside local IP already mapped';
    case 'global-already-mapped': return 'inside global IP already mapped';
    case 'global-port-already-mapped': return 'global IP:port already mapped to another inside target';
    default: return reason;
  }
}

// ─── Global Config Mode ──────────────────────────────────────────────────────

export function buildNATConfigCommands(trie: CommandTrie, ctx: CiscoShellContext): void {
  trie.registerGreedy('ip nat inside source static', 'Configure static NAT translation', (rawArgs) => {
    if (hasUnmatchedQuote(rawArgs)) return '% Unmatched quote in input.';
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
        } else if (isValidSubnetMask(maskTok)) {
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
    if (vrf) {
      const vrfs = (ctx.r() as any)._vrfs as Map<string, unknown> | undefined;
      if (!vrfs?.has?.(vrf)) return `% VRF ${vrf} does not exist.`;
    }
    const rawLocal = rawArgs[0].replace(/^["']|["']$/g, '');
    const rawGlobal = rawArgs[1].replace(/^["']|["']$/g, '');
    const rawConfig = vrf ? `ip nat inside source static ${rawLocal} ${rawGlobal} vrf ${vrf}` : `ip nat inside source static ${rawLocal} ${rawGlobal}`;
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
  trie.registerGreedy('ip nat inside source list', 'Configure dynamic NAT/PAT', (rawArgs) => {
    if (hasUnmatchedQuote(rawArgs)) return '% Unmatched quote in input.';
    const args = rawArgs.map(a => a.replace(/^["']|["']$/g, ''));
    if (args.length < 3) return '% Incomplete command.';
    const engine = ctx.r()._getNATEngine();
    const aclId = args[0];
    const router = ctx.r() as any;
    const aclEngine = router._getACLEngine?.() ?? router._acl;
    const aclExists = aclEngine?.hasAcl?.(aclId) ?? (router._aclList?.has?.(String(aclId)) ?? false);
    if (aclEngine && !aclExists) return `% access-list ${aclId} not defined.`;
    const aclType: string | undefined = aclEngine?.getAclType?.(aclId);
    if (aclType && aclType.toLowerCase().includes('mac')) return '% MAC ACLs cannot be used for NAT.';
    const vrf = parseVrf(args);
    if (vrf) {
      const vrfs = router._vrfs as Map<string, unknown> | undefined;
      if (!vrfs?.has?.(vrf)) return `% VRF ${vrf} does not exist.`;
    }
    const keyword = args[1]?.toLowerCase();

    if (keyword === 'interface') {
      const ifName = ctx.resolveInterfaceName(args[2]) ?? args[2];
      const ifaces = (ctx.r() as any).getInterfaces?.() ?? new Map();
      if (!ifaces.has?.(ifName) && !/^GigabitEthernet|^FastEthernet|^Serial|^Loopback|^Vlan/.test(ifName)) {
        return `% Invalid interface ${args[2]}.`;
      }
      const isOverload = args.some((a, i) => i >= 3 && a.toLowerCase() === 'overload');
      if (!isOverload) return '% Missing "overload" keyword.';
      const after = args.slice(3).filter(a => !['overload', 'vrf', vrf ?? ''].includes(a.toLowerCase()));
      if (after.length > 0) return `% Invalid extra argument(s): ${after.join(' ')}`;
      engine.addDynamicRule({ aclId, type: 'overload', interfaceName: ifName, ...(vrf ? { vrf } : {}) } as any);
    } else if (keyword === 'pool') {
      const poolName = args[2];
      if (!engine.getPool(poolName)) return `% Pool ${poolName} not defined.`;
      const after = args.slice(3).filter(a => !['vrf', vrf ?? '', 'overload'].includes(a.toLowerCase()));
      if (after.length > 0) return `% Invalid extra argument(s): ${after.join(' ')}`;
      engine.addDynamicRule({ aclId, type: 'pool', poolName, ...(vrf ? { vrf } : {}) } as any);
    } else {
      return '% Invalid command syntax.';
    }
    return '';
  });

  // no ip nat inside source list <acl>
  trie.registerGreedy('no ip nat inside source list', 'Remove dynamic NAT rule', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    const engine = ctx.r()._getNATEngine();
    engine.removeDynamicRule(args[0]);
    engine.clearDynamicTranslations();
    return '';
  });

  // ip nat pool NAME startIP endIP netmask MASK | prefix-length N
  trie.registerGreedy('ip nat pool', 'Define NAT address pool', (rawArgs) => {
    const args = rawArgs.map(a => a.replace(/^["']|["']$/g, ''));
    if (args.length < 3) return '% Incomplete command.';
    const name = args[0];
    if (name.length > 31) return '% Pool name exceeds 31 characters.';
    if (!/^[A-Za-z0-9_-]+$/.test(name)) return '% Invalid pool name (special characters not allowed).';
    const startIP = args[1];
    const endIP = args[2];
    if (!isValidIPv4(startIP)) return `% Invalid IP address ${startIP}.`;
    if (!isValidIPv4(endIP)) return `% Invalid IP address ${endIP}.`;
    const startN = startIP.split('.').reduce((a, p) => (a << 8) + parseInt(p, 10), 0) >>> 0;
    const endN = endIP.split('.').reduce((a, p) => (a << 8) + parseInt(p, 10), 0) >>> 0;
    if (startN > endN) return '% Start IP greater than end IP.';

    const kw = args[3]?.toLowerCase();
    let mask: string | null = null;
    let prefixLen: number | null = null;
    if (kw === 'netmask') {
      if (!args[4]) return '% Missing netmask value.';
      if (!isValidSubnetMask(args[4])) return `% Invalid netmask ${args[4]}.`;
      mask = args[4];
    } else if (kw === 'prefix-length') {
      const n = parseInt(args[4] ?? '', 10);
      if (isNaN(n) || n < 0 || n > 32) return '% Invalid prefix-length.';
      prefixLen = n;
    } else {
      return '% Expected "netmask" or "prefix-length" keyword.';
    }
    if (args.length > 5) return `% Invalid extra argument(s): ${args.slice(5).join(' ')}`;
    const effPrefix = prefixLen ?? (mask ? mask.split('.').reduce((a, p) => a + parseInt(p, 10).toString(2).replace(/0/g, '').length, 0) : 24);
    const netMaskN = prefixLengthToMaskUint32(effPrefix);
    if ((startN & netMaskN) !== (endN & netMaskN)) return '% IP range does not align with netmask.';

    const engine = ctx.r()._getNATEngine();
    for (const [, p] of engine.getPools()) {
      const pS = p.startIP.split('.').reduce((a, x) => (a << 8) + parseInt(x, 10), 0) >>> 0;
      const pE = p.endIP.split('.').reduce((a, x) => (a << 8) + parseInt(x, 10), 0) >>> 0;
      if (!(endN < pS || startN > pE)) return `% Pool range overlaps existing pool ${p.name}.`;
    }
    engine.addPool({ name, startIP, endIP });
    (engine.getPool(name) as any).prefixLen = effPrefix;
    return '';
  });

  // no ip nat pool <name>
  trie.registerGreedy('no ip nat pool', 'Remove NAT address pool', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    ctx.r()._getNATEngine().removePool(args[0]);
    return '';
  });

  const validateTimeout = (s: number): string | null => {
    if (isNaN(s)) return '% Invalid timeout value.';
    if (s === 0) return '% Timeout value cannot be zero.';
    if (s < 0) return '% Timeout value must be positive.';
    if (s > 4_294_967) return '% Timeout value out of range.';
    return null;
  };

  trie.registerGreedy('ip nat translation tcp-timeout', 'Set TCP NAT session timeout', (args) => {
    const s = parseInt(args[0], 10);
    const err = validateTimeout(s);
    if (err) return err;
    ctx.r()._getNATEngine().setTimeouts({ tcp: s * 1000 });
    return '';
  });

  trie.registerGreedy('ip nat translation udp-timeout', 'Set UDP NAT session timeout', (args) => {
    const s = parseInt(args[0], 10);
    const err = validateTimeout(s);
    if (err) return err;
    ctx.r()._getNATEngine().setTimeouts({ udp: s * 1000 });
    return '';
  });

  trie.registerGreedy('ip nat translation icmp-timeout', 'Set ICMP NAT session timeout', (args) => {
    const s = parseInt(args[0], 10);
    const err = validateTimeout(s);
    if (err) return err;
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
    const engine = ctx.r()._getNATEngine();
    for (const e of engine.getStaticEntries()) {
      if (!e.protocol && (e.localIP === outside || e.globalIP === outside || e.localIP === inside || e.globalIP === inside)) {
        return `% Outside static mapping overlaps inside static entry ${e.localIP}/${e.globalIP}.`;
      }
    }
    engine.addOutsideStatic({ outsideGlobal: outside, outsideLocal: inside });
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

  trie.registerGreedy('ip vrf', 'Define a VRF instance', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    const name = args[0];
    const router = ctx.r() as any;
    const vrfs: Map<string, { name: string; rd?: string; rts: { import: string[]; export: string[] }; interfaces: Set<string> }> =
      router._vrfs ??= new Map();
    if (!vrfs.has(name)) vrfs.set(name, { name, rts: { import: [], export: [] }, interfaces: new Set() });
    return '';
  });
  trie.registerGreedy('no ip vrf', 'Remove a VRF instance', (args) => {
    const name = args[0];
    if (!name) return '% Incomplete command.';
    const router = ctx.r() as any;
    router._vrfs?.delete?.(name);
    const engine = ctx.r()._getNATEngine();
    for (const e of engine.getStaticEntries()) {
      if (e.vrf === name) engine.removeStaticEntry(e.localIP, e.globalIP);
    }
    return '';
  });

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
  trie.registerGreedy('no ip nat inside source route-map', 'Remove route-map NAT', (args) => {
    const r = ctx.r() as any;
    const name = args[0];
    if (!r._ciscoNatRouteMapRules) return '';
    r._ciscoNatRouteMapRules = (r._ciscoNatRouteMapRules as string[]).filter((s: string) => !s.includes(`route-map ${name}`));
    return '';
  });

  trie.registerGreedy('ip nat translation timeout', 'Set generic NAT timeout', (args) => {
    const s = parseInt(args[0] ?? '', 10);
    const err = validateTimeout(s);
    if (err) return err;
    ctx.r()._getNATEngine().setTimeouts({ tcp: s * 1000, udp: s * 1000, icmp: s * 1000 });
    return '';
  });

  trie.registerGreedy('ip nat translation max-entries', 'Set NAT translation table cap', (args) => {
    const n = parseInt(args[0] ?? '', 10);
    if (isNaN(n)) return '% Invalid max-entries value.';
    if (n < 1 || n > 2_147_483) return '% max-entries value exceeds platform limits.';
    (ctx.r() as any)._ciscoNatMaxEntries = n;
    ctx.r()._getNATEngine().setMaxEntries?.(n);
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
    const port = ctx.r().getPort?.(ifName);
    if (port && !port.getIsUp() && /^Loopback/i.test(ifName)) {
      return `% Cannot enable ip nat inside: ${ifName} is administratively down.`;
    }
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
  trie.registerGreedy('clear ip nat translation tcp', 'Clear TCP NAT translation entries', (args) => {
    if (args.length < 4) return '% Incomplete command: tcp LOCAL LPORT GLOBAL GPORT.';
    if (args.some(a => a === '*' || a === '?')) return '% Invalid wildcard syntax for clear ip nat translation tcp.';
    for (let i = 0; i < args.length; i++) {
      if (i % 2 === 0 && !isValidIPv4(args[i])) return `% Invalid IP address ${args[i]}.`;
      if (i % 2 === 1) {
        const p = parseInt(args[i], 10);
        if (isNaN(p) || p < 1 || p > 65535) return `% Invalid port number ${args[i]}.`;
      }
    }
    getRouter()._getNATEngine().clearTranslations();
    return '';
  });
  trie.registerGreedy('clear ip nat translation udp', 'Clear UDP NAT translation entries', (args) => {
    if (args.length < 4) return '% Incomplete command: udp LOCAL LPORT GLOBAL GPORT.';
    for (let i = 0; i < args.length; i++) {
      if (i % 2 === 0 && !isValidIPv4(args[i])) return `% Invalid IP address ${args[i]}.`;
      if (i % 2 === 1) {
        const p = parseInt(args[i], 10);
        if (isNaN(p) || p < 1 || p > 65535) return `% Invalid port number ${args[i]}.`;
      }
    }
    getRouter()._getNATEngine().clearTranslations();
    return '';
  });
  trie.registerGreedy('clear ip nat translation vrf', 'Clear NAT translations in VRF', (args) => {
    const vrf = args[0];
    if (!vrf) return '% Incomplete command.';
    const router = getRouter() as any;
    const vrfs = router._vrfs as Map<string, unknown> | undefined;
    if (!vrfs?.has?.(vrf)) return `% VRF ${vrf} does not exist.`;
    getRouter()._getNATEngine().clearTranslations();
    return '';
  });
  trie.registerGreedy('clear ip nat translation pool', 'Clear NAT translations for pool', (args) => {
    const name = args[0];
    if (!name) return '% Incomplete command.';
    if (!getRouter()._getNATEngine().getPool(name)) return `% Pool ${name} does not exist.`;
    getRouter()._getNATEngine().clearTranslations();
    return '';
  });
  trie.register('clear ip nat statistics', 'Clear NAT statistics counters', () => {
    getRouter()._getNATEngine().resetCounters();
    return '';
  });
}

// ─── Show Commands ────────────────────────────────────────────────────────────

export function registerNATShowCommands(trie: CommandTrie, getRouter: () => Router): void {
  trie.register('show ip nat nvi translations', 'Show NVI NAT translations', () => showNATTranslations(getRouter()));
  trie.register('show ip nat translations', 'Display NAT translation table', () => showNATTranslations(getRouter()));
  trie.registerGreedy('show ip nat translations vrf', 'Display NAT translations in VRF', (args) => {
    const vrfName = args[0];
    if (!vrfName) return '% Incomplete command.';
    const router = getRouter() as any;
    const vrfs: Map<string, unknown> | undefined = router._vrfs;
    if (!vrfs?.has?.(vrfName)) return `% VRF ${vrfName} does not exist.`;
    const engine = getRouter()._getNATEngine();
    const entries = engine.getStaticEntries().filter(e => e.vrf === vrfName);
    if (entries.length === 0) return 'No NAT entries.';
    const lines = ['Pro  Inside global          Inside local           Outside local          Outside global'];
    for (const e of entries) {
      lines.push(`---  ${e.globalIP.padEnd(23)}${e.localIP.padEnd(23)}---                    ---`);
    }
    return lines.join('\n');
  });
  trie.registerGreedy('show ip nat translations verbose', 'Display detailed NAT translations', (args) => {
    if (args[0]?.toLowerCase() === 'vrf') {
      const vrfName = args[1];
      const router = getRouter() as any;
      const vrfs: Map<string, unknown> | undefined = router._vrfs;
      if (!vrfs?.has?.(vrfName)) return `% VRF ${vrfName} does not exist.`;
      return showNATTranslationsVerbose(getRouter());
    }
    return showNATTranslationsVerbose(getRouter(), args);
  });
  trie.register('show ip nat statistics', 'Display NAT statistics', () => showNATStatistics(getRouter()));
  trie.registerGreedy('show ip nat statistics vrf', 'Display NAT statistics in VRF', (args) => {
    const vrfName = args[0];
    const router = getRouter() as any;
    const vrfs: Map<string, unknown> | undefined = router._vrfs;
    if (!vrfs?.has?.(vrfName)) return `% VRF ${vrfName} does not exist.`;
    return showNATStatistics(getRouter());
  });
}

export function showNATTranslations(router: Router): string {
  const engine = router._getNATEngine();
  const entries = engine.getTranslations();
  const outsideStatic = engine.getOutsideStaticEntries();
  const networkStatic = engine.getStaticEntries().filter(e => e.isNetwork);

  const header = 'Pro  Inside global          Inside local           Outside local          Outside global';
  if (entries.length === 0 && outsideStatic.length === 0 && networkStatic.length === 0) {
    return `${header}\nNo NAT entries.`;
  }
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

export function showNATTranslationsVerbose(router: Router, filterArgs: string[] = []): string {
  const cleaned = filterArgs.map(a => a.replace(/^["']|["']$/g, ''));
  let filterIP: string | null = null;
  for (let i = 0; i < cleaned.length; i++) {
    const t = cleaned[i].toLowerCase();
    if ((t === 'local' || t === 'global') && cleaned[i + 1]) {
      filterIP = cleaned[i + 1];
      if (!isValidIPv4(filterIP)) return `% Invalid filter IP ${filterIP}.`;
    }
  }
  let entries = router._getNATEngine().getTranslations();
  if (filterIP) entries = entries.filter(e => e.insideLocal.includes(filterIP!) || e.insideGlobal.includes(filterIP!));
  if (entries.length === 0) return 'No NAT entries.';

  const lines: string[] = [];
  lines.push(`Pro  Inside global          Inside local           Outside local          Outside global`);
  for (const e of entries) {
    lines.push(`${e.proto.padEnd(4)} ${e.insideGlobal.padEnd(23)}${e.insideLocal.padEnd(23)}${e.outsideLocal.padEnd(23)}${e.outsideGlobal}`);
    lines.push(`    create: 0d:00h:00m:00s, use: 0d:00h:00m:00s, left: --`);
    lines.push(`    flags: ${e.proto === '---' ? 'static' : 'extended'}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

export function showNATStatistics(router: Router): string {
  const engine = router._getNATEngine();
  const statics = engine.getStaticEntries().length;
  const dynamicSessions = engine.getSessions().length;
  const dynamic = engine.getDynamicRules().length;
  const pools = engine.getPools().size;
  const total = engine.getTranslationCount();
  const inside = [...engine.getInsideInterfaces()].join(', ') || 'none';
  const outside = [...engine.getOutsideInterfaces()].join(', ') || 'none';
  const counters = engine.getCounters();
  const timeouts = engine.getTimeouts();
  const maxEntries = engine.getMaxEntries?.();
  const hasOverload = engine.getDynamicRules().some(r => r.type === 'overload');

  return [
    `Total active translations: ${total} (${statics} static, ${dynamicSessions} dynamic; 0 extended)`,
    `Static translations: ${statics}`,
    `Dynamic translations: ${dynamicSessions}`,
    `Translation errors: 0`,
    `Outside interfaces:  ${outside}`,
    `Inside interfaces:   ${inside}`,
    `Hits: ${counters.hits}  Misses: ${counters.misses}`,
    `Expired translations: ${counters.expired}`,
    `Session timeouts (seconds): tcp ${timeouts.tcp / 1000}  udp ${timeouts.udp / 1000}  icmp ${timeouts.icmp / 1000}  syn ${timeouts.tcpHalfOpen / 1000}`,
    ...(hasOverload ? ['Overload: enabled'] : []),
    ...(maxEntries != null ? [`max-entries ${maxEntries}`, ...(dynamicSessions >= maxEntries ? ['Limit reached: new translations blocked'] : [])] : []),
    `Dynamic mappings:`,
    ...(dynamic === 0 ? ['-- No dynamic NAT rules configured --'] :
      engine.getDynamicRules().map(r =>
        ` -- Inside Source [acl ${r.aclId}] ${r.type === 'overload' ? 'overload' : `pool ${r.poolName}`}`
      )),
    ...(pools > 0 ? [
      `Pools:`,
      ...[...engine.getPools().values()].map(p => ` ${p.name}: ${p.startIP} - ${p.endIP}${(p as any).prefixLen != null ? ` /${(p as any).prefixLen}` : ''}`),
    ] : []),
    `Application Layer Gateways: none (FTP/SIP ALG and NAT64 not supported in this simulator)`,
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

  for (const r of engine.getDynamicRules()) {
    const vrfTail = (r as any).vrf ? ` vrf ${(r as any).vrf}` : '';
    if (r.type === 'overload') {
      const iface = r.interfaceName ?? [...engine.getOutsideInterfaces()][0] ?? 'GigabitEthernet0/1';
      lines.push(`ip nat inside source list ${r.aclId} interface ${iface} overload${vrfTail}`);
    } else if (r.type === 'pool' && r.poolName) {
      lines.push(`ip nat inside source list ${r.aclId} pool ${r.poolName}${vrfTail}`);
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
