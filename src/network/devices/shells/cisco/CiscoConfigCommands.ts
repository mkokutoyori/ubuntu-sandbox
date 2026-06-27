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
import { isValidIPv4, isValidSubnetMask } from '../../../core/ip';
import type { Router } from '../../Router';
import { CommandTrie } from '../CommandTrie';
import { resolveCiscoInterfaceName } from '../cli-utils';

// ─── Shell Context Interface ─────────────────────────────────────────

export type CiscoShellMode =
  | 'user' | 'privileged' | 'config' | 'config-if'
  | 'config-dhcp' | 'config-router' | 'config-router-ospf' | 'config-router-ospfv3'
  | 'config-track' | 'config-ipsla' | 'config-route-map' | 'config-line'
  | 'config-std-nacl' | 'config-ext-nacl' | 'config-ipv6-nacl'
  | 'config-dhcp-pool-class'
  // IPSec modes
  | 'config-isakmp' | 'config-isakmp-profile' | 'config-tfset' | 'config-crypto-map'
  | 'config-ipsec-profile'
  | 'config-ikev2-proposal' | 'config-ikev2-policy'
  | 'config-ikev2-keyring' | 'config-ikev2-keyring-peer' | 'config-ikev2-profile'
  | 'config-time-range' | 'config-cmap' | 'config-pmap' | 'config-pmap-c'
  | 'config-cp' | 'config-zone' | 'config-zone-pair'
  | 'config-radius-server' | 'config-tacacs-server' | 'config-aaa-group'
  | 'config-ca-trustpoint'
  | 'config-applet' | 'config-flow-exporter' | 'config-flow-record' | 'config-flow-monitor'
  | 'config-archive' | 'config-archive-log';

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
  /** Routing process currently being configured (config-router) */
  getSelectedRoutingProto(): { proto: 'rip' | 'eigrp' | 'bgp'; asn?: number } | null;
  setSelectedRoutingProto(v: { proto: 'rip' | 'eigrp' | 'bgp'; asn?: number } | null): void;
  /** Resolve interface name abbreviation to full name */
  resolveInterfaceName(input: string): string | null;
  // IPSec context
  getSelectedISAKMPPriority(): number | null;
  setSelectedISAKMPPriority(p: number | null): void;
  getSelectedISAKMPProfile(): string | null;
  setSelectedISAKMPProfile(p: string | null): void;
  getSelectedTransformSet(): string | null;
  setSelectedTransformSet(ts: string | null): void;
  getSelectedCryptoMap(): string | null;
  setSelectedCryptoMap(m: string | null): void;
  getSelectedCryptoMapSeq(): number | null;
  setSelectedCryptoMapSeq(seq: number | null): void;
  getSelectedCryptoMapIsDynamic(): boolean;
  setSelectedCryptoMapIsDynamic(d: boolean): void;
  getSelectedIPSecProfile(): string | null;
  setSelectedIPSecProfile(p: string | null): void;
  getSelectedIKEv2Proposal(): string | null;
  setSelectedIKEv2Proposal(p: string | null): void;
  getSelectedIKEv2Policy(): string | null;
  setSelectedIKEv2Policy(n: string | null): void;
  getSelectedIKEv2Keyring(): string | null;
  setSelectedIKEv2Keyring(k: string | null): void;
  getSelectedIKEv2KeyringPeer(): string | null;
  setSelectedIKEv2KeyringPeer(p: string | null): void;
  getSelectedIKEv2Profile(): string | null;
  setSelectedIKEv2Profile(p: string | null): void;
}

// ─── Global Config Mode Commands ─────────────────────────────────────

export function buildConfigCommands(trie: CommandTrie, ctx: CiscoShellContext): void {
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
    const typeIdx = args.findIndex((a) => a.toLowerCase() === 'type');
    const stripped = typeIdx >= 0 ? args.slice(0, typeIdx) : args;
    const raw = stripped.join(' ');
    let ifName = ctx.resolveInterfaceName(raw);
    if (!ifName) {
      const combined = raw.replace(/\s+/g, '');
      const vMatch = combined.match(/^(loopback|tunnel|serial|virtual-template|port-channel|vlan|nve)([\d/.]+)$/i);
      if (vMatch) {
        const typeMap: Record<string, string> = {
          'loopback': 'Loopback', 'tunnel': 'Tunnel', 'serial': 'Serial',
          'virtual-template': 'Virtual-Template', 'port-channel': 'Port-channel', 'vlan': 'Vlan',
          'nve': 'Nve',
        };
        const fullName = `${typeMap[vMatch[1].toLowerCase()]}${vMatch[2]}`;
        ctx.r()._createVirtualInterface(fullName);
        ifName = fullName;
      }
      if (!ifName) {
        const subMatch = combined.match(/^([a-z]+\d+(?:\/\d+){1,2})\.(\d+)$/i);
        if (subMatch) {
          const baseName = ctx.resolveInterfaceName(subMatch[1]);
          if (baseName) {
            const fullName = `${baseName}.${subMatch[2]}`;
            ctx.r()._createVirtualInterface(fullName);
            ifName = fullName;
          }
        }
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

  trie.registerGreedy('no ip dhcp pool', 'Remove a DHCP address pool', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    ctx.r()._getDHCPServerInternal().deletePool(args[0]);
    return '';
  });

  trie.registerGreedy('ip dhcp excluded-address', 'Prevent DHCP from assigning certain addresses', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    const start = args[0];
    const end = args[1] || start;
    ctx.r()._getDHCPServerInternal().addExcludedRange(start, end);
    return '';
  });

  trie.registerGreedy('ip dhcp class', 'Define DHCP class', (args) => {
    if (!args[0]) return '% Incomplete command.';
    const r = ctx.r() as any;
    const classes = r._ciscoDhcpClasses ?? (r._ciscoDhcpClasses = new Map<string, any>());
    if (!classes.has(args[0])) classes.set(args[0], { name: args[0], options: [], lines: [] });
    r._ciscoDhcpCurrentClass = args[0];
    ctx.setMode('config-dhcp-class' as any);
    return '';
  });

  trie.registerGreedy('ipv6 dhcp pool', 'Define an IPv6 DHCP pool', (args) => {
    if (!args[0]) return '% Incomplete command.';
    const r = ctx.r() as any;
    const pools = r._ciscoIpv6DhcpPools ?? (r._ciscoIpv6DhcpPools = new Map<string, any>());
    if (!pools.has(args[0])) pools.set(args[0], { name: args[0] });
    r._ciscoIpv6DhcpCurrent = args[0];
    ctx.setMode('config-ipv6-dhcp' as any);
    return '';
  });

  trie.register('ip dhcp use class', 'Enable DHCP class lookup', () => {
    (ctx.r() as any)._ciscoDhcpUseClass = true;
    return '';
  });
  trie.registerGreedy('ip dhcp ping packets', 'Set DHCP ping packets', (args) => {
    (ctx.r() as any)._ciscoDhcpPingPackets = parseInt(args[0] ?? '', 10) || 0;
    return '';
  });
  trie.registerGreedy('ip dhcp ping timeout', 'Set DHCP ping timeout (ms)', (args) => {
    (ctx.r() as any)._ciscoDhcpPingTimeout = parseInt(args[0] ?? '', 10) || 0;
    return '';
  });
  trie.registerGreedy('ip dhcp database', 'Set DHCP database URL', (args, raw) => {
    (ctx.r() as any)._ciscoDhcpDatabase = raw ?? args.join(' ');
    return '';
  });
  trie.register('ip dhcp bootp ignore', 'Ignore BOOTP requests', () => {
    (ctx.r() as any)._ciscoDhcpBootpIgnore = true; return '';
  });
  trie.registerGreedy('ip dhcp compatibility', 'DHCP compatibility tweaks', (_args) => '');

  trie.register('ip dhcp relay information option', 'Enable option-82 insertion', () => {
    (ctx.r() as any)._ciscoDhcpRelayInfoOption = true;
    ctx.r()._getDHCPServerInternal().setRelayInformationOption(true);
    return '';
  });
  trie.register('no ip dhcp relay information option', 'Disable option-82 insertion', () => {
    (ctx.r() as any)._ciscoDhcpRelayInfoOption = false;
    ctx.r()._getDHCPServerInternal().setRelayInformationOption(false);
    return '';
  });
  trie.registerGreedy('ip dhcp relay information policy', 'Option-82 policy (keep/replace/drop)', (args) => {
    (ctx.r() as any)._ciscoDhcpRelayInfoPolicy = args[0]?.toLowerCase() ?? 'replace'; return '';
  });
  trie.register('ip dhcp relay information trust-all', 'Trust option-82 on all interfaces', () => {
    (ctx.r() as any)._ciscoDhcpRelayInfoTrustAll = true; return '';
  });
  trie.register('ip dhcp smart-relay', 'Enable DHCP smart relay', () => {
    (ctx.r() as any)._ciscoDhcpSmartRelay = true; return '';
  });

  trie.register('ip dhcp snooping', 'Enable DHCP snooping globally', () => {
    (ctx.r() as any)._ciscoDhcpSnooping = true; return '';
  });
  trie.registerGreedy('ip dhcp snooping vlan', 'Enable DHCP snooping for VLANs', (args, raw) => {
    (ctx.r() as any)._ciscoDhcpSnoopingVlans = raw ?? args.join(' '); return '';
  });
  trie.register('ip dhcp snooping information option', 'Include option-82 in snooped packets', () => {
    (ctx.r() as any)._ciscoDhcpSnoopingInfoOption = true; return '';
  });

  trie.registerGreedy('ip route', 'Establish static routes', (args) => {
    return cmdIpRoute(ctx.r(), args);
  });

  trie.registerGreedy('no ip route', 'Remove static route', (args) => {
    return cmdNoIpRoute(ctx.r(), args);
  });

  trie.registerGreedy('ip default-network', 'Configure default-network', (args) => {
    (ctx.r() as any)._ciscoDefaultNetwork = args[0];
    return '';
  });
  trie.registerGreedy('ip local policy route-map', 'Apply local PBR', (args) => {
    (ctx.r() as any)._ciscoLocalPolicyRouteMap = args[0];
    return '';
  });

  trie.register('router rip', 'Enter RIP routing protocol configuration', () => {
    if (!ctx.r().isRIPEnabled()) ctx.r().enableRIP();
    ctx.setSelectedRoutingProto({ proto: 'rip' });
    ctx.setMode('config-router');
    return '';
  });

  trie.register('no router rip', 'Disable RIP routing protocol', () => {
    ctx.r().disableRIP();
    return '';
  });

  trie.register('no shutdown', 'Enable (no-op in global config)', () => '');

  // ARP config commands are registered once for both vendors by the shared
  // CiscoShellBase (registerArpConfigCommands on the config trie); no need to
  // register them again here.

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
  trie.registerGreedy('ip policy route-map', 'Apply PBR on interface', (args) => {
    const r = ctx.r() as any;
    const iface = ctx.getSelectedInterface();
    if (!iface) return '';
    const m = r._ciscoIfacePolicyRouteMap ?? (r._ciscoIfacePolicyRouteMap = new Map<string, string>());
    if (args[0]) m.set(iface, args[0]);
    return '';
  });
  trie.registerGreedy('interface', 'Select an interface to configure', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    const raw = args.join(' ');
    let ifName = resolveInterfaceName(ctx.r(), raw);
    if (!ifName) {
      const combined = raw.replace(/\s+/g, '');
      const vMatch = combined.match(/^(loopback|tunnel|serial|nve)([\d/.]+)$/i);
      if (vMatch) {
        const typeMap: Record<string, string> = { 'loopback': 'Loopback', 'tunnel': 'Tunnel', 'serial': 'Serial', 'nve': 'Nve' };
        const fullName = `${typeMap[vMatch[1].toLowerCase()]}${vMatch[2]}`;
        ctx.r()._createVirtualInterface(fullName);
        ifName = fullName;
      }
      if (!ifName) {
        const subMatch = combined.match(/^([a-z]+\d+\/\d+(?:\/\d+)?)\.(\d+)$/i);
        if (subMatch) {
          const baseName = resolveInterfaceName(ctx.r(), subMatch[1]);
          if (baseName) {
            const fullName = `${baseName}.${subMatch[2]}`;
            ctx.r()._createVirtualInterface(fullName);
            ifName = fullName;
          }
        }
      }
      if (!ifName) return `% Invalid interface "${raw}"`;
    }
    ctx.setSelectedInterface(ifName);
    ctx.setMode('config-if');
    return '';
  });

  trie.registerGreedy('ip address', 'Set interface IP address', (args) => {
    if (args.length < 2) return '% Incomplete command.';
    if (!ctx.getSelectedInterface()) return '% No interface selected';
    if (!isValidIPv4(args[0]) || !isValidSubnetMask(args[1])) {
      return "% Invalid input detected at '^' marker.";
    }
    const secondary = args[2]?.toLowerCase() === 'secondary';
    if (args[2] !== undefined && !secondary) {
      return "% Invalid input detected at '^' marker.";
    }
    try {
      ctx.r().configureInterface(ctx.getSelectedInterface()!, new IPAddress(args[0]), new SubnetMask(args[1]), secondary);
      return '';
    } catch (e: any) {
      return `% Invalid input: ${e.message}`;
    }
  });

  trie.registerGreedy('no ip address', 'Remove interface IP address', (args) => {
    const ifName = ctx.getSelectedInterface();
    if (!ifName) return '% No interface selected';
    if (args[2]?.toLowerCase() === 'secondary' && isValidIPv4(args[0]) && isValidSubnetMask(args[1])) {
      ctx.r().removeSecondaryAddress(ifName, new IPAddress(args[0]), new SubnetMask(args[1]));
      return '';
    }
    ctx.r().unconfigureInterface(ifName);
    return '';
  });

  trie.registerGreedy('mtu', 'Set MTU', (args) => {
    if (!ctx.getSelectedInterface()) return '% No interface selected';
    const port = ctx.r().getPort(ctx.getSelectedInterface()!);
    if (!port) return '';
    if (!/^\d+$/.test(args[0] ?? '')) return "% Invalid input detected at '^' marker.";
    try { port.setMTU(parseInt(args[0], 10)); } catch (e: unknown) { return e instanceof Error ? `% ${e.message}` : '% Invalid MTU'; }
    return '';
  });
  trie.registerGreedy('bandwidth', 'Set interface bandwidth (kbps)', (args) => {
    if (!ctx.getSelectedInterface()) return '% No interface selected';
    const port = ctx.r().getPort(ctx.getSelectedInterface()!);
    if (!port) return '';
    const n = parseInt(args[0] ?? '', 10);
    if (!/^\d+$/.test(args[0] ?? '') || n < 1 || n > 10000000) {
      return "% Invalid input detected at '^' marker.";
    }
    port.setBandwidthKbps(n);
    return '';
  });
  trie.registerGreedy('delay', 'Set interface delay (10us)', (args) => {
    if (!ctx.getSelectedInterface()) return '% No interface selected';
    const port = ctx.r().getPort(ctx.getSelectedInterface()!);
    const n = parseInt(args[0] ?? '', 10);
    if (port && !isNaN(n)) port.setDelayUs(n * 10);
    return '';
  });
  trie.registerGreedy('arp timeout', 'Set ARP timeout (seconds)', (args) => {
    if (!ctx.getSelectedInterface()) return '% No interface selected';
    const port = ctx.r().getPort(ctx.getSelectedInterface()!);
    const n = parseInt(args[0] ?? '', 10);
    if (port && !isNaN(n)) port.setArpTimeoutSec(n);
    return '';
  });
  trie.registerGreedy('duplex', 'Set interface duplex', (args) => {
    if (!ctx.getSelectedInterface()) return '% No interface selected';
    const port = ctx.r().getPort(ctx.getSelectedInterface()!);
    if (!port) return '';
    const a = (args[0] ?? '').toLowerCase();
    if (a !== 'full' && a !== 'half' && a !== 'auto') return "% Invalid input detected at '^' marker.";
    port.setDuplex(a as 'full' | 'half' | 'auto');
    return '';
  });
  trie.registerGreedy('speed', 'Set interface speed', (args) => {
    if (!ctx.getSelectedInterface()) return '% No interface selected';
    const port = ctx.r().getPort(ctx.getSelectedInterface()!);
    if (!port) return '';
    if (args[0]?.toLowerCase() === 'auto') { port.setNegotiationAuto(true); return ''; }
    if (!/^\d+$/.test(args[0] ?? '')) return "% Invalid input detected at '^' marker.";
    try { port.setSpeed(parseInt(args[0], 10)); } catch { return "% Invalid input detected at '^' marker."; }
    return '';
  });
  trie.registerGreedy('negotiation', 'Set auto-negotiation', (args) => {
    if (!ctx.getSelectedInterface()) return '% No interface selected';
    const port = ctx.r().getPort(ctx.getSelectedInterface()!);
    if (port) port.setNegotiationAuto(args[0]?.toLowerCase() === 'auto');
    return '';
  });
  trie.register('no keepalive', 'Disable keepalive', () => {
    if (!ctx.getSelectedInterface()) return '';
    ctx.r().getPort(ctx.getSelectedInterface()!)?.setKeepalive(null);
    return '';
  });
  trie.registerGreedy('keepalive', 'Set keepalive interval', (args) => {
    if (!ctx.getSelectedInterface()) return '';
    const port = ctx.r().getPort(ctx.getSelectedInterface()!);
    const n = parseInt(args[0] ?? '10', 10);
    if (port) port.setKeepalive(isNaN(n) ? 10 : n);
    return '';
  });
  trie.register('ip directed-broadcast', 'Enable directed broadcast', () => {
    if (!ctx.getSelectedInterface()) return '';
    ctx.r().getPort(ctx.getSelectedInterface()!)?.setDirectedBroadcast(true);
    return '';
  });
  trie.register('no ip directed-broadcast', 'Disable directed broadcast', () => {
    if (!ctx.getSelectedInterface()) return '';
    ctx.r().getPort(ctx.getSelectedInterface()!)?.setDirectedBroadcast(false);
    return '';
  });
  trie.registerGreedy('no ip helper-address', 'Remove DHCP relay helper', (args) => {
    if (!ctx.getSelectedInterface() || !args[0]) return '';
    const dhcp = ctx.r()._getDHCPServerInternal() as unknown as { removeHelperAddress?: (iface: string, ip: string) => void };
    dhcp.removeHelperAddress?.(ctx.getSelectedInterface()!, args[0]);
    return '';
  });
  trie.registerGreedy('ip unnumbered', 'Borrow IP from another interface', (args) => {
    if (!ctx.getSelectedInterface() || !args[0]) return '';
    const port = ctx.r().getPort(ctx.getSelectedInterface()!);
    if (port) (port as unknown as { unnumberedSource?: string | null }).unnumberedSource = args[0];
    return '';
  });
  trie.register('no ip unnumbered', 'Clear unnumbered', () => {
    if (!ctx.getSelectedInterface()) return '';
    const port = ctx.r().getPort(ctx.getSelectedInterface()!);
    if (port) (port as unknown as { unnumberedSource?: string | null }).unnumberedSource = null;
    return '';
  });
  trie.registerGreedy('service-policy', 'Apply QoS policy', (args) => {
    if (!ctx.getSelectedInterface()) return '';
    const port = ctx.r().getPort(ctx.getSelectedInterface()!);
    if (!port || !args[0] || !args[1]) return '';
    if (args[0].toLowerCase() === 'input') port.setInputServicePolicy(args[1]);
    else if (args[0].toLowerCase() === 'output') port.setOutputServicePolicy(args[1]);
    return '';
  });
  trie.register('ipv6 enable', 'Enable IPv6 on interface', () => {
    if (!ctx.getSelectedInterface()) return '';
    const port = ctx.r().getPort(ctx.getSelectedInterface()!);
    if (port) (port as unknown as { ipv6Enabled?: boolean }).ipv6Enabled = true;
    return '';
  });
  trie.register('no ipv6 enable', 'Disable IPv6 on interface', () => {
    if (!ctx.getSelectedInterface()) return '';
    const port = ctx.r().getPort(ctx.getSelectedInterface()!);
    if (port) (port as unknown as { ipv6Enabled?: boolean }).ipv6Enabled = false;
    return '';
  });
  trie.registerGreedy('ip mtu', 'Set IP MTU', (args) => {
    if (!ctx.getSelectedInterface()) return '';
    const port = ctx.r().getPort(ctx.getSelectedInterface()!);
    const n = parseInt(args[0] ?? '', 10);
    if (port && !isNaN(n)) {
      (port as unknown as { ipMtu?: number }).ipMtu = n;
      try { port.setMTU(n); } catch { /* ignore */ }
    }
    return '';
  });
  trie.registerGreedy('ipv6 mtu', 'Set IPv6 MTU', (args) => {
    if (!ctx.getSelectedInterface()) return '';
    const port = ctx.r().getPort(ctx.getSelectedInterface()!);
    const n = parseInt(args[0] ?? '', 10);
    if (port && !isNaN(n)) (port as unknown as { ipv6Mtu?: number }).ipv6Mtu = n;
    return '';
  });
  trie.register('ip proxy-arp', 'Enable proxy-ARP', () => {
    if (!ctx.getSelectedInterface()) return '';
    const port = ctx.r().getPort(ctx.getSelectedInterface()!);
    if (port) port.setProxyArp(true);
    return '';
  });
  trie.register('ip redirects', 'Enable ICMP redirects', () => {
    if (!ctx.getSelectedInterface()) return '';
    const port = ctx.r().getPort(ctx.getSelectedInterface()!);
    if (port) (port as unknown as { ipRedirects?: boolean }).ipRedirects = true;
    return '';
  });
  trie.register('ip accounting', 'Enable IP accounting', () => {
    if (!ctx.getSelectedInterface()) return '';
    const port = ctx.r().getPort(ctx.getSelectedInterface()!);
    if (port) (port as unknown as { ipAccounting?: boolean }).ipAccounting = true;
    return '';
  });
  trie.register('ip dhcp relay information trusted', 'Trust DHCP option-82', () => {
    if (!ctx.getSelectedInterface()) return '';
    const port = ctx.r().getPort(ctx.getSelectedInterface()!);
    if (port) (port as unknown as { dhcpRelayInfoTrusted?: boolean }).dhcpRelayInfoTrusted = true;
    return '';
  });
  trie.register('ip dhcp snooping trust', 'Trust DHCP snooping on interface', () => {
    const ifName = ctx.getSelectedInterface();
    if (!ifName) return '';
    const port = ctx.r().getPort(ifName);
    if (port) (port as any).dhcpSnoopingTrust = true;
    return '';
  });
  trie.registerGreedy('ip dhcp snooping limit rate', 'Snooping rate-limit (pps)', (args) => {
    const ifName = ctx.getSelectedInterface();
    if (!ifName) return '';
    const port = ctx.r().getPort(ifName);
    const n = parseInt(args[0] ?? '', 10);
    if (port && !isNaN(n)) (port as any).dhcpSnoopingRateLimit = n;
    return '';
  });
  trie.registerGreedy('ipv6 dhcp server', 'Bind IPv6 DHCP pool to interface', (args) => {
    const ifName = ctx.getSelectedInterface();
    if (!ifName || !args[0]) return '';
    const port = ctx.r().getPort(ifName);
    if (port) (port as any).ipv6DhcpPool = args[0];
    return '';
  });
  trie.registerGreedy('ipv6 dhcp relay destination', 'IPv6 DHCP relay destination', (args) => {
    const ifName = ctx.getSelectedInterface();
    if (!ifName || !args[0]) return '';
    const port = ctx.r().getPort(ifName);
    if (port) ((port as any).ipv6DhcpRelayDestinations ??= []).push(args[0]);
    return '';
  });
  trie.register('ipv6 nd managed-config-flag', 'Set IPv6 ND M flag', () => {
    const ifName = ctx.getSelectedInterface();
    if (!ifName) return '';
    const port = ctx.r().getPort(ifName);
    if (port) (port as any).ipv6NdManagedFlag = true;
    return '';
  });
  trie.register('ipv6 nd other-config-flag', 'Set IPv6 ND O flag', () => {
    const ifName = ctx.getSelectedInterface();
    if (!ifName) return '';
    const port = ctx.r().getPort(ifName);
    if (port) (port as any).ipv6NdOtherFlag = true;
    return '';
  });
  trie.registerGreedy('ip rip authentication', 'Configure RIP authentication', (args, raw) => {
    const ifName = ctx.getSelectedInterface(); if (!ifName) return '';
    const port = ctx.r().getPort(ifName) as any;
    if (port) (port.ripAuth ??= []).push(raw ?? `ip rip authentication ${args.join(' ')}`);
    return '';
  });
  trie.registerGreedy('ip rip send version', 'Set RIP send version', (args) => {
    const ifName = ctx.getSelectedInterface(); if (!ifName) return '';
    const port = ctx.r().getPort(ifName) as any;
    if (port) port.ripSendVersion = args.join(' ');
    return '';
  });
  trie.registerGreedy('ip rip receive version', 'Set RIP receive version', (args) => {
    const ifName = ctx.getSelectedInterface(); if (!ifName) return '';
    const port = ctx.r().getPort(ifName) as any;
    if (port) port.ripRecvVersion = args.join(' ');
    return '';
  });
  trie.register('ip rip v2-broadcast', 'Broadcast RIPv2 instead of multicast', () => {
    const ifName = ctx.getSelectedInterface(); if (!ifName) return '';
    const port = ctx.r().getPort(ifName) as any;
    if (port) port.ripV2Broadcast = true;
    return '';
  });
  trie.registerGreedy('ip summary-address rip', 'Summarize RIP routes', (args, raw) => {
    const ifName = ctx.getSelectedInterface(); if (!ifName) return '';
    const port = ctx.r().getPort(ifName) as any;
    if (port) (port.ripSummaries ??= []).push(raw ?? `ip summary-address rip ${args.join(' ')}`);
    return '';
  });
  trie.registerGreedy('ip summary-address eigrp', 'Summarize EIGRP routes', (args, raw) => {
    const ifName = ctx.getSelectedInterface(); if (!ifName) return '';
    const port = ctx.r().getPort(ifName) as any;
    if (port) (port.eigrpSummaries ??= []).push(raw ?? `ip summary-address eigrp ${args.join(' ')}`);
    return '';
  });
  trie.registerGreedy('ip bandwidth-percent eigrp', 'EIGRP bandwidth %', (args, raw) => {
    const ifName = ctx.getSelectedInterface(); if (!ifName) return '';
    const port = ctx.r().getPort(ifName) as any;
    if (port) (port.eigrpExtras ??= []).push(raw ?? `ip bandwidth-percent eigrp ${args.join(' ')}`);
    return '';
  });
  trie.registerGreedy('ip hello-interval eigrp', 'EIGRP hello interval', (args, raw) => {
    const ifName = ctx.getSelectedInterface(); if (!ifName) return '';
    const port = ctx.r().getPort(ifName) as any;
    if (port) (port.eigrpExtras ??= []).push(raw ?? `ip hello-interval eigrp ${args.join(' ')}`);
    return '';
  });
  trie.registerGreedy('ip hold-time eigrp', 'EIGRP hold time', (args, raw) => {
    const ifName = ctx.getSelectedInterface(); if (!ifName) return '';
    const port = ctx.r().getPort(ifName) as any;
    if (port) (port.eigrpExtras ??= []).push(raw ?? `ip hold-time eigrp ${args.join(' ')}`);
    return '';
  });
  trie.registerGreedy('ip authentication mode eigrp', 'EIGRP auth mode', (args, raw) => {
    const ifName = ctx.getSelectedInterface(); if (!ifName) return '';
    const port = ctx.r().getPort(ifName) as any;
    if (port) (port.eigrpExtras ??= []).push(raw ?? `ip authentication mode eigrp ${args.join(' ')}`);
    return '';
  });
  trie.registerGreedy('ip authentication key-chain eigrp', 'EIGRP auth key-chain', (args, raw) => {
    const ifName = ctx.getSelectedInterface(); if (!ifName) return '';
    const port = ctx.r().getPort(ifName) as any;
    if (port) (port.eigrpExtras ??= []).push(raw ?? `ip authentication key-chain eigrp ${args.join(' ')}`);
    return '';
  });
  trie.registerGreedy('no ip split-horizon eigrp', 'Disable EIGRP split-horizon', (args, raw) => {
    const ifName = ctx.getSelectedInterface(); if (!ifName) return '';
    const port = ctx.r().getPort(ifName) as any;
    if (port) (port.eigrpExtras ??= []).push(raw ?? `no ip split-horizon eigrp ${args.join(' ')}`);
    return '';
  });
  trie.registerGreedy('no bfd echo', 'Disable BFD echo on interface', (_args) => {
    const ifName = ctx.getSelectedInterface(); if (!ifName) return '';
    const port = ctx.r().getPort(ifName) as any;
    if (port) port.bfdEcho = false;
    return '';
  });
  trie.registerGreedy('max-reserved-bandwidth', 'Max reservable bandwidth %', (args) => {
    const ifName = ctx.getSelectedInterface(); if (!ifName) return '';
    const port = ctx.r().getPort(ifName) as any;
    const n = parseInt(args[0] ?? '', 10);
    if (port && !isNaN(n)) port.maxReservedBandwidth = n;
    return '';
  });
  trie.registerGreedy('rate-limit', 'Rate-limit (legacy CAR)', (args, raw) => {
    const ifName = ctx.getSelectedInterface(); if (!ifName) return '';
    const port = ctx.r().getPort(ifName) as any;
    if (port) (port.rateLimits ??= []).push(raw ?? `rate-limit ${args.join(' ')}`);
    return '';
  });
  trie.register('ip nbar protocol-discovery', 'Enable NBAR protocol discovery', () => {
    const ifName = ctx.getSelectedInterface(); if (!ifName) return '';
    const port = ctx.r().getPort(ifName) as any;
    if (port) port.nbarProtocolDiscovery = true;
    return '';
  });
  trie.registerGreedy('priority-group', 'Apply priority queueing group', (args) => {
    const ifName = ctx.getSelectedInterface(); if (!ifName) return '';
    const port = ctx.r().getPort(ifName) as any;
    if (port) port.priorityGroup = parseInt(args[0] ?? '', 10) || 0;
    return '';
  });
  trie.registerGreedy('custom-queue-list', 'Apply custom queue list', (args) => {
    const ifName = ctx.getSelectedInterface(); if (!ifName) return '';
    const port = ctx.r().getPort(ifName) as any;
    if (port) port.customQueueList = parseInt(args[0] ?? '', 10) || 0;
    return '';
  });
  trie.registerGreedy('fair-queue', 'Enable WFQ', (args, raw) => {
    const ifName = ctx.getSelectedInterface(); if (!ifName) return '';
    const port = ctx.r().getPort(ifName) as any;
    if (port) port.fairQueueConfig = raw ?? `fair-queue ${args.join(' ')}`;
    return '';
  });
  trie.register('random-detect', 'Enable WRED', () => {
    const ifName = ctx.getSelectedInterface(); if (!ifName) return '';
    const port = ctx.r().getPort(ifName) as any;
    if (port) port.wredEnabled = true;
    return '';
  });
  trie.registerGreedy('tx-ring-limit', 'Configure TX-ring limit', (args) => {
    const ifName = ctx.getSelectedInterface(); if (!ifName) return '';
    const port = ctx.r().getPort(ifName) as any;
    const n = parseInt(args[0] ?? '', 10);
    if (port && !isNaN(n)) port.txRingLimit = n;
    return '';
  });

  trie.registerGreedy('ip address dhcp', 'Configure IP via DHCP', (args, raw) => {
    const ifName = ctx.getSelectedInterface();
    if (!ifName) return '';
    const port = ctx.r().getPort(ifName);
    if (port) {
      (port as any).ipAddressDhcp = true;
      (port as any).ipAddressDhcpRaw = raw ?? `ip address dhcp ${args.join(' ')}`;
    }
    return '';
  });
  trie.registerGreedy('load-interval', 'Set load calculation interval', (args) => {
    if (!ctx.getSelectedInterface()) return '';
    const port = ctx.r().getPort(ctx.getSelectedInterface()!);
    const n = parseInt(args[0] ?? '', 10);
    if (port && !isNaN(n)) (port as unknown as { loadIntervalSec?: number }).loadIntervalSec = n;
    return '';
  });
  trie.registerGreedy('encapsulation', 'Set encapsulation', (args) => {
    if (!ctx.getSelectedInterface()) return '';
    const port = ctx.r().getPort(ctx.getSelectedInterface()!);
    if (!port) return '';
    (port as unknown as { encapsulation?: { type: string; vlan?: number; native?: boolean } }).encapsulation = {
      type: args[0]?.toLowerCase() ?? '',
      vlan: args[1] ? parseInt(args[1], 10) : undefined,
      native: args.includes('native'),
    };
    return '';
  });

  trie.registerGreedy('description', 'Set interface description', (args) => {
    if (!ctx.getSelectedInterface()) return '% No interface selected';
    if (args.length < 1) return '% Incomplete command.';
    ctx.r().setInterfaceDescription(ctx.getSelectedInterface()!, args.join(' '));
    return '';
  });

  trie.register('no description', 'Remove interface description', () => {
    if (!ctx.getSelectedInterface()) return '% No interface selected';
    ctx.r().setInterfaceDescription(ctx.getSelectedInterface()!, '');
    return '';
  });

  trie.register('no shutdown', 'Enable interface', () => {
    if (!ctx.getSelectedInterface()) return '% No interface selected';
    const port = ctx.r().getPort(ctx.getSelectedInterface()!);
    if (port) port.setUp(true);
    return '';
  });

  trie.register('shutdown', 'Disable interface', () => {
    if (!ctx.getSelectedInterface()) return '% No interface selected';
    const ifName = ctx.getSelectedInterface()!;
    const port = ctx.r().getPort(ifName);
    if (port) {
      port.setUp(false);
      // Clear IPSec SAs bound to this interface (like a real Cisco router)
      const ipsecEngine = (ctx.r() as any)._getIPSecEngineInternal?.();
      if (ipsecEngine) ipsecEngine.clearSAsForInterface(ifName);
    }
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

const isDottedIp = (s: string) => /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(s);

export function cmdIpRoute(router: Router, args: string[]): string {
  let cursor = 0;
  let vrfName: string | null = null;
  if (args[cursor]?.toLowerCase() === 'vrf' && args[cursor + 1]) {
    vrfName = args[cursor + 1];
    cursor += 2;
  }
  if (args.length - cursor < 3) return '% Incomplete command.';
  const netStr = args[cursor];
  const maskStr = args[cursor + 1];
  if (!isValidIPv4(netStr) || !isValidSubnetMask(maskStr)) {
    return "% Invalid input detected at '^' marker.";
  }
  const network = new IPAddress(netStr);
  const mask = new SubnetMask(maskStr);
  if (!(netStr === '0.0.0.0' && maskStr === '0.0.0.0') && !network.networkAddress(mask).equals(network)) {
    return '%Inconsistent address and mask';
  }
  const remaining = args.slice(cursor + 2);
  let outIface: string | null = null;
  let nextHopStr: string | null = null;
  let rest: string[];
  if (looksLikeInterfaceName(remaining[0])) {
    outIface = remaining[0];
    if (remaining[1] && isDottedIp(remaining[1])) { nextHopStr = remaining[1]; rest = remaining.slice(2); }
    else rest = remaining.slice(1);
  } else {
    nextHopStr = remaining[0];
    rest = remaining.slice(1);
  }
  if (nextHopStr && !isValidIPv4(nextHopStr)) {
    return "% Invalid input detected at '^' marker.";
  }
  // Optional administrative distance (RFC: 1-255).
  let ad: number | undefined;
  const adTok = rest.find((t) => /^\d+$/.test(t));
  if (adTok !== undefined) {
    const n = parseInt(adTok, 10);
    if (n < 1 || n > 255) return "% Invalid input detected at '^' marker.";
    ad = n;
  }
  if (vrfName) {
    const r = router as any;
    const vrfs = r._ciscoVrfRoutes ?? (r._ciscoVrfRoutes = new Map<string, any[]>());
    const list = vrfs.get(vrfName) ?? [];
    list.push({ network: netStr, mask: maskStr, nextHop: nextHopStr, iface: outIface });
    vrfs.set(vrfName, list);
    return '';
  }
  const opts: { preference?: number; iface?: string } = {};
  if (ad !== undefined) opts.preference = ad;
  if (outIface) {
    opts.iface = outIface;
    const nextHop = nextHopStr ? new IPAddress(nextHopStr) : new IPAddress('0.0.0.0');
    return router.addStaticRoute(network, mask, nextHop, 0, opts) ? '' : '% Invalid route';
  }
  if (nextHopStr) {
    const nextHop = new IPAddress(nextHopStr);
    if (netStr === '0.0.0.0' && maskStr === '0.0.0.0') {
      return router.setDefaultRoute(nextHop) ? '' : '% Next-hop is not reachable';
    }
    return router.addStaticRoute(network, mask, nextHop, 0, ad !== undefined ? opts : undefined)
      ? '' : '% Next-hop is not reachable';
  }
  return '% Incomplete command.';
}

function looksLikeInterfaceName(token: string | undefined): boolean {
  if (!token) return false;
  return /^(gigabitethernet|gi|ge|ethernet|eth|fastethernet|fa|serial|s|loopback|lo|tunnel|tu|vlan|null|nve|virtual-template)\d/i.test(token)
    || /^null0$/i.test(token);
}

export function cmdNoIpRoute(router: Router, args: string[]): string {
  if (args.length < 2) return '% Incomplete command.';
  try {
    const network = new IPAddress(args[0]);
    const mask = new SubnetMask(args[1]);
    const nextHop = args[2] && isDottedIp(args[2]) ? new IPAddress(args[2]) : undefined;
    if (args[0] === '0.0.0.0' && args[1] === '0.0.0.0') {
      return router.removeDefaultRoute() ? '' : '% Route not found';
    }
    return router.removeStaticRoute(network, mask, nextHop) ? '' : '% Route not found';
  } catch (e: any) {
    return `% Invalid input: ${e.message}`;
  }
}

// ─── Interface Name Resolution ───────────────────────────────────────

/**
 * Resolve abbreviated Cisco interface name (backward-compatible wrapper).
 * Delegates to shared resolveCiscoInterfaceName in cli-utils.
 */
export function resolveInterfaceName(router: Router, input: string): string | null {
  return resolveCiscoInterfaceName(router.getPortNames(), input);
}

// ─── Classful Mask (for RIP) ────────────────────────────────────────

export function classfulMask(ip: IPAddress): SubnetMask {
  const firstOctet = ip.getOctets()[0];
  if (firstOctet < 128) return new SubnetMask('255.0.0.0');
  if (firstOctet < 192) return new SubnetMask('255.255.0.0');
  return new SubnetMask('255.255.255.0');
}
