/**
 * CiscoIOSShell - Cisco IOS CLI emulation for Router Management Plane
 *
 * FSM-based CLI with CommandTrie for abbreviation/help support:
 *   user        — Router>           (limited show commands)
 *   privileged  — Router#           (full show/debug/clear + configure)
 *   config      — Router(config)#   (global configuration)
 *   config-if   — Router(config-if)# (interface configuration)
 *   config-dhcp — Router(dhcp-config)# (DHCP pool configuration)
 *   config-router — Router(config-router)# (routing protocol config)
 *
 * Features:
 *   - Abbreviation matching (e.g. "sh ip ro" → "show ip route")
 *   - Context-aware ? help listing valid completions
 *   - Pipe filtering: "show ... | include <pattern>"
 *   - 'do' prefix in config modes (execute privileged command)
 *   - 'show' shortcut in config modes
 */

import { IPAddress, SubnetMask } from '../../core/types';
import type { Router } from '../Router';
import type { IRouterShell } from './IRouterShell';
import { CommandTrie, type CommandAction } from './CommandTrie';

type RouterCLIMode = 'user' | 'privileged' | 'config' | 'config-if' | 'config-dhcp' | 'config-router';

export class CiscoIOSShell implements IRouterShell {
  private mode: RouterCLIMode = 'user';
  private selectedInterface: string | null = null;
  private selectedDHCPPool: string | null = null;

  /** Temporary reference set during execute() for closures */
  private routerRef: Router | null = null;

  // Per-mode command tries
  private userTrie = new CommandTrie();
  private privilegedTrie = new CommandTrie();
  private configTrie = new CommandTrie();
  private configIfTrie = new CommandTrie();
  private configDhcpTrie = new CommandTrie();
  private configRouterTrie = new CommandTrie();

  constructor() {
    this.buildUserCommands();
    this.buildPrivilegedCommands();
    this.buildConfigCommands();
    this.buildConfigIfCommands();
    this.buildConfigDhcpCommands();
    this.buildConfigRouterCommands();
  }

  getOSType(): string { return 'cisco-ios'; }

  getMode(): RouterCLIMode { return this.mode; }

  // ─── Prompt Generation ─────────────────────────────────────────────

  getPrompt(router: Router): string {
    const host = router._getHostnameInternal();
    switch (this.mode) {
      case 'user':          return `${host}>`;
      case 'privileged':    return `${host}#`;
      case 'config':        return `${host}(config)#`;
      case 'config-if':     return `${host}(config-if)#`;
      case 'config-dhcp':   return `${host}(dhcp-config)#`;
      case 'config-router': return `${host}(config-router)#`;
      default:              return `${host}>`;
    }
  }

  // ─── Main Execute ──────────────────────────────────────────────────

  execute(router: Router, rawInput: string): string {
    const trimmed = rawInput.trim();
    if (!trimmed) return '';

    // Handle pipe filtering: "show logging | include DHCP"
    let pipeFilter: { type: string; pattern: string } | null = null;
    let cmdPart = trimmed;
    const pipeIdx = trimmed.indexOf(' | ');
    if (pipeIdx !== -1) {
      cmdPart = trimmed.substring(0, pipeIdx).trim();
      const filterPart = trimmed.substring(pipeIdx + 3).trim();
      const filterMatch = filterPart.match(/^(include|exclude|grep|findstr)\s+(.+)$/i);
      if (filterMatch) {
        pipeFilter = { type: filterMatch[1].toLowerCase(), pattern: filterMatch[2] };
      }
    }

    // Handle ? for help
    if (cmdPart.endsWith('?')) {
      const helpInput = cmdPart.slice(0, -1);
      return this.getHelp(helpInput);
    }

    // Global shortcuts
    const lower = cmdPart.toLowerCase();
    if (lower === 'exit') return this.cmdExit();
    if (lower === 'end') return this.cmdEnd();
    if (lower === 'logout' && this.mode === 'user') return 'Connection closed.';
    if (lower === 'disable' && this.mode === 'privileged') {
      this.mode = 'user';
      return '';
    }

    // Bind router reference for command closures
    this.routerRef = router;

    // Handle 'do' prefix in config modes
    if (this.mode !== 'user' && this.mode !== 'privileged' && lower.startsWith('do ')) {
      const subCmd = cmdPart.slice(3).trim();
      // Temporarily switch to privileged mode for execution
      const savedMode = this.mode;
      this.mode = 'privileged';
      let output = this.executeOnTrie(subCmd);
      this.mode = savedMode;
      this.routerRef = null;
      return this.applyPipeFilter(output, pipeFilter);
    }

    // Handle 'show' shortcut in config modes (real Cisco IOS behavior)
    if (this.mode !== 'user' && this.mode !== 'privileged' && lower.startsWith('show ')) {
      const savedMode = this.mode;
      this.mode = 'privileged';
      let output = this.executeOnTrie(cmdPart);
      this.mode = savedMode;
      this.routerRef = null;
      return this.applyPipeFilter(output, pipeFilter);
    }

    let output = this.executeOnTrie(cmdPart);
    this.routerRef = null;

    return this.applyPipeFilter(output, pipeFilter);
  }

  private executeOnTrie(cmdPart: string): string {
    const trie = this.getActiveTrie();
    const result = trie.match(cmdPart);

    switch (result.status) {
      case 'ok':
        if (result.node?.action) {
          return result.node.action(result.args, cmdPart);
        }
        return '';

      case 'ambiguous':
        return result.error || `% Ambiguous command: "${cmdPart}"`;

      case 'incomplete':
        return result.error || '% Incomplete command.';

      case 'invalid':
        return result.error || `% Invalid input detected at '^' marker.`;

      default:
        return `% Unrecognized command "${cmdPart}"`;
    }
  }

  private applyPipeFilter(output: string, pipeFilter: { type: string; pattern: string } | null): string {
    if (!pipeFilter || !output) return output;
    const lines = output.split('\n');
    // Remove quotes from pattern (like the grep pipe does)
    let pattern = pipeFilter.pattern;
    if ((pattern.startsWith('"') && pattern.endsWith('"')) ||
        (pattern.startsWith("'") && pattern.endsWith("'"))) {
      pattern = pattern.slice(1, -1);
    }
    const lowerPattern = pattern.toLowerCase();
    if (pipeFilter.type === 'include' || pipeFilter.type === 'grep' || pipeFilter.type === 'findstr') {
      return lines.filter(l => l.toLowerCase().includes(lowerPattern)).join('\n');
    } else if (pipeFilter.type === 'exclude') {
      return lines.filter(l => !l.toLowerCase().includes(lowerPattern)).join('\n');
    }
    return output;
  }

  // ─── Help / Completion ─────────────────────────────────────────────

  getHelp(input: string): string {
    const trie = this.getActiveTrie();
    const completions = trie.getCompletions(input);
    if (completions.length === 0) return '% Unrecognized command';
    const maxKw = Math.max(...completions.map(c => c.keyword.length));
    return completions
      .map(c => `  ${c.keyword.padEnd(maxKw + 2)}${c.description}`)
      .join('\n');
  }

  tabComplete(input: string): string | null {
    const trie = this.getActiveTrie();
    return trie.tabComplete(input);
  }

  // ─── Active Trie Selection ─────────────────────────────────────────

  private getActiveTrie(): CommandTrie {
    switch (this.mode) {
      case 'user': return this.userTrie;
      case 'privileged': return this.privilegedTrie;
      case 'config': return this.configTrie;
      case 'config-if': return this.configIfTrie;
      case 'config-dhcp': return this.configDhcpTrie;
      case 'config-router': return this.configRouterTrie;
      default: return this.userTrie;
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

  // ═══════════════════════════════════════════════════════════════════
  // Command Registration (per-mode CommandTrie construction)
  // ═══════════════════════════════════════════════════════════════════

  // ─── User EXEC Mode (>) ──────────────────────────────────────────

  private buildUserCommands(): void {
    const t = this.userTrie;

    t.register('enable', 'Enter privileged EXEC mode', () => {
      this.mode = 'privileged';
      return '';
    });

    // show commands (limited in user mode)
    this.registerShowCommands(t);

    t.registerGreedy('ping', 'Send echo messages', () => {
      return '% Use "enable" to access privileged commands first.';
    });
  }

  // ─── Privileged EXEC Mode (#) ─────────────────────────────────────

  private buildPrivilegedCommands(): void {
    const t = this.privilegedTrie;

    t.register('enable', 'Enter privileged EXEC mode (already in)', () => '');

    t.register('configure terminal', 'Enter configuration mode', () => {
      this.mode = 'config';
      return 'Enter configuration commands, one per line.  End with CNTL/Z.';
    });

    t.register('disable', 'Return to user EXEC mode', () => {
      this.mode = 'user';
      return '';
    });

    t.register('copy running-config startup-config', 'Save configuration', () => {
      return '[OK]';
    });

    t.register('write memory', 'Save configuration', () => {
      return 'Building configuration...\n[OK]';
    });

    // show commands
    this.registerShowCommands(t);

    // debug commands
    t.register('debug ip dhcp server packet', 'Debug DHCP server packets', () => {
      this.r()._getDHCPServerInternal().setDebugServerPacket(true);
      return 'DHCP server packet debugging is on';
    });
    t.register('debug ip dhcp server events', 'Debug DHCP server events', () => {
      this.r()._getDHCPServerInternal().setDebugServerEvents(true);
      return 'DHCP server event debugging is on';
    });

    // no debug commands
    t.register('no debug ip dhcp server packet', 'Disable DHCP packet debugging', () => {
      this.r()._getDHCPServerInternal().setDebugServerPacket(false);
      return '';
    });
    t.register('no debug ip dhcp server events', 'Disable DHCP event debugging', () => {
      this.r()._getDHCPServerInternal().setDebugServerEvents(false);
      return '';
    });

    // clear commands
    t.registerGreedy('clear ip dhcp binding', 'Clear DHCP bindings', (args) => {
      const dhcp = this.r()._getDHCPServerInternal();
      if (args.length > 0 && args[0] === '*') {
        dhcp.clearBindings();
      } else if (args.length > 0) {
        dhcp.clearBinding(args[0]);
      } else {
        return '% Incomplete command.';
      }
      return '';
    });
    t.register('clear ip dhcp server statistics', 'Clear DHCP server statistics', () => {
      this.r()._getDHCPServerInternal().clearStats();
      return '';
    });

    // ping (greedy to accept IP/hostname)
    t.registerGreedy('ping', 'Send echo messages', () => {
      return '% Ping requires a target IP address.';
    });
  }

  // ─── Global Config Mode ((config)#) ──────────────────────────────

  private buildConfigCommands(): void {
    const t = this.configTrie;

    t.registerGreedy('hostname', 'Set system hostname', (args) => {
      if (args.length < 1) return '% Incomplete command.';
      this.r()._setHostnameInternal(args[0]);
      return '';
    });

    t.register('service dhcp', 'Enable DHCP service', () => {
      this.r()._getDHCPServerInternal().enable();
      return '';
    });
    t.register('no service dhcp', 'Disable DHCP service', () => {
      this.r()._getDHCPServerInternal().disable();
      return '';
    });

    t.registerGreedy('interface', 'Select an interface to configure', (args) => {
      if (args.length < 1) return '% Incomplete command.';
      const ifName = this.resolveInterfaceName(this.r(), args.join(' '));
      if (!ifName) return `% Invalid interface "${args.join(' ')}"`;
      this.selectedInterface = ifName;
      this.mode = 'config-if';
      return '';
    });

    t.registerGreedy('ip dhcp pool', 'Define a DHCP address pool', (args) => {
      if (args.length < 1) return '% Incomplete command.';
      const poolName = args[0];
      const dhcp = this.r()._getDHCPServerInternal();
      if (!dhcp.getPool(poolName)) {
        dhcp.createPool(poolName);
      }
      this.selectedDHCPPool = poolName;
      this.mode = 'config-dhcp';
      return '';
    });

    t.registerGreedy('ip dhcp excluded-address', 'Prevent DHCP from assigning certain addresses', (args) => {
      if (args.length < 1) return '% Incomplete command.';
      const start = args[0];
      const end = args[1] || start;
      this.r()._getDHCPServerInternal().addExcludedRange(start, end);
      return '';
    });

    t.registerGreedy('ip route', 'Establish static routes', (args) => {
      return this.cmdIpRoute(this.r(), args);
    });

    t.register('router rip', 'Enter RIP routing protocol configuration', () => {
      if (!this.r().isRIPEnabled()) this.r().enableRIP();
      this.mode = 'config-router';
      return '';
    });

    t.register('no router rip', 'Disable RIP routing protocol', () => {
      this.r().disableRIP();
      return '';
    });

    t.register('no shutdown', 'Enable (no-op in global config)', () => '');

    // do prefix is handled in execute() before trie matching
    // show prefix is handled in execute() before trie matching
  }

  // ─── Interface Config Mode ((config-if)#) ─────────────────────────

  private buildConfigIfCommands(): void {
    const t = this.configIfTrie;

    t.registerGreedy('ip address', 'Set interface IP address', (args) => {
      if (args.length < 2) return '% Incomplete command.';
      if (!this.selectedInterface) return '% No interface selected';
      try {
        this.r().configureInterface(this.selectedInterface, new IPAddress(args[0]), new SubnetMask(args[1]));
        return '';
      } catch (e: any) {
        return `% Invalid input: ${e.message}`;
      }
    });

    t.register('no shutdown', 'Enable interface', () => {
      if (!this.selectedInterface) return '% No interface selected';
      const port = this.r().getPort(this.selectedInterface);
      if (port) port.setUp(true);
      return '';
    });

    t.register('shutdown', 'Disable interface', () => {
      if (!this.selectedInterface) return '% No interface selected';
      const port = this.r().getPort(this.selectedInterface);
      if (port) port.setUp(false);
      return '';
    });

    t.registerGreedy('ip helper-address', 'Set DHCP relay agent address', (args) => {
      if (args.length < 1) return '% Incomplete command.';
      if (!this.selectedInterface) return '% No interface selected';
      this.r()._getDHCPServerInternal().addHelperAddress(this.selectedInterface, args[0]);
      return '';
    });

    t.registerGreedy('ip forward-protocol udp', 'Forward UDP port', (args) => {
      if (args.length < 1) return '% Incomplete command.';
      const service = args[0];
      const portNum = service === 'bootps' ? 67 : service === 'bootpc' ? 68 : parseInt(service, 10);
      if (!isNaN(portNum)) {
        this.r()._getDHCPServerInternal().addForwardProtocol(portNum);
      }
      return '';
    });

    // do/show handled in execute()
  }

  // ─── DHCP Pool Config Mode ((dhcp-config)#) ────────────────────────

  private buildConfigDhcpCommands(): void {
    const t = this.configDhcpTrie;

    t.registerGreedy('network', 'Define DHCP pool network', (args) => {
      if (args.length < 2) return '% Incomplete command.';
      if (!this.selectedDHCPPool) return '% No DHCP pool selected';
      this.r()._getDHCPServerInternal().configurePoolNetwork(this.selectedDHCPPool, args[0], args[1]);
      return '';
    });

    t.registerGreedy('default-router', 'Set default router for DHCP clients', (args) => {
      if (args.length < 1) return '% Incomplete command.';
      if (!this.selectedDHCPPool) return '% No DHCP pool selected';
      this.r()._getDHCPServerInternal().configurePoolRouter(this.selectedDHCPPool, args[0]);
      return '';
    });

    t.registerGreedy('dns-server', 'Set DNS server for DHCP clients', (args) => {
      if (args.length < 1) return '% Incomplete command.';
      if (!this.selectedDHCPPool) return '% No DHCP pool selected';
      this.r()._getDHCPServerInternal().configurePoolDNS(this.selectedDHCPPool, args);
      return '';
    });

    t.registerGreedy('domain-name', 'Set domain name for DHCP clients', (args) => {
      if (args.length < 1) return '% Incomplete command.';
      if (!this.selectedDHCPPool) return '% No DHCP pool selected';
      this.r()._getDHCPServerInternal().configurePoolDomain(this.selectedDHCPPool, args[0]);
      return '';
    });

    t.registerGreedy('lease', 'Set DHCP lease duration', (args) => {
      if (args.length < 1) return '% Incomplete command.';
      if (!this.selectedDHCPPool) return '% No DHCP pool selected';
      const leaseArgs = args.map(Number);
      let seconds = 0;
      if (leaseArgs.length >= 1) seconds += leaseArgs[0] * 86400; // days
      if (leaseArgs.length >= 2) seconds += leaseArgs[1] * 3600;  // hours
      if (leaseArgs.length >= 3) seconds += leaseArgs[2];          // seconds
      if (seconds === 0) seconds = 86400; // default 1 day
      this.r()._getDHCPServerInternal().configurePoolLease(this.selectedDHCPPool, seconds);
      return '';
    });

    t.registerGreedy('client-identifier deny', 'Deny DHCP by client identifier', (args) => {
      if (args.length < 1) return '% Incomplete command.';
      if (!this.selectedDHCPPool) return '% No DHCP pool selected';
      this.r()._getDHCPServerInternal().addDenyPattern(this.selectedDHCPPool, args[0]);
      return '';
    });

    // do/show handled in execute()
  }

  // ─── Router Config Mode ((config-router)#) ────────────────────────

  private buildConfigRouterCommands(): void {
    const t = this.configRouterTrie;

    t.registerGreedy('network', 'Advertise a network in RIP', (args) => {
      if (args.length < 1) return '% Incomplete command.';
      if (!this.r().isRIPEnabled()) return '% RIP is not enabled.';
      try {
        const network = new IPAddress(args[0]);
        const mask = args.length >= 2 ? new SubnetMask(args[1]) : this.classfulMask(network);
        this.r().ripAdvertiseNetwork(network, mask);
        return '';
      } catch (e: any) {
        return `% Invalid input: ${e.message}`;
      }
    });

    t.register('version 2', 'Use RIPv2', () => '');

    t.register('no router rip', 'Disable RIP and exit to config mode', () => {
      this.mode = 'config';
      this.r().disableRIP();
      return '';
    });

    // do/show handled in execute()
  }

  // ─── Shared Show Commands ──────────────────────────────────────────

  private registerShowCommands(trie: CommandTrie): void {
    trie.register('show ip route', 'Display IP routing table', () => this.showIpRoute(this.r()));
    trie.register('show ip interface brief', 'Display interface status summary', () => this.showIpIntBrief(this.r()));
    trie.register('show arp', 'Display ARP table', () => this.showArp(this.r()));
    trie.register('show running-config', 'Display running configuration', () => this.showRunningConfig(this.r()));
    trie.register('show counters', 'Display traffic counters', () => this.showCounters(this.r()));
    trie.register('show ip traffic', 'Display IP traffic statistics', () => this.showCounters(this.r()));
    trie.register('show ip protocols', 'Display routing protocol status', () => this.showIpProtocols(this.r()));
    trie.register('show ip rip', 'Display RIP information', () => this.showIpProtocols(this.r()));

    // DHCP show commands
    trie.registerGreedy('show ip dhcp pool', 'Display DHCP pool information', (args) =>
      this.r()._getDHCPServerInternal().formatPoolShow(args.length > 0 ? args[0] : undefined));
    trie.register('show ip dhcp binding', 'Display DHCP address bindings', () =>
      this.r()._getDHCPServerInternal().formatBindingsShow());
    trie.register('show ip dhcp server statistics', 'Display DHCP server statistics', () =>
      this.r()._getDHCPServerInternal().formatStatsShow());
    trie.register('show ip dhcp conflict', 'Display DHCP address conflicts', () =>
      this.r()._getDHCPServerInternal().formatConflictShow());
    trie.register('show ip dhcp excluded-address', 'Display DHCP excluded addresses', () =>
      this.r()._getDHCPServerInternal().formatExcludedShow());

    // Debug show
    trie.register('show debug', 'Display debugging flags', () =>
      this.r()._getDHCPServerInternal().formatDebugShow());

    // show running-config interface <name>
    trie.registerGreedy('show running-config interface', 'Display interface running config', (args) => {
      if (args.length < 1) return '% Incomplete command.';
      const ifName = this.resolveInterfaceName(this.r(), args.join(' '));
      if (!ifName) return `% Invalid interface`;
      return this.showRunningConfigInterface(this.r(), ifName);
    });

    trie.register('show version', 'Display system hardware and software status', () => this.showVersion(this.r()));
  }

  // ─── Show Implementations ──────────────────────────────────────────

  private showVersion(router: Router): string {
    const ports = router._getPortsInternal();
    const giPorts = [...ports.keys()].filter(n => n.startsWith('Gig'));
    return [
      `Cisco IOS Software, C2900 Software (C2900-UNIVERSALK9-M), Version 15.7(3)M5`,
      `Copyright (c) 1986-2025 by Cisco Systems, Inc.`,
      '',
      `ROM: System Bootstrap, Version 15.0(1r)M15`,
      '',
      `${router._getHostnameInternal()} uptime is 0 minutes`,
      `System image file is "flash:c2900-universalk9-mz.SPA.157-3.M5.bin"`,
      '',
      `Cisco C2911 (revision 1.0) with 524288K/65536K bytes of memory.`,
      `Processor board ID FTX1234567A`,
      `${giPorts.length} Gigabit Ethernet interfaces`,
      `DRAM configuration is 64 bits wide with parity enabled.`,
      `256K bytes of non-volatile configuration memory.`,
      '',
      `Configuration register is 0x2102`,
    ].join('\n');
  }

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

  // ─── IP Route (config mode) ────────────────────────────────────────

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

  // ─── Interface Name Resolution ─────────────────────────────────────

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

  /** Helper: get the router reference (set during execute) */
  private r(): Router {
    if (!this.routerRef) throw new Error('Router reference not set (BUG)');
    return this.routerRef;
  }
}
