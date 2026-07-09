/**
 * Parsers/serializers for the two Linux "declared interface config" file
 * formats this simulator supports:
 *
 *   - `/etc/network/interfaces` (Debian/Ubuntu classic ifupdown stanzas)
 *   - `/etc/netplan/*.yaml` (Ubuntu 18.04+ netplan, rendered by networkd
 *     or NetworkManager)
 *
 * Both formats are reduced to the same `DeclaredInterfaceConfig` shape so
 * `LinuxNetworkConfigManager` can apply either one against the same
 * `LinuxNetKernel` primitives. Neither parser attempts to be a general
 * ifupdown/YAML implementation — only the bounded subset of each grammar
 * these files are ever generated with here.
 */

import { SubnetMask } from '../../../core/types';

export type InterfaceMethod = 'static' | 'dhcp';

export interface DeclaredInterfaceConfig {
  method: InterfaceMethod;
  address?: string;
  cidr?: number;
  gateway?: string;
  mtu?: number;
}

export type NetplanRenderer = 'networkd' | 'NetworkManager';

export interface NetplanConfig {
  renderer: NetplanRenderer;
  interfaces: Map<string, DeclaredInterfaceConfig>;
}

// ─── /etc/network/interfaces ────────────────────────────────────────────

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

// ─── /etc/netplan/*.yaml ────────────────────────────────────────────────

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

export function parseNetplanYaml(text: string): NetplanConfig {
  const lines = text.split('\n').filter(l => l.trim() && !l.trim().startsWith('#'));
  let renderer: NetplanRenderer = 'networkd';
  const interfaces = new Map<string, DeclaredInterfaceConfig>();

  const ethernetsIdx = lines.findIndex(l => /^\s*ethernets:\s*$/.test(l));
  const ethernetsIndent = ethernetsIdx >= 0 ? indentOf(lines[ethernetsIdx]) : -1;

  for (const line of lines) {
    const m = /^\s*renderer:\s*(\S+)\s*$/.exec(line);
    if (m && (ethernetsIndent < 0 || indentOf(line) < ethernetsIndent)) {
      renderer = m[1] === 'NetworkManager' ? 'NetworkManager' : 'networkd';
    }
  }

  if (ethernetsIdx < 0) return { renderer, interfaces };

  let currentName: string | null = null;
  let currentIndent = -1;
  let inAddresses = false;

  for (let i = ethernetsIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    const indent = indentOf(line);
    if (indent <= ethernetsIndent) break;

    const ifaceHeader = /^\s*([A-Za-z0-9_.-]+):\s*$/.exec(line);
    if (ifaceHeader && indent === ethernetsIndent + 2) {
      currentName = ifaceHeader[1];
      currentIndent = indent;
      inAddresses = false;
      interfaces.set(currentName, { method: 'dhcp' });
      continue;
    }
    if (!currentName) continue;
    const cfg = interfaces.get(currentName)!;

    if (indent <= currentIndent) { currentName = null; inAddresses = false; continue; }

    const listItem = /^\s*-\s*(.+)\s*$/.exec(line);
    if (inAddresses && listItem) {
      const [addr, cidrStr] = listItem[1].trim().split('/');
      cfg.address = addr;
      if (cidrStr) cfg.cidr = parseInt(cidrStr, 10);
      continue;
    }
    inAddresses = false;

    const kv = /^\s*([A-Za-z0-9_.-]+):\s*(.*)\s*$/.exec(line);
    if (!kv) continue;
    const [, key, rawValue] = kv;
    const value = rawValue.trim();
    if (key === 'dhcp4') {
      cfg.method = /^(yes|true)$/i.test(value) ? 'dhcp' : 'static';
    } else if (key === 'addresses') {
      if (value) {
        const [addr, cidrStr] = value.replace(/^\[|\]$/g, '').split('/');
        cfg.address = addr;
        if (cidrStr) cfg.cidr = parseInt(cidrStr, 10);
      } else {
        inAddresses = true;
      }
    } else if (key === 'gateway4') {
      cfg.gateway = value;
    } else if (key === 'mtu') {
      cfg.mtu = parseInt(value, 10);
    }
  }

  return { renderer, interfaces };
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
