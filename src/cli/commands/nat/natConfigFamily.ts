import type { CommandSpec } from '../../CommandTable';
import type { ArgumentSpec } from '../../ArgumentTypes';
import { IPAddress, SubnetMask } from '@/network/core/types';
import {
  isValidIPv4, isValidSubnetMask, prefixLengthToMaskUint32,
} from '@/network/core/ip';
import { NAT_ROUTE_MAP_PREFIX } from '@/network/devices/router/nat/NatRouteMap';
import {
  DEFAULT_NAT_TIMEOUTS, type NatStaticEntry, type NatTimeouts,
} from '@/network/devices/router/NATEngine';
import {
  hasUnmatchedQuote, unquoted, vrfNamed, words, type NatHost,
} from './natHost';

const CONFIG: readonly string[] = Object.freeze(['config']);

const TIMEOUT_CEILING_SECONDS = 4_294_967;
const MAX_ENTRIES_CEILING = 2_147_483;
export const NAT_TIMEOUT_KEYWORDS: ReadonlyArray<readonly [string, keyof NatTimeouts]> = [
  ['timeout', 'simple'],
  ['tcp-timeout', 'tcp'],
  ['udp-timeout', 'udp'],
  ['icmp-timeout', 'icmp'],
  ['syn-timeout', 'tcpHalfOpen'],
  ['dns-timeout', 'dns'],
  ['finrst-timeout', 'finrst'],
];

const ALG_PROTOCOLS = ['dns', 'ftp', 'tftp', 'h323', 'sip', 'rtsp', 'pptp'];

interface StaticPortMapping {
  protocol: 'tcp' | 'udp';
  localIP: string;
  localPort: number;
  globalIP: string;
  globalPort: number;
  interfaceName?: string;
}

export function natStaticErrorMessage(reason: string): string {
  switch (reason) {
    case 'duplicate': return 'duplicate static NAT entry';
    case 'local-already-mapped': return 'inside local IP already mapped';
    case 'global-already-mapped': return 'inside global IP already mapped';
    case 'global-port-already-mapped': return 'global IP:port already mapped to another inside target';
    default: return reason;
  }
}

export function networkPrefixLength(token: string): number | null {
  const slash = token.match(/^\/(\d+)$/);
  if (slash) {
    const length = parseInt(slash[1], 10);
    return length >= 0 && length <= 32 ? length : null;
  }
  return isValidSubnetMask(token) ? new SubnetMask(token).toCIDR() : null;
}

function addressNumber(ip: string): number {
  return ip.split('.').reduce((accumulated, part) => (accumulated << 8) + parseInt(part, 10), 0) >>> 0;
}

function normalizeStaticArguments(raw: readonly string[], host: NatHost): string[] {
  const args = raw.map(unquoted);
  if (args[0] !== undefined) args[0] = host.resolveHostName(args[0]);
  if (args[1] !== undefined) args[1] = host.resolveHostName(args[1]);
  return args;
}

function parseStaticPortMapping(args: string[], host: NatHost): StaticPortMapping | string {
  if (args.length < 5) return '% Incomplete command.';
  const protocol = args[0].toLowerCase() as 'tcp' | 'udp';
  const localIP = args[1];
  const localPort = parseInt(args[2], 10);
  if (!isValidIPv4(localIP)) return `% Invalid IP address ${localIP}.`;
  if (isNaN(localPort) || localPort < 1 || localPort > 65535) return '% Invalid port number.';
  if (args[3]?.toLowerCase() === 'interface') {
    const interfaceName = host.resolveInterface(args[4]) ?? args[4];
    if (!/^(GigabitEthernet|FastEthernet|Serial|Loopback|Vlan|Tunnel)\d/i.test(interfaceName)) {
      return `% Invalid interface ${args[4]}.`;
    }
    const port = host.portOf(interfaceName);
    if (!port && !/^Loopback\d/i.test(interfaceName) && !/\.\d+$/.test(interfaceName)) {
      return `% Interface ${interfaceName} does not exist.`;
    }
    const globalPort = parseInt(args[5] ?? args[2], 10);
    if (isNaN(globalPort) || globalPort < 1 || globalPort > 65535) return '% Invalid port number.';
    return {
      protocol, localIP, localPort, globalPort, interfaceName,
      globalIP: port?.address ?? '0.0.0.0',
    };
  }
  const globalIP = args[3];
  const globalPort = parseInt(args[4], 10);
  if (!isValidIPv4(globalIP)) return `% Invalid IP address ${globalIP}.`;
  if (isNaN(globalPort) || globalPort < 1 || globalPort > 65535) return '% Invalid port number.';
  return { protocol, localIP, localPort, globalIP, globalPort };
}

function addStatic(host: NatHost, raw: string[]): string {
  if (hasUnmatchedQuote(raw)) return '% Unmatched quote in input.';
  const args = normalizeStaticArguments(raw, host);
  if (args.length < 2) return '% Incomplete command.';
  const engine = host.engine();
  const first = args[0].toLowerCase();
  if (first === 'tcp' || first === 'udp') {
    const mapping = parseStaticPortMapping(args, host);
    if (typeof mapping === 'string') return mapping;
    const { localIP, globalIP, localPort, globalPort, interfaceName } = mapping;
    const result = engine.addStaticEntry({
      localIP, globalIP, protocol: mapping.protocol, localPort, globalPort,
      vrf: vrfNamed(args),
      ...(interfaceName ? {
        interfaceName,
        rawConfig: `ip nat inside source static ${mapping.protocol} ${localIP} ${localPort} interface ${interfaceName} ${globalPort}`,
      } : {}),
    });
    return result.ok === false ? `% ${natStaticErrorMessage(result.reason)}` : '';
  }
  if (/^[a-z_]+$/i.test(first) && first !== 'network') return `% Invalid protocol ${args[0]}.`;
  const [localIP, globalIP] = args;
  if (!isValidIPv4(localIP)) return `% Invalid IP address ${localIP}.`;
  if (!isValidIPv4(globalIP)) return `% Invalid IP address ${globalIP}.`;
  const vrf = vrfNamed(args);
  if (vrf && !host.vrfExists(vrf)) return `% VRF ${vrf} does not exist.`;
  const rawLocal = unquoted(raw[0]);
  const rawGlobal = unquoted(raw[1]);
  const entry: NatStaticEntry = {
    localIP, globalIP, vrf,
    rawConfig: `ip nat inside source static ${rawLocal} ${rawGlobal}${vrf ? ` vrf ${vrf}` : ''}`,
  };
  const result = engine.addStaticEntry(entry);
  return result.ok === false ? `% ${natStaticErrorMessage(result.reason)}` : '';
}

function removeStatic(host: NatHost, raw: string[]): string {
  if (hasUnmatchedQuote(raw)) return '% Unmatched quote in input.';
  const args = normalizeStaticArguments(raw, host);
  if (args.length < 2) return '% Incomplete command.';
  const vrf = vrfNamed(args);
  const protocol = args[0].toLowerCase();
  if (protocol === 'tcp' || protocol === 'udp') {
    const mapping = parseStaticPortMapping(args, host);
    if (typeof mapping === 'string') return mapping;
    host.engine().removeStaticMapping({ ...mapping, vrf });
  } else {
    host.engine().removeStaticMapping({ localIP: args[0], globalIP: args[1], vrf });
  }
  return '';
}

function addDynamicRule(host: NatHost, raw: string[], selector: { routeMap?: string }): string {
  if (hasUnmatchedQuote(raw)) return '% Unmatched quote in input.';
  const args = raw.map(unquoted);
  if (args.length < 3) return '% Incomplete command.';
  const engine = host.engine();
  const viaRouteMap = selector.routeMap !== undefined;
  const aclId = viaRouteMap ? `${NAT_ROUTE_MAP_PREFIX}${args[0]}` : args[0];
  const identity = viaRouteMap ? { aclId, routeMap: args[0] } : { aclId };
  const vrf = viaRouteMap ? undefined : vrfNamed(args);
  if (vrf && !host.vrfExists(vrf)) return `% VRF ${vrf} does not exist.`;
  const keyword = args[1].toLowerCase();
  const overloaded = args.some((token, at) => at >= 3 && token.toLowerCase() === 'overload');

  if (keyword === 'interface') {
    const interfaceName = host.resolveInterface(args[2]) ?? args[2];
    if (!host.portOf(interfaceName) && !/^Loopback/i.test(interfaceName) && !/\.\d+$/.test(interfaceName)) {
      return `% Invalid interface ${args[2]}.`;
    }
    if (!overloaded) return '% Missing "overload" keyword.';
    const allowed = new Set(['overload', ...(viaRouteMap ? [] : ['vrf', (vrf ?? '').toLowerCase()])]);
    const extra = args.slice(3).filter(token => !allowed.has(token.toLowerCase()));
    if (extra.length > 0) return `% Invalid extra argument(s): ${extra.join(' ')}`;
    engine.addDynamicRule({ ...identity, type: 'overload', interfaceName, ...(vrf ? { vrf } : {}) });
    return '';
  }
  if (keyword === 'pool') {
    const poolName = args[2];
    if (!engine.getPool(poolName)) return `% Pool ${poolName} not defined.`;
    const allowed = new Set(['overload', ...(viaRouteMap ? [] : ['vrf', (vrf ?? '').toLowerCase()])]);
    const extra = args.slice(3).filter(token => !allowed.has(token.toLowerCase()));
    if (extra.length > 0) return `% Invalid extra argument(s): ${extra.join(' ')}`;
    engine.addDynamicRule({
      ...identity, type: 'pool', poolName,
      ...(overloaded ? { overload: true } : {}),
      ...(vrf ? { vrf } : {}),
    });
    return '';
  }
  return '% Invalid command syntax.';
}

function removeDynamicRule(host: NatHost, aclId: string | undefined): string {
  if (!aclId) return '% Incomplete command.';
  const engine = host.engine();
  engine.removeDynamicRule(aclId);
  engine.clearDynamicTranslations();
  return '';
}

function definePool(host: NatHost, raw: string[]): string {
  const args = raw.map(unquoted);
  if (args.length < 3) return '% Incomplete command.';
  const [name, startIP, endIP] = args;
  if (name.length > 31) return '% Pool name exceeds 31 characters.';
  if (!/^[A-Za-z0-9_-]+$/.test(name)) return '% Invalid pool name (special characters not allowed).';
  if (!isValidIPv4(startIP)) return `% Invalid IP address ${startIP}.`;
  if (!isValidIPv4(endIP)) return `% Invalid IP address ${endIP}.`;
  const startN = addressNumber(startIP);
  const endN = addressNumber(endIP);
  if (startN > endN) return '% Start IP greater than end IP.';

  const keyword = args[3]?.toLowerCase();
  let mask: string | null = null;
  let prefixLength: number | null = null;
  if (keyword === 'netmask') {
    if (!args[4]) return '% Missing netmask value.';
    if (!isValidSubnetMask(args[4])) return `% Invalid netmask ${args[4]}.`;
    mask = args[4];
  } else if (keyword === 'prefix-length') {
    const length = parseInt(args[4] ?? '', 10);
    if (isNaN(length) || length < 0 || length > 32) return '% Invalid prefix-length.';
    prefixLength = length;
  } else {
    return '% Expected "netmask" or "prefix-length" keyword.';
  }
  if (args.length > 5) return `% Invalid extra argument(s): ${args.slice(5).join(' ')}`;
  const effectivePrefix = prefixLength ?? (mask ? new SubnetMask(mask).toCIDR() : 24);
  const netMask = prefixLengthToMaskUint32(effectivePrefix);
  if ((startN & netMask) !== (endN & netMask)) return '% IP range does not align with netmask.';

  const engine = host.engine();
  for (const [, pool] of engine.getPools()) {
    if (!(endN < addressNumber(pool.startIP) || startN > addressNumber(pool.endIP))) {
      return `% Pool range overlaps existing pool ${pool.name}.`;
    }
  }
  for (const interfaceName of engine.getOutsideInterfaces()) {
    const address = host.portOf(interfaceName)?.address;
    if (!address || !/^\d+\.\d+\.\d+\.\d+$/.test(address)) continue;
    const n = addressNumber(address);
    if (n >= startN && n <= endN) return `% Pool overlaps WAN gateway ${interfaceName} (${address}).`;
  }
  engine.addPool({
    name, startIP, endIP,
    ...(mask !== null ? { netmask: mask } : {}),
    ...(prefixLength !== null ? { prefixLength } : {}),
  });
  return '';
}

function removePool(host: NatHost, name: string | undefined): string {
  if (!name) return '% Incomplete command.';
  const engine = host.engine();
  if (engine.getDynamicRules().some(rule => rule.type === 'pool' && rule.poolName === name)) {
    return '% Pool is in use by an active list translation.';
  }
  engine.removePool(name);
  return '';
}

function timeoutSeconds(text: string | undefined): number | string {
  const seconds = parseInt(text ?? '', 10);
  if (isNaN(seconds)) return '% Invalid timeout value.';
  if (seconds === 0) return '% Timeout value cannot be zero.';
  if (seconds < 0) return '% Timeout value must be positive.';
  if (seconds > TIMEOUT_CEILING_SECONDS) return '% Timeout value out of range.';
  return seconds;
}

function setOutsideStatic(host: NatHost, args: string[]): string {
  if (args.length < 2) return '% Incomplete command.';
  const [outside, inside] = args;
  if (!isValidIPv4(outside)) return `% Invalid IP address ${outside}.`;
  if (!isValidIPv4(inside)) return `% Invalid IP address ${inside}.`;
  const engine = host.engine();
  for (const entry of engine.getStaticEntries()) {
    if (!entry.protocol && [outside, inside].some(ip => entry.localIP === ip || entry.globalIP === ip)) {
      return `% Outside static mapping overlaps inside static entry ${entry.localIP}/${entry.globalIP}.`;
    }
  }
  engine.addOutsideStatic({ outsideGlobal: outside, outsideLocal: inside });
  return '';
}

function setMaxEntries(host: NatHost, args: string[]): string {
  const engine = host.engine();
  const limitOf = (text: string | undefined): number | string => {
    const n = parseInt(text ?? '', 10);
    if (isNaN(n)) return '% Invalid max-entries value.';
    if (n < 1 || n > MAX_ENTRIES_CEILING) return '% max-entries value exceeds platform limits.';
    return n;
  };
  const keyword = (args[0] ?? '').toLowerCase();
  if (keyword === 'host') {
    if (!args[1] || !IPAddress.tryParse(args[1])) return '% Invalid IP address.';
    const n = limitOf(args[2]);
    if (typeof n === 'string') return n;
    engine.setMaxEntriesForHost(args[1], n);
    return '';
  }
  const n = limitOf(keyword === 'all-host' ? args[1] : args[0]);
  if (typeof n === 'string') return n;
  if (keyword === 'all-host') engine.setMaxEntriesAllHost(n);
  else engine.setMaxEntries(n);
  return '';
}

function clearMaxEntries(host: NatHost, args: string[]): string {
  const engine = host.engine();
  const keyword = (args[0] ?? '').toLowerCase();
  if (keyword === 'host' && args[1]) engine.setMaxEntriesForHost(args[1], null);
  else if (keyword === 'all-host') engine.setMaxEntriesAllHost(null);
  else engine.setMaxEntries(null);
  return '';
}

const REST = (name: string, description: string, extra: Partial<ArgumentSpec> = {}): ArgumentSpec =>
  ({ name, type: 'REST', description, ...extra });

const OPTIONAL_REST = (name: string, description: string): ArgumentSpec =>
  ({ name, type: 'REST', optional: true, description, values: [] });

export function natConfigFamily(host: () => NatHost): CommandSpec[] {
  const place = (
    id: string, path: readonly string[], argument: ArgumentSpec | null,
    description: string, run: (h: NatHost, tokens: string[]) => string,
    undo?: (h: NatHost, tokens: string[]) => string,
    undoDescription?: string,
  ): CommandSpec => {
    const read = (args: Readonly<Record<string, string>>): string[] =>
      argument === null ? [] : words(args[argument.name]);
    return {
      id: `config-${id}`,
      path: argument === null ? [...path] : [...path, argument],
      description, modes: CONFIG, minPrivilege: 15,
      run: (_session, args) => run(host(), read(args)),
      ...(undo ? { undo: (_session, args) => undo(host(), read(args)) } : {}),
      ...(undoDescription ? { undoDescription } : {}),
    };
  };

  const timeout = (keyword: string, field: keyof NatTimeouts, description: string,
    seconds: (text: string | undefined) => number | string): CommandSpec =>
    place(`ip-nat-translation-${keyword}`, ['ip', 'nat', 'translation', keyword],
      OPTIONAL_REST('seconds', description), description,
      (h, tokens) => {
        const value = seconds(tokens[0]);
        if (typeof value === 'string') return value;
        h.engine().setTimeouts({ [field]: value * 1000 });
        return '';
      },
      (h) => {
        h.engine().setTimeouts({ [field]: DEFAULT_NAT_TIMEOUTS[field] });
        return '';
      },
      `Restore the default ${description.toLowerCase().replace(/^set /, '')}`);

  const halfOpenSeconds = (text: string | undefined): number | string => {
    const value = parseInt(text ?? '', 10);
    return isNaN(value) || value < 1 ? '% Invalid timeout value.' : value;
  };

  return [
    place('ip-nat-inside-source-static',
      ['ip', 'nat', 'inside', 'source', 'static'],
      REST('traduction', 'Local then global address, or `tcp`/`udp` with their ports', {
        alternatives: [
          { keyword: 'A.B.C.D', description: 'Inside local address' },
          { keyword: 'tcp', description: 'Translate a TCP port' },
          { keyword: 'udp', description: 'Translate a UDP port' },
        ],
      }),
      'Configure static NAT translation', addStatic, removeStatic,
      'Remove static NAT translation'),
    place('ip-nat-inside-source-list',
      ['ip', 'nat', 'inside', 'source', 'list'],
      REST('regle', 'Access list, then `pool <nom>` or `interface <nom>`, then `overload`'),
      'Configure dynamic NAT/PAT',
      (h, tokens) => addDynamicRule(h, tokens, {}),
      (h, tokens) => removeDynamicRule(h, tokens[0]),
      'Remove dynamic NAT rule'),
    place('ip-nat-inside-source-route-map',
      ['ip', 'nat', 'inside', 'source', 'route-map'],
      REST('regle', 'Route-map, then `pool <nom>`'),
      'NAT via route-map',
      (h, tokens) => addDynamicRule(h, tokens, { routeMap: tokens[0] }),
      (h, tokens) => removeDynamicRule(h, tokens[0] === undefined ? undefined : `${NAT_ROUTE_MAP_PREFIX}${tokens[0]}`),
      'Remove route-map NAT'),
    place('ip-nat-pool', ['ip', 'nat', 'pool'],
      REST('reserve', 'Name, first and last address, then `netmask` or `prefix-length`'),
      'Define NAT address pool', definePool,
      (h, tokens) => removePool(h, tokens[0]), 'Remove NAT address pool'),
    place('ip-nat-outside-source-static',
      ['ip', 'nat', 'outside', 'source', 'static'],
      REST('traduction', 'Outside global then outside local address'),
      'Configure outside static NAT', setOutsideStatic,
      (h, tokens) => {
        if (tokens.length < 2) return '% Incomplete command.';
        h.engine().removeOutsideStatic(tokens[0], tokens[1]);
        return '';
      }, 'Remove outside static NAT'),
    {
      id: 'config-ip-nat',
      path: ['ip', 'nat'],
      description: 'Wipe NAT configuration',
      modes: CONFIG, minPrivilege: 15,
      existsOnlyNegated: true,
      run: () => '',
      undo: () => {
        const engine = host().engine();
        engine.removeAllStaticEntries();
        engine.clearTranslations();
        return '';
      },
      undoDescription: 'Wipe NAT configuration',
    },
    timeout('tcp-timeout', 'tcp', 'Set TCP NAT session timeout', timeoutSeconds),
    timeout('udp-timeout', 'udp', 'Set UDP NAT session timeout', timeoutSeconds),
    timeout('icmp-timeout', 'icmp', 'Set ICMP NAT session timeout', timeoutSeconds),
    timeout('syn-timeout', 'tcpHalfOpen', 'Set TCP SYN (half-open) timeout', halfOpenSeconds),
    timeout('dns-timeout', 'dns', 'Set DNS NAT session timeout', timeoutSeconds),
    timeout('finrst-timeout', 'finrst', 'Set TCP FIN/RST NAT session timeout', timeoutSeconds),
    timeout('timeout', 'simple', 'Set generic NAT timeout', timeoutSeconds),
    place('ip-nat-translation-max-entries', ['ip', 'nat', 'translation', 'max-entries'],
      OPTIONAL_REST('limite', 'Set NAT translation table cap'),
      'Set NAT translation table cap', setMaxEntries, clearMaxEntries,
      'Remove a NAT table cap'),
    place('ip-nat-log-translations', ['ip', 'nat', 'log', 'translations'],
      REST('ou', 'Where the translations are logged', {
        optional: true,
        alternatives: [{ keyword: 'syslog', description: 'Log the translations to syslog' }],
      }),
      'Enable NAT translation logging',
      (h, tokens) => {
        if (tokens.length !== 1 || tokens[0].toLowerCase() !== 'syslog') return '% Incomplete command.';
        h.engine().setTranslationLogging(true);
        return '';
      },
      (h, tokens) => {
        if (tokens.length > 1 || (tokens.length === 1 && tokens[0].toLowerCase() !== 'syslog')) {
          return "% Invalid input detected at '^' marker.";
        }
        h.engine().setTranslationLogging(false);
        return '';
      }, 'Disable NAT translation logging'),
    place('ip-nat-service', ['ip', 'nat', 'service'],
      REST('service', 'NAT service to enable or disable', { optional: true }),
      'Enable an ALG for a protocol',
      (h, tokens) => {
        const protocol = (tokens[0] ?? '').toLowerCase();
        if (!ALG_PROTOCOLS.includes(protocol)) return `% Unknown ALG protocol "${tokens[0] ?? ''}".`;
        h.engine().setAlgEnabled(protocol, true);
        return '';
      },
      (h, tokens) => {
        h.engine().setAlgEnabled((tokens[0] ?? '').toLowerCase(), false);
        return '';
      }, 'Disable an ALG for a protocol'),
  ];
}
