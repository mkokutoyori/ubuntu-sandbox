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
  type IpTunnelContext,
  type IpTunnelInfo,
  type IpLinkOpsContext,
  type IpMaddrContext,
  type IpRuleContext,
  type IpRuleInfo,
  type IpNetnsContext,
} from '../../LinuxIpCommand';
import { IPAddress, SubnetMask, MACAddress, IPv6Address } from '../../../../core/types';
import { getNUDState, type HostPolicyRule } from '../../../EndHost';
import type { GreAgent } from '../../../../gre/GreAgent';
import { makeArgCompleter } from '../completionHelpers';

function buildTunnelCtx(greAgent: GreAgent): IpTunnelContext {
  return {
    addTunnel(name: string, local: string, remote: string, opts?: { key?: number; ttl?: number }): string {
      try {
        greAgent.addTunnel(name, local, remote, { key: opts?.key, ttl: opts?.ttl });
        return '';
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
    removeTunnel(name: string): string {
      if (!greAgent.getTunnel(name)) return `RTNETLINK answers: No such device`;
      greAgent.removeTunnel(name);
      return '';
    },
    listTunnels(): IpTunnelInfo[] {
      return greAgent.listTunnels().map(t => ({
        name: t.tunnelId, mode: 'gre', local: t.sourceIp, remote: t.destinationIp,
        key: t.key ?? undefined, ttl: t.ttl,
      }));
    },
  };
}

function interfaceTowardIpv6(net: LinuxNetKernel, nextHop: IPv6Address | null): string | null {
  for (const [name, port] of net.getPorts()) {
    if (!port.isIPv6Enabled()) continue;
    if (nextHop === null) return name;
    if (nextHop.isLinkLocal()) return name;
    for (const entry of port.getIPv6Addresses()) {
      if (entry.address.isInSameSubnet(nextHop, entry.prefixLength)) return name;
    }
  }
  return null;
}

function cidrToNetworkMask(cidr: string): { network: IPAddress; mask: SubnetMask } | null {
  const slashIdx = cidr.indexOf('/');
  if (slashIdx === -1) return null;
  try {
    const network = new IPAddress(cidr.slice(0, slashIdx));
    const mask = SubnetMask.fromCIDR(parseInt(cidr.slice(slashIdx + 1), 10));
    return { network, mask };
  } catch {
    return null;
  }
}

function buildRuleCtx(net: LinuxNetKernel): IpRuleContext {
  return {
    addRule(rule: { priority: number; from?: string; to?: string; table: number }): string {
      const hostRule: HostPolicyRule = { priority: rule.priority, table: rule.table };
      if (rule.from) {
        const parsed = cidrToNetworkMask(rule.from);
        if (!parsed) return `Error: ${rule.from} is not a valid prefix.`;
        hostRule.fromNetwork = parsed.network;
        hostRule.fromMask = parsed.mask;
      }
      if (rule.to) {
        const parsed = cidrToNetworkMask(rule.to);
        if (!parsed) return `Error: ${rule.to} is not a valid prefix.`;
        hostRule.toNetwork = parsed.network;
        hostRule.toMask = parsed.mask;
      }
      net.addPolicyRule(hostRule);
      return '';
    },
    removeRule(priority: number): string {
      if (!net.removePolicyRule(priority)) return 'RTNETLINK answers: No such file or directory';
      return '';
    },
    listRules(): IpRuleInfo[] {
      return net.getPolicyRules().map(r => ({
        priority: r.priority,
        from: r.fromNetwork && r.fromMask ? `${r.fromNetwork}/${r.fromMask.toCIDR()}` : undefined,
        to: r.toNetwork && r.toMask ? `${r.toNetwork}/${r.toMask.toCIDR()}` : undefined,
        table: r.table,
      }));
    },
  };
}

export function buildIpCtx(
  net: LinuxNetKernel,
  xfrm?: IpXfrmContext,
  greAgent?: GreAgent,
  linkOps?: IpLinkOpsContext,
  netns?: IpNetnsContext,
  maddr?: IpMaddrContext,
): IpNetworkContext {
  return {
    // Any local port answers this: a port belongs to the machine that
    // owns it, so there is nothing further to inject.
    getLocalDevice(): object | null {
      for (const [, port] of net.getPorts()) {
        const owner = (port as unknown as { getOwner?: () => object | null }).getOwner?.();
        if (owner) return owner;
      }
      return null;
    },
    getInterfaceNames(): string[] {
      return [...net.getPorts().keys()];
    },
    getIfIndex(name: string): number {
      return net.getIfIndex(name);
    },
    getInterfaceInfo(name: string): IpInterfaceInfo | null {
      // `lo` était FABRIQUÉ ici, sans port derrière : la boucle se
      // décrivait mais n'existait pas, si bien qu'ajouter une adresse
      // dessus répondait `Cannot find device "lo"` sur la machine même
      // qui venait de l'afficher. C'est un port comme un autre
      // désormais, créé au démarrage par `createLoopbackPort()`.
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
        isConnected: port.hasCarrier(),
        isDHCP: net.isDHCPConfigured(name),
        carrierless: port.isCarrierless(),
        txQueueLen: port.getTxQueueLen(),
        promiscuous: port.isPromiscuous(),
        master: (this.getLocalDevice() as unknown as
          { bondOwning?(i: string): string | null } | null)
          ?.bondOwning?.(port.getName()) ?? null,
        counters: {
          framesIn: counters.framesIn,
          framesOut: counters.framesOut,
          bytesIn: counters.bytesIn,
          bytesOut: counters.bytesOut,
          errorsIn: counters.errorsIn,
          errorsOut: counters.errorsOut,
        },
        ipv6: port.getIPv6Addresses().map(entry => ({
          address: entry.address.toString().split('%')[0],
          prefixLength: entry.prefixLength,
          // `::1` est de portée HOST : elle ne quitte pas la machine,
          // exactement comme 127.0.0.1. Elle était annoncée `global`,
          // donc décrite comme routable.
          scope: entry.address.toString() === '::1' ? 'host' as const
            : entry.origin === 'link-local' ? 'link' as const : 'global' as const,
        })),
        secondaryIPs: port.getSecondaryIPs().map(e => ({ ip: e.ip.toString(), cidr: e.mask.toCIDR() })),
      };
    },
    addInterfaceIP(ifName: string, ip: IPAddress, cidr: number): string {
      const port = net.getPorts().get(ifName);
      if (!port) return `Cannot find device "${ifName}"`;
      try {
        const mask = SubnetMask.fromCIDR(cidr);
        if (!port.getIPAddress()) net.configureInterface(ifName, ip, mask);
        else port.addSecondaryIP(ip, mask);
        return '';
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
    addInterfaceIPv6(ifName: string, addr: string, prefixLength: number): string {
      const port = net.getPorts().get(ifName);
      if (!port) return `Cannot find device "${ifName}"`;
      try {
        net.configureIPv6Interface(ifName, new IPv6Address(addr), prefixLength);
        return '';
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
    removeInterfaceIPv6(ifName: string, addr: string): string {
      const port = net.getPorts().get(ifName);
      if (!port) return `Cannot find device "${ifName}"`;
      try {
        port.removeIPv6Address(new IPv6Address(addr));
        return '';
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
    removeInterfaceAddress(ifName: string, ip: IPAddress): string {
      const port = net.getPorts().get(ifName);
      if (!port) return `Cannot find device "${ifName}"`;
      if (port.getIPAddress()?.equals(ip)) { net.clearInterfaceIP(ifName); return ''; }
      if (port.getSecondaryIPs().some(e => e.ip.equals(ip))) { port.removeSecondaryIP(ip); return ''; }
      return 'RTNETLINK answers: Cannot assign requested address';
    },
    addIPv6Route(prefix: string, prefixLength: number, gateway: string | null,
      dev: string | null, metric?: number): string {
      if (dev && !net.getPorts().get(dev)) return `Cannot find device "${dev}"`;
      try {
        const nextHop = gateway === null ? null : new IPv6Address(gateway);
        if (prefixLength === 0 && nextHop) { net.setDefaultGateway6(nextHop); return ''; }
        const iface = dev ?? interfaceTowardIpv6(net, nextHop);
        if (!iface) return 'RTNETLINK answers: Network is unreachable';
        net.addIPv6StaticRoute(
          new IPv6Address(prefix), prefixLength, nextHop, iface, metric ?? 0);
        return '';
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
    deleteIPv6Route(prefix: string, prefixLength: number, gateway: string | null): string {
      try {
        const nextHop = gateway === null ? null : new IPv6Address(gateway);
        return net.removeIPv6StaticRoute(new IPv6Address(prefix), prefixLength, nextHop)
          ? '' : 'RTNETLINK answers: No such process';
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : String(e)}`;
      }
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
    configureInterface(ifName: string, ip: IPAddress, cidr: number): string {
      const port = net.getPorts().get(ifName);
      if (!port) return `Cannot find device "${ifName}"`;
      try {
        const mask = SubnetMask.fromCIDR(cidr);
        net.configureInterface(ifName, ip, mask);
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
    getRoutingTable(tableId?: number): IpRouteEntry[] {
      const table = net.getRoutingTableFor(tableId ?? 254);
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
        linkdown: r.linkdown,
      }));
    },
    addDefaultRoute(gateway: IPAddress): string {
      net.setDefaultGateway(gateway);
      return '';
    },
    addStaticRoute(
      network: IPAddress,
      cidr: number,
      gateway: IPAddress,
      metric?: number,
      routeOpts?: { allowDuplicate?: boolean; table?: number },
    ): string {
      try {
        const mask = SubnetMask.fromCIDR(cidr);
        if (!network.networkAddress(mask).equals(network)) {
          return `Error: an inet prefix is expected rather than "${network.toString()}/${cidr}".`;
        }
        const wantedMetric = metric ?? 100;
        const tableId = routeOpts?.table ?? 254;
        if (!routeOpts?.allowDuplicate) {
          const duplicate = net.getRoutingTableFor(tableId).some(
            r => r.network.toString() === network.toString()
              && r.mask.toCIDR() === cidr
              && r.metric === wantedMetric
              && (r.nextHop ? r.nextHop.toString() === gateway.toString() : false));
          if (duplicate) return 'RTNETLINK answers: File exists';
        }
        if (!net.addStaticRouteToTable(tableId, network, mask, gateway, wantedMetric)) {
          return 'RTNETLINK answers: Network is unreachable';
        }
        return '';
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
    addDeviceRoute(network: IPAddress, cidr: number, iface: string, table?: number): string {
      try {
        const mask = SubnetMask.fromCIDR(cidr);
        if (!network.networkAddress(mask).equals(network)) {
          return `Error: an inet prefix is expected rather than "${network.toString()}/${cidr}".`;
        }
        if (!net.addDeviceRouteToTable(table ?? 254, network, mask, iface, 0)) {
          return `Cannot find device "${iface}"`;
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
    deleteRoute(
      network: IPAddress,
      cidr: number,
      filter?: { nextHop?: IPAddress | null; metric?: number; table?: number },
    ): string {
      try {
        const mask = SubnetMask.fromCIDR(cidr);
        if (!net.removeRouteFromTable(filter?.table ?? 254, network, mask, filter)) {
          return 'RTNETLINK answers: No such process';
        }
        return '';
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
    resolveRouteWithRules(dest: IPAddress, from: IPAddress | null) {
      const r = net.resolveRouteFromTable(dest, from);
      return r ? { iface: r.iface, nextHopIP: r.nextHopIP.toString(), table: r.table } : null;
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
    addNeighbor(ip: IPAddress, mac: MACAddress, ifName: string): string {
      const port = net.getPorts().get(ifName);
      if (!port) return 'RTNETLINK answers: No such device';
      net.addStaticARP(ip, mac, ifName);
      return '';
    },
    deleteNeighbor(ip: IPAddress, ifName: string): string {
      const port = net.getPorts().get(ifName);
      if (!port) return 'RTNETLINK answers: No such device';
      const removed = net.deleteARP(ip);
      if (!removed) return 'RTNETLINK answers: No such file or directory';
      return '';
    },
    flushNeighbors(ifName?: string): string {
      for (const [ip, entry] of net.getArpTable()) {
        if (entry.type === 'static') continue;
        if (ifName && entry.iface !== ifName) continue;
        net.deleteARP(new IPAddress(ip));
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
    setInterfaceMac(ifName: string, mac: string): string {
      const port = net.getPorts().get(ifName);
      if (!port) return `Cannot find device "${ifName}"`;
      try {
        port.setMAC(new MACAddress(mac));
      } catch {
        return `Error: argument "${mac}" is wrong: "address" is invalid lladdr.`;
      }
      return '';
    },
    setInterfaceTxQueueLen(ifName: string, n: number): string {
      const port = net.getPorts().get(ifName);
      if (!port) return `Cannot find device "${ifName}"`;
      port.setTxQueueLen(n);
      return '';
    },
    setInterfacePromiscuous(ifName: string, on: boolean): string {
      const port = net.getPorts().get(ifName);
      if (!port) return `Cannot find device "${ifName}"`;
      port.setPromiscuous(on);
      return '';
    },
    setInterfaceMTU(ifName: string, mtu: number): string {
      const port = net.getPorts().get(ifName);
      if (!port) return `Cannot find device "${ifName}"`;
      try {
        port.setMTU(mtu);
        return '';
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
    xfrm,
    tunnel: greAgent ? buildTunnelCtx(greAgent) : undefined,
    linkOps,
    rule: buildRuleCtx(net),
    netns,
    maddr,
  };
}

export const ipCommand: LinuxCommand = {
  name: 'ip',
  needsNetworkContext: true,
  usage: 'ip [ OPTIONS ] OBJECT { COMMAND | help }',
  complete: makeArgCompleter({
    firstWords: ['address', 'addr', 'link', 'maddr', 'route', 'neigh', 'neighbor',
      'rule', 'tunnel', 'netns', 'xfrm'],
    wordsAfter: {
      addr: ['show', 'add', 'del', 'flush'],
      address: ['show', 'add', 'del', 'flush'],
      maddr: ['show', 'add', 'del'],
      link: ['show', 'set'],
      route: ['show', 'add', 'del', 'get', 'flush'],
      neigh: ['show', 'add', 'del', 'flush'],
      neighbor: ['show', 'add', 'del', 'flush'],
      rule: ['show', 'add', 'del'],
      tunnel: ['show', 'add', 'del'],
    },
    interfacesAfter: ['dev'],
  }),
  run(ctx: LinuxCommandContext, args: string[]): Promise<string> | string {
    const filtered = args.filter(a => !a.startsWith('-'));
    if (filtered[0] === 'netns' && filtered[1] === 'exec' && ctx.netns) {
      const name = filtered[2];
      const cmdLine = filtered.slice(3).join(' ');
      if (!name || !cmdLine) return 'Usage: ip netns exec NAME cmd...';
      return ctx.netns.exec(name, cmdLine);
    }
    const ipCtx = buildIpCtx(ctx.net, ctx.xfrm, ctx.greAgent, ctx.linkOps, ctx.netns, ctx.maddr);
    // Seul `-c=auto` consulte ce drapeau ; les autres formes de `-c`
    // tranchent d'elles-mêmes.
    const out = executeIpCommand(ipCtx, args, ctx.outputPiped === true);
    return out;
  },
};
