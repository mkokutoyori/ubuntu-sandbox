/**
 * CiscoSharedCommands — Commands shared between CiscoIOSShell (Router) and
 * CiscoSwitchShell (Switch).
 *
 * Eliminates DRY violations where identical commands are registered
 * independently in both shell classes.
 *
 * Shared commands:
 *   - enable (user → privileged)
 *   - configure terminal (privileged → config)
 *   - disable (privileged → user)
 *   - write memory / copy running-config startup-config
 *   - hostname (config)
 */

import type { CommandTrie } from '../CommandTrie';

// ─── User Mode Shared Commands ───────────────────────────────────

/**
 * Register common user-mode commands on a trie.
 */
export function registerSharedUserCommands(
  trie: CommandTrie,
  setMode: (mode: string) => void,
): void {
  trie.register('enable', 'Enter privileged EXEC mode', () => {
    setMode('privileged');
    return '';
  });
}

// ─── Privileged Mode Shared Commands ─────────────────────────────

export interface PrivilegedCommandsOptions {
  setMode: (mode: string) => void;
  onSave?: () => string;
}

/**
 * Register common privileged-mode commands on a trie.
 */
export function registerSharedPrivilegedCommands(
  trie: CommandTrie,
  opts: PrivilegedCommandsOptions,
): void {
  trie.register('enable', 'Enter privileged EXEC mode (already in)', () => '');

  trie.register('configure terminal', 'Enter configuration mode', () => {
    opts.setMode('config');
    return 'Enter configuration commands, one per line.  End with CNTL/Z.';
  });

  trie.register('disable', 'Return to user EXEC mode', () => {
    opts.setMode('user');
    return '';
  });

  const saveHandler = opts.onSave ?? (() => 'Building configuration...\n[OK]');

  trie.register('copy running-config startup-config', 'Save configuration', () => {
    return saveHandler();
  });

  trie.register('write memory', 'Save configuration', () => {
    return saveHandler();
  });

  trie.registerSuggestions('copy', [
    { keyword: 'running-config', description: 'Current running configuration' },
    { keyword: 'startup-config', description: 'Saved startup configuration' },
    { keyword: 'tftp:',          description: 'Trivial File Transfer Protocol' },
    { keyword: 'flash:',         description: 'Local flash filesystem' },
    { keyword: 'scp:',           description: 'Secure Copy' },
  ]);
  trie.registerSuggestions('copy running-config', [
    { keyword: 'startup-config', description: 'Save to NVRAM startup-config' },
    { keyword: 'tftp:',          description: 'Upload to TFTP server' },
    { keyword: 'scp:',           description: 'Upload over SCP' },
    { keyword: 'flash:',         description: 'Save to flash filesystem' },
  ]);
  trie.registerSuggestions('write', [
    { keyword: 'memory',   description: 'Write to NVRAM' },
    { keyword: 'terminal', description: 'Write to terminal (display running-config)' },
    { keyword: 'erase',    description: 'Erase NVRAM' },
  ]);
  trie.registerSuggestions('clear', [
    { keyword: 'arp-cache', description: 'Clear ARP cache' },
    { keyword: 'counters',  description: 'Clear interface counters' },
    { keyword: 'ip',        description: 'Clear an IP subsystem' },
    { keyword: 'mac',       description: 'Clear MAC address tables' },
    { keyword: 'access-list', description: 'Clear access-list counters' },
    { keyword: 'logging',   description: 'Clear logging buffer' },
  ]);
  trie.registerSuggestions('debug', [
    { keyword: 'all',      description: 'Enable all debugging' },
    { keyword: 'ip',       description: 'Debug IP subsystem' },
    { keyword: 'ipv6',     description: 'Debug IPv6 subsystem' },
    { keyword: 'arp',      description: 'Debug ARP' },
    { keyword: 'crypto',   description: 'Debug crypto subsystem' },
    { keyword: 'dhcp',     description: 'Debug DHCP' },
    { keyword: 'ospf',     description: 'Debug OSPF' },
  ]);
  trie.registerSuggestions('debug ip', [
    { keyword: 'icmp',     description: 'Debug ICMP packets' },
    { keyword: 'packet',   description: 'Debug all IP packets' },
    { keyword: 'ospf',     description: 'Debug OSPF' },
    { keyword: 'routing',  description: 'Debug routing table changes' },
    { keyword: 'nat',      description: 'Debug NAT' },
    { keyword: 'dhcp',     description: 'Debug DHCP' },
  ]);
  trie.registerSuggestions('show ip route', [
    { keyword: 'static',    description: 'Static routes' },
    { keyword: 'connected', description: 'Directly connected networks' },
    { keyword: 'ospf',      description: 'OSPF-learned routes' },
    { keyword: 'rip',       description: 'RIP-learned routes' },
    { keyword: 'eigrp',     description: 'EIGRP-learned routes' },
    { keyword: 'bgp',       description: 'BGP-learned routes' },
  ]);
}

// ─── Config Mode Shared Commands ─────────────────────────────────

export interface ConfigCommandsOptions {
  setHostname: (name: string) => void;
  selectInterface: (portName: string) => void;
  resolveInterfaceName: (input: string) => string | null;
  getPort: (name: string) => unknown | undefined;
}

/**
 * Register common config-mode commands on a trie.
 * Specific commands (VLANs, routing, etc.) are registered by each shell.
 */
export function registerSharedConfigCommands(
  trie: CommandTrie,
  opts: ConfigCommandsOptions,
): void {
  trie.registerGreedy('hostname', 'Set system hostname', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    opts.setHostname(args[0]);
    return '';
  });
}
