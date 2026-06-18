/**
 * Linux `ip` command — thin LinuxCommand wrapper around `executeIpCommand()`.
 *
 * The heavy lifting (parsing, formatting) stays in `LinuxIpCommand.ts`.
 * This file only bridges the `LinuxCommand` interface to `IpNetworkContext`.
 */

import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import type { LinuxNetKernel } from '../../LinuxNetKernel';
import {
  executeIpCommand,
  type IpNetworkContext,
  type IpInterfaceInfo,
  type IpRouteEntry,
  type IpNeighborEntry,
  type IpXfrmContext,
} from '../../LinuxIpCommand';
import { IPAddress, SubnetMask, MACAddress } from '../../../../core/types';
import { getNUDState } from '../../../EndHost';

export function buildIpCtx(net: LinuxNetKernel, xfrm?: IpXfrmContext): IpNetworkContext {
  return {
    getInterfaceNames(): string[] {
      return ['lo', ...net.getPorts().keys()];
    },
    getInterfaceInfo(name: string): IpInterfaceInfo | null {
      if (name === 'lo') {
        return {
          name: 'lo', mac: '00:00:00:00:00:00',
          ip: '127.0.0.1', mask: '255.0.0.0', cidr: 8,
          mtu: 65536, isUp: true, isConnected: true, isDHCP: false,
          counters: { framesIn: 0, framesOut: 0, bytesIn: 0, bytesOut: 0 },
          ipv6: [{ address: '::1', prefixLength: 128, scope: 'global' as const }],
        };
      }
      const port = net.getPorts().get(name);
      if (!port) return null;
      const ip = port.getIPAddress();
      const mask = port.getSubnetMask();
      const counters = port.getCounters();
      return {
        name: port.getName(),
        mac: port.getMAC().toString(),
        ip: ip ? ip.toString() : null,
        mask: mask ? mask.toString() : null,
        cidr: mask ? mask.toCIDR() : null,
        mtu: port.getMTU(),
        isUp: port.getIsUp(),
        isConnected: port.isConnected(),
        isDHCP: net.isDHCPConfigured(name),
        counters: {
          framesIn: counters.framesIn,
          framesOut: counters.framesOut,
          bytesIn: counters.bytesIn,
          bytesOut: counters.bytesOut,
        },
        ipv6: port.getIPv6Addresses().map(entry => ({
          address: entry.address.toString(),
          prefixLength: entry.prefixLength,
          scope: entry.origin === 'link-local' ? 'link' as const : 'global' as const,
        })),
      };
    },
    getIPv6RoutingTable() {
      return net.getIPv6RoutingTable().map(r => ({
        prefix: r.prefix.toString(),
        prefixLength: r.prefixLength,
        nextHop: r.nextHop ? r.nextHop.toString() : null,
        iface: r.iface,
        type: r.type,
        metric: r.metric,
      }));
    },
    configureInterface(ifName: string, ip: string, cidr: number): string {
      const port = net.getPorts().get(ifName);
      if (!port) return `Cannot find device "${ifName}"`;
      try {
        const mask = SubnetMask.fromCIDR(cidr);
        net.configureInterface(ifName, new IPAddress(ip), mask);
        return '';
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
    removeInterfaceIP(ifName: string): string {
      const port = net.getPorts().get(ifName);
      if (!port) return `Cannot find device "${ifName}"`;
      net.clearInterfaceIP(ifName);
      return '';
    },
    getRoutingTable(): IpRouteEntry[] {
      const table = net.getRoutingTable();
      return table.map(r => ({
        network: r.network.toString(),
        cidr: r.mask.toCIDR(),
        nextHop: r.nextHop ? r.nextHop.toString() : null,
        iface: r.iface,
        type: r.type,
        metric: r.metric,
        isDHCP: net.isDHCPConfigured(r.iface),
        srcIp: r.type === 'connected'
          ? net.getPorts().get(r.iface)?.getIPAddress()?.toString()
          : undefined,
      }));
    },
    addDefaultRoute(gateway: string): string {
      try {
        net.setDefaultGateway(new IPAddress(gateway));
        return '';
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
    addStaticRoute(network: string, cidr: number, gateway: string, metric?: number): string {
      try {
        const mask = SubnetMask.fromCIDR(cidr);
        const net4 = new IPAddress(network);
        if (!net4.networkAddress(mask).equals(net4)) {
          return `Error: an inet prefix is expected rather than "${network}/${cidr}".`;
        }
        const exists = net.getRoutingTable().some(
          r => r.network.toString() === net4.toString() && r.mask.toCIDR() === cidr);
        if (exists) return 'RTNETLINK answers: File exists';
        if (!net.addStaticRoute(net4, mask, new IPAddress(gateway), metric ?? 100)) {
          return 'RTNETLINK answers: Network is unreachable';
        }
        return '';
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
    deleteDefaultRoute(): string {
      if (!net.getDefaultGateway()) return 'RTNETLINK answers: No such process';
      net.clearDefaultGateway();
      return '';
    },
    deleteRoute(network: string, cidr: number): string {
      try {
        const mask = SubnetMask.fromCIDR(cidr);
        if (!net.removeRoute(new IPAddress(network), mask)) {
          return 'RTNETLINK answers: No such process';
        }
        return '';
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
    getNeighborTable(): IpNeighborEntry[] {
      const entries: IpNeighborEntry[] = [];
      for (const [ip, entry] of net.getArpTable()) {
        entries.push({
          ip,
          mac: entry.mac.toString(),
          iface: entry.iface,
          state: getNUDState(entry),
        });
      }
      return entries;
    },
    addNeighbor(ip: string, mac: string, ifName: string): string {
      const port = net.getPorts().get(ifName);
      if (!port) return 'RTNETLINK answers: No such device';
      try {
        const macAddr = new MACAddress(mac);
        net.addStaticARP(ip, macAddr, ifName);
        return '';
      } catch {
        return 'RTNETLINK answers: Invalid argument';
      }
    },
    deleteNeighbor(ip: string, ifName: string): string {
      const port = net.getPorts().get(ifName);
      if (!port) return 'RTNETLINK answers: No such device';
      const removed = net.deleteARP(ip);
      if (!removed) return 'RTNETLINK answers: No such file or directory';
      return '';
    },
    flushNeighbors(ifName?: string): string {
      if (ifName) {
        for (const [ip, entry] of net.getArpTable()) {
          if (entry.iface === ifName) net.deleteARP(ip);
        }
      } else {
        net.clearARPTable();
      }
      return '';
    },
    setInterfaceUp(ifName: string): string {
      const port = net.getPorts().get(ifName);
      if (!port) return `Cannot find device "${ifName}"`;
      net.setInterfaceAdmin(ifName, true);
      return '';
    },
    setInterfaceDown(ifName: string): string {
      const port = net.getPorts().get(ifName);
      if (!port) return `Cannot find device "${ifName}"`;
      net.setInterfaceAdmin(ifName, false);
      return '';
    },
    xfrm,
  };
}

export const ipCommand: LinuxCommand = {
  name: 'ip',
  needsNetworkContext: true,
  usage: 'ip [ OPTIONS ] OBJECT { COMMAND | help }',
  run(ctx: LinuxCommandContext, args: string[]): string {
    const ipCtx = buildIpCtx(ctx.net, ctx.xfrm);
    const out = executeIpCommand(ipCtx, args);
    return out;
  },
};
