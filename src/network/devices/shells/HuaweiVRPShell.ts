/**
 * HuaweiVRPShell - Huawei VRP CLI emulation for Router Management Plane
 *
 * Modes:
 *   - User view: <hostname> — display commands, ping, traceroute
 *   - System view: [hostname] — configuration commands
 *   - Interface view: [hostname-GE0/0/X] — interface configuration
 *   - DHCP pool view: [hostname-ip-pool-name] — DHCP pool configuration
 *
 * Commands:
 *   display ip routing-table       - Display routing table
 *   display ip interface brief     - Display interface summary
 *   display arp                    - Display ARP cache
 *   display current-configuration  - Display running configuration
 *   display ip traffic             - Display traffic statistics
 *   display version                - Display VRP version info
 *   display interface <name>       - Display interface details
 *   display ip pool name <name>    - Display DHCP pool info
 *   display rip                    - Display RIP status
 *   system-view                    - Enter system view
 *   return                         - Return to user view
 *   quit                           - Exit one level
 *   sysname <name>                 - Set hostname
 *   interface <name>               - Enter interface view
 *   ip route-static <net> <mask> <nh> - Add static route
 *   undo ip route-static           - Remove static route
 *   arp static <ip> <mac>          - Add static ARP entry
 *   undo arp static <ip>           - Remove static ARP entry
 *   dhcp enable                    - Enable DHCP globally
 *   ip pool <name>                 - Create/enter DHCP pool
 *   rip [1]                        - Enable RIP process
 *   undo rip                       - Disable RIP
 */

import { IPAddress, SubnetMask, MACAddress } from '../../core/types';
import type { Router } from '../Router';
import type { IRouterShell } from './IRouterShell';

type VRPRouterMode = 'user' | 'system' | 'interface' | 'dhcp-pool';

export class HuaweiVRPShell implements IRouterShell {
  private mode: VRPRouterMode = 'user';
  private selectedInterface: string | null = null;
  private selectedPool: string | null = null;
  private dhcpEnabled: boolean = false;
  /** Track which interfaces have 'dhcp select global' */
  private dhcpSelectGlobal: Set<string> = new Set();

  getOSType(): string { return 'huawei-vrp'; }

  getPrompt(router: Router): string {
    const host = router._getHostnameInternal();
    switch (this.mode) {
      case 'user':       return `<${host}>`;
      case 'system':     return `[${host}]`;
      case 'interface':  return `[${host}-${this.selectedInterface}]`;
      case 'dhcp-pool':  return `[${host}-ip-pool-${this.selectedPool}]`;
      default:           return `<${host}>`;
    }
  }

  execute(router: Router, rawInput: string): string {
    const trimmed = rawInput.trim();
    if (!trimmed) return '';

    const lower = trimmed.toLowerCase();

    // Global navigation
    if (lower === 'return') {
      this.mode = 'user';
      this.selectedInterface = null;
      this.selectedPool = null;
      return '';
    }
    if (lower === 'quit') return this.cmdQuit();

    switch (this.mode) {
      case 'user':       return this.executeUserMode(router, trimmed);
      case 'system':     return this.executeSystemMode(router, trimmed);
      case 'interface':  return this.executeInterfaceMode(router, trimmed);
      case 'dhcp-pool':  return this.executeDhcpPoolMode(router, trimmed);
      default:           return `Error: Unrecognized command "${trimmed}"`;
    }
  }

  private cmdQuit(): string {
    switch (this.mode) {
      case 'interface':
        this.mode = 'system';
        this.selectedInterface = null;
        return '';
      case 'dhcp-pool':
        this.mode = 'system';
        this.selectedPool = null;
        return '';
      case 'system':
        this.mode = 'user';
        return '';
      case 'user':
        return '';
      default:
        return '';
    }
  }

  // ─── User View (<hostname>) ──────────────────────────────────────

  private executeUserMode(router: Router, input: string): string {
    const parts = input.split(/\s+/);
    const cmd = parts[0].toLowerCase();

    if (cmd === 'system-view') {
      this.mode = 'system';
      return 'Enter system view, return user view with return command.';
    }

    if (cmd === 'display') return this.cmdDisplay(router, parts.slice(1));
    if (cmd === 'show') return this.cmdDisplay(router, parts.slice(1)); // alias

    // Allow config commands in user view for backward compatibility
    // (real VRP requires system-view, but existing tests use direct commands)
    if (cmd === 'ip') return this.cmdIp(router, parts.slice(1));
    if (cmd === 'rip') return this.cmdRip(router, parts.slice(1));
    if (cmd === 'undo') return this.cmdUndo(router, parts.slice(1));

    return `Error: Unrecognized command "${input}"`;
  }

  // ─── System View ([hostname]) ────────────────────────────────────

  private executeSystemMode(router: Router, input: string): string {
    const parts = input.split(/\s+/);
    const cmd = parts[0].toLowerCase();

    if (cmd === 'display') return this.cmdDisplay(router, parts.slice(1));

    if (cmd === 'sysname') {
      if (parts.length < 2) return 'Error: Incomplete command.';
      router._setHostnameInternal(parts[1]);
      return '';
    }

    if (cmd === 'interface') {
      if (parts.length < 2) return 'Error: Incomplete command.';
      const portName = this.resolveInterfaceName(router, parts[1]);
      if (!portName) return `Error: Wrong parameter found at '^' position.`;
      this.selectedInterface = portName;
      this.mode = 'interface';
      return '';
    }

    if (cmd === 'ip') return this.cmdIp(router, parts.slice(1));
    if (cmd === 'undo') return this.cmdUndo(router, parts.slice(1));
    if (cmd === 'rip') return this.cmdRip(router, parts.slice(1));

    if (cmd === 'arp') {
      // arp static <ip> <mac>
      if (parts.length >= 4 && parts[1].toLowerCase() === 'static') {
        return this.cmdArpStatic(router, parts[2], parts[3]);
      }
      return 'Error: Incomplete command.';
    }

    if (cmd === 'dhcp') {
      if (parts.length >= 2 && parts[1].toLowerCase() === 'enable') {
        this.dhcpEnabled = true;
        router._getDHCPServerInternal().enable();
        return '';
      }
      return 'Error: Incomplete command.';
    }

    return `Error: Unrecognized command "${input}"`;
  }

  // ─── Interface View ([hostname-GE0/0/X]) ─────────────────────────

  private executeInterfaceMode(router: Router, input: string): string {
    const parts = input.split(/\s+/);
    const lower = input.toLowerCase();

    if (lower === 'display') return 'Error: Incomplete command.';
    if (parts[0].toLowerCase() === 'display') return this.cmdDisplay(router, parts.slice(1));

    if (lower === 'shutdown') {
      const port = router.getPort(this.selectedInterface!);
      if (port) port.setUp(false);
      return '';
    }

    if (lower === 'undo shutdown') {
      const port = router.getPort(this.selectedInterface!);
      if (port) port.setUp(true);
      return '';
    }

    // ip address <ip> <mask>
    if (parts[0].toLowerCase() === 'ip' && parts.length >= 4 && parts[1].toLowerCase() === 'address') {
      try {
        const ip = new IPAddress(parts[2]);
        const mask = new SubnetMask(parts[3]);
        router.configureInterface(this.selectedInterface!, ip, mask);
        return '';
      } catch (e: any) {
        return `Error: ${e.message}`;
      }
    }

    // dhcp select global
    if (lower === 'dhcp select global') {
      this.dhcpSelectGlobal.add(this.selectedInterface!);
      return '';
    }

    return `Error: Unrecognized command "${input}"`;
  }

  // ─── DHCP Pool View ([hostname-ip-pool-name]) ────────────────────

  private executeDhcpPoolMode(router: Router, input: string): string {
    const parts = input.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const dhcp = router._getDHCPServerInternal();

    if (cmd === 'gateway-list') {
      if (parts.length < 2 || !this.selectedPool) return 'Error: Incomplete command.';
      dhcp.configurePoolRouter(this.selectedPool, parts[1]);
      return '';
    }

    if (cmd === 'network') {
      if (parts.length < 2 || !this.selectedPool) return 'Error: Incomplete command.';
      const network = parts[1];
      // mask can be keyword "mask" followed by mask, or just the mask
      let mask = '255.255.255.0';
      if (parts.length >= 4 && parts[2].toLowerCase() === 'mask') {
        mask = parts[3];
      } else if (parts.length >= 3) {
        mask = parts[2];
      }
      dhcp.configurePoolNetwork(this.selectedPool, network, mask);
      return '';
    }

    if (cmd === 'dns-list') {
      if (parts.length < 2 || !this.selectedPool) return 'Error: Incomplete command.';
      dhcp.configurePoolDNS(this.selectedPool, parts.slice(1));
      return '';
    }

    return `Error: Unrecognized command "${input}"`;
  }

  // ─── Display Command ────────────────────────────────────────────

  private cmdDisplay(router: Router, args: string[]): string {
    if (args.length === 0) return 'Error: Incomplete command.';
    const sub = args.join(' ').toLowerCase();

    if (sub === 'ip routing-table') return this.displayIpRoutingTable(router);
    if (sub === 'ip interface brief') return this.displayIpIntBrief(router);
    if (sub === 'arp') return this.displayArp(router);
    if (sub === 'current-configuration' || sub === 'current') return this.displayCurrentConfig(router);
    if (sub === 'ip traffic' || sub === 'counters') return this.displayCounters(router);
    if (sub === 'rip' || sub === 'rip 1') return this.displayRip(router);
    if (sub === 'version') return this.displayVersion(router);
    if (sub.startsWith('interface ')) return this.displayInterface(router, args.slice(1).join(' '));
    if (sub.startsWith('ip pool name ')) return this.displayIpPool(router, args.slice(3).join(' '));

    return `Error: Unrecognized command "display ${args.join(' ')}"`;
  }

  private displayVersion(router: Router): string {
    return [
      'Huawei Versatile Routing Platform Software',
      'VRP (R) software, Version 5.170 (AR2220 V200R009C00SPC500)',
      'Copyright (C) 2000-2025 HUAWEI TECH CO., LTD',
      '',
      `BOARD TYPE:          AR2220`,
      `BootROM Version:     1.0`,
      `${router._getHostnameInternal()} uptime is 0 days, 0 hours, 0 minutes`,
    ].join('\n');
  }

  private displayInterface(router: Router, ifName: string): string {
    const portName = this.resolveInterfaceName(router, ifName) || ifName;
    const port = router.getPort(portName);
    if (!port) return `Error: Wrong parameter found at '^' position.`;

    const ip = port.getIPAddress();
    const mask = port.getSubnetMask();
    const isUp = port.getIsUp();
    const isConn = port.isConnected();

    return [
      `${portName} current state : ${isUp ? (isConn ? 'UP' : 'DOWN') : 'Administratively DOWN'}`,
      `Line protocol current state : ${isConn ? 'UP' : 'DOWN'}`,
      `Internet Address is ${ip && mask ? `${ip}/${mask.toCIDR()}` : 'not configured'}`,
      `The Maximum Transmit Unit is 1500`,
      `Input:  0 packets, 0 bytes`,
      `Output: 0 packets, 0 bytes`,
    ].join('\n');
  }

  private displayIpPool(router: Router, poolName: string): string {
    const dhcp = router._getDHCPServerInternal();
    const pool = dhcp.getPool(poolName);
    if (!pool) return `Error: Pool "${poolName}" does not exist.`;

    const lines = [
      `Pool-name      : ${pool.name}`,
      `Pool-No        : 0`,
      `Position       : Local`,
      `Status         : Unlocked`,
      `Gateway-list   : ${pool.defaultRouter || 'not configured'}`,
      `Network        : ${pool.network || 'not configured'}`,
      `Mask           : ${pool.mask || 'not configured'}`,
      `DNS-list       : ${pool.dnsServers.join(' ') || 'not configured'}`,
    ];
    return lines.join('\n');
  }

  private displayIpRoutingTable(router: Router): string {
    const table = router.getRoutingTable();
    const lines = [
      'Route Flags: R - relay, D - download to fib',
      '------------------------------------------------------------------------------',
      'Routing Tables: Public',
      '         Destinations : ' + table.length + '        Routes : ' + table.length,
      '',
      'Destination/Mask    Proto   Pre  Cost  Flags NextHop         Interface',
    ];

    for (const r of table) {
      const dest = `${r.network}/${r.mask.toCIDR()}`.padEnd(20);
      const proto = (r.type === 'connected' ? 'Direct' : r.type === 'rip' ? 'RIP' : 'Static').padEnd(8);
      const pre = String(r.ad).padEnd(5);
      const cost = String(r.metric).padEnd(6);
      const flags = 'D'.padEnd(6);
      const nh = r.nextHop ? r.nextHop.toString().padEnd(16) : '0.0.0.0'.padEnd(16);
      lines.push(`${dest}${proto}${pre}${cost}${flags}${nh}${r.iface}`);
    }
    return lines.join('\n');
  }

  private displayIpIntBrief(router: Router): string {
    const ports = router._getPortsInternal();
    const lines = ['Interface                         IP Address/Mask      Physical   Protocol'];
    for (const [name, port] of ports) {
      const ip = port.getIPAddress();
      const mask = port.getSubnetMask();
      const ipStr = ip && mask ? `${ip}/${mask.toCIDR()}` : 'unassigned';
      const phys = port.isConnected() ? 'up' : 'down';
      const proto = port.isConnected() ? 'up' : 'down';
      lines.push(`${name.padEnd(34)}${ipStr.padEnd(21)}${phys.padEnd(11)}${proto}`);
    }
    return lines.join('\n');
  }

  private displayArp(router: Router): string {
    const arpTable = router._getArpTableInternal();
    const lines = ['IP ADDRESS      MAC ADDRESS     EXPIRE(M)  TYPE      INTERFACE'];
    if (arpTable.size === 0) {
      lines.push('No ARP entries found.');
    }
    for (const [ip, entry] of arpTable) {
      const age = Math.floor((Date.now() - entry.timestamp) / 60000);
      const type = (entry as any).type === 'static' ? 'static' : 'D';
      lines.push(`${ip.padEnd(16)}${entry.mac.toString().padEnd(16)}${String(age).padEnd(11)}${type.padEnd(10)}${entry.iface}`);
    }
    return lines.join('\n');
  }

  private displayCurrentConfig(router: Router): string {
    const ports = router._getPortsInternal();
    const table = router._getRoutingTableInternal();
    const lines = [
      '#',
      `sysname ${router._getHostnameInternal()}`,
      '#',
    ];

    if (this.dhcpEnabled) {
      lines.push('dhcp enable');
      lines.push('#');
    }

    for (const [name, port] of ports) {
      const ip = port.getIPAddress();
      const mask = port.getSubnetMask();
      lines.push(`interface ${name}`);
      if (ip && mask) {
        lines.push(` ip address ${ip} ${mask.toCIDR()}`);
      } else {
        lines.push(` shutdown`);
      }
      if (this.dhcpSelectGlobal.has(name)) {
        lines.push(` dhcp select global`);
      }
      lines.push('#');
    }
    for (const r of table) {
      if (r.type === 'static' && r.nextHop) {
        lines.push(`ip route-static ${r.network} ${r.mask} ${r.nextHop}`);
      }
      if (r.type === 'default' && r.nextHop) {
        lines.push(`ip route-static 0.0.0.0 0.0.0.0 ${r.nextHop}`);
      }
    }
    // RIP config
    if (router.isRIPEnabled()) {
      lines.push('#');
      lines.push('rip 1');
      lines.push(' version 2');
      const cfg = router.getRIPConfig();
      for (const net of cfg.networks) {
        lines.push(` network ${net.network}`);
      }
    }
    lines.push('#');
    return lines.join('\n');
  }

  private displayCounters(router: Router): string {
    const c = router.getCounters();
    return [
      'IP statistics:',
      `  Input:  ${c.ifInOctets} bytes`,
      `  Output: ${c.ifOutOctets} bytes`,
      `  Forward: ${c.ipForwDatagrams} packets`,
      `  Discard: ${c.ipInHdrErrors} header errors, ${c.ipInAddrErrors} no-route`,
      '',
      'ICMP statistics:',
      `  Output: ${c.icmpOutMsgs} packets`,
      `    Destination unreachable: ${c.icmpOutDestUnreachs}`,
      `    Time exceeded: ${c.icmpOutTimeExcds}`,
      `    Echo reply: ${c.icmpOutEchoReps}`,
    ].join('\n');
  }

  private displayRip(router: Router): string {
    if (!router.isRIPEnabled()) return 'Info: RIP is not enabled.';
    const cfg = router.getRIPConfig();
    const ripRoutes = router.getRIPRoutes();
    const lines = [
      'RIP process 1',
      '  Version: 2',
      `  Update timer: ${cfg.updateInterval / 1000}s`,
      `  Timeout timer: ${cfg.routeTimeout / 1000}s`,
      `  Garbage-collect timer: ${cfg.gcTimeout / 1000}s`,
      '',
      '  Networks:',
    ];
    for (const net of cfg.networks) {
      lines.push(`    ${net.network}/${net.mask.toCIDR()}`);
    }
    lines.push('');
    lines.push(`  Routes: ${ripRoutes.size}`);
    for (const [key, info] of ripRoutes) {
      lines.push(`    ${key} cost ${info.metric} via ${info.learnedFrom} age ${info.age}s${info.garbageCollect ? ' [garbage-collect]' : ''}`);
    }
    return lines.join('\n');
  }

  // ─── IP Command ─────────────────────────────────────────────────

  private cmdIp(router: Router, args: string[]): string {
    if (args.length === 0) return 'Error: Incomplete command.';

    // ip route-static <network> <mask> <next-hop>
    if (args.length >= 4 && args[0] === 'route-static') {
      try {
        const network = new IPAddress(args[1]);
        const mask = new SubnetMask(args[2]);
        const nextHop = new IPAddress(args[3]);

        if (args[1] === '0.0.0.0' && args[2] === '0.0.0.0') {
          return router.setDefaultRoute(nextHop) ? '' : 'Error: Next-hop is not reachable';
        }
        return router.addStaticRoute(network, mask, nextHop) ? '' : 'Error: Next-hop is not reachable';
      } catch (e: any) {
        return `Error: ${e.message}`;
      }
    }

    // ip pool <name> → enter DHCP pool configuration
    if (args.length >= 2 && args[0] === 'pool') {
      const poolName = args[1];
      const dhcp = router._getDHCPServerInternal();
      if (!dhcp.getPool(poolName)) {
        dhcp.createPool(poolName);
      }
      this.selectedPool = poolName;
      this.mode = 'dhcp-pool';
      return '';
    }

    return 'Error: Incomplete command.';
  }

  // ─── ARP Static Command ─────────────────────────────────────────

  private cmdArpStatic(router: Router, ip: string, mac: string): string {
    // Huawei MAC format: aaaa-bbbb-cccc → convert to standard
    const normalizedMAC = this.normalizeMAC(mac);
    const arpTable = router._getArpTableInternal();
    arpTable.set(ip, {
      mac: new MACAddress(normalizedMAC),
      iface: '',
      timestamp: Date.now(),
      type: 'static',
    } as any);
    return '';
  }

  private normalizeMAC(mac: string): string {
    // Convert Huawei format aaaa-bbbb-cccc to aa:aa:bb:bb:cc:cc
    const cleaned = mac.replace(/-/g, '').replace(/:/g, '').replace(/\./g, '');
    if (cleaned.length === 12) {
      return cleaned.match(/.{2}/g)!.join(':');
    }
    return mac;
  }

  // ─── RIP Command ────────────────────────────────────────────────

  private cmdRip(router: Router, args: string[]): string {
    if (!router.isRIPEnabled()) {
      router.enableRIP();
    }

    if (args.length >= 2 && args[0] === 'network') {
      try {
        const network = new IPAddress(args[1]);
        const mask = args.length >= 3 ? new SubnetMask(args[2]) : this.classfulMask(network);
        router.ripAdvertiseNetwork(network, mask);
        return '';
      } catch (e: any) {
        return `Error: ${e.message}`;
      }
    }

    return '';
  }

  // ─── Undo Command ───────────────────────────────────────────────

  private cmdUndo(router: Router, args: string[]): string {
    if (args.length < 1) return 'Error: Incomplete command.';

    if (args[0] === 'rip') {
      router.disableRIP();
      return '';
    }

    // undo ip route-static <network> <mask> <next-hop>
    if (args[0] === 'ip' && args.length >= 5 && args[1] === 'route-static') {
      try {
        const network = new IPAddress(args[2]);
        const mask = new SubnetMask(args[3]);
        const nextHop = new IPAddress(args[4]);

        // Remove matching static route from routing table
        const table = router._getRoutingTableInternal();
        const idx = table.findIndex(r =>
          (r.type === 'static' || r.type === 'default') &&
          r.network.equals(network) &&
          r.mask.toCIDR() === mask.toCIDR() &&
          r.nextHop?.equals(nextHop)
        );
        if (idx >= 0) {
          table.splice(idx, 1);
          return '';
        }
        return 'Error: Route not found.';
      } catch (e: any) {
        return `Error: ${e.message}`;
      }
    }

    // undo arp static <ip>
    if (args[0] === 'arp' && args.length >= 3 && args[1] === 'static') {
      const arpTable = router._getArpTableInternal();
      if (arpTable.has(args[2])) {
        arpTable.delete(args[2]);
        return '';
      }
      return 'Error: ARP entry not found.';
    }

    // undo shutdown (in interface mode - handled elsewhere, but also from system view)
    if (args[0] === 'shutdown' && this.selectedInterface) {
      const port = router.getPort(this.selectedInterface);
      if (port) port.setUp(true);
      return '';
    }

    return `Error: Unrecognized command "undo ${args.join(' ')}"`;
  }

  // ─── Interface Name Resolution ──────────────────────────────────

  private resolveInterfaceName(router: Router, input: string): string | null {
    // Direct match
    for (const name of router.getPortNames()) {
      if (name.toLowerCase() === input.toLowerCase()) return name;
    }

    // Abbreviation: GE0/0/0 → full port name
    const lower = input.toLowerCase();
    const match = lower.match(/^(ge|gigabitethernet|gi)([\d/]+)$/);
    if (match) {
      const numbers = match[2];
      // Try GE format first (router naming)
      const geResolved = `GE${numbers}`;
      for (const name of router.getPortNames()) {
        if (name === geResolved) return name;
      }
      // Try GigabitEthernet format
      const giResolved = `GigabitEthernet${numbers}`;
      for (const name of router.getPortNames()) {
        if (name === giResolved) return name;
      }
    }

    return null;
  }

  private classfulMask(ip: IPAddress): SubnetMask {
    const firstOctet = ip.getOctets()[0];
    if (firstOctet < 128) return new SubnetMask('255.0.0.0');
    if (firstOctet < 192) return new SubnetMask('255.255.0.0');
    return new SubnetMask('255.255.255.0');
  }
}
