import { SubnetMask } from '../../../core/types';

export type InterfaceMethod = 'static' | 'dhcp';

export interface DeclaredRoute {
  to: string;
  via: string;
  metric?: number;
}

export interface DeclaredInterfaceConfig {
  method: InterfaceMethod;
  address?: string;
  cidr?: number;
  gateway?: string;
  mtu?: number;
  secondaryAddresses?: string[];
  routes?: DeclaredRoute[];
  nameservers?: string[];
  searchDomains?: string[];
  macAddress?: string;
  match?: { name?: string; macAddress?: string; driver?: string };
  setName?: string;
}

export type NetplanRenderer = 'networkd' | 'NetworkManager';

export interface NetplanConfig {
  renderer: NetplanRenderer;
  interfaces: Map<string, DeclaredInterfaceConfig>;
  sources?: ReadonlyMap<string, string>;
}

export interface NetplanSource {
  readonly path: string;
  readonly text: string;
}

export interface NetplanReading {
  readonly config: NetplanConfig;
  readonly errors: readonly string[];
}

export function parseInterfacesFile(text: string): Map<string, DeclaredInterfaceConfig> {
  const result = new Map<string, DeclaredInterfaceConfig>();
  const lines = text.split('\n');
  let current: string | null = null;
  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, '').trimEnd();
    if (!line.trim()) { continue; }
    const ifaceMatch = /^iface\s+(\S+)\s+inet\s+(static|dhcp|loopback)/.exec(line.trim());
    if (ifaceMatch) {
      const [, name, method] = ifaceMatch;
      if (method === 'loopback') { current = null; continue; }
      current = name;
      result.set(name, { method: method as InterfaceMethod });
      continue;
    }
    if (/^(auto|allow-hotplug|source|iface)\s/.test(line.trim())) { current = null; continue; }
    if (!current) continue;
    const kv = /^\s+(\S+)\s+(.+)$/.exec(rawLine);
    if (!kv) continue;
    const [, key, value] = kv;
    const cfg = result.get(current)!;
    if (key === 'address') cfg.address = value.trim();
    else if (key === 'netmask') cfg.cidr = new SubnetMask(value.trim()).toCIDR();
    else if (key === 'gateway') cfg.gateway = value.trim();
    else if (key === 'mtu') cfg.mtu = parseInt(value.trim(), 10);
  }
  return result;
}

export function serializeInterfacesFile(configs: ReadonlyMap<string, DeclaredInterfaceConfig>): string {
  const lines = [
    '# This file describes the network interfaces available on your system',
    '# and how to activate them. For more information, see interfaces(5).',
    '',
    'source /etc/network/interfaces.d/*',
    '',
    'auto lo',
    'iface lo inet loopback',
    '',
  ];
  for (const [name, cfg] of configs) {
    lines.push(`auto ${name}`);
    lines.push(`iface ${name} inet ${cfg.method}`);
    if (cfg.method === 'static') {
      if (cfg.address) lines.push(`    address ${cfg.address}`);
      if (cfg.cidr !== undefined) lines.push(`    netmask ${SubnetMask.fromCIDR(cfg.cidr).toString()}`);
      if (cfg.gateway) lines.push(`    gateway ${cfg.gateway}`);
      if (cfg.mtu !== undefined) lines.push(`    mtu ${cfg.mtu}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export function serializeNetplanYaml(cfg: NetplanConfig): string {
  const lines = [
    'network:',
    '  version: 2',
    `  renderer: ${cfg.renderer}`,
    '  ethernets:',
  ];
  for (const [name, iface] of cfg.interfaces) {
    lines.push(`    ${name}:`);
    if (iface.method === 'dhcp') {
      lines.push('      dhcp4: true');
    } else {
      lines.push('      dhcp4: false');
      if (iface.address) {
        lines.push('      addresses:');
        lines.push(`        - ${iface.address}/${iface.cidr ?? 24}`);
      }
      if (iface.gateway) lines.push(`      gateway4: ${iface.gateway}`);
      if (iface.mtu !== undefined) lines.push(`      mtu: ${iface.mtu}`);
    }
  }
  return lines.join('\n') + '\n';
}
