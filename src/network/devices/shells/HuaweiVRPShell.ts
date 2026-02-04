/**
 * HuaweiVRPShell - Huawei VRP CLI emulation for Router Management Plane
 *
 * Commands:
 *   display ip routing-table       - Display routing table
 *   display ip interface brief     - Display interface summary
 *   display arp                    - Display ARP cache
 *   display current-configuration  - Display running configuration
 *   display counters               - Display traffic statistics
 *   display rip                    - Display RIP status
 *   ip route-static <net> <mask> <nh> - Add static route
 *   rip [1]                        - Enable RIP process
 *   rip network <ip>               - Advertise network in RIP
 *   undo rip                       - Disable RIP
 */

import { IPAddress, SubnetMask } from '../../core/types';
import type { Router } from '../Router';
import type { IRouterShell } from './IRouterShell';

export class HuaweiVRPShell implements IRouterShell {
  getOSType(): string { return 'huawei-vrp'; }

  execute(router: Router, cmd: string, args: string[]): string {
    switch (cmd) {
      case 'display': return this.cmdDisplay(router, args);
      case 'ip':      return this.cmdIp(router, args);
      case 'rip':     return this.cmdRip(router, args);
      case 'undo':    return this.cmdUndo(router, args);
      case 'show':    return this.cmdDisplay(router, args); // Alias for compatibility
      default:        return `Error: Unrecognized command "${cmd}"`;
    }
  }

  private cmdDisplay(router: Router, args: string[]): string {
    if (args.length === 0) return 'Error: Incomplete command.';
    const sub = args.join(' ').toLowerCase();

    if (sub === 'ip routing-table') return this.displayIpRoutingTable(router);
    if (sub === 'ip interface brief') return this.displayIpIntBrief(router);
    if (sub === 'arp') return this.displayArp(router);
    if (sub === 'current-configuration' || sub === 'current') return this.displayCurrentConfig(router);
    if (sub === 'ip traffic' || sub === 'counters') return this.displayCounters(router);
    if (sub === 'rip' || sub === 'rip 1') return this.displayRip(router);

    return `Error: Unrecognized command "display ${args.join(' ')}"`;
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
    if (arpTable.size === 0) return 'No ARP entries found.';
    const lines = ['IP ADDRESS      MAC ADDRESS     EXPIRE(M)  TYPE   INTERFACE'];
    for (const [ip, entry] of arpTable) {
      const age = Math.floor((Date.now() - entry.timestamp) / 60000);
      lines.push(`${ip.padEnd(16)}${entry.mac.toString().padEnd(16)}${String(age).padEnd(11)}D      ${entry.iface}`);
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
    for (const [name, port] of ports) {
      const ip = port.getIPAddress();
      const mask = port.getSubnetMask();
      lines.push(`interface ${name}`);
      if (ip && mask) {
        lines.push(` ip address ${ip} ${mask.toCIDR()}`);
      } else {
        lines.push(` shutdown`);
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

  private cmdIp(router: Router, args: string[]): string {
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

    return 'Error: Incomplete command.';
  }

  // Huawei: "rip [1]" → enables RIP process 1
  private cmdRip(router: Router, args: string[]): string {
    if (!router.isRIPEnabled()) {
      router.enableRIP();
    }

    // "rip 1 network <ip>" or nested: handle "network" as sub-command
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

  // Huawei: "undo rip [1]" → disables RIP
  private cmdUndo(router: Router, args: string[]): string {
    if (args.length >= 1 && args[0] === 'rip') {
      router.disableRIP();
      return '';
    }
    return 'Error: Unrecognized command';
  }

  private classfulMask(ip: IPAddress): SubnetMask {
    const firstOctet = ip.getOctets()[0];
    if (firstOctet < 128) return new SubnetMask('255.0.0.0');
    if (firstOctet < 192) return new SubnetMask('255.255.0.0');
    return new SubnetMask('255.255.255.0');
  }
}
