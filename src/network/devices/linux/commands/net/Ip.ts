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
import { IPAddress, SubnetMask } from '../../../../core/types';

function buildIpCtx(net: LinuxNetKernel, xfrm: IpXfrmContext): IpNetworkContext {
  return {
    getInterfaceNames(): string[] {
      return [...net.getPorts().keys()];
    },
    getInterfaceInfo(name: string): IpInterfaceInfo | null {
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
      };
    },
    configureInterface(ifName: string, ip: string, cidr: number): string {
      const port = net.getPorts().get(ifName);
      if (!port) return `Cannot find device "${ifName}"`;
      try {
        const mask = SubnetMask.fromCIDR(cidr);
        net.configureInterface(ifName, new IPAddress(ip), mask);
        return '';
      } catch (e: any) {
        return `Error: ${e.message}`;
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
      } catch (e: any) {
        return `Error: ${e.message}`;
      }
    },
    addStaticRoute(network: string, cidr: number, gateway: string, metric?: number): string {
      try {
        const mask = SubnetMask.fromCIDR(cidr);
        if (!net.addStaticRoute(new IPAddress(network), mask, new IPAddress(gateway), metric ?? 100)) {
          return 'RTNETLINK answers: Network is unreachable';
        }
        return '';
      } catch (e: any) {
        return `Error: ${e.message}`;
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
      } catch (e: any) {
        return `Error: ${e.message}`;
      }
    },
    getNeighborTable(): IpNeighborEntry[] {
      const entries: IpNeighborEntry[] = [];
      for (const [ip, entry] of net.getArpTable()) {
        entries.push({
          ip,
          mac: entry.mac.toString(),
          iface: entry.iface,
          state: 'REACHABLE',
        });
      }
      return entries;
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
