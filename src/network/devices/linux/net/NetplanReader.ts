import { IPAddress, IPv6Address, MACAddress } from '../../../core/types';
import {
  entryOf, loadYaml, mergeYaml,
  type YamlLocation, type YamlMapping, type YamlNode, type YamlScalar, type YamlSequence,
} from '../../../yaml/YamlTree';
import type { YamlError } from '../../../yaml/YamlTypes';
import type {
  DeclaredInterfaceConfig, DeclaredRoute, NetplanConfig, NetplanReading, NetplanRenderer, NetplanSource,
} from './NetworkConfigFiles';

type NodeKind = 'scalar' | 'sequence' | 'mapping';

const NETWORK_KEYS: ReadonlyMap<string, NodeKind> = new Map([
  ['bonds', 'mapping'], ['bridges', 'mapping'], ['ethernets', 'mapping'], ['renderer', 'scalar'], ['tunnels', 'mapping'],
  ['version', 'scalar'], ['vlans', 'mapping'], ['wifis', 'mapping'], ['modems', 'mapping'], ['nm-devices', 'mapping'],
  ['openvswitch', 'mapping'],
]);

const BOOLEAN_KEYS: ReadonlySet<string> = new Set([
  'critical', 'ignore-carrier', 'dhcp4', 'dhcp6', 'optional', 'wakeonlan', 'emit-lldp', 'receive-checksum-offload',
  'transmit-checksum-offload', 'tcp-segmentation-offload', 'tcp6-segmentation-offload', 'generic-segmentation-offload',
  'generic-receive-offload', 'large-receive-offload', 'delay-virtual-functions-rebind', 'ipv6-privacy',
]);

const UNSIGNED_KEYS: ReadonlySet<string> = new Set(['mtu', 'ipv6-mtu', 'virtual-function-count']);

const OTHER_SCALAR_KEYS: readonly string[] = [
  'accept-ra', 'activation-mode', 'dhcp-identifier', 'gateway4', 'gateway6', 'ipv6-address-generation', 'ipv6-address-token',
  'macaddress', 'renderer', 'set-name', 'link', 'embedded-switch-mode',
];

const SEQUENCE_KEYS: readonly string[] = ['addresses', 'link-local', 'optional-addresses', 'routes', 'routing-policy', 'wakeonwlan'];

const MAPPING_KEYS: readonly string[] = [
  'dhcp4-overrides', 'dhcp6-overrides', 'nameservers', 'networkmanager', 'openvswitch', 'match', 'auth',
];

const ETHERNET_KEYS: ReadonlyMap<string, NodeKind> = new Map([
  ...[...BOOLEAN_KEYS, ...UNSIGNED_KEYS, ...OTHER_SCALAR_KEYS].map((key): [string, NodeKind] => [key, 'scalar']),
  ...SEQUENCE_KEYS.map((key): [string, NodeKind] => [key, 'sequence']),
  ...MAPPING_KEYS.map((key): [string, NodeKind] => [key, 'mapping']),
]);

const ROUTE_KEYS: ReadonlyMap<string, 'scalar'> = new Map(
  ['from', 'on-link', 'scope', 'table', 'to', 'type', 'via', 'metric', 'mtu', 'congestion-window', 'advertised-receive-window']
    .map((key): [string, 'scalar'] => [key, 'scalar']),
);

const DEFAULT_DESTINATIONS: ReadonlySet<string> = new Set(['default', '0.0.0.0/0']);
const MAC_PATTERN = /^[0-9a-fA-F]{2}(:[0-9a-fA-F]{2}){5}$/;
const BOOLEAN_WORDS = /^(true|on|yes|y|false|off|no|n)$/i;
const TRUE_WORDS = /^(true|on|yes|y)$/i;

class NetplanError extends Error {
  constructor(readonly location: YamlLocation, message: string) {
    super(message);
  }
}

function isIpv4(text: string): boolean {
  return IPAddress.tryParse(text) !== null;
}

function isIpv6(text: string): boolean {
  return text.includes(':') && IPv6Address.tryParse(text) !== null;
}

function expect(node: YamlNode, kind: NodeKind): void {
  if (node.kind === kind) return;
  const wording = kind === 'scalar' ? 'expected scalar' : kind === 'sequence' ? 'expected sequence' : 'expected mapping (check indentation)';
  throw new NetplanError(node.location, wording);
}

function walkMapping(
  mapping: YamlNode, allowed: ReadonlyMap<string, NodeKind>, visit: (key: YamlScalar, value: YamlNode) => void,
): void {
  expect(mapping, 'mapping');
  if (mapping.kind !== 'mapping') return;
  for (const { key, value } of mapping.entries) {
    const kind = allowed.get(key.value);
    if (kind === undefined) throw new NetplanError(key.location, `unknown key '${key.value}'`);
    expect(value, kind);
    visit(key, value);
  }
}

function checkBoolean(value: YamlNode): void {
  if (value.kind === 'scalar' && !BOOLEAN_WORDS.test(value.value)) throw new NetplanError(value.location, `invalid boolean value '${value.value}'`);
}

function checkUnsigned(value: YamlNode): void {
  if (value.kind !== 'scalar') return;
  if (!/^\d+$/.test(value.value) || Number(value.value) > 0xffffffff) {
    throw new NetplanError(value.location, `invalid unsigned int value '${value.value}'`);
  }
}

function checkAddresses(sequence: YamlSequence): void {
  for (const item of sequence.items) {
    if (item.kind === 'sequence') throw new NetplanError(item.location, 'expected either scalar or mapping (check indentation)');
    const entry = item.kind === 'mapping' ? item.entries[0]?.key : item;
    if (entry === undefined) continue;
    const slash = entry.value.lastIndexOf('/');
    if (slash < 0) throw new NetplanError(sequence.location, `address '${entry.value}' is missing /prefixlength`);
    const address = entry.value.slice(0, slash);
    const prefix = Number.parseInt(entry.value.slice(slash + 1), 10) || 0;
    if (isIpv4(address)) {
      if (prefix === 0 || prefix > 32) throw new NetplanError(sequence.location, `invalid prefix length in address '${entry.value}'`);
    } else if (isIpv6(address)) {
      if (prefix === 0 || prefix > 128) throw new NetplanError(sequence.location, `invalid prefix length in address '${entry.value}'`);
    } else {
      throw new NetplanError(sequence.location, `malformed address '${entry.value}', must be X.X.X.X/NN or X:X:X:X:X:X:X:X/NN`);
    }
  }
}

function checkNameservers(mapping: YamlNode): void {
  walkMapping(mapping, new Map([['search', 'sequence'], ['addresses', 'sequence']]), (key, value) => {
    if (value.kind !== 'sequence') return;
    for (const item of value.items) {
      expect(item, 'scalar');
      if (key.value === 'addresses' && item.kind === 'scalar' && !isIpv4(item.value) && !isIpv6(item.value)) {
        throw new NetplanError(value.location, `malformed address '${item.value}', must be X.X.X.X or X:X:X:X:X:X:X:X`);
      }
    }
  });
}

function addressFamily(text: string): number {
  const address = text.includes('/') ? text.slice(0, text.lastIndexOf('/')) : text;
  if (isIpv4(address)) return 4;
  return isIpv6(address) ? 6 : -1;
}

function checkRoutes(sequence: YamlSequence): void {
  for (const route of sequence.items) {
    expect(route, 'mapping');
    let family = -1;
    let to: string | undefined;
    let via: string | undefined;
    let type = 'unicast';
    let scope: string | undefined;
    walkMapping(route, ROUTE_KEYS, (key, value) => {
      if (value.kind !== 'scalar') return;
      if (key.value === 'to' && value.value === 'default') {
        to = value.value;
        return;
      }
      if (key.value === 'to' || key.value === 'via' || key.value === 'from') {
        const found = addressFamily(value.value);
        if (found < 0) throw new NetplanError(value.location, `invalid IP family '${found}'`);
        if (family !== -1 && family !== found) throw new NetplanError(value.location, `IP family mismatch in route to ${value.value}`);
        family = found;
        if (key.value === 'to') to = value.value;
        if (key.value === 'via') via = value.value;
      } else if (key.value === 'type') {
        type = value.value.toLowerCase();
      } else if (key.value === 'scope') {
        scope = value.value.toLowerCase();
      } else if (key.value === 'on-link') {
        checkBoolean(value);
      } else if (['table', 'metric', 'mtu', 'congestion-window', 'advertised-receive-window'].includes(key.value)) {
        checkUnsigned(value);
      }
    });
    const effectiveScope = scope ?? (type === 'local' || type === 'nat' ? 'host'
      : (type === 'unicast' && via === undefined) || ['broadcast', 'multicast', 'anycast'].includes(type) ? 'link' : 'global');
    if ((effectiveScope === 'link' || effectiveScope === 'host') && to === undefined) {
      throw new NetplanError(sequence.location, "link and host routes must specify a 'to' IP");
    }
    if (type === 'unicast' && effectiveScope === 'global' && (to === undefined || via === undefined)) {
      throw new NetplanError(sequence.location, "global unicast route must include both a 'to' and 'via' IP");
    }
    if (type !== 'unicast' && to === undefined) throw new NetplanError(sequence.location, "non-unicast routes must specify a 'to' IP");
  }
}

function checkRenderer(value: YamlNode): void {
  if (value.kind === 'scalar' && value.value !== 'networkd' && value.value !== 'NetworkManager') {
    throw new NetplanError(value.location, `unknown renderer '${value.value}'`);
  }
}

function checkMatch(mapping: YamlNode): void {
  walkMapping(mapping, new Map([['name', 'scalar'], ['macaddress', 'scalar'], ['driver', 'scalar']]), (key, value) => {
    if (key.value === 'macaddress' && value.kind === 'scalar' && !MAC_PATTERN.test(value.value)) {
      throw new NetplanError(value.location, `Invalid MAC address '${value.value}', must be XX:XX:XX:XX:XX:XX`);
    }
  });
}

function checkEthernet(id: string, definition: YamlNode): void {
  let hasMatch = false;
  let hasSetName = false;
  walkMapping(definition, ETHERNET_KEYS, (key, value) => {
    const name = key.value;
    if (BOOLEAN_KEYS.has(name)) checkBoolean(value);
    else if (UNSIGNED_KEYS.has(name)) checkUnsigned(value);
    else if (name === 'addresses' && value.kind === 'sequence') checkAddresses(value);
    else if (name === 'routes' && value.kind === 'sequence') checkRoutes(value);
    else if (name === 'nameservers') checkNameservers(value);
    else if (name === 'renderer') checkRenderer(value);
    else if (name === 'match') {
      hasMatch = true;
      checkMatch(value);
    } else if (name === 'set-name') hasSetName = true;
    else if (name === 'macaddress' && value.kind === 'scalar' && !MAC_PATTERN.test(value.value)) {
      throw new NetplanError(value.location, `Invalid MAC address '${value.value}', must be XX:XX:XX:XX:XX:XX`);
    } else if (name === 'gateway4' && value.kind === 'scalar' && !isIpv4(value.value)) {
      throw new NetplanError(value.location, `invalid IPv4 address '${value.value}'`);
    } else if (name === 'gateway6' && value.kind === 'scalar' && !isIpv6(value.value)) {
      throw new NetplanError(value.location, `invalid IPv6 address '${value.value}'`);
    }
  });
  if (hasSetName && !hasMatch) throw new NetplanError(definition.location, `${id}: 'set-name:' requires 'match:' properties`);
}

function checkDefinitions(group: YamlNode, ethernet: boolean): void {
  expect(group, 'mapping');
  if (group.kind !== 'mapping') return;
  for (const { key, value } of group.entries) {
    if (!/^[\x21-\x7e]+$/.test(key.value)) throw new NetplanError(key.location, `Invalid name '${key.value}'`);
    if (/[*[\]?]/.test(key.value)) throw new NetplanError(key.location, `Definition ID '${key.value}' must not use globbing`);
    if (key.value === 'renderer') {
      checkRenderer(value);
      continue;
    }
    expect(value, 'mapping');
    if (ethernet) checkEthernet(key.value, value);
  }
}

function checkDocument(root: YamlNode): void {
  walkMapping(root, new Map([['network', 'mapping']]), (_, network) => {
    walkMapping(network, NETWORK_KEYS, (key, value) => {
      if (key.value === 'version' && value.kind === 'scalar' && Number.parseInt(value.value, 10) !== 2) {
        throw new NetplanError(value.location, 'Only version 2 is supported');
      }
      if (key.value === 'renderer') checkRenderer(value);
      else if (key.value !== 'version' && key.value !== 'openvswitch') checkDefinitions(value, key.value === 'ethernets');
    });
  });
}

function scalarOf(node: YamlNode | undefined): string | undefined {
  return node?.kind === 'scalar' ? node.value : undefined;
}

function scalarsOf(node: YamlNode | undefined): string[] {
  if (node?.kind !== 'sequence') return [];
  return node.items.flatMap((item) => (item.kind === 'scalar' ? [item.value] : item.kind === 'mapping' && item.entries[0] ? [item.entries[0].key.value] : []));
}

function integerOf(node: YamlNode | undefined): number | undefined {
  const text = scalarOf(node);
  return text !== undefined && /^\d+$/.test(text) ? Number.parseInt(text, 10) : undefined;
}

function pairOf(mapping: YamlMapping, key: string): YamlNode | undefined {
  return entryOf(mapping, key)?.value;
}

function declaredInterface(definition: YamlMapping, firstGateway4: string | undefined): DeclaredInterfaceConfig {
  const dhcp4 = scalarOf(pairOf(definition, 'dhcp4'));
  const config: DeclaredInterfaceConfig = { method: dhcp4 !== undefined && TRUE_WORDS.test(dhcp4) ? 'dhcp' : 'static' };
  const addresses = [...new Set(scalarsOf(pairOf(definition, 'addresses')))];
  const ipv4 = addresses.filter((entry) => isIpv4(entry.slice(0, entry.lastIndexOf('/'))));
  const others = addresses.filter((entry) => !ipv4.includes(entry));
  if (ipv4.length > 0) {
    const slash = ipv4[0].lastIndexOf('/');
    config.address = ipv4[0].slice(0, slash);
    config.cidr = Number.parseInt(ipv4[0].slice(slash + 1), 10);
  }
  const secondary = [...ipv4.slice(1), ...others];
  if (secondary.length > 0) config.secondaryAddresses = secondary;
  if (firstGateway4 !== undefined) config.gateway = firstGateway4;
  const routes: DeclaredRoute[] = [];
  const declaredRoutes = pairOf(definition, 'routes');
  for (const route of declaredRoutes?.kind === 'sequence' ? declaredRoutes.items : []) {
    if (route.kind !== 'mapping') continue;
    const to = scalarOf(pairOf(route, 'to'));
    const via = scalarOf(pairOf(route, 'via'));
    const type = (scalarOf(pairOf(route, 'type')) ?? 'unicast').toLowerCase();
    const table = integerOf(pairOf(route, 'table'));
    if (to === undefined || via === undefined || via.includes(':') || type !== 'unicast' || (table !== undefined && table !== 254)) continue;
    if (DEFAULT_DESTINATIONS.has(to)) {
      config.gateway ??= via;
      continue;
    }
    const metric = integerOf(pairOf(route, 'metric'));
    routes.push(metric === undefined ? { to, via } : { to, via, metric });
  }
  if (routes.length > 0) config.routes = routes;
  const nameservers = pairOf(definition, 'nameservers');
  if (nameservers?.kind === 'mapping') {
    const servers = scalarsOf(pairOf(nameservers, 'addresses')).filter((server) => isIpv4(server));
    if (servers.length > 0) config.nameservers = servers;
    const search = scalarsOf(pairOf(nameservers, 'search'));
    if (search.length > 0) config.searchDomains = search;
  }
  const mtu = integerOf(pairOf(definition, 'mtu'));
  if (mtu !== undefined) config.mtu = mtu;
  const macAddress = scalarOf(pairOf(definition, 'macaddress'));
  if (macAddress !== undefined && MACAddress.tryParse(macAddress) !== null) config.macAddress = macAddress;
  const match = pairOf(definition, 'match');
  if (match?.kind === 'mapping') {
    const criteria: NonNullable<DeclaredInterfaceConfig['match']> = {};
    const name = scalarOf(pairOf(match, 'name'));
    const matchedMac = scalarOf(pairOf(match, 'macaddress'));
    if (name !== undefined) criteria.name = name;
    if (matchedMac !== undefined) criteria.macAddress = matchedMac;
    if (pairOf(match, 'driver') !== undefined) criteria.driver = scalarOf(pairOf(match, 'driver')) ?? '';
    config.match = criteria;
  }
  const setName = scalarOf(pairOf(definition, 'set-name'));
  if (setName !== undefined) config.setName = setName;
  return config;
}

function yamlErrorText(path: string, text: string, error: YamlError): string {
  const mark = error.problemMark;
  const line = mark === null ? 0 : mark.line;
  const column = mark === null ? 0 : mark.column;
  const source = text.split('\n')[line] ?? '';
  const reason = source[column] === '\t' ? 'tabs are not allowed for indent' : error.problem;
  return `${path}:${line + 1}:${column + 1}: Invalid YAML: ${reason}:\n${source}\n${' '.repeat(column)}^`;
}

function definitionErrorText(error: NetplanError, texts: ReadonlyMap<string, string>): string {
  const { file, line, column } = error.location;
  const source = (texts.get(file) ?? '').split('\n')[line] ?? '';
  return `${file}:${line + 1}:${column + 1}: Error in network definition: ${error.message}\n${source}\n${' '.repeat(column)}^`;
}

export function readNetplanSources(sources: readonly NetplanSource[]): NetplanReading {
  const empty: NetplanConfig = { renderer: 'networkd', interfaces: new Map(), sources: new Map() };
  const texts = new Map(sources.map((source) => [source.path, source.text]));
  const owners = new Map<string, string>();
  const firstGateway4 = new Map<string, string>();
  let merged: YamlNode | null = null;
  for (const source of sources) {
    const document = loadYaml(source.text, source.path);
    if (document.error !== null) return { config: empty, errors: [yamlErrorText(source.path, source.text, document.error)] };
    if (document.root === null) continue;
    try {
      checkDocument(document.root);
    } catch (error) {
      if (error instanceof NetplanError) return { config: empty, errors: [definitionErrorText(error, texts)] };
      throw error;
    }
    merged = merged === null ? document.root : mergeYaml(merged, document.root);
    const network = document.root.kind === 'mapping' ? pairOf(document.root, 'network') : undefined;
    const ethernets = network?.kind === 'mapping' ? pairOf(network, 'ethernets') : undefined;
    if (ethernets?.kind === 'mapping') {
      for (const { key, value } of ethernets.entries) {
        if (key.value === 'renderer' || value.kind !== 'mapping') continue;
        owners.set(key.value, source.path);
        const gateway4 = scalarOf(pairOf(value, 'gateway4'));
        if (gateway4 !== undefined && !firstGateway4.has(key.value)) firstGateway4.set(key.value, gateway4);
      }
    }
  }
  const network = merged?.kind === 'mapping' ? pairOf(merged, 'network') : undefined;
  const interfaces = new Map<string, DeclaredInterfaceConfig>();
  let renderer: NetplanRenderer = 'networkd';
  if (network?.kind === 'mapping') {
    if (scalarOf(pairOf(network, 'renderer')) === 'NetworkManager') renderer = 'NetworkManager';
    const ethernets = pairOf(network, 'ethernets');
    if (ethernets?.kind === 'mapping') {
      for (const { key, value } of ethernets.entries) {
        if (key.value !== 'renderer' && value.kind === 'mapping') interfaces.set(key.value, declaredInterface(value, firstGateway4.get(key.value)));
      }
    }
  }
  return { config: { renderer, interfaces, sources: owners }, errors: [] };
}
