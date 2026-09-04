import { IPAddress } from '@/network/core/types';
import { matchEnumValue } from './netIpAddress';

export type NetFirewallAction = 'NotConfigured' | 'Allow' | 'Block';
export type NetFirewallDirection = 'Inbound' | 'Outbound';
export type NetFirewallProfile = 'Any' | 'Domain' | 'Private' | 'Public' | 'NotApplicable';

export const NET_FIREWALL_ACTIONS: readonly NetFirewallAction[] = ['NotConfigured', 'Allow', 'Block'];
export const NET_FIREWALL_DIRECTIONS: readonly NetFirewallDirection[] = ['Inbound', 'Outbound'];
export const NET_FIREWALL_PROFILES: readonly NetFirewallProfile[] =
  ['Any', 'Domain', 'Private', 'Public', 'NotApplicable'];
export const NET_FIREWALL_ENABLED: readonly string[] = ['True', 'False'];

export const FIREWALL_PROTOCOL_NUMBERS: Readonly<Record<string, number>> = {
  ICMPv4: 1, IGMP: 2, TCP: 6, UDP: 17, IPv6: 41, IPv6Route: 43, IPv6Frag: 44,
  GRE: 47, ICMPv6: 58, IPv6NoNxt: 59, IPv6Opts: 60, VRRP: 112, PGM: 113, L2TP: 115,
};

export const ANY = 'Any';
export const MAX_PORT = 65535;

export function parseFirewallProtocol(raw: string): string | null {
  const token = raw.trim();
  if (token === '') return null;
  if (token.toLowerCase() === ANY.toLowerCase()) return ANY;
  const named = Object.keys(FIREWALL_PROTOCOL_NUMBERS)
    .find(k => k.toLowerCase() === token.toLowerCase());
  if (named) return named;
  if (!/^\d+$/.test(token)) return null;
  const value = parseInt(token, 10);
  if (value > 255) return null;
  const canonical = Object.entries(FIREWALL_PROTOCOL_NUMBERS).find(([, n]) => n === value);
  return canonical ? canonical[0] : String(value);
}

export function protocolNumberOf(protocol: string): number | null {
  if (protocol === ANY) return null;
  const named = FIREWALL_PROTOCOL_NUMBERS[protocol];
  if (named !== undefined) return named;
  return /^\d+$/.test(protocol) ? parseInt(protocol, 10) : null;
}

export function parsePortSpec(raw: string | readonly string[]): string | null {
  const tokens = (Array.isArray(raw) ? raw : [String(raw)])
    .flatMap(part => String(part).split(','))
    .map(part => part.trim())
    .filter(part => part !== '');
  if (tokens.length === 0) return null;
  if (tokens.length === 1 && tokens[0].toLowerCase() === ANY.toLowerCase()) return ANY;
  const kept: string[] = [];
  for (const token of tokens) {
    const range = /^(\d+)-(\d+)$/.exec(token);
    if (range) {
      const low = parseInt(range[1], 10);
      const high = parseInt(range[2], 10);
      if (low > MAX_PORT || high > MAX_PORT || low > high) return null;
      kept.push(`${low}-${high}`);
      continue;
    }
    if (!/^\d+$/.test(token)) return null;
    const value = parseInt(token, 10);
    if (value > MAX_PORT) return null;
    kept.push(String(value));
  }
  return kept.join(',');
}

export function portSpecMatches(spec: string, port: number): boolean {
  if (spec === '' || spec === ANY) return true;
  return spec.split(',').some(part => {
    const range = /^(\d+)-(\d+)$/.exec(part);
    if (range) return port >= parseInt(range[1], 10) && port <= parseInt(range[2], 10);
    return parseInt(part, 10) === port;
  });
}

export function parseAddressSpec(raw: string | readonly string[]): string | null {
  const tokens = (Array.isArray(raw) ? raw : [String(raw)])
    .flatMap(part => String(part).split(','))
    .map(part => part.trim())
    .filter(part => part !== '');
  if (tokens.length === 0) return null;
  if (tokens.length === 1 && tokens[0].toLowerCase() === ANY.toLowerCase()) return ANY;
  const kept: string[] = [];
  for (const token of tokens) {
    const slash = token.indexOf('/');
    const network = slash === -1 ? token : token.slice(0, slash);
    const value = IPAddress.tryParse(network);
    if (value === null) return null;
    if (slash === -1) { kept.push(value.toString()); continue; }
    const lengthText = token.slice(slash + 1);
    if (!/^\d+$/.test(lengthText)) return null;
    const prefixLength = parseInt(lengthText, 10);
    if (prefixLength > 32) return null;
    kept.push(`${value.toString()}/${prefixLength}`);
  }
  return kept.join(',');
}

export function addressSpecMatches(spec: string, address: IPAddress): boolean {
  if (spec === '' || spec === ANY) return true;
  const target = address.toUint32() >>> 0;
  return spec.split(',').some(part => {
    const slash = part.indexOf('/');
    if (slash === -1) return part === address.toString();
    const network = IPAddress.tryParse(part.slice(0, slash));
    if (network === null) return false;
    const prefixLength = parseInt(part.slice(slash + 1), 10);
    if (prefixLength === 0) return true;
    const mask = (0xffffffff << (32 - prefixLength)) >>> 0;
    return ((network.toUint32() >>> 0) & mask) === (target & mask);
  });
}

export interface NetFirewallRuleEntry {
  name: string;
  displayName: string;
  description: string;
  group: string;
  enabled: boolean;
  action: NetFirewallAction;
  direction: NetFirewallDirection;
  profile: NetFirewallProfile;
  protocol: string;
  localPort: string;
  remotePort: string;
  localAddress: string;
  remoteAddress: string;
  builtIn: boolean;
}

export interface NetFirewallRuleRequest {
  name?: string;
  displayName?: string;
  description?: string;
  group?: string;
  enabled?: string;
  action?: string;
  direction?: string;
  profile?: string;
  protocol?: string;
  localPort?: string | readonly string[];
  remotePort?: string | readonly string[];
  localAddress?: string | readonly string[];
  remoteAddress?: string | readonly string[];
}

export type NetFirewallDecision =
  | { ok: true; rule: NetFirewallRuleEntry; message?: undefined }
  | { ok: false; rule?: undefined; message: string };

function refuseEnum(parameter: string, values: readonly string[]): string {
  return `Cannot validate argument on parameter '${parameter}'. The argument does not belong to the set "${values.join(',')}".`;
}

export function planNetFirewallRule(
  request: NetFirewallRuleRequest, nameFor: () => string,
): NetFirewallDecision {
  const refuse = (message: string): NetFirewallDecision => ({ ok: false, message });
  const displayName = (request.displayName ?? '').trim();
  if (displayName === '') {
    return refuse('Cannot process command because of one or more missing mandatory parameters: DisplayName.');
  }

  const action = request.action === undefined ? 'Allow' : matchEnumValue(NET_FIREWALL_ACTIONS, request.action);
  if (action === null) return refuse(refuseEnum('Action', NET_FIREWALL_ACTIONS));
  const direction = request.direction === undefined ? 'Inbound'
    : matchEnumValue(NET_FIREWALL_DIRECTIONS, request.direction);
  if (direction === null) return refuse(refuseEnum('Direction', NET_FIREWALL_DIRECTIONS));
  const profile = request.profile === undefined ? ANY : matchEnumValue(NET_FIREWALL_PROFILES, request.profile);
  if (profile === null) return refuse(refuseEnum('Profile', NET_FIREWALL_PROFILES));
  const enabledWord = request.enabled === undefined ? 'True' : matchEnumValue(NET_FIREWALL_ENABLED, request.enabled);
  if (enabledWord === null) return refuse(refuseEnum('Enabled', NET_FIREWALL_ENABLED));

  const protocol = request.protocol === undefined ? ANY : parseFirewallProtocol(request.protocol);
  if (protocol === null) {
    return refuse(`Cannot validate argument on parameter 'Protocol'. The argument "${request.protocol}" is not a valid protocol.`);
  }
  const ports: Record<'localPort' | 'remotePort', string> = { localPort: ANY, remotePort: ANY };
  for (const key of ['localPort', 'remotePort'] as const) {
    const given = request[key];
    if (given === undefined) continue;
    const parsed = parsePortSpec(given);
    if (parsed === null) {
      const label = key === 'localPort' ? 'LocalPort' : 'RemotePort';
      return refuse(`Cannot validate argument on parameter '${label}'. The argument "${String(given)}" is not a valid port.`);
    }
    ports[key] = parsed;
  }
  const addresses: Record<'localAddress' | 'remoteAddress', string> = { localAddress: ANY, remoteAddress: ANY };
  for (const key of ['localAddress', 'remoteAddress'] as const) {
    const given = request[key];
    if (given === undefined) continue;
    const parsed = parseAddressSpec(given);
    if (parsed === null) {
      const label = key === 'localAddress' ? 'LocalAddress' : 'RemoteAddress';
      return refuse(`Cannot validate argument on parameter '${label}'. The argument "${String(given)}" is not a valid address.`);
    }
    addresses[key] = parsed;
  }

  const name = (request.name ?? '').trim();
  return {
    ok: true,
    rule: {
      name: name === '' ? nameFor() : name,
      displayName,
      description: request.description ?? '',
      group: request.group ?? '',
      enabled: enabledWord === 'True',
      action,
      direction,
      profile,
      protocol,
      localPort: ports.localPort,
      remotePort: ports.remotePort,
      localAddress: addresses.localAddress,
      remoteAddress: addresses.remoteAddress,
      builtIn: false,
    },
  };
}

export interface NetFirewallSelection {
  name?: string[];
  displayName?: string[];
  description?: string[];
  group?: string[];
  enabled?: string[];
  action?: string[];
  direction?: string[];
}

export function selectFirewallRules<T extends NetFirewallRuleEntry>(
  rules: readonly T[], selection: NetFirewallSelection,
): T[] {
  const criteria: Array<[string[] | undefined, (rule: T) => string]> = [
    [selection.name, r => r.name],
    [selection.displayName, r => r.displayName],
    [selection.description, r => r.description],
    [selection.group, r => r.group],
    [selection.enabled, r => (r.enabled ? 'True' : 'False')],
    [selection.action, r => r.action],
    [selection.direction, r => r.direction],
  ];
  let kept = [...rules];
  for (const [values, of] of criteria) {
    if (values === undefined) continue;
    const wanted = values.map(v => v.trim().toLowerCase());
    kept = kept.filter(r => wanted.includes(of(r).toLowerCase()));
  }
  return kept;
}

export function noMatchingFirewallRule(selection: NetFirewallSelection): string {
  const named = selection.name?.[0] ?? selection.displayName?.[0];
  const property = selection.name?.[0] !== undefined ? 'Name' : 'DisplayName';
  return named === undefined
    ? 'No MSFT_NetFirewallRule objects found with the specified criteria. Verify the values and retry.'
    : `No MSFT_NetFirewallRule objects found with property '${property}' equal to '${named}'. Verify the value of the property and retry.`;
}

export interface FirewallPacketFacts {
  direction: NetFirewallDirection;
  protocolNumber: number;
  localAddress: IPAddress;
  remoteAddress: IPAddress;
  localPort: number;
  remotePort: number;
  profile: NetFirewallProfile;
}

export function firewallRuleMatches(rule: NetFirewallRuleEntry, packet: FirewallPacketFacts): boolean {
  if (!rule.enabled) return false;
  if (rule.direction !== packet.direction) return false;
  const wanted = protocolNumberOf(rule.protocol);
  if (wanted !== null && wanted !== packet.protocolNumber) return false;
  if (rule.profile !== ANY && rule.profile !== packet.profile) return false;
  if (!addressSpecMatches(rule.localAddress, packet.localAddress)) return false;
  if (!addressSpecMatches(rule.remoteAddress, packet.remoteAddress)) return false;
  if (!portSpecMatches(rule.localPort, packet.localPort)) return false;
  if (!portSpecMatches(rule.remotePort, packet.remotePort)) return false;
  return true;
}

export const BUILT_IN_FIREWALL_RULES: readonly NetFirewallRuleEntry[] = [
  {
    name: 'CoreNet-DHCP-In', displayName: 'Core Networking - Dynamic Host Configuration Protocol (DHCP-In)',
    description: 'Allow DHCP traffic for stateful auto-configuration.', group: 'Core Networking',
    enabled: true, action: 'Allow', direction: 'Inbound', profile: ANY,
    protocol: 'UDP', localPort: '68', remotePort: '67',
    localAddress: ANY, remoteAddress: ANY, builtIn: true,
  },
  {
    name: 'CoreNet-DHCP-Out', displayName: 'Core Networking - Dynamic Host Configuration Protocol (DHCP-Out)',
    description: 'Allow DHCP traffic for stateful auto-configuration.', group: 'Core Networking',
    enabled: true, action: 'Allow', direction: 'Outbound', profile: ANY,
    protocol: 'UDP', localPort: '68', remotePort: '67',
    localAddress: ANY, remoteAddress: ANY, builtIn: true,
  },
  {
    name: 'CoreNet-DNS-Out', displayName: 'Core Networking - DNS (UDP-Out)',
    description: 'Outbound rule to allow DNS requests.', group: 'Core Networking',
    enabled: true, action: 'Allow', direction: 'Outbound', profile: ANY,
    protocol: 'UDP', localPort: ANY, remotePort: '53',
    localAddress: ANY, remoteAddress: ANY, builtIn: true,
  },
  {
    name: 'FPS-ICMP4-ERQ-In', displayName: 'File and Printer Sharing (Echo Request - ICMPv4-In)',
    description: 'Echo Request messages are sent as ping requests to other nodes.',
    group: 'File and Printer Sharing',
    enabled: true, action: 'Allow', direction: 'Inbound', profile: ANY,
    protocol: 'ICMPv4', localPort: ANY, remotePort: ANY,
    localAddress: ANY, remoteAddress: ANY, builtIn: true,
  },
  {
    name: 'RemoteDesktop-UserMode-In-TCP', displayName: 'Remote Desktop - User Mode (TCP-In)',
    description: 'Inbound rule for the Remote Desktop service to allow RDP traffic.',
    group: 'Remote Desktop',
    enabled: false, action: 'Allow', direction: 'Inbound', profile: ANY,
    protocol: 'TCP', localPort: '3389', remotePort: ANY,
    localAddress: ANY, remoteAddress: ANY, builtIn: true,
  },
  {
    name: 'WINRM-HTTP-In-TCP', displayName: 'Windows Remote Management (HTTP-In)',
    description: 'Inbound rule for Windows Remote Management via WS-Management.',
    group: 'Windows Remote Management',
    enabled: false, action: 'Allow', direction: 'Inbound', profile: ANY,
    protocol: 'TCP', localPort: '5985', remotePort: ANY,
    localAddress: ANY, remoteAddress: ANY, builtIn: true,
  },
];

export function firewallRuleKey(name: string): string {
  return name.trim().toLowerCase();
}

export function seedBuiltInFirewallRules(store: Map<string, NetFirewallRuleEntry>): void {
  for (const rule of BUILT_IN_FIREWALL_RULES) store.set(firewallRuleKey(rule.name), { ...rule });
}

export function generatedFirewallRuleName(ordinal: number): string {
  const hex = (ordinal + 1).toString(16).padStart(12, '0');
  return `{00000000-0000-0000-0000-${hex}}`;
}
