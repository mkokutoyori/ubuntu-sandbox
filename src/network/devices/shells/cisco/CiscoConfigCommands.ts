/**
 * CiscoConfigCommands - Extracted config mode command registration for Cisco IOS CLI
 *
 * Registers commands on CommandTrie instances for:
 *   - Global config mode (config)#
 *   - Interface config mode (config-if)#
 *
 * Uses CiscoShellContext to interact with shell state (mode, selected interface, etc.)
 */

import { IPAddress, SubnetMask, IPv6Address } from '../../../core/types';
import type { Router } from '../../Router';
import { CommandTrie } from '../CommandTrie';

// ─── Shell Context Interface ─────────────────────────────────────────

export type CiscoShellMode = 'user' | 'privileged' | 'config' | 'config-if' | 'config-dhcp' | 'config-router' | 'config-router-ospf' | 'config-router-ospfv3' | 'config-std-nacl' | 'config-ext-nacl';

export interface CiscoShellContext {
  /** Get the current router reference (set during execute) */
  r(): Router;
  /** Change CLI mode */
  setMode(mode: CiscoShellMode): void;
  /** Get currently selected interface name */
  getSelectedInterface(): string | null;
  /** Set currently selected interface name */
  setSelectedInterface(iface: string | null): void;
  /** Get currently selected DHCP pool name */
  getSelectedDHCPPool(): string | null;
  /** Set currently selected DHCP pool name */
  setSelectedDHCPPool(pool: string | null): void;
  /** Resolve interface name abbreviation to full name */
  resolveInterfaceName(input: string): string | null;
}

// ─── Global Config Mode Commands ─────────────────────────────────────

export function buildConfigCommands(trie: CommandTrie, ctx: CiscoShellContext): void {
  trie.registerGreedy('hostname', 'Set system hostname', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    ctx.r()._setHostnameInternal(args[0]);
    return '';
  });

  trie.register('service dhcp', 'Enable DHCP service', () => {
    ctx.r()._getDHCPServerInternal().enable();
    return '';
  });
  trie.register('no service dhcp', 'Disable DHCP service', () => {
    ctx.r()._getDHCPServerInternal().disable();
    return '';
  });

  trie.registerGreedy('interface', 'Select an interface to configure', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    const raw = args.join(' ');
    let ifName = ctx.resolveInterfaceName(raw);
    if (!ifName) {
      // Try creating virtual interface (Loopback, Tunnel, Serial subinterface)
      const combined = raw.replace(/\s+/g, '');
      const vMatch = combined.match(/^(loopback|tunnel|serial)([\d/.]+)$/i);
      if (vMatch) {
        const typeMap: Record<string, string> = { 'loopback': 'Loopback', 'tunnel': 'Tunnel', 'serial': 'Serial' };
        const fullName = `${typeMap[vMatch[1].toLowerCase()]}${vMatch[2]}`;
        ctx.r()._createVirtualInterface(fullName);
        ifName = fullName;
      }
      if (!ifName) return `% Invalid interface "${raw}"`;
    }
    ctx.setSelectedInterface(ifName);
    ctx.setMode('config-if');
    return '';
  });

  trie.registerGreedy('ip dhcp pool', 'Define a DHCP address pool', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    const poolName = args[0];
    const dhcp = ctx.r()._getDHCPServerInternal();
    if (!dhcp.getPool(poolName)) {
      dhcp.createPool(poolName);
    }
    ctx.setSelectedDHCPPool(poolName);
    ctx.setMode('config-dhcp');
    return '';
  });

  trie.registerGreedy('ip dhcp excluded-address', 'Prevent DHCP from assigning certain addresses', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    const start = args[0];
    const end = args[1] || start;
    ctx.r()._getDHCPServerInternal().addExcludedRange(start, end);
    return '';
  });

  trie.registerGreedy('ip route', 'Establish static routes', (args) => {
    return cmdIpRoute(ctx.r(), args);
  });

  trie.register('router rip', 'Enter RIP routing protocol configuration', () => {
    if (!ctx.r().isRIPEnabled()) ctx.r().enableRIP();
    ctx.setMode('config-router');
    return '';
  });

  trie.register('no router rip', 'Disable RIP routing protocol', () => {
    ctx.r().disableRIP();
    return '';
  });

  trie.register('no shutdown', 'Enable (no-op in global config)', () => '');

  // IPv6 static routes
  trie.registerGreedy('ipv6 route', 'Configure IPv6 static route', (args) => {
    if (args.length < 2) return '% Incomplete command.';
    // ipv6 route <prefix>/<len> <next-hop>
    const prefixStr = args[0];
    const nextHopStr = args[1];
    const slashIdx = prefixStr.indexOf('/');
    if (slashIdx === -1) return '% Invalid prefix format';
    const prefix = prefixStr.substring(0, slashIdx);
    const prefixLen = parseInt(prefixStr.substring(slashIdx + 1), 10);
    if (isNaN(prefixLen)) return '% Invalid prefix length';
    try {
      const prefixAddr = new IPv6Address(prefix);
      const nextHop = new IPv6Address(nextHopStr);
      ctx.r().addIPv6StaticRoute(prefixAddr, prefixLen, nextHop);
    } catch (e: any) {
      // Store as unresolved static route for later redistribution
      (ctx.r() as any)._ipv6StaticRoutes = (ctx.r() as any)._ipv6StaticRoutes || [];
      (ctx.r() as any)._ipv6StaticRoutes.push({ prefix: prefixStr, nextHop: nextHopStr });
    }
    return '';
  });
}

// ─── Interface Config Mode Commands ──────────────────────────────────

export function buildConfigIfCommands(trie: CommandTrie, ctx: CiscoShellContext): void {
  trie.registerGreedy('ip address', 'Set interface IP address', (args) => {
    if (args.length < 2) return '% Incomplete command.';
    if (!ctx.getSelectedInterface()) return '% No interface selected';
    try {
      ctx.r().configureInterface(ctx.getSelectedInterface()!, new IPAddress(args[0]), new SubnetMask(args[1]));
      return '';
    } catch (e: any) {
      return `% Invalid input: ${e.message}`;
    }
  });

  trie.register('no shutdown', 'Enable interface', () => {
    if (!ctx.getSelectedInterface()) return '% No interface selected';
    const port = ctx.r().getPort(ctx.getSelectedInterface()!);
    if (port) port.setUp(true);
    return '';
  });

  trie.register('shutdown', 'Disable interface', () => {
    if (!ctx.getSelectedInterface()) return '% No interface selected';
    const port = ctx.r().getPort(ctx.getSelectedInterface()!);
    if (port) port.setUp(false);
    return '';
  });

  trie.registerGreedy('ip helper-address', 'Set DHCP relay agent address', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    if (!ctx.getSelectedInterface()) return '% No interface selected';
    ctx.r()._getDHCPServerInternal().addHelperAddress(ctx.getSelectedInterface()!, args[0]);
    return '';
  });

  trie.registerGreedy('ip forward-protocol udp', 'Forward UDP port', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    const service = args[0];
    const portNum = service === 'bootps' ? 67 : service === 'bootpc' ? 68 : parseInt(service, 10);
    if (!isNaN(portNum)) {
      ctx.r()._getDHCPServerInternal().addForwardProtocol(portNum);
    }
    return '';
  });

  // IPv6 address configuration
  trie.registerGreedy('ipv6 address', 'Configure IPv6 address', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    if (!ctx.getSelectedInterface()) return '% No interface selected';
    const addrStr = args[0];
    // Handle eui-64 suffix
    const isEUI64 = args.length > 1 && args[1].toLowerCase() === 'eui-64';
    // Parse address/prefix
    const slashIdx = addrStr.indexOf('/');
    if (slashIdx === -1) return '% Invalid IPv6 address format (expected addr/prefix)';
    const addr = addrStr.substring(0, slashIdx);
    const prefixLen = parseInt(addrStr.substring(slashIdx + 1), 10);
    if (isNaN(prefixLen)) return '% Invalid prefix length';
    try {
      const ipv6Addr = new IPv6Address(addr);
      ctx.r().configureIPv6Interface(ctx.getSelectedInterface()!, ipv6Addr, prefixLen);
      return '';
    } catch (e: any) {
      return `% Invalid input: ${e.message}`;
    }
  });
}

// ─── IP Route Command (config mode) ─────────────────────────────────

export function cmdIpRoute(router: Router, args: string[]): string {
  if (args.length < 3) return '% Incomplete command.';
  try {
    const network = new IPAddress(args[0]);
    const mask = new SubnetMask(args[1]);
    const nextHop = new IPAddress(args[2]);

    if (args[0] === '0.0.0.0' && args[1] === '0.0.0.0') {
      return router.setDefaultRoute(nextHop) ? '' : '% Next-hop is not reachable';
    }
    return router.addStaticRoute(network, mask, nextHop) ? '' : '% Next-hop is not reachable';
  } catch (e: any) {
    return `% Invalid input: ${e.message}`;
  }
}

// ─── Interface Name Resolution ───────────────────────────────────────

export function resolveInterfaceName(router: Router, input: string): string | null {
  const combined = input.replace(/\s+/g, '');
  const lower = combined.toLowerCase();

  // Direct match
  for (const name of router.getPortNames()) {
    if (name.toLowerCase() === lower || name === input.trim()) return name;
  }

  // Abbreviation expansion
  const prefixMap: Record<string, string> = {
    'g': 'GigabitEthernet',
    'gi': 'GigabitEthernet',
    'gig': 'GigabitEthernet',
    'giga': 'GigabitEthernet',
    'gigabit': 'GigabitEthernet',
    'gigabitethernet': 'GigabitEthernet',
    'fa': 'FastEthernet',
    'fast': 'FastEthernet',
    'fastethernet': 'FastEthernet',
    'se': 'Serial',
    'serial': 'Serial',
    'lo': 'Loopback',
    'loopback': 'Loopback',
    'tu': 'Tunnel',
    'tunnel': 'Tunnel',
    'ge': 'GE',
  };

  const match = lower.match(/^([a-z]+)([\d/.-]+)$/);
  if (!match) return null;

  const [, prefix, numbers] = match;
  const fullPrefix = prefixMap[prefix];
  if (!fullPrefix) return null;

  const resolved = `${fullPrefix}${numbers}`;
  for (const name of router.getPortNames()) {
    if (name === resolved) return name;
  }

  return null;
}

// ─── Classful Mask (for RIP) ────────────────────────────────────────

export function classfulMask(ip: IPAddress): SubnetMask {
  const firstOctet = ip.getOctets()[0];
  if (firstOctet < 128) return new SubnetMask('255.0.0.0');
  if (firstOctet < 192) return new SubnetMask('255.255.0.0');
  return new SubnetMask('255.255.255.0');
}
