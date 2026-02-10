/**
 * CiscoIOSShell - Cisco IOS CLI emulation for Router Management Plane
 *
 * FSM-based CLI with modes:
 *   user      — Router>        (limited show commands)
 *   privileged — Router#        (full show/debug/clear + configure)
 *   config    — Router(config)# (global configuration)
 *   config-if — Router(config-if)# (interface configuration)
 *   config-dhcp — Router(dhcp-config)# (DHCP pool configuration)
 *   config-router — Router(config-router)# (routing protocol config)
 *
 * Commands include:
 *   show ip route / interface brief / arp / running-config / counters / protocols
 *   show ip dhcp pool / binding / server statistics / conflict / excluded-address
 *   show running-config interface <if>
 *   show debug
 *   configure terminal / interface / ip dhcp pool / router rip
 *   ip address / route / helper-address / forward-protocol / dhcp excluded-address
 *   service dhcp / no service dhcp
 *   debug ip dhcp server {packet|events}
 *   clear ip dhcp {binding|server statistics}
 */

import { IPAddress, SubnetMask } from '../../core/types';
import type { Router } from '../Router';
import type { IRouterShell } from './IRouterShell';

type RouterCLIMode = 'user' | 'privileged' | 'config' | 'config-if' | 'config-dhcp' | 'config-router';

export class CiscoIOSShell implements IRouterShell {
  private mode: RouterCLIMode = 'user';
  private selectedInterface: string | null = null;
  private selectedDHCPPool: string | null = null;

  getOSType(): string { return 'cisco-ios'; }

  getMode(): RouterCLIMode { return this.mode; }

  // ─── Main Execute (replaces old flat dispatch) ────────────────────

  execute(router: Router, cmd: string, args: string[]): string {
    // Reconstruct full input for mode-based parsing
    const fullInput = [cmd, ...args].join(' ').trim();
    if (!fullInput) return '';

    // Global shortcuts
    const lower = fullInput.toLowerCase();
    if (lower === 'exit') return this.cmdExit();
    if (lower === 'end') return this.cmdEnd();
    // Show commands are available from any mode (simulator convenience)
    if (lower.startsWith('show ')) return this.handleShow(router, fullInput.slice(5).trim());

    switch (this.mode) {
      case 'user': return this.execUser(router, fullInput);
      case 'privileged': return this.execPrivileged(router, fullInput);
      case 'config': return this.execConfig(router, fullInput);
      case 'config-if': return this.execConfigIf(router, fullInput);
      case 'config-dhcp': return this.execConfigDHCP(router, fullInput);
      case 'config-router': return this.execConfigRouter(router, fullInput);
      default: return `% Unrecognized command "${fullInput}"`;
    }
  }

  // ─── FSM Transitions ──────────────────────────────────────────────

  private cmdExit(): string {
    switch (this.mode) {
      case 'config-if':
      case 'config-dhcp':
      case 'config-router':
        this.mode = 'config';
        this.selectedInterface = null;
        this.selectedDHCPPool = null;
        return '';
      case 'config':
        this.mode = 'privileged';
        return '';
      case 'privileged':
        this.mode = 'user';
        return '';
      case 'user':
        return '';
      default:
        return '';
    }
  }

  private cmdEnd(): string {
    if (this.mode !== 'user' && this.mode !== 'privileged') {
      this.mode = 'privileged';
      this.selectedInterface = null;
      this.selectedDHCPPool = null;
    }
    return '';
  }

  // ─── User EXEC Mode (>) ──────────────────────────────────────────

  private execUser(router: Router, input: string): string {
    const lower = input.toLowerCase();
    if (lower === 'enable') {
      this.mode = 'privileged';
      return '';
    }
    if (lower.startsWith('show ')) {
      return this.handleShow(router, input.slice(5).trim());
    }
    // Auto-enable for privileged/config commands (simulator convenience)
    if (lower === 'configure terminal' || lower === 'conf t') {
      this.mode = 'config';
      return 'Enter configuration commands, one per line.  End with CNTL/Z.';
    }
    if (lower.startsWith('debug ')) {
      this.mode = 'privileged';
      return this.handleDebug(router, input.slice(6).trim());
    }
    if (lower.startsWith('no debug ')) {
      this.mode = 'privileged';
      return this.handleNoDebug(router, input.slice(9).trim());
    }
    if (lower.startsWith('clear ')) {
      this.mode = 'privileged';
      return this.handleClear(router, input.slice(6).trim());
    }
    // Auto-escalate config-mode commands from user mode (simulator convenience)
    if (lower.startsWith('router ') || lower.startsWith('no router ') ||
        lower.startsWith('interface ') || lower.startsWith('ip ') ||
        lower.startsWith('no ip ') || lower.startsWith('service ') ||
        lower.startsWith('no service ') || lower.startsWith('hostname ')) {
      this.mode = 'config';
      return this.execConfig(router, input);
    }
    return `% Unrecognized command "${input}"`;
  }

  // ─── Privileged EXEC Mode (#) ────────────────────────────────────

  private execPrivileged(router: Router, input: string): string {
    const lower = input.toLowerCase();

    if (lower === 'enable') return '';

    if (lower === 'configure terminal' || lower === 'conf t') {
      this.mode = 'config';
      return 'Enter configuration commands, one per line.  End with CNTL/Z.';
    }

    if (lower.startsWith('show ')) {
      return this.handleShow(router, input.slice(5).trim());
    }

    if (lower.startsWith('debug ')) {
      return this.handleDebug(router, input.slice(6).trim());
    }

    if (lower.startsWith('no debug ')) {
      return this.handleNoDebug(router, input.slice(9).trim());
    }

    if (lower.startsWith('clear ')) {
      return this.handleClear(router, input.slice(6).trim());
    }

    // Auto-escalate config-mode commands from privileged mode (simulator convenience)
    if (lower.startsWith('router ') || lower.startsWith('no router ') ||
        lower.startsWith('interface ') || lower.startsWith('ip ') ||
        lower.startsWith('no ip ') || lower.startsWith('service ') ||
        lower.startsWith('no service ') || lower.startsWith('hostname ')) {
      this.mode = 'config';
      return this.execConfig(router, input);
    }

    return `% Unrecognized command "${input}"`;
  }

  // ─── Global Config Mode ((config)#) ──────────────────────────────

  private execConfig(router: Router, input: string): string {
    const lower = input.toLowerCase();
    const parts = input.trim().split(/\s+/);

    // hostname
    if (lower.startsWith('hostname ') && parts.length >= 2) {
      router._setHostnameInternal(parts[1]);
      return '';
    }

    // service dhcp
    if (lower === 'service dhcp') {
      router._getDHCPServerInternal().enable();
      return '';
    }
    if (lower === 'no service dhcp') {
      router._getDHCPServerInternal().disable();
      return '';
    }

    // interface <name>
    if (lower.startsWith('interface ') && parts.length >= 2) {
      const ifName = this.resolveInterfaceName(router, parts.slice(1).join(' '));
      if (!ifName) return `% Invalid interface "${parts.slice(1).join(' ')}"`;
      this.selectedInterface = ifName;
      this.mode = 'config-if';
      return '';
    }

    // ip dhcp pool <name>
    if (lower.startsWith('ip dhcp pool ') && parts.length >= 4) {
      const poolName = parts[3];
      const dhcp = router._getDHCPServerInternal();
      if (!dhcp.getPool(poolName)) {
        dhcp.createPool(poolName);
      }
      this.selectedDHCPPool = poolName;
      this.mode = 'config-dhcp';
      return '';
    }

    // ip dhcp excluded-address <start> [<end>]
    if (lower.startsWith('ip dhcp excluded-address ')) {
      const addrParts = parts.slice(3);
      if (addrParts.length < 1) return '% Incomplete command.';
      const start = addrParts[0];
      const end = addrParts[1] || start;
      router._getDHCPServerInternal().addExcludedRange(start, end);
      return '';
    }

    // ip route <net> <mask> <nh>
    if (lower.startsWith('ip route ') && parts.length >= 5) {
      return this.cmdIpRoute(router, parts.slice(2));
    }

    // router rip
    if (lower === 'router rip') {
      if (!router.isRIPEnabled()) router.enableRIP();
      this.mode = 'config-router';
      return '';
    }

    // no router rip
    if (lower === 'no router rip') {
      router.disableRIP();
      return '';
    }

    // no shutdown (no-op in global config)
    if (lower === 'no shutdown') return '';

    // show running-config (from config mode)
    if (lower.startsWith('show ') || lower.startsWith('do show ')) {
      const showArgs = lower.startsWith('do ') ? input.slice(8).trim() : input.slice(5).trim();
      return this.handleShow(router, showArgs);
    }

    return `% Unrecognized command "${input}"`;
  }

  // ─── Interface Config Mode ((config-if)#) ─────────────────────────

  private execConfigIf(router: Router, input: string): string {
    const lower = input.toLowerCase();
    const parts = input.trim().split(/\s+/);

    if (!this.selectedInterface) return '% No interface selected';

    // ip address <ip> <mask>
    if (lower.startsWith('ip address ') && parts.length >= 4) {
      try {
        router.configureInterface(this.selectedInterface, new IPAddress(parts[2]), new SubnetMask(parts[3]));
        return '';
      } catch (e: any) {
        return `% Invalid input: ${e.message}`;
      }
    }

    // no shutdown
    if (lower === 'no shutdown') {
      const port = router.getPort(this.selectedInterface);
      if (port) port.setUp(true);
      return '';
    }

    // shutdown
    if (lower === 'shutdown') {
      const port = router.getPort(this.selectedInterface);
      if (port) port.setUp(false);
      return '';
    }

    // ip helper-address <ip>
    if (lower.startsWith('ip helper-address ') && parts.length >= 3) {
      router._getDHCPServerInternal().addHelperAddress(this.selectedInterface, parts[2]);
      return '';
    }

    // ip forward-protocol udp <service>
    if (lower.startsWith('ip forward-protocol udp ')) {
      const service = parts[3];
      const portNum = service === 'bootps' ? 67 : service === 'bootpc' ? 68 : parseInt(service, 10);
      if (!isNaN(portNum)) {
        router._getDHCPServerInternal().addForwardProtocol(portNum);
      }
      return '';
    }

    return `% Unrecognized command "${input}"`;
  }

  // ─── DHCP Pool Config Mode ((dhcp-config)#) ───────────────────────

  private execConfigDHCP(router: Router, input: string): string {
    const lower = input.toLowerCase();
    const parts = input.trim().split(/\s+/);
    const pool = this.selectedDHCPPool;
    const dhcp = router._getDHCPServerInternal();

    if (!pool) return '% No DHCP pool selected';

    // network <ip> <mask>
    if (lower.startsWith('network ') && parts.length >= 3) {
      dhcp.configurePoolNetwork(pool, parts[1], parts[2]);
      return '';
    }

    // default-router <ip>
    if (lower.startsWith('default-router ') && parts.length >= 2) {
      dhcp.configurePoolRouter(pool, parts[1]);
      return '';
    }

    // dns-server <ip> [<ip2>...]
    if (lower.startsWith('dns-server ')) {
      dhcp.configurePoolDNS(pool, parts.slice(1));
      return '';
    }

    // domain-name <name>
    if (lower.startsWith('domain-name ') && parts.length >= 2) {
      dhcp.configurePoolDomain(pool, parts[1]);
      return '';
    }

    // lease <days> [<hours> [<seconds>]]
    if (lower.startsWith('lease ')) {
      const leaseArgs = parts.slice(1).map(Number);
      let seconds = 0;
      if (leaseArgs.length >= 1) seconds += leaseArgs[0] * 86400; // days
      if (leaseArgs.length >= 2) seconds += leaseArgs[1] * 3600;  // hours
      if (leaseArgs.length >= 3) seconds += leaseArgs[2];          // seconds
      if (seconds === 0) seconds = 86400; // default 1 day
      dhcp.configurePoolLease(pool, seconds);
      return '';
    }

    // client-identifier deny <pattern>
    if (lower.startsWith('client-identifier deny ') && parts.length >= 3) {
      dhcp.addDenyPattern(pool, parts[2]);
      return '';
    }

    return `% Unrecognized command "${input}"`;
  }

  // ─── Router Config Mode ((config-router)#) ────────────────────────

  private execConfigRouter(router: Router, input: string): string {
    const lower = input.toLowerCase();
    const parts = input.trim().split(/\s+/);

    // no router rip (exit config-router and disable)
    if (lower === 'no router rip') {
      this.mode = 'config';
      router.disableRIP();
      return '';
    }

    // network <ip> [<mask>]
    if (lower.startsWith('network ') && parts.length >= 2) {
      if (!router.isRIPEnabled()) return '% RIP is not enabled.';
      try {
        const network = new IPAddress(parts[1]);
        const mask = parts.length >= 3 ? new SubnetMask(parts[2]) : this.classfulMask(network);
        router.ripAdvertiseNetwork(network, mask);
        return '';
      } catch (e: any) {
        return `% Invalid input: ${e.message}`;
      }
    }

    // version 2
    if (lower === 'version 2') return '';

    return `% Unrecognized command "${input}"`;
  }

  // ─── Show Commands ────────────────────────────────────────────────

  private handleShow(router: Router, sub: string): string {
    const lower = sub.toLowerCase();

    if (lower === 'ip route' || lower === 'ip route table') return this.showIpRoute(router);
    if (lower === 'ip interface brief' || lower === 'ip int brief') return this.showIpIntBrief(router);
    if (lower === 'arp') return this.showArp(router);
    if (lower === 'running-config' || lower === 'run') return this.showRunningConfig(router);
    if (lower === 'counters' || lower === 'ip traffic') return this.showCounters(router);
    if (lower === 'ip protocols' || lower === 'ip rip') return this.showIpProtocols(router);

    // DHCP show commands
    if (lower === 'ip dhcp pool') return router._getDHCPServerInternal().formatPoolShow();
    if (lower.startsWith('ip dhcp pool ')) {
      const poolName = sub.slice(13).trim();
      return router._getDHCPServerInternal().formatPoolShow(poolName);
    }
    if (lower === 'ip dhcp binding') return router._getDHCPServerInternal().formatBindingsShow();
    if (lower === 'ip dhcp server statistics') return router._getDHCPServerInternal().formatStatsShow();
    if (lower === 'ip dhcp conflict') return router._getDHCPServerInternal().formatConflictShow();
    if (lower === 'ip dhcp excluded-address') return router._getDHCPServerInternal().formatExcludedShow();

    // Debug show
    if (lower === 'debug') return this.showDebug(router);

    // show running-config interface <name>
    if (lower.startsWith('running-config interface ')) {
      const ifName = this.resolveInterfaceName(router, sub.slice(24).trim());
      if (!ifName) return `% Invalid interface`;
      return this.showRunningConfigInterface(router, ifName);
    }

    return `% Unrecognized command "show ${sub}"`;
  }

  // ─── Debug Commands ───────────────────────────────────────────────

  private handleDebug(router: Router, sub: string): string {
    const lower = sub.toLowerCase();
    const dhcp = router._getDHCPServerInternal();

    if (lower === 'ip dhcp server packet') {
      dhcp.setDebugServerPacket(true);
      return 'DHCP server packet debugging is on';
    }
    if (lower === 'ip dhcp server events') {
      dhcp.setDebugServerEvents(true);
      return 'DHCP server event debugging is on';
    }

    return `% Unrecognized debug command "${sub}"`;
  }

  private handleNoDebug(router: Router, sub: string): string {
    const lower = sub.toLowerCase();
    const dhcp = router._getDHCPServerInternal();

    if (lower === 'ip dhcp server packet') {
      dhcp.setDebugServerPacket(false);
      return '';
    }
    if (lower === 'ip dhcp server events') {
      dhcp.setDebugServerEvents(false);
      return '';
    }

    return `% Unrecognized command`;
  }

  private showDebug(router: Router): string {
    return router._getDHCPServerInternal().formatDebugShow();
  }

  // ─── Clear Commands ───────────────────────────────────────────────

  private handleClear(router: Router, sub: string): string {
    const lower = sub.toLowerCase();
    const dhcp = router._getDHCPServerInternal();

    if (lower === 'ip dhcp binding *') {
      dhcp.clearBindings();
      return '';
    }
    if (lower.startsWith('ip dhcp binding ')) {
      const ip = sub.slice(16).trim();
      dhcp.clearBinding(ip);
      return '';
    }
    if (lower === 'ip dhcp server statistics') {
      dhcp.clearStats();
      return '';
    }

    return `% Unrecognized command "clear ${sub}"`;
  }

  // ─── Show Implementations ─────────────────────────────────────────

  private showIpRoute(router: Router): string {
    const table = router.getRoutingTable();
    const lines = ['Codes: C - connected, S - static, R - RIP, * - candidate default', ''];
    const sorted = [...table].sort((a, b) => {
      const order: Record<string, number> = { connected: 0, rip: 1, static: 2, default: 3 };
      return (order[a.type] ?? 4) - (order[b.type] ?? 4);
    });
    for (const r of sorted) {
      let code: string;
      switch (r.type) {
        case 'connected': code = 'C'; break;
        case 'rip': code = 'R'; break;
        case 'default': code = 'S*'; break;
        default: code = 'S'; break;
      }
      const via = r.nextHop ? `via ${r.nextHop}` : 'is directly connected';
      const metricStr = r.type === 'rip' ? ` [${r.ad}/${r.metric}]` : '';
      lines.push(`${code}    ${r.network}/${r.mask.toCIDR()}${metricStr} ${via}, ${r.iface}`);
    }
    return lines.length > 2 ? lines.join('\n') : 'No routes configured.';
  }

  private showIpIntBrief(router: Router): string {
    const ports = router._getPortsInternal();
    const lines = ['Interface                  IP-Address      OK? Method Status                Protocol'];
    for (const [name, port] of ports) {
      const ip = port.getIPAddress()?.toString() || 'unassigned';
      const status = port.isConnected() ? 'up' : 'administratively down';
      const proto = port.isConnected() ? 'up' : 'down';
      lines.push(`${name.padEnd(27)}${ip.padEnd(16)}YES manual ${status.padEnd(22)}${proto}`);
    }
    return lines.join('\n');
  }

  private showArp(router: Router): string {
    const arpTable = router._getArpTableInternal();
    if (arpTable.size === 0) return 'No ARP entries.';
    const lines = ['Protocol  Address          Age (min)   Hardware Addr   Type   Interface'];
    for (const [ip, entry] of arpTable) {
      const age = Math.floor((Date.now() - entry.timestamp) / 60000);
      lines.push(`Internet  ${ip.padEnd(17)}${String(age).padEnd(12)}${entry.mac.toString().padEnd(16)}ARPA   ${entry.iface}`);
    }
    return lines.join('\n');
  }

  private showRunningConfig(router: Router): string {
    const ports = router._getPortsInternal();
    const table = router._getRoutingTableInternal();
    const dhcp = router._getDHCPServerInternal();
    const lines = [
      'Building configuration...',
      '',
      'Current configuration:',
      '!',
      `hostname ${router._getHostnameInternal()}`,
      '!',
    ];

    // DHCP config
    if (dhcp.isEnabled()) {
      lines.push('service dhcp');
    }
    const pools = dhcp.getAllPools();
    for (const [, pool] of pools) {
      lines.push('!');
      lines.push(`ip dhcp pool ${pool.name}`);
      if (pool.network && pool.mask) lines.push(` network ${pool.network} ${pool.mask}`);
      if (pool.defaultRouter) lines.push(` default-router ${pool.defaultRouter}`);
      if (pool.dnsServers.length > 0) lines.push(` dns-server ${pool.dnsServers.join(' ')}`);
      if (pool.domainName) lines.push(` domain-name ${pool.domainName}`);
      const days = Math.floor(pool.leaseDuration / 86400);
      if (days !== 1) lines.push(` lease ${days}`);
    }
    const excluded = dhcp.getExcludedRanges();
    for (const range of excluded) {
      if (range.start === range.end) {
        lines.push(`ip dhcp excluded-address ${range.start}`);
      } else {
        lines.push(`ip dhcp excluded-address ${range.start} ${range.end}`);
      }
    }

    lines.push('!');
    for (const [name, port] of ports) {
      lines.push(`interface ${name}`);
      const ip = port.getIPAddress();
      const mask = port.getSubnetMask();
      if (ip && mask) {
        lines.push(` ip address ${ip} ${mask}`);
        lines.push(` no shutdown`);
      } else {
        lines.push(` shutdown`);
      }
      // Show helper addresses
      const helpers = dhcp.getHelperAddresses(name);
      for (const h of helpers) {
        lines.push(` ip helper-address ${h}`);
      }
      lines.push('!');
    }

    for (const r of table) {
      if (r.type === 'static' && r.nextHop) lines.push(`ip route ${r.network} ${r.mask} ${r.nextHop}`);
      if (r.type === 'default' && r.nextHop) lines.push(`ip route 0.0.0.0 0.0.0.0 ${r.nextHop}`);
    }

    // RIP config
    if (router.isRIPEnabled()) {
      lines.push('!');
      lines.push('router rip');
      lines.push(' version 2');
      const cfg = router.getRIPConfig();
      for (const net of cfg.networks) {
        lines.push(` network ${net.network}`);
      }
    }

    lines.push('!');
    lines.push('end');
    return lines.join('\n');
  }

  private showRunningConfigInterface(router: Router, ifName: string): string {
    const port = router.getPort(ifName);
    if (!port) return `% Invalid interface "${ifName}"`;

    const ip = port.getIPAddress();
    const mask = port.getSubnetMask();
    const dhcp = router._getDHCPServerInternal();
    const lines = [
      'Building configuration...',
      '',
      `Current configuration : interface ${ifName}`,
      '!',
      `interface ${ifName}`,
    ];
    if (ip && mask) {
      lines.push(` ip address ${ip} ${mask}`);
      lines.push(` no shutdown`);
    } else {
      lines.push(` shutdown`);
    }
    const helpers = dhcp.getHelperAddresses(ifName);
    for (const h of helpers) {
      lines.push(` ip helper-address ${h}`);
    }
    lines.push('end');
    return lines.join('\n');
  }

  private showCounters(router: Router): string {
    const c = router.getCounters();
    return [
      'IP statistics:',
      `  Rcvd:  ${c.ifInOctets} total octets`,
      `  Sent:  ${c.ifOutOctets} total octets`,
      `  Frags: ${c.ipForwDatagrams} forwarded`,
      `  Drop:  ${c.ipInHdrErrors} header errors, ${c.ipInAddrErrors} address errors`,
      '',
      'ICMP statistics:',
      `  Sent: ${c.icmpOutMsgs} total`,
      `    Destination unreachable: ${c.icmpOutDestUnreachs}`,
      `    Time exceeded: ${c.icmpOutTimeExcds}`,
      `    Echo replies: ${c.icmpOutEchoReps}`,
    ].join('\n');
  }

  private showIpProtocols(router: Router): string {
    if (!router.isRIPEnabled()) return 'No routing protocol is configured.';
    const cfg = router.getRIPConfig();
    const ripRoutes = router.getRIPRoutes();
    const lines = [
      'Routing Protocol is "rip"',
      '  Version: 2',
      `  Update interval: ${cfg.updateInterval / 1000}s`,
      `  Route timeout: ${cfg.routeTimeout / 1000}s`,
      `  Garbage collection: ${cfg.gcTimeout / 1000}s`,
      `  Split horizon: ${cfg.splitHorizon ? 'enabled' : 'disabled'}`,
      `  Poisoned reverse: ${cfg.poisonedReverse ? 'enabled' : 'disabled'}`,
      '',
      '  Advertised networks:',
    ];
    for (const net of cfg.networks) {
      lines.push(`    ${net.network}/${net.mask.toCIDR()}`);
    }
    lines.push('');
    lines.push(`  RIP learned routes: ${ripRoutes.size}`);
    for (const [key, info] of ripRoutes) {
      lines.push(`    ${key} metric ${info.metric} via ${info.learnedFrom} (age ${info.age}s)${info.garbageCollect ? ' [gc]' : ''}`);
    }
    return lines.join('\n');
  }

  // ─── IP Route (config mode) ───────────────────────────────────────

  private cmdIpRoute(router: Router, args: string[]): string {
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

  // ─── Interface Name Resolution ────────────────────────────────────

  private resolveInterfaceName(router: Router, input: string): string | null {
    const combined = input.replace(/\s+/g, '');
    const lower = combined.toLowerCase();

    // Direct match
    for (const name of router.getPortNames()) {
      if (name.toLowerCase() === lower || name === input.trim()) return name;
    }

    // Abbreviation expansion
    const prefixMap: Record<string, string> = {
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

  /** Determine classful mask from IP address (for RIP network command) */
  private classfulMask(ip: IPAddress): SubnetMask {
    const firstOctet = ip.getOctets()[0];
    if (firstOctet < 128) return new SubnetMask('255.0.0.0');
    if (firstOctet < 192) return new SubnetMask('255.255.0.0');
    return new SubnetMask('255.255.255.0');
  }
}
