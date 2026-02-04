/**
 * CiscoIOSShell - Cisco IOS CLI emulation for Router Management Plane
 *
 * Commands:
 *   show ip route             - Display routing table
 *   show ip interface brief   - Display interface summary
 *   show arp                  - Display ARP cache
 *   show running-config       - Display running configuration
 *   show counters             - Display traffic statistics
 *   show ip protocols         - Display routing protocol info (RIP)
 *   ip route <net> <mask> <nh> - Add static route
 *   ip address <ip> <mask>    - Configure interface IP
 *   router rip                - Enable RIP
 *   network <ip>              - Advertise network in RIP
 *   no router rip             - Disable RIP
 */

import { IPAddress, SubnetMask } from '../../core/types';
import type { Router } from '../Router';
import type { IRouterShell } from './IRouterShell';

export class CiscoIOSShell implements IRouterShell {
  getOSType(): string { return 'cisco-ios'; }

  execute(router: Router, cmd: string, args: string[]): string {
    switch (cmd) {
      case 'show':    return this.cmdShow(router, args);
      case 'ip':      return this.cmdIp(router, args);
      case 'router':  return this.cmdRouter(router, args);
      case 'network': return this.cmdNetwork(router, args);
      case 'no':      return this.cmdNo(router, args);
      case 'display': return this.cmdShow(router, args); // Alias for compatibility
      default:        return `% Unrecognized command "${cmd}"`;
    }
  }

  private cmdShow(router: Router, args: string[]): string {
    if (args.length === 0) return '% Incomplete command.';
    const sub = args.join(' ').toLowerCase();

    if (sub === 'ip route' || sub === 'ip route table') return this.showIpRoute(router);
    if (sub === 'ip interface brief' || sub === 'ip int brief') return this.showIpIntBrief(router);
    if (sub === 'arp') return this.showArp(router);
    if (sub === 'running-config' || sub === 'run') return this.showRunningConfig(router);
    if (sub === 'counters' || sub === 'ip traffic') return this.showCounters(router);
    if (sub === 'ip protocols' || sub === 'ip rip') return this.showIpProtocols(router);

    return `% Unrecognized command "show ${args.join(' ')}"`;
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
    const lines = [`hostname ${router._getHostnameInternal()}`, '!'];
    for (const [name, port] of ports) {
      const ip = port.getIPAddress();
      const mask = port.getSubnetMask();
      lines.push(`interface ${name}`);
      if (ip && mask) {
        lines.push(` ip address ${ip} ${mask}`);
        lines.push(` no shutdown`);
      } else {
        lines.push(` shutdown`);
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

  private cmdIp(router: Router, args: string[]): string {
    // ip route <network> <mask> <next-hop>
    if (args.length >= 4 && args[0] === 'route') {
      try {
        const network = new IPAddress(args[1]);
        const mask = new SubnetMask(args[2]);
        const nextHop = new IPAddress(args[3]);

        if (args[1] === '0.0.0.0' && args[2] === '0.0.0.0') {
          return router.setDefaultRoute(nextHop) ? '' : '% Next-hop is not reachable';
        }
        return router.addStaticRoute(network, mask, nextHop) ? '' : '% Next-hop is not reachable';
      } catch (e: any) {
        return `% Invalid input: ${e.message}`;
      }
    }

    // ip address <ip> <mask>
    if (args.length >= 3 && args[0] === 'address') {
      const ports = router._getPortsInternal();
      for (const [name, port] of ports) {
        if (!port.getIPAddress()) {
          try {
            router.configureInterface(name, new IPAddress(args[1]), new SubnetMask(args[2]));
            return '';
          } catch (e: any) {
            return `% Invalid input: ${e.message}`;
          }
        }
      }
      return '% No unconfigured interface available';
    }

    return '% Incomplete command.';
  }

  // Cisco: "router rip" → enables RIP
  private cmdRouter(router: Router, args: string[]): string {
    if (args.length >= 1 && args[0].toLowerCase() === 'rip') {
      if (!router.isRIPEnabled()) {
        router.enableRIP();
      }
      return '';
    }
    return '% Unrecognized routing protocol';
  }

  // Cisco: "network <ip>" → adds network to RIP
  private cmdNetwork(router: Router, args: string[]): string {
    if (args.length < 1) return '% Incomplete command.';
    if (!router.isRIPEnabled()) return '% RIP is not enabled. Use "router rip" first.';

    try {
      const network = new IPAddress(args[0]);
      // Use classful mask if no mask specified
      const mask = args.length >= 2 ? new SubnetMask(args[1]) : this.classfulMask(network);
      router.ripAdvertiseNetwork(network, mask);
      return '';
    } catch (e: any) {
      return `% Invalid input: ${e.message}`;
    }
  }

  // Cisco: "no router rip" → disables RIP
  private cmdNo(router: Router, args: string[]): string {
    if (args.length >= 2 && args[0] === 'router' && args[1] === 'rip') {
      router.disableRIP();
      return '';
    }
    return '% Unrecognized command';
  }

  /** Determine classful mask from IP address (for RIP network command) */
  private classfulMask(ip: IPAddress): SubnetMask {
    const firstOctet = ip.getOctets()[0];
    if (firstOctet < 128) return new SubnetMask('255.0.0.0');       // Class A
    if (firstOctet < 192) return new SubnetMask('255.255.0.0');     // Class B
    return new SubnetMask('255.255.255.0');                          // Class C
  }
}
