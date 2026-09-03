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
import { IP_PROTO_TCP, IP_PROTO_UDP } from '../../../core/types';
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

/**
 * Les places de NAT global.
 *
 * Ces gestionnaires VALIDENT ET EXPLIQUENT ce que l'analyse ne peut pas
 * trancher — nom de reserve trop long, plage mal alignee sur le masque,
 * debut superieur a la fin, mot-cle `netmask` ou `prefix-length`
 * attendu. Les places NOMMENT donc leur forme sans la restreindre : les
 * devancer remplacerait « % IP range does not align with netmask. » par
 * un caret nu, c'est-a-dire une information par une absence.
 *
 * Les delais de traduction, eux, ne portent aucune borne dans ce code
 * et n'en recoivent pas ici : un lot de migration ne change pas ce
 * qu'une commande accepte.
 */
const NAT_GLOBAL_ARGUMENTS:
Readonly<Record<string, ArgumentSpec | readonly ArgumentSpec[] | null>> = {
  /*
   * `ip vrf` vit dans ce constructeur : sa place etait declaree dans
   * `ciscoArgumentHelp`, ou elle est morte avec l'elagage, si bien que
   * `ip vrf ?` s'est mis a annoncer `<cr>` pour une commande qui exige
   * un nom.
   */
  'ip vrf': { name: 'nom', type: 'WORD', description: 'VRF name' },
  'ip nat pool': {
    name: 'reserve', type: 'REST',
    description: 'Name, first and last address, then `netmask` or `prefix-length`',
  },
  'ip nat inside source static': {
    name: 'traduction', type: 'REST',
    description: 'Local then global address, or `tcp`/`udp` with their ports',
    alternatives: [
      { keyword: 'A.B.C.D', description: 'Inside local address' },
      { keyword: 'tcp', description: 'Translate a TCP port' },
      { keyword: 'udp', description: 'Translate a UDP port' },
    ],
  },
  'ip nat inside source list': {
    name: 'regle', type: 'REST',
    description: 'Access list, then `pool <nom>` or `interface <nom>`, then `overload`',
  },
  'ip nat inside source route-map': {
    name: 'regle', type: 'REST', description: 'Route-map, then `pool <nom>`',
  },
  'ip nat outside source static': {
    name: 'traduction', type: 'REST',
    description: 'Outside global then outside local address',
  },
  'ip nat log translations': {
    name: 'ou', type: 'REST', description: 'Where the translations are logged',
    alternatives: [{ keyword: 'syslog', description: 'Log the translations to syslog' }],
  },
  'ip nat service': {
    name: 'service', type: 'REST', description: 'NAT service to enable or disable',
  },
};

export function natConfigSpecs(ctx: CiscoShellContext): CommandSpec[] {
  return specsFromTrieRegistrations(
    (collector) => buildNATConfigCommands(collector as unknown as CommandTrie, ctx),
    {
      modes: ['config'], minPrivilege: 15,
      undoFromNegatedPaths: true,
      argumentFor: (path) => NAT_GLOBAL_ARGUMENTS[path],
    },
  );
}

export function buildNATConfigCommands(trie: CommandTrie, ctx: CiscoShellContext): void {
  trie.registerGreedy('ip nat inside source static', 'Configure static NAT translation', (rawArgs) => {
    if (hasUnmatchedQuote(rawArgs)) return '% Unmatched quote in input.';
    const args = rawArgs.map(a => a.replace(/^["']|["']$/g, ''));
    if (args.length < 2) return '% Incomplete command.';
    const engine = ctx.r()._getNATEngine();
    const aliasLookup = (router: ReturnType<typeof ctx.r>, name: string): string => {
      const hosts = (router as unknown as { _getHostsTable?: () => { resolve: (n: string) => string | null } })._getHostsTable?.();
      return hosts?.resolve(name) ?? name;
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
      return res.ok === false ? `% ${errorMessageFor(res.reason)}` : '';
    }

    if (first === 'tcp' || first === 'udp') {
      if (args.length < 5) return '% Incomplete command.';
      const localIP = args[1];
      const localPort = parseInt(args[2], 10);
      if (!isValidIPv4(localIP)) return `% Invalid IP address ${localIP}.`;
      if (isNaN(localPort) || localPort < 1 || localPort > 65535) return '% Invalid port number.';
      let globalIP: string;
      let globalPort: number;
      let ifaceTarget: string | undefined;
      if (args[3]?.toLowerCase() === 'interface') {
        const ifName = ctx.resolveInterfaceName?.(args[4]) ?? args[4];
        const exactPrefix = /^(GigabitEthernet|FastEthernet|Serial|Loopback|Vlan|Tunnel)\d/i.test(ifName);
        if (!exactPrefix) return `% Invalid interface ${args[4]}.`;
        const port = ctx.r().getPort?.(ifName);
        const isSubInterface = /\.\d+$/.test(ifName);
        if (!port && !/^Loopback\d/i.test(ifName) && !isSubInterface) {
          return `% Interface ${ifName} does not exist.`;
        }
        const ip = port?.getIPAddress?.();
        globalIP = ip ? ip.toString() : '0.0.0.0';
        ifaceTarget = ifName;
        globalPort = parseInt(args[5] ?? args[2], 10);
        if (isNaN(globalPort) || globalPort < 1 || globalPort > 65535) return '% Invalid port number.';
      } else {
        globalIP = args[3];
        globalPort = parseInt(args[4], 10);
        if (!isValidIPv4(globalIP)) return `% Invalid IP address ${globalIP}.`;
        if (isNaN(globalPort) || globalPort < 1 || globalPort > 65535) return '% Invalid port number.';
      }
      const vrf = parseVrf(args);
      const res = engine.addStaticEntry({ localIP, globalIP, protocol: first as 'tcp' | 'udp', localPort, globalPort, vrf, ...(ifaceTarget ? { rawConfig: `ip nat inside source static ${first} ${localIP} ${localPort} interface ${ifaceTarget} ${globalPort}` } : {}) });
      return res.ok === false ? `% ${errorMessageFor(res.reason)}` : '';
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
    return res.ok === false ? `% ${errorMessageFor(res.reason)}` : '';
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
    const vrf = parseVrf(args);
    if (vrf) {
      const vrfs = router._vrfs as Map<string, unknown> | undefined;
      if (!vrfs?.has?.(vrf)) return `% VRF ${vrf} does not exist.`;
    }
    const keyword = args[1]?.toLowerCase();

    if (keyword === 'interface') {
      const ifName = ctx.resolveInterfaceName(args[2]) ?? args[2];
      const port = ctx.r().getPort?.(ifName);
      if (!port && !/^Loopback/i.test(ifName) && !/\.\d+$/.test(ifName)) {
        return `% Invalid interface ${args[2]}.`;
      }
      const isOverload = args.some((a, i) => i >= 3 && a.toLowerCase() === 'overload');
      if (!isOverload) return '% Missing "overload" keyword.';
      const allowed = new Set(['overload', 'vrf', (vrf ?? '').toLowerCase()]);
      const after = args.slice(3).filter(a => !allowed.has(a.toLowerCase()));
      if (after.length > 0) return `% Invalid extra argument(s): ${after.join(' ')}`;
      engine.addDynamicRule({ aclId, type: 'overload', interfaceName: ifName, ...(vrf ? { vrf } : {}) } as any);
    } else if (keyword === 'pool') {
      const poolName = args[2];
      if (!engine.getPool(poolName)) return `% Pool ${poolName} not defined.`;
      const allowed = new Set(['vrf', (vrf ?? '').toLowerCase(), 'overload']);
      const after = args.slice(3).filter(a => !allowed.has(a.toLowerCase()));
      if (after.length > 0) return `% Invalid extra argument(s): ${after.join(' ')}`;
      const overload = args.some((a, i) => i >= 3 && a.toLowerCase() === 'overload');
      engine.addDynamicRule({
        aclId, type: 'pool', poolName,
        ...(overload ? { overload: true } : {}),
        ...(vrf ? { vrf } : {}),
      } as any);
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
    const router = ctx.r();
    for (const ifName of engine.getOutsideInterfaces()) {
      const port = router.getPort?.(ifName);
      const ipRaw = port?.getIPAddress?.();
      const ip = ipRaw != null ? String(ipRaw) : '';
      if (!ip || !/^\d+\.\d+\.\d+\.\d+$/.test(ip)) continue;
      const n = ip.split('.').reduce((a: number, x: string) => (a << 8) + parseInt(x, 10), 0) >>> 0;
      if (n >= startN && n <= endN) {
        return `% Pool overlaps WAN gateway ${ifName} (${ip}).`;
      }
    }
    engine.addPool({
      name, startIP, endIP,
      ...(mask !== null ? { netmask: mask } : {}),
      ...(prefixLen !== null ? { prefixLength: prefixLen } : {}),
    });
    (engine.getPool(name) as any).prefixLen = effPrefix;
    return '';
  });

  trie.registerGreedy('no ip nat pool', 'Remove NAT address pool', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    const name = args[0];
    const engine = ctx.r()._getNATEngine();
    if (engine.getDynamicRules().some(r => r.type === 'pool' && r.poolName === name)) {
      return `% Pool is in use by an active list translation.`;
    }
    engine.removePool(name);
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

  trie.registerGreedy('ip nat translation dns-timeout', 'Set DNS NAT session timeout', (args) => {
    const s = parseInt(args[0], 10);
    const err = validateTimeout(s);
    if (err) return err;
    ctx.r()._getNATEngine().setTimeouts({ dns: s * 1000 });
    return '';
  });

  trie.registerGreedy('ip nat translation finrst-timeout', 'Set TCP FIN/RST NAT session timeout', (args) => {
    const s = parseInt(args[0], 10);
    const err = validateTimeout(s);
    if (err) return err;
    ctx.r()._getNATEngine().setTimeouts({ finrst: s * 1000 });
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
    if (!isVrfName(name)) return "% Invalid input detected at '^' marker.";
    ensureVrf(vrfStoreOf(ctx.r() as unknown as VrfHost), name, 'legacy');
    (ctx as unknown as { setSelectedVRF?: (n: string) => void }).setSelectedVRF?.(name);
    ctx.setMode('config-vrf');
    return '';
  });
  trie.registerGreedy('no ip vrf', 'Remove a VRF instance', (args) => {
    const name = args[0];
    if (!name) return '% Incomplete command.';
    vrfStoreOf(ctx.r() as unknown as VrfHost).delete(name);
    const engine = ctx.r()._getNATEngine();
    for (const e of engine.getStaticEntries()) {
      if (e.vrf === name) engine.removeStaticEntry(e.localIP, e.globalIP);
    }
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

  trie.registerGreedy('ip nat service', 'Enable an ALG for a protocol', (args) => {
    const proto = (args[0] ?? '').toLowerCase();
    if (!['dns', 'ftp', 'tftp', 'h323', 'sip', 'rtsp', 'pptp'].includes(proto)) {
      return `% Unknown ALG protocol "${args[0] ?? ''}".`;
    }
    ctx.r()._getNATEngine().setAlgEnabled(proto, true);
    return '';
  });

  trie.registerGreedy('no ip nat service', 'Disable an ALG for a protocol', (args) => {
    const proto = (args[0] ?? '').toLowerCase();
    ctx.r()._getNATEngine().setAlgEnabled(proto, false);
    return '';
  });
}

// ─── Interface Config Mode ────────────────────────────────────────────────────

interface VrfTable {
  _vrfs?: Map<string, { name: string; interfaces: Set<string> }>;
  _ifaceVrf?: Map<string, string>;
}

export function interfaceVrfName(router: Router, iface: string): string | undefined {
  return (router as unknown as VrfTable)._ifaceVrf?.get(iface);
}

function vrfInterfaceSpecs(ctx: CiscoShellContext): CommandSpec[] {
  const nom: ArgumentSpec = {
    name: 'vrf', type: 'WORD',
    description: 'VPN Routing/Forwarding instance name',
  };
  const table = (): VrfTable => ctx.r() as unknown as VrfTable;
  const detacher = (iface: string): void => {
    const t = table();
    const lie = t._ifaceVrf?.get(iface);
    if (lie === undefined) return;
    t._vrfs?.get(lie)?.interfaces.delete(iface);
    t._ifaceVrf?.delete(iface);
  };
  return [
    {
      id: 'config-if-ip-vrf-forwarding',
      path: ['ip', 'vrf', 'forwarding', nom],
      description: 'Configure forwarding table',
      undoDescription: 'Remove the interface from its forwarding table',
      modes: MODES_INTERFACE, minPrivilege: 15,
      run: (_session, args) => {
        const iface = ctx.getSelectedInterface();
        if (!iface) return '% No interface selected.';
        const cible = args.vrf ?? '';
        const t = table();
        if (!t._vrfs?.has(cible)) return `% VRF ${cible} not configured`;
        detacher(iface);
        t._vrfs.get(cible)!.interfaces.add(iface);
        (t._ifaceVrf ??= new Map()).set(iface, cible);
        const port = ctx.r().getPort?.(iface);
        const adresse = port?.getIPAddress?.();
        if (!adresse) return '';
        ctx.r().unconfigureInterface(iface);
        return `% Interface ${iface} IP address ${adresse.toString()} `
          + `removed due to enabling VRF ${cible}`;
      },
      undo: (_session) => {
        const iface = ctx.getSelectedInterface();
        if (!iface) return '% No interface selected.';
        detacher(iface);
        return '';
      },
    },
    {
      id: 'config-if-ip-vrf-forwarding-nu',
      path: ['ip', 'vrf', 'forwarding'],
      description: 'Configure forwarding table',
      undoDescription: 'Remove the interface from its forwarding table',
      existsOnlyNegated: true,
      modes: MODES_INTERFACE, minPrivilege: 15,
      run: () => '% Incomplete command.',
      undo: () => {
        const iface = ctx.getSelectedInterface();
        if (!iface) return '% No interface selected.';
        detacher(iface);
        return '';
      },
    },
  ];
}

export function natInterfaceSpecs(ctx: CiscoShellContext): CommandSpec[] {
  return [
    ...specsFromTrieRegistrations(
      (collector) => buildNATInterfaceCommands(collector as unknown as CommandTrie, ctx),
      {
        modes: MODES_INTERFACE, minPrivilege: 15,
        undoFromNegatedPaths: true,
        argumentFor: () => null,
      },
    ),
    ...vrfInterfaceSpecs(ctx),
  ];
}

export function buildNATInterfaceCommands(trie: CommandTrie, ctx: CiscoShellContext): void {
  const requireIp = (ifName: string): string | null => {
    const port = ctx.r().getPort?.(ifName);
    if (!port) return null;
    const ip = port.getIPAddress?.();
    if (!ip && !/^Loopback/i.test(ifName) && !/\.\d+$/.test(ifName)) {
      return `% Interface ${ifName} has no IP address configured.`;
    }
    return null;
  };

  trie.register('ip nat inside', 'Mark interface as NAT inside', () => {
    const ifName = ctx.getSelectedInterface();
    if (!ifName) return '% No interface selected.';
    const port = ctx.r().getPort?.(ifName);
    if (port && !port.getIsUp() && /^Loopback/i.test(ifName)) {
      return `% Cannot enable ip nat inside: ${ifName} is administratively down.`;
    }
    const err = requireIp(ifName);
    if (err) return err;
    ctx.r()._getNATEngine().setInsideInterface(ifName);
    return '';
  });

  trie.register('ip nat outside', 'Mark interface as NAT outside', () => {
    const ifName = ctx.getSelectedInterface();
    if (!ifName) return '% No interface selected.';
    const err = requireIp(ifName);
    if (err) return err;
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

import type { CommandSpec } from '@/cli/CommandTable';
import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import {
  specsFromTrieRegistrations,
} from '@/cli/commands/trieAdapter';
import { MODES_INTERFACE } from './CiscoConfigCommands';
import { ensureVrf, isVrfName, vrfStoreOf, type VrfHost } from './ciscoVrfStore';

/*
 * Chaque forme de `clear ip nat translation` porte un refus qui EXPLIQUE
 * — VRF absent, reserve absente, port hors bornes — donc la place NOMME
 * ce qui suit et laisse le gestionnaire trancher. Typer le VRF ou la
 * reserve remplacerait « % VRF ZORG does not exist. » par un caret nu,
 * c'est-a-dire une information par une absence d'information.
 */
const NAT_EXEC_ARGUMENTS:
Readonly<Record<string, ArgumentSpec | readonly ArgumentSpec[] | null>> = {
  'clear ip nat translation inside': { name: 'filtre', type: 'REST', optional: true,
    description: 'Inside local address, or `vrf` then its name' },
  'clear ip nat translation outside': { name: 'filtre', type: 'REST', optional: true,
    description: 'Outside global address, or `vrf` then its name' },
  'clear ip nat translation tcp': { name: 'traduction', type: 'REST',
    description: 'Local address and port, then global address and port' },
  'clear ip nat translation udp': { name: 'traduction', type: 'REST',
    description: 'Local address and port, then global address and port' },
  'clear ip nat translation vrf': { name: 'nom', type: 'WORD', description: 'VRF name' },
  'clear ip nat translation pool': { name: 'nom', type: 'WORD', description: 'Pool name' },
  'clear ip nat statistics': null,
};

export function natExecSpecs(getRouter: () => Router): CommandSpec[] {
  return specsFromTrieRegistrations(
    (collector) => registerNATPrivilegedCommands(collector as unknown as CommandTrie, getRouter),
    {
      modes: ['privileged'], minPrivilege: 15,
      undoFromNegatedPaths: true,
      argumentFor: (path) => NAT_EXEC_ARGUMENTS[path],
    },
  );
}

export function registerNATPrivilegedCommands(trie: CommandTrie, getRouter: () => Router): void {
  trie.register('clear ip nat translation *', 'Clear all dynamic NAT translations', () => {
    getRouter()._getNATEngine().clearTranslations();
    return '';
  });
  const validateVrfArg = (args: string[]): string | null => {
    const i = args.findIndex(a => a.toLowerCase() === 'vrf');
    if (i < 0) return null;
    const name = args[i + 1];
    if (!name) return '% Missing VRF name.';
    const router = getRouter() as any;
    const vrfs = router._vrfs as Map<string, unknown> | undefined;
    if (!vrfs?.has?.(name)) return `% VRF ${name} does not exist.`;
    return null;
  };
  const vrfIfaces = (args: string[]): Set<string> | undefined => {
    const name = parseVrf(args);
    if (!name) return undefined;
    const router = getRouter() as any;
    return (router._vrfs as Map<string, { interfaces: Set<string> }> | undefined)?.get(name)?.interfaces;
  };
  trie.registerGreedy('clear ip nat translation inside', 'Clear inside NAT translation entries', (args) => {
    const err = validateVrfArg(args);
    if (err) return err;
    const engine = getRouter()._getNATEngine();
    const ip = args[0];
    if (ip && isValidIPv4(ip)) {
      engine.clearTranslationsFiltered({ insideIP: ip, ifaces: vrfIfaces(args) });
    } else {
      engine.clearTranslations();
    }
    return '';
  });
  trie.registerGreedy('clear ip nat translation outside', 'Clear outside NAT translation entries', (args) => {
    const err = validateVrfArg(args);
    if (err) return err;
    const engine = getRouter()._getNATEngine();
    const ip = args[0];
    if (ip && isValidIPv4(ip)) {
      engine.clearTranslationsFiltered({ outsideIP: ip, ifaces: vrfIfaces(args) });
    } else {
      engine.clearTranslations();
    }
    return '';
  });
  const protoClearHandler = (proto: 'tcp' | 'udp') => (args: string[]) => {
    if (args.length === 1 && args[0] === '*') {
      getRouter()._getNATEngine().clearTranslations();
      return '';
    }
    if (args.length < 4) return `% Incomplete command: ${proto} LOCAL LPORT GLOBAL GPORT.`;
    if (args.some(a => /\*/.test(a) && a !== '*')) return `% Invalid wildcard syntax for clear ip nat translation ${proto}.`;
    if (args.some(a => a === '*')) return `% Invalid mixed wildcard syntax.`;
    const engine = getRouter()._getNATEngine();
    for (let i = 0; i < args.length; i++) {
      if (i % 2 === 0 && !isValidIPv4(args[i])) return `% Invalid IP address ${args[i]}.`;
      if (i % 2 === 1) {
        const p = parseInt(args[i], 10);
        if (isNaN(p) || p < 1 || p > 65535) return `% Invalid port number ${args[i]}.`;
      }
    }
    const globalIP = args[2];
    const globalPort = parseInt(args[3], 10);
    engine.clearTranslation(proto === 'tcp' ? IP_PROTO_TCP : IP_PROTO_UDP, globalIP, globalPort);
    return '';
  };
  trie.registerGreedy('clear ip nat translation tcp', 'Clear TCP NAT translation entries', protoClearHandler('tcp'));
  trie.registerGreedy('clear ip nat translation udp', 'Clear UDP NAT translation entries', protoClearHandler('udp'));
  trie.registerGreedy('clear ip nat translation vrf', 'Clear NAT translations in VRF', (args) => {
    const vrf = args[0];
    if (!vrf) return '% Incomplete command.';
    const router = getRouter() as any;
    const vrfs = router._vrfs as Map<string, { interfaces: Set<string> }> | undefined;
    if (!vrfs?.has?.(vrf)) return `% VRF ${vrf} does not exist.`;
    getRouter()._getNATEngine().clearTranslationsFiltered({ ifaces: vrfs.get(vrf)!.interfaces });
    return '';
  });
  trie.registerGreedy('clear ip nat translation pool', 'Clear NAT translations for pool', (args) => {
    const name = args[0];
    if (!name) return '% Incomplete command.';
    if (!getRouter()._getNATEngine().getPool(name)) return `% Pool ${name} does not exist.`;
    getRouter()._getNATEngine().clearTranslationsFiltered({ poolName: name });
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
  trie.register('show ip nat translations timeout', 'Display configured NAT timeouts', () => {
    const t = getRouter()._getNATEngine().getTimeouts();
    return [
      `tcp-timeout: ${t.tcp / 1000}`,
      `udp-timeout: ${t.udp / 1000}`,
      `icmp-timeout: ${t.icmp / 1000}`,
      `dns-timeout: ${t.dns / 1000}`,
      `syn-timeout: ${t.tcpHalfOpen / 1000}`,
      `finrst-timeout: ${t.finrst / 1000}`,
    ].join('\n');
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
  engine.purgeStale();
  const entries = engine.getTranslations();
  const outsideStatic = engine.getOutsideStaticEntries();
  const networkStatic = engine.getStaticEntries().filter(e => e.isNetwork);

  const header = 'Pro  Inside global          Inside local           Outside local          Outside global';
  if (entries.length === 0 && outsideStatic.length === 0 && networkStatic.length === 0) {
    return `${header}\nNo NAT translations.`;
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

/** `Xd:XXh:XXm:XXs` duration format used by `show ip nat translations verbose`. */
function formatNatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  return `${days}d:${String(hours).padStart(2, '0')}h:${String(mins).padStart(2, '0')}m:${String(secs).padStart(2, '0')}s`;
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
  const header = `Pro  Inside global          Inside local           Outside local          Outside global`;
  if (entries.length === 0) return `${header}\nNo NAT entries.`;

  const lines: string[] = [];
  lines.push(header);
  const now = Date.now();
  for (const e of entries) {
    lines.push(`${e.proto.padEnd(4)} ${e.insideGlobal.padEnd(23)}${e.insideLocal.padEnd(23)}${e.outsideLocal.padEnd(23)}${e.outsideGlobal}`);
    if (e.createdAtMs !== undefined && e.lastUsedMs !== undefined && e.timeoutMs !== undefined) {
      const create = formatNatDuration(now - e.createdAtMs);
      const use = formatNatDuration(now - e.lastUsedMs);
      const left = formatNatDuration(Math.max(0, e.timeoutMs - (now - e.lastUsedMs)));
      lines.push(`    create: ${create}, use: ${use}, left: ${left}`);
    } else {
      lines.push(`    create: 0d:00h:00m:00s, use: 0d:00h:00m:00s, left: --`);
    }
    if (e.inputIface) lines.push(`    input iface: ${e.inputIface}`);
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

  const poolUsage: string[] = [];
  if (pools > 0) {
    poolUsage.push(`Pools:`);
    for (const [, p] of engine.getPools()) {
      const startN = p.startIP.split('.').reduce((a, x) => (a << 8) + parseInt(x, 10), 0) >>> 0;
      const endN = p.endIP.split('.').reduce((a, x) => (a << 8) + parseInt(x, 10), 0) >>> 0;
      const cap = (endN - startN + 1) || 1;
      const used = engine.getSessions().filter(s => {
        const n = s.globalIP.split('.').reduce((a, x) => (a << 8) + parseInt(x, 10), 0) >>> 0;
        return n >= startN && n <= endN;
      }).length;
      const pct = Math.round((used * 100) / cap);
      poolUsage.push(` ${p.name}: ${p.startIP} - ${p.endIP} — used ${used}/${cap} (${pct}%)`);
    }
  }

  const staticEntries = engine.getStaticEntries();

  return [
    `Total active translations: ${total} (${statics} static, ${dynamicSessions} dynamic; 0 extended)`,
    `Peak translations: ${engine.getPeakTranslationCount()}`,
    `Total translations: ${total}`,
    `Static translations: ${statics}`,
    `Dynamic translations: ${dynamicSessions}`,
    `Translation errors: 0`,
    `Outside interfaces:  ${outside}`,
    `Inside interfaces:   ${inside}`,
    `Hits: ${counters.hits}  Misses: ${counters.misses}`,
    ...(counters.expired > 0 ? [`Expired translations: ${counters.expired}`] : []),
    `Session timeouts (seconds): tcp ${timeouts.tcp / 1000}  udp ${timeouts.udp / 1000}  icmp ${timeouts.icmp / 1000}  syn ${timeouts.tcpHalfOpen / 1000}`,
    ...(hasOverload ? ['Overloaded mappings: yes'] : []),
    ...(maxEntries != null ? [`max-entries ${maxEntries}`, ...(dynamicSessions >= maxEntries ? ['Limit reached: new translations blocked'] : [])] : []),
    `Static mappings:`,
    ...(staticEntries.length === 0 ? ['-- No static NAT entries configured --'] :
      staticEntries.map(e =>
        ` -- static  ${e.localIP}  ${e.globalIP}  refcount ${e.hitCount ?? 0}`
      )),
    `Dynamic mappings:`,
    ...(dynamic === 0 ? ['-- No dynamic NAT rules configured --'] :
      engine.getDynamicRules().map(r =>
        ` -- Inside Source [acl ${r.aclId}] ${r.type === 'overload' ? 'overload' : `pool ${r.poolName}`}`
      )),
    ...poolUsage,
    `Total doors: ${engine.getAlgDoors()}`,
    `Appl doors: ${engine.getAlgDoors()}`,
    `Normal doors: 0`,
    `Queued Packets: 0`,
  ].join('\n');
}

// ─── Running-Config helpers ───────────────────────────────────────────────────

export function runningConfigNAT(router: Router): string[] {
  const engine = router._getNATEngine();
  const lines: string[] = [];

  for (const [, pool] of engine.getPools()) {
    const tail = pool.netmask != null
      ? `netmask ${pool.netmask}`
      : `prefix-length ${pool.prefixLength ?? 24}`;
    lines.push(`ip nat pool ${pool.name} ${pool.startIP} ${pool.endIP} ${tail}`);
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
  for (const r of engine.getDynamicRules()) {
    const vrfTail = (r as any).vrf ? ` vrf ${(r as any).vrf}` : '';
    if (r.type === 'overload') {
      const iface = r.interfaceName ?? [...engine.getOutsideInterfaces()][0] ?? 'GigabitEthernet0/1';
      lines.push(`ip nat inside source list ${r.aclId} interface ${iface} overload${vrfTail}`);
    } else if (r.type === 'pool' && r.poolName) {
      lines.push(`ip nat inside source list ${r.aclId} pool ${r.poolName}${r.overload ? ' overload' : ''}${vrfTail}`);
    }
  }

  // Non-default timeouts
  const t = engine.getTimeouts();
  if (t.tcp !== 86_400_000)       lines.push(`ip nat translation tcp-timeout ${t.tcp / 1000}`);
  if (t.udp !== 300_000)          lines.push(`ip nat translation udp-timeout ${t.udp / 1000}`);
  if (t.icmp !== 60_000)          lines.push(`ip nat translation icmp-timeout ${t.icmp / 1000}`);
  if (t.tcpHalfOpen !== 30_000)   lines.push(`ip nat translation syn-timeout ${t.tcpHalfOpen / 1000}`);
  if (t.dns !== 60_000)           lines.push(`ip nat translation dns-timeout ${t.dns / 1000}`);
  if (t.finrst !== 60_000)        lines.push(`ip nat translation finrst-timeout ${t.finrst / 1000}`);

  return lines;
}

export function runningConfigInterfaceNAT(router: Router, ifName: string): string[] {
  const engine = router._getNATEngine();
  const lines: string[] = [];
  if (engine.isInsideInterface(ifName)) lines.push(' ip nat inside');
  if (engine.isOutsideInterface(ifName)) lines.push(' ip nat outside');
  return lines;
}

export function natShowSpecs(getRouter: () => Router): CommandSpec[] {
  return specsFromTrieRegistrations(
    (collector) => registerNATShowCommands(collector as unknown as CommandTrie, getRouter),
    {
      modes: ['user', 'privileged'], minPrivilege: 1,
      restDescription: 'Filter',
      restDescriptionFor: (path) => ({
        'show ip nat translations vrf': 'VRF name',
        'show ip nat statistics vrf': 'VRF name',
        'show ip nat translations verbose': 'Optional filter',
      })[path],
      skip: (path) => !path.startsWith('show ip nat'),
      keywordsFor: (path) => path === 'show ip nat translations verbose'
        ? [{ keyword: 'vrf', description: 'Display NAT translations in VRF' }]
        : undefined,
    },
  );
}
