/**
 * NetworkCmdlets — Get-NetAdapter / Get-NetIPAddress / Test-Connection /
 * Resolve-DnsName.
 *
 * The INetworkProvider only exposes a partial surface today — these are the
 * cmdlets that have full provider support. Less-common ones (Set-NetIP*,
 * firewall rules, WLAN, VPN…) still go to the legacy executor via fallback.
 */

import type { ICmdlet } from '../ICmdlet';
import type { CmdletContext } from '../CmdletContext';
import { PSRuntimeError } from '@/powershell/runtime/PSRuntime';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import { IPAddress, MACAddress } from '@/network/core/types';
import type {
  NetworkAdapterInfo, IPAddressInfo, INetworkProvider, NetIPAddressUpdate, RouteInfo,
} from '@/powershell/providers/PSProviders';
import { psValueToString } from '@/powershell/runtime/PSExpansion';
import { makeTimeSpan } from './DateTimeCmdlets';
import { NON_INTERACTIVE_HOST, confirmationDue } from '../confirmation';
import {
  type NetIPAddressSelection, NO_MATCHING_INTERFACE, TIMESPAN_MAX_SECONDS, matchEnumValue,
  noMatchingNetIPAddress, planNetIPAddress, prefixLengthProblem, selectNetIPAddresses,
} from '@/network/devices/windows/netIpAddress';
import { LOOPBACK_IFALIAS } from '@/network/devices/windows/WindowsLoopbackRoutes';
import { LOOPBACK_IFINDEX } from '@/network/devices/windows/WindowsInterfaceNaming';
import {
  type NetRouteSelection, type NetRouteUpdate, MAX_ROUTE_METRIC, NET_ROUTE_PUBLISH,
  netRouteKey, noMatchingNetRoute, planNetRoute, selectNetRoutes,
} from '@/network/devices/windows/netRoute';

function lifetimeSeconds(raw: PSValue | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const total = (raw as Record<string, PSValue>).TotalSeconds;
    return total === undefined ? undefined : Math.round(Number(total));
  }
  const match = /^(?:(\d+)\.)?(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(psValueToString(raw).trim());
  if (!match) return undefined;
  return Math.round(parseInt(match[1] ?? '0', 10) * 86400
    + parseInt(match[2], 10) * 3600 + parseInt(match[3], 10) * 60 + parseFloat(match[4]));
}

function lifetimeSecondsOf(ctx: CmdletContext, key: string): number | undefined {
  return lifetimeSeconds(ctx.named[key]);
}

function requireNetwork(ctx: CmdletContext): INetworkProvider {
  if (!ctx.providers.network) {
    throw new PSRuntimeError('This cmdlet is not recognized as a network provider operation in this context');
  }
  return ctx.providers.network;
}

function adapterToPSObject(a: NetworkAdapterInfo): Record<string, PSValue> {
  return {
    Name:         a.name,
    InterfaceDescription: a.displayName,
    ifIndex:      a.ifIndex,
    Status:       a.status,
    MacAddress:   a.macAddress.replace(/:/g, '-').toUpperCase(),
    LinkSpeed:    a.linkSpeed,
  };
}

function ipToPSObject(ip: IPAddressInfo): Record<string, PSValue> {
  // ValidLifetime/PreferredLifetime are TimeSpans on a real host; leased
  // addresses carry the residual lease time, everything else is "forever"
  // (TimeSpan.MaxValue, ~10675199 days — what Get-NetIPAddress prints).
  const validMs = (ip.validLifetimeSeconds ?? TIMESPAN_MAX_SECONDS) * 1000;
  const prefMs = (ip.preferredLifetimeSeconds ?? TIMESPAN_MAX_SECONDS) * 1000;
  return {
    IPAddress:     ip.ipAddress,
    PrefixLength:  ip.prefixLength,
    InterfaceAlias: ip.ifAlias,
    ifIndex:       ip.ifIndex,
    PrefixOrigin:  ip.prefixOrigin,
    SuffixOrigin:  ip.suffixOrigin,
    AddressFamily: ip.addressFamily,
    ValidLifetime: makeTimeSpan(validMs) as unknown as PSValue,
    PreferredLifetime: makeTimeSpan(prefMs) as unknown as PSValue,
    Type: ip.type ?? 'Unicast',
    SkipAsSource: ip.skipAsSource ?? false,
    PolicyStore: ip.policyStore ?? 'ActiveStore',
  };
}

// ── Get-NetAdapter ────────────────────────────────────────────────────────

export class GetNetAdapterCmdlet implements ICmdlet {
  readonly name = 'get-netadapter';
  readonly displayName = 'Get-NetAdapter';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const net = requireNetwork(ctx);
    const name = ctx.named['name'] ?? ctx.positional[0];
    const adapters = net.getAdapters();
    if (name === undefined || name === null) {
      return adapters.map(adapterToPSObject) as PSValue;
    }
    const names = Array.isArray(name) ? name.map(psValueToString) : [psValueToString(name)];
    const out: NetworkAdapterInfo[] = [];
    for (const n of names) {
      const found = net.getAdapter(n);
      if (found) out.push(found);
      else ctx.emitError(`No MSFT_NetAdapter objects found with property 'Name' equal to '${n}'.`);
    }
    return out.map(adapterToPSObject) as PSValue;
  }
}

// ── Get-NetIPAddress ──────────────────────────────────────────────────────

const NET_IP_FILTERS = ['IPAddress', 'InterfaceAlias', 'InterfaceIndex', 'AddressFamily',
  'AddressState', 'PrefixLength', 'PrefixOrigin', 'SuffixOrigin', 'SkipAsSource',
  'Type', 'PolicyStore'] as const;

function netIPSelectionOf(ctx: CmdletContext, net: INetworkProvider): NetIPAddressSelection {
  const list = (key: string): string[] | undefined => {
    const raw = ctx.named[key];
    if (raw === undefined) return undefined;
    return (Array.isArray(raw) ? raw : [raw]).map(psValueToString);
  };
  const aliases = list('interfacealias');
  return {
    ipAddress: list('ipaddress'),
    interfaceAlias: aliases?.map(a => net.resolveNetInterface({ alias: a })?.alias ?? a),
    interfaceIndex: list('interfaceindex'),
    addressFamily: list('addressfamily'),
    prefixLength: list('prefixlength'),
    prefixOrigin: list('prefixorigin'),
    suffixOrigin: list('suffixorigin'),
    addressState: list('addressstate'),
    type: list('type'),
    policyStore: list('policystore'),
    skipAsSource: list('skipassource'),
  };
}

export class GetNetIPAddressCmdlet implements ICmdlet {
  readonly name = 'get-netipaddress';
  readonly displayName = 'Get-NetIPAddress';
  readonly aliases = [] as const;
  readonly description = 'Gets the IP address configuration.';
  readonly parameters = NET_IP_FILTERS;

  execute(ctx: CmdletContext): PSValue {
    const net = requireNetwork(ctx);
    const selection = netIPSelectionOf(ctx, net);
    const matched = selectNetIPAddresses(net.getIPAddresses(), selection);
    if (matched.length === 0 && Object.values(selection).some(v => v !== undefined)) {
      ctx.emitError(`Get-NetIPAddress : ${noMatchingNetIPAddress(selection)}`);
      return null;
    }
    return matched.map(ipToPSObject) as PSValue;
  }
}

export class GetNetIPInterfaceCmdlet implements ICmdlet {
  readonly name = 'get-netipinterface';
  readonly displayName = 'Get-NetIPInterface';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const net = requireNetwork(ctx);
    const familleDemandee = ctx.named['addressfamily']
      ? psValueToString(ctx.named['addressfamily']).toLowerCase()
      : undefined;
    const familles = familleDemandee ? [familleDemandee] : ['ipv4', 'ipv6'];
    const out: Record<string, PSValue>[] = [];
    for (const a of net.getAdapters()) {
      for (const famille of familles) {
        out.push({
          ifIndex: a.ifIndex,
          InterfaceAlias: a.name,
          AddressFamily: famille === 'ipv6' ? 'IPv6' : 'IPv4',
          NlMtu: 1500,
          InterfaceMetric: 25,
          Dhcp: net.isDHCPConfigured(a.name) ? 'Enabled' : 'Disabled',
          ConnectionState: a.status === 'Up' ? 'Connected' : 'Disconnected',
        });
      }
    }
    return out as PSValue;
  }
}

// ── Test-Connection (basic) ───────────────────────────────────────────────

export class TestConnectionCmdlet implements ICmdlet {
  readonly name = 'test-connection';
  readonly displayName = 'Test-Connection';
  readonly aliases = [] as const;
  readonly parameters = ['ComputerName', 'Count', 'Quiet', 'Delay'] as const;

  execute(ctx: CmdletContext): PSValue {
    const net = requireNetwork(ctx);
    const target = psValueToString(
      ctx.named['computername'] ?? ctx.named['targetname'] ?? ctx.positional[0] ?? '',
    );
    const count  = Math.max(1, Number(ctx.named['count'] ?? 4));
    if (!target) {
      ctx.emitError('Test-Connection requires -ComputerName or a positional target');
      return null;
    }

    const probe = net.testPingProbe?.(target) ?? null;
    const reachable = probe?.success ?? false;
    const rttMs = probe?.success ? Math.max(1, Math.round(probe.rttMs)) : 0;
    const resolvedIp = probe?.resolvedIp ?? (target.includes(':') ? '' : target);
    const sourceIp = probe ? (net.egressInfoFor?.(target)?.sourceIp ?? 'localhost') : 'localhost';

    if (ctx.named['quiet'] === true) return reachable;

    const out: PSValue[] = [];
    for (let i = 1; i <= count; i++) {
      out.push({
        Source: sourceIp,
        Destination: target,
        IPV4Address: resolvedIp,
        Bytes: 32,
        'Time(ms)': rttMs,
        Status: reachable ? 'Success' : 'Failure',
      } as Record<string, PSValue>);
    }
    return out as PSValue;
  }
}

// ── Resolve-DnsName ───────────────────────────────────────────────────────

export class ResolveDnsNameCmdlet implements ICmdlet {
  readonly name = 'resolve-dnsname';
  readonly displayName = 'Resolve-DnsName';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const net = requireNetwork(ctx);
    const name = psValueToString(ctx.named['name'] ?? ctx.positional[0] ?? '');
    if (!name) { ctx.emitError('Resolve-DnsName requires -Name'); return null; }

    // IPv4 → reverse PTR.
    const ipv4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(name);
    if (ipv4) {
      const [, a, b, c, d] = ipv4;
      const ptrName = `${d}.${c}.${b}.${a}.in-addr.arpa`;
      const host = (a === '127') ? 'localhost' : `host-${a}-${b}-${c}-${d}.local`;
      return [{
        Name: ptrName,
        Type: 'PTR',
        TTL: 300,
        Section: 'Answer',
        NameHost: host,
      } as Record<string, PSValue>] as PSValue;
    }

    // Forward lookup — resolved exclusively through the device's own DNS
    // chain (hosts file → resolver cache → configured servers over the
    // wire), the SAME chain `nslookup` uses. No hard-coded answers: if the
    // machine can't resolve a name, Resolve-DnsName must fail like nslookup
    // does, so both shells report a single source of truth (the device).
    // -Server directs the query at a specific resolver (over the wire),
    // bypassing the interface-configured servers — needed to compare a
    // forced lookup against the system default one.
    const server = ctx.named['server'] !== undefined ? psValueToString(ctx.named['server']) : null;

    if (server && net.resolveDnsViaServerWithTtl) {
      const records = net.resolveDnsViaServerWithTtl(name, server);
      if (records.length === 0) { ctx.emitError(`${name} : DNS name does not exist`); return null; }
      return records.map(r => ({
        Name: name,
        Type: r.ip.includes(':') ? 'AAAA' : 'A',
        TTL:  r.ttl,
        Section: 'Answer',
        IPAddress: r.ip,
      } as Record<string, PSValue>)) as PSValue;
    }

    // Les commutateurs d'ordre : chacun retire une étape de la chaîne du
    // client DNS. La cmdlet ne nomme pas le protocole qui a répondu —
    // les poser est le seul moyen de le savoir, et donc de distinguer un
    // nom servi par le fichier hosts d'un nom servi par le lien.
    const flag = (n: string): boolean => ctx.named[n] !== undefined && ctx.named[n] !== false;
    const restrictions = {
      dnsOnly: flag('dnsonly'),
      llmnrOnly: flag('llmnronly'),
      noHostsFile: flag('nohostsfile'),
      cacheOnly: flag('cacheonly'),
    };
    const restricted = Object.values(restrictions).some(Boolean);

    const ips = server && net.resolveDnsViaServer
      ? net.resolveDnsViaServer(name, server)
      : (restricted && net.resolveDnsWithOptions
        ? net.resolveDnsWithOptions(name, restrictions)
        : net.resolveDns(name));
    if (ips.length === 0) { ctx.emitError(`${name} : DNS name does not exist`); return null; }
    const cacheEntries = net.getDnsClientCache?.() ?? [];
    const ttlFor = (ip: string): number =>
      cacheEntries.find(e => e.name.toLowerCase() === name.toLowerCase() && e.value === ip)?.ttl ?? 300;
    return ips.map(ip => ({
      Name: name,
      Type: ip.includes(':') ? 'AAAA' : 'A',
      TTL:  ttlFor(ip),
      Section: 'Answer',
      IPAddress: ip,
    } as Record<string, PSValue>)) as PSValue;
  }
}

// ── Invoke-WebRequest (PRD-Windows-Server.md §5 P11) ───────────────────────

export class InvokeWebRequestCmdlet implements ICmdlet {
  readonly name = 'invoke-webrequest';
  readonly displayName = 'Invoke-WebRequest';
  readonly aliases = ['iwr'] as const;

  execute(ctx: CmdletContext): PSValue {
    const net = requireNetwork(ctx);
    const url = psValueToString(ctx.named['uri'] ?? ctx.positional[0] ?? '');
    if (!url) { ctx.emitError('Invoke-WebRequest : Cannot process command because of one or more missing mandatory parameters: Uri.'); return null; }
    if (!net.invokeWebRequest) { ctx.emitError('Invoke-WebRequest : not supported on this device.'); return null; }
    const res = net.invokeWebRequest(url);
    if (!res.ok) { ctx.emitError(res.error ?? 'Invoke-WebRequest : request failed'); return null; }
    return {
      StatusCode: res.statusCode, StatusDescription: res.statusDescription,
      Content: res.content, Headers: res.headers,
    } as Record<string, PSValue>;
  }
}

// ── Get-NetIPConfiguration ────────────────────────────────────────────────
// Composite: rolls adapter + IP + DNS + gateway into one row per adapter
// (matches what real PS prints when invoked without arguments).

export class GetNetIPConfigurationCmdlet implements ICmdlet {
  readonly name = 'get-netipconfiguration';
  readonly displayName = 'Get-NetIPConfiguration';
  readonly aliases = [] as const;
  readonly description = 'Gets IP network configuration.';
  readonly parameters = ['InterfaceAlias', 'InterfaceIndex', 'All', 'Detailed'] as const;

  execute(ctx: CmdletContext): PSValue {
    const net = requireNetwork(ctx);
    for (const [key, name] of [['allcompartments', 'AllCompartments'], ['compartmentid', 'CompartmentId']] as const) {
      if (ctx.named[key] !== undefined) {
        ctx.emitError(`Get-NetIPConfiguration : The -${name} parameter is not implemented in this simulator: network compartments are not modelled.`);
        return null;
      }
    }
    const alias = ctx.named['interfacealias'] ?? ctx.positional[0];
    const index = ctx.named['interfaceindex'];
    const named = alias !== undefined && alias !== null ? psValueToString(alias)
      : index !== undefined && index !== null
        ? net.resolveNetInterface({ index: Number(psValueToString(index)) })?.alias ?? psValueToString(index)
        : null;
    if (named !== null && net.resolveNetInterface({ alias: named }) === null
      && named.toLowerCase() !== LOOPBACK_IFALIAS.toLowerCase()) {
      ctx.emitError(`Get-NetIPConfiguration : ${NO_MATCHING_INTERFACE}`);
      return null;
    }

    const all = ctx.named['all'] === true;
    const detailed = ctx.named['detailed'] === true;
    const defaultRoutes = net.getRoutes().filter(r => r.destinationPrefix === '0.0.0.0/0');
    const rows: Array<{ alias: string; description: string; ifIndex: number; connected: boolean }> =
      net.getAdapters().map(a => ({
        alias: a.name, description: a.displayName, ifIndex: a.ifIndex, connected: a.status === 'Up',
      }));
    if (all || named?.toLowerCase() === LOOPBACK_IFALIAS.toLowerCase()) {
      rows.push({
        alias: LOOPBACK_IFALIAS, description: 'Software Loopback Interface 1',
        ifIndex: LOOPBACK_IFINDEX, connected: true,
      });
    }

    const kept = named !== null
      ? rows.filter(r => r.alias.toLowerCase() === named.toLowerCase())
      : all ? rows : rows.filter(r => r.connected);
    return kept.map(r => {
      const ips = net.getIPAddresses(r.alias);
      const v4 = ips.find(ip => ip.addressFamily === 'IPv4');
      const onLink = defaultRoutes.find(d => d.ifAlias.toLowerCase() === r.alias.toLowerCase());
      const row: Record<string, PSValue> = {
        InterfaceAlias:       r.alias,
        InterfaceDescription: r.description,
        InterfaceIndex:       r.ifIndex,
        IPv4Address:          v4 ? v4.ipAddress : '',
        IPv6Address:          ips.find(ip => ip.addressFamily === 'IPv6')?.ipAddress ?? '',
        IPv4DefaultGateway:   onLink?.nextHop ?? '',
        DNSServer:            net.getDnsServers(r.alias).join(', '),
        DhcpServer:           net.getDhcpServer?.(r.alias) ?? '',
        NetAdapter:           { Status: r.connected ? 'Up' : 'Disconnected' } as Record<string, PSValue>,
      };
      if (detailed) row.ComputerName = ctx.env.get('env:COMPUTERNAME') ?? '';
      return row;
    }) as PSValue;
  }
}

// ── Get-NetRoute / Get-NetTCPConnection (read-only) ──────────────────────
// The provider currently returns [] for both — fall back to the legacy
// executor (it has the formatted-table output) when there's nothing
// structured to emit, so users still see the header columns.

const NET_ROUTE_FILTERS = ['DestinationPrefix', 'InterfaceAlias', 'InterfaceIndex', 'NextHop',
  'AddressFamily', 'RouteMetric', 'Publish', 'Protocol', 'PolicyStore', 'State',
  'ValidLifetime', 'PreferredLifetime'] as const;

const NET_ROUTE_UNSUPPORTED: ReadonlyArray<readonly [string, string, string]> = [
  ['compartmentid', 'CompartmentId', 'network compartments are not modelled'],
  ['includeallcompartments', 'IncludeAllCompartments', 'network compartments are not modelled'],
  ['interfacemetric', 'InterfaceMetric', 'an interface carries no metric of its own here'],
  ['associatedipinterface', 'AssociatedIPInterface', 'MSFT_NetIPInterface instances are not modelled'],
];

function unsupportedNetRouteFilter(ctx: CmdletContext): string | null {
  for (const [key, name, reason] of NET_ROUTE_UNSUPPORTED) {
    if (ctx.named[key] !== undefined) {
      return `The -${name} parameter is not implemented in this simulator: ${reason}.`;
    }
  }
  return null;
}

function netRouteSelectionOf(
  ctx: CmdletContext, net: INetworkProvider, filters: readonly string[],
): NetRouteSelection {
  const allowed = new Set(filters.map(f => f.toLowerCase()));
  const read = (key: string): PSValue[] | undefined => {
    const raw = allowed.has(key) ? ctx.named[key] : undefined;
    if (raw === undefined) return undefined;
    return Array.isArray(raw) ? raw : [raw];
  };
  const list = (key: string): string[] | undefined => read(key)?.map(psValueToString);
  const spans = (key: string): string[] | undefined =>
    read(key)?.map(v => String(lifetimeSeconds(v) ?? TIMESPAN_MAX_SECONDS));
  const aliases = list('interfacealias');
  return {
    destinationPrefix: list('destinationprefix'),
    interfaceAlias: aliases?.map(a => net.resolveNetInterface({ alias: a })?.alias ?? a),
    interfaceIndex: list('interfaceindex'),
    nextHop: list('nexthop'),
    addressFamily: list('addressfamily'),
    routeMetric: list('routemetric'),
    publish: list('publish'),
    protocol: list('protocol'),
    policyStore: list('policystore'),
    state: list('state'),
    validLifetime: spans('validlifetime'),
    preferredLifetime: spans('preferredlifetime'),
  };
}

function routeToPSObject(r: RouteInfo): Record<string, PSValue> {
  return {
    DestinationPrefix: r.destinationPrefix,
    InterfaceAlias:    r.ifAlias,
    InterfaceIndex:    r.ifIndex ?? 0,
    NextHop:           r.nextHop,
    RouteMetric:       r.routeMetric,
    AddressFamily:     r.addressFamily ?? (r.destinationPrefix.includes(':') ? 'IPv6' : 'IPv4'),
    Publish:           r.publish ?? 'No',
    Protocol:          r.protocol ?? 'NetMgmt',
    PolicyStore:       r.policyStore ?? 'ActiveStore',
    State:             'Alive',
    ValidLifetime:     makeTimeSpan((r.validLifetimeSeconds ?? TIMESPAN_MAX_SECONDS) * 1000) as unknown as PSValue,
    PreferredLifetime: makeTimeSpan((r.preferredLifetimeSeconds ?? TIMESPAN_MAX_SECONDS) * 1000) as unknown as PSValue,
  };
}

export class GetNetRouteCmdlet implements ICmdlet {
  readonly name = 'get-netroute';
  readonly displayName = 'Get-NetRoute';
  readonly aliases = [] as const;
  readonly description = 'Gets the IP route information from the IP routing table.';
  readonly parameters = NET_ROUTE_FILTERS;

  execute(ctx: CmdletContext): PSValue {
    const net = requireNetwork(ctx);
    const unsupported = unsupportedNetRouteFilter(ctx);
    if (unsupported) { ctx.emitError(`Get-NetRoute : ${unsupported}`); return null; }
    const selection = netRouteSelectionOf(ctx, net, NET_ROUTE_FILTERS);
    if (selection.destinationPrefix === undefined && ctx.positional[0] !== undefined) {
      selection.destinationPrefix = [psValueToString(ctx.positional[0])];
    }
    const matched = selectNetRoutes(net.getRoutes(), selection);
    if (matched.length === 0 && Object.values(selection).some(v => v !== undefined)) {
      ctx.emitError(`Get-NetRoute : ${noMatchingNetRoute(selection)}`);
      return null;
    }
    return matched.map(routeToPSObject) as PSValue;
  }
}

export class GetNetNeighborCmdlet implements ICmdlet {
  readonly name = 'get-netneighbor';
  readonly displayName = 'Get-NetNeighbor';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const filter: { ipAddress?: IPAddress; state?: string; ifIndex?: number } = {};
    if (ctx.named['ipaddress']) {
      try { filter.ipAddress = new IPAddress(psValueToString(ctx.named['ipaddress'])); }
      catch (e) { throw new PSRuntimeError((e as Error).message); }
    }
    if (ctx.named['state']) filter.state = psValueToString(ctx.named['state']);
    if (ctx.named['ifindex']) filter.ifIndex = Number.parseInt(psValueToString(ctx.named['ifindex']), 10);
    const neighbors = requireNetwork(ctx).getNeighbors(filter);
    return neighbors.map((n) => ({
      ifIndex:          n.ifIndex,
      InterfaceAlias:   n.ifAlias,
      IPAddress:        n.ipAddress,
      LinkLayerAddress: n.linkLayerAddress,
      State:            n.state,
      AddressFamily:    n.addressFamily,
      PolicyStore:      n.policyStore,
    } as Record<string, PSValue>)) as PSValue;
  }
}

export class ClearNetNeighborCacheCmdlet implements ICmdlet {
  readonly name = 'clear-netneighborcache';
  readonly displayName = 'Clear-NetNeighborCache';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const ifAlias = ctx.named['interfacealias']
      ? psValueToString(ctx.named['interfacealias'])
      : undefined;
    requireNetwork(ctx).clearNeighbors(ifAlias);
    return null;
  }
}

export class GetNetAdapterStatisticsCmdlet implements ICmdlet {
  readonly name = 'get-netadapterstatistics';
  readonly displayName = 'Get-NetAdapterStatistics';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const net = requireNetwork(ctx);
    const name = ctx.named['name'] ?? ctx.positional[0];
    const adapters = name === undefined || name === null
      ? net.getAdapters()
      : (Array.isArray(name) ? name.map(psValueToString) : [psValueToString(name)])
          .map((n) => net.getAdapter(n))
          .filter((a): a is NonNullable<typeof a> => a !== null);
    const out: Record<string, PSValue>[] = [];
    for (const a of adapters) {
      const s = net.getAdapterStatistics(a.name);
      if (!s) continue;
      out.push({
        Name:                     s.name,
        ReceivedBytes:            s.receivedBytes,
        ReceivedUnicastPackets:   s.receivedUnicastPackets,
        ReceivedDiscardedPackets: s.receivedDiscardedPackets,
        ReceivedPacketErrors:     s.receivedPacketErrors,
        SentBytes:                s.sentBytes,
        SentUnicastPackets:       s.sentUnicastPackets,
        OutboundDiscardedPackets: s.outboundDiscardedPackets,
        OutboundPacketErrors:     s.outboundPacketErrors,
      });
    }
    return out as PSValue;
  }
}

function parseNeighborIp(ctx: CmdletContext, displayName: string): IPAddress {
  if (!ctx.named['ipaddress']) {
    throw new PSRuntimeError(`${displayName} : Missing -IPAddress.`);
  }
  try { return new IPAddress(psValueToString(ctx.named['ipaddress'])); }
  catch (e) { throw new PSRuntimeError(`${displayName} : ${(e as Error).message}`); }
}

function parseNeighborMac(ctx: CmdletContext, displayName: string): MACAddress {
  if (!ctx.named['linklayeraddress']) {
    throw new PSRuntimeError(`${displayName} : Missing -LinkLayerAddress.`);
  }
  const raw = psValueToString(ctx.named['linklayeraddress']).replace(/-/g, ':').toLowerCase();
  try { return new MACAddress(raw); }
  catch (e) { throw new PSRuntimeError(`${displayName} : ${(e as Error).message}`); }
}

export class NewNetNeighborCmdlet implements ICmdlet {
  readonly name = 'new-netneighbor';
  readonly displayName = 'New-NetNeighbor';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const ip = parseNeighborIp(ctx, this.displayName);
    const mac = parseNeighborMac(ctx, this.displayName);
    const ifAlias = ctx.named['interfacealias'] ? psValueToString(ctx.named['interfacealias']) : 'Ethernet';
    const err = requireNetwork(ctx).addNeighbor(ip, mac, ifAlias);
    if (err) throw new PSRuntimeError(err);
    return null;
  }
}

export class RemoveNetNeighborCmdlet implements ICmdlet {
  readonly name = 'remove-netneighbor';
  readonly displayName = 'Remove-NetNeighbor';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const ip = parseNeighborIp(ctx, this.displayName);
    const ifAlias = ctx.named['interfacealias'] ? psValueToString(ctx.named['interfacealias']) : undefined;
    const err = requireNetwork(ctx).removeNeighbor(ip, ifAlias);
    if (err) throw new PSRuntimeError(err);
    return null;
  }
}

export class SetNetNeighborCmdlet implements ICmdlet {
  readonly name = 'set-netneighbor';
  readonly displayName = 'Set-NetNeighbor';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const ip = parseNeighborIp(ctx, this.displayName);
    const mac = parseNeighborMac(ctx, this.displayName);
    const ifAlias = ctx.named['interfacealias'] ? psValueToString(ctx.named['interfacealias']) : undefined;
    const err = requireNetwork(ctx).setNeighbor(ip, mac, ifAlias);
    if (err) throw new PSRuntimeError(err);
    return null;
  }
}

export class GetNetTCPConnectionCmdlet implements ICmdlet {
  readonly name = 'get-nettcpconnection';
  readonly displayName = 'Get-NetTCPConnection';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    // Always emit at least a representative loopback row so the cmdlet
    // produces non-empty output (real Windows always has Local LISTEN
    // sockets). Avoids the historical throw-and-fallback dance.
    const seeded = [{
      localAddress: '0.0.0.0', localPort: 135,
      remoteAddress: '0.0.0.0', remotePort: 0,
      state: 'Listen', pid: 4,
    }];
    const real = requireNetwork(ctx).getTcpConnections();
    const conns = real.length ? real : seeded;
    return conns.map(c => ({
      LocalAddress:   c.localAddress,
      LocalPort:      c.localPort,
      RemoteAddress:  c.remoteAddress,
      RemotePort:     c.remotePort,
      State:          c.state,
      OwningProcess:  c.pid,
    } as Record<string, PSValue>)) as PSValue;
  }
}

// ── Get-NetUDPEndpoint ────────────────────────────────────────────────────

/**
 * Le pendant UDP de `Get-NetTCPConnection`. Pas de colonne `State` :
 * UDP n'a pas de connexion, un point de terminaison est une écoute.
 * C'est la vue PowerShell de ce que `netstat -an` montre pour 5355 et
 * 5353 — la preuve qu'un répondeur de lien tient son port, et non un
 * réglage qui l'affirmerait.
 */
export class GetNetUDPEndpointCmdlet implements ICmdlet {
  readonly name = 'get-netudpendpoint';
  readonly displayName = 'Get-NetUDPEndpoint';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const net = requireNetwork(ctx);
    const endpoints = net.getUdpEndpoints?.() ?? [];
    const rawPort = ctx.named['localport'];
    const portFilter = rawPort !== undefined ? Number(psValueToString(rawPort)) : null;
    return endpoints
      .filter(e => portFilter === null || e.localPort === portFilter)
      .map(e => ({
        LocalAddress:  e.localAddress,
        LocalPort:     e.localPort,
        OwningProcess: e.pid,
        ProcessName:   e.processName,
      } as Record<string, PSValue>)) as PSValue;
  }
}

// ── New / Remove-NetIPAddress ─────────────────────────────────────────────

export class NewNetIPAddressCmdlet implements ICmdlet {
  readonly name = 'new-netipaddress';
  readonly displayName = 'New-NetIPAddress';
  readonly aliases = [] as const;
  readonly pipelineByPropertyName = true as const;
  readonly description = 'Creates and configures an IP address.';
  readonly parameters = ['IPAddress', 'InterfaceAlias', 'InterfaceIndex', 'DefaultGateway',
    'AddressFamily', 'Type', 'PrefixLength', 'ValidLifetime', 'PreferredLifetime',
    'SkipAsSource', 'PolicyStore', 'WhatIf', 'Confirm'] as const;

  execute(ctx: CmdletContext): PSValue {
    const net = requireNetwork(ctx);
    const arg = (key: string): string | undefined =>
      ctx.named[key] === undefined ? undefined : psValueToString(ctx.named[key]);
    const decision = planNetIPAddress({
      ipAddress: arg('ipaddress') ?? (ctx.positional[0] === undefined ? undefined : psValueToString(ctx.positional[0])),
      interfaceAlias: arg('interfacealias'),
      interfaceIndex: arg('interfaceindex'),
      prefixLength: arg('prefixlength'),
      addressFamily: arg('addressfamily'),
      type: arg('type'),
      policyStore: arg('policystore'),
      defaultGateway: arg('defaultgateway'),
      skipAsSource: ctx.named['skipassource'] === true,
    }, { resolveInterface: spec => net.resolveNetInterface(spec) });
    if (!decision.ok) { ctx.emitError(`New-NetIPAddress : ${decision.message}`); return null; }
    const plan = decision.plan;

    if (ctx.named['whatif'] === true) {
      ctx.emit(`What if: Performing the operation "Create" on target "${plan.address.text}".`);
      return null;
    }
    try {
      net.addIPAddress(plan.address.text, plan.prefixLength, plan.iface.alias, {
        gateway: plan.gateway,
        skipAsSource: plan.skipAsSource,
        type: plan.type,
        policyStore: plan.policyStore,
        validLifetimeSeconds: lifetimeSecondsOf(ctx, 'validlifetime'),
        preferredLifetimeSeconds: lifetimeSecondsOf(ctx, 'preferredlifetime'),
      });
    } catch (e) {
      ctx.emitError(`New-NetIPAddress : ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
    const created = net.getIPAddresses().find(e => e.ipAddress.toLowerCase() === plan.address.text.toLowerCase());
    return created ? ipToPSObject(created) : null;
  }
}

export class RemoveNetIPAddressCmdlet implements ICmdlet {
  readonly name = 'remove-netipaddress';
  readonly displayName = 'Remove-NetIPAddress';
  readonly aliases = [] as const;
  readonly pipelineByPropertyName = true as const;
  readonly description = 'Removes an IP address and its configuration.';
  readonly parameters = [...NET_IP_FILTERS, 'DefaultGateway', 'PassThru', 'WhatIf', 'Confirm'] as const;

  execute(ctx: CmdletContext): PSValue {
    const net = requireNetwork(ctx);
    const selection = netIPSelectionOf(ctx, net);
    if (selection.ipAddress === undefined && ctx.positional[0] !== undefined) {
      selection.ipAddress = [psValueToString(ctx.positional[0])];
    }
    const matched = selectNetIPAddresses(net.getIPAddresses(), selection);
    if (matched.length === 0) {
      ctx.emitError(`Remove-NetIPAddress : ${noMatchingNetIPAddress(selection)}`);
      return null;
    }
    if (ctx.named['whatif'] === true) {
      for (const e of matched) {
        ctx.emit(`What if: Performing the operation "Remove-NetIPAddress" on target "IPAddress: ${e.ipAddress}, InterfaceAlias: ${e.ifAlias}".`);
      }
      return null;
    }
    if (confirmationDue(ctx, 'High')) {
      ctx.emitError(`Remove-NetIPAddress : ${NON_INTERACTIVE_HOST}`);
      return null;
    }
    const removed: Record<string, PSValue>[] = [];
    for (const entry of matched) {
      try {
        net.removeIPAddress(entry.ipAddress, entry.ifAlias);
        removed.push(ipToPSObject(entry));
      } catch (e) {
        ctx.emitError(`Remove-NetIPAddress : ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return ctx.named['passthru'] === true ? (removed as PSValue) : null;
  }
}

// ── New / Remove-NetRoute ─────────────────────────────────────────────────

export class NewNetRouteCmdlet implements ICmdlet {
  readonly name = 'new-netroute';
  readonly displayName = 'New-NetRoute';
  readonly aliases = [] as const;
  readonly pipelineByPropertyName = true as const;
  readonly description = 'Creates a route in the IP routing table.';
  readonly parameters = ['DestinationPrefix', 'InterfaceAlias', 'InterfaceIndex', 'NextHop',
    'AddressFamily', 'RouteMetric', 'Publish', 'Protocol', 'PolicyStore',
    'ValidLifetime', 'PreferredLifetime', 'WhatIf', 'Confirm'] as const;

  execute(ctx: CmdletContext): PSValue {
    const net = requireNetwork(ctx);
    const unsupported = unsupportedNetRouteFilter(ctx);
    if (unsupported) { ctx.emitError(`New-NetRoute : ${unsupported}`); return null; }
    const arg = (key: string): string | undefined =>
      ctx.named[key] === undefined ? undefined : psValueToString(ctx.named[key]);
    const decision = planNetRoute({
      destinationPrefix: arg('destinationprefix')
        ?? (ctx.positional[0] === undefined ? undefined : psValueToString(ctx.positional[0])),
      interfaceAlias: arg('interfacealias'),
      interfaceIndex: arg('interfaceindex'),
      nextHop: arg('nexthop'),
      addressFamily: arg('addressfamily'),
      routeMetric: arg('routemetric'),
      publish: arg('publish'),
      protocol: arg('protocol'),
      policyStore: arg('policystore'),
      validLifetimeSeconds: lifetimeSecondsOf(ctx, 'validlifetime'),
      preferredLifetimeSeconds: lifetimeSecondsOf(ctx, 'preferredlifetime'),
    }, { resolveInterface: spec => net.resolveNetInterface(spec) });
    if (!decision.ok) { ctx.emitError(`New-NetRoute : ${decision.message}`); return null; }
    const plan = decision.plan;

    const identity = {
      destinationPrefix: plan.destination.text,
      ifAlias: plan.iface.alias,
      nextHop: plan.nextHop,
    };
    const key = netRouteKey(identity);
    if (net.getRoutes().some(r => netRouteKey(r) === key)) {
      ctx.emitError(`New-NetRoute : Instance MSFT_NetRoute already exists`);
      return null;
    }
    if (ctx.named['whatif'] === true) {
      ctx.emit(`What if: Performing the operation "Create" on target "${plan.destination.text}".`);
      return null;
    }
    net.addRoute(plan.destination.text, plan.iface.alias, plan.nextHop, plan.routeMetric, {
      publish: plan.publish, protocol: plan.protocol, policyStore: plan.policyStore,
      addressFamily: plan.destination.family, ifIndex: plan.iface.ifIndex,
      validLifetimeSeconds: plan.validLifetimeSeconds,
      preferredLifetimeSeconds: plan.preferredLifetimeSeconds,
    });
    const created = net.getRoutes().find(r => netRouteKey(r) === key);
    return created ? routeToPSObject(created) : null;
  }
}

export class RemoveNetRouteCmdlet implements ICmdlet {
  readonly name = 'remove-netroute';
  readonly displayName = 'Remove-NetRoute';
  readonly aliases = [] as const;
  readonly pipelineByPropertyName = true as const;
  readonly description = 'Removes IP routes from the IP routing table.';
  readonly parameters = [...NET_ROUTE_FILTERS, 'PassThru', 'WhatIf', 'Confirm'] as const;

  execute(ctx: CmdletContext): PSValue {
    const net = requireNetwork(ctx);
    const unsupported = unsupportedNetRouteFilter(ctx);
    if (unsupported) { ctx.emitError(`Remove-NetRoute : ${unsupported}`); return null; }
    const selection = netRouteSelectionOf(ctx, net, NET_ROUTE_FILTERS);
    if (selection.destinationPrefix === undefined && ctx.positional[0] !== undefined) {
      selection.destinationPrefix = [psValueToString(ctx.positional[0])];
    }
    const matched = selectNetRoutes(net.getRoutes(), selection);
    if (matched.length === 0) {
      ctx.emitError(`Remove-NetRoute : ${noMatchingNetRoute(selection)}`);
      return null;
    }
    if (ctx.named['whatif'] === true) {
      for (const r of matched) {
        ctx.emit(`What if: Performing the operation "Remove-NetRoute" on target "DestinationPrefix: ${r.destinationPrefix}, InterfaceAlias: ${r.ifAlias}".`);
      }
      return null;
    }
    if (confirmationDue(ctx, 'High')) {
      ctx.emitError(`Remove-NetRoute : ${NON_INTERACTIVE_HOST}`);
      return null;
    }
    const removed = matched.map(routeToPSObject);
    for (const r of matched) net.removeRoute(r);
    return ctx.named['passthru'] === true ? (removed as PSValue) : null;
  }
}

const NET_IP_SET_FILTERS = ['IPAddress', 'InterfaceAlias', 'InterfaceIndex', 'AddressFamily',
  'AddressState', 'PrefixOrigin', 'SuffixOrigin', 'Type', 'PolicyStore'] as const;

export class SetNetIPAddressCmdlet implements ICmdlet {
  readonly name = 'set-netipaddress';
  readonly displayName = 'Set-NetIPAddress';
  readonly aliases = [] as const;
  readonly pipelineByPropertyName = true as const;
  readonly description = 'Modifies the configuration of an IP address.';
  readonly parameters = [...NET_IP_SET_FILTERS, 'PrefixLength', 'ValidLifetime',
    'PreferredLifetime', 'SkipAsSource', 'PassThru', 'WhatIf', 'Confirm'] as const;

  execute(ctx: CmdletContext): PSValue {
    const net = requireNetwork(ctx);
    const selection = netIPSelectionOf(ctx, net);
    selection.prefixLength = undefined;
    selection.skipAsSource = undefined;
    if (selection.ipAddress === undefined && ctx.positional[0] !== undefined) {
      selection.ipAddress = [psValueToString(ctx.positional[0])];
    }
    const matched = selectNetIPAddresses(net.getIPAddresses(), selection);
    if (matched.length === 0) {
      ctx.emitError(`Set-NetIPAddress : ${noMatchingNetIPAddress(selection)}`);
      return null;
    }

    const update: NetIPAddressUpdate = {
      validLifetimeSeconds: lifetimeSecondsOf(ctx, 'validlifetime'),
      preferredLifetimeSeconds: lifetimeSecondsOf(ctx, 'preferredlifetime'),
    };
    if (ctx.named['skipassource'] !== undefined) update.skipAsSource = ctx.named['skipassource'] === true;
    if (ctx.named['prefixlength'] !== undefined) {
      const given = psValueToString(ctx.named['prefixlength']);
      for (const entry of matched) {
        const problem = prefixLengthProblem(given, entry.addressFamily === 'IPv6' ? 'IPv6' : 'IPv4');
        if (problem) { ctx.emitError(`Set-NetIPAddress : ${problem}`); return null; }
      }
      update.prefixLength = parseInt(given.trim(), 10);
    }

    if (ctx.named['whatif'] === true) {
      for (const e of matched) {
        ctx.emit(`What if: Performing the operation "Set-NetIPAddress" on target "IPAddress: ${e.ipAddress}, InterfaceAlias: ${e.ifAlias}".`);
      }
      return null;
    }
    for (const entry of matched) {
      const message = net.setIPAddress(entry.ipAddress, entry.ifAlias, update);
      if (message) ctx.emitError(`Set-NetIPAddress : ${message}`);
    }
    if (ctx.named['passthru'] !== true) return null;
    const refreshed = selectNetIPAddresses(net.getIPAddresses(), selection);
    return refreshed.map(ipToPSObject) as PSValue;
  }
}

const NET_ROUTE_SET_FILTERS = ['DestinationPrefix', 'InterfaceAlias', 'InterfaceIndex',
  'NextHop', 'AddressFamily', 'Protocol', 'PolicyStore'] as const;

export class SetNetRouteCmdlet implements ICmdlet {
  readonly name = 'set-netroute';
  readonly displayName = 'Set-NetRoute';
  readonly aliases = [] as const;
  readonly pipelineByPropertyName = true as const;
  readonly description = 'Sets route information in the IP routing table.';
  readonly parameters = [...NET_ROUTE_SET_FILTERS, 'Publish', 'RouteMetric',
    'ValidLifetime', 'PreferredLifetime', 'PassThru', 'WhatIf', 'Confirm'] as const;

  execute(ctx: CmdletContext): PSValue {
    const net = requireNetwork(ctx);
    const unsupported = unsupportedNetRouteFilter(ctx);
    if (unsupported) { ctx.emitError(`Set-NetRoute : ${unsupported}`); return null; }
    const selection = netRouteSelectionOf(ctx, net, NET_ROUTE_SET_FILTERS);
    if (selection.destinationPrefix === undefined && ctx.positional[0] !== undefined) {
      selection.destinationPrefix = [psValueToString(ctx.positional[0])];
    }
    const matched = selectNetRoutes(net.getRoutes(), selection);
    if (matched.length === 0) {
      ctx.emitError(`Set-NetRoute : ${noMatchingNetRoute(selection)}`);
      return null;
    }

    const update: NetRouteUpdate = {};
    if (ctx.named['publish'] !== undefined) {
      const value = matchEnumValue(NET_ROUTE_PUBLISH, psValueToString(ctx.named['publish']));
      if (value === null) {
        ctx.emitError(`Set-NetRoute : Cannot validate argument on parameter 'Publish'. The argument does not belong to the set "${NET_ROUTE_PUBLISH.join(',')}".`);
        return null;
      }
      update.publish = value;
    }
    if (ctx.named['routemetric'] !== undefined) {
      const given = psValueToString(ctx.named['routemetric']).trim();
      if (!/^\d+$/.test(given) || parseInt(given, 10) > MAX_ROUTE_METRIC) {
        ctx.emitError(`Set-NetRoute : Cannot convert value "${given}" to type "System.UInt16". Error: "Value was either too large or too small for a UInt16."`);
        return null;
      }
      update.routeMetric = parseInt(given, 10);
    }
    update.validLifetimeSeconds = lifetimeSecondsOf(ctx, 'validlifetime');
    update.preferredLifetimeSeconds = lifetimeSecondsOf(ctx, 'preferredlifetime');

    if (ctx.named['whatif'] === true) {
      for (const r of matched) {
        ctx.emit(`What if: Performing the operation "Set-NetRoute" on target "DestinationPrefix: ${r.destinationPrefix}, InterfaceAlias: ${r.ifAlias}".`);
      }
      return null;
    }
    for (const r of matched) {
      const message = net.setRoute(r, update);
      if (message) ctx.emitError(`Set-NetRoute : ${message}`);
    }
    if (ctx.named['passthru'] !== true) return null;
    return selectNetRoutes(net.getRoutes(), selection).map(routeToPSObject) as PSValue;
  }
}

// ── Restart-NetAdapter (cycle adapter status) ────────────────────────────

export class RestartNetAdapterCmdlet implements ICmdlet {
  readonly name = 'restart-netadapter';
  readonly displayName = 'Restart-NetAdapter';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const net = requireNetwork(ctx);
    const name = psValueToString(ctx.named['name'] ?? ctx.positional[0] ?? '');
    if (!name) { ctx.emitError('Restart-NetAdapter requires -Name'); return null; }
    net.setAdapterStatus(name, 'Down');
    net.setAdapterStatus(name, 'Up');
    return null;
  }
}

const COMMON_TCP_PORTS: Record<string, number> = {
  http: 80, smb: 445, rdp: 3389, winrm: 5985, winrmhttp: 5985, winrmhttps: 5986,
};

export class TestNetConnectionCmdlet implements ICmdlet {
  readonly name = 'test-netconnection';
  readonly displayName = 'Test-NetConnection';
  readonly aliases = [] as const;
  readonly parameters = ['ComputerName', 'Port', 'CommonTCPPort', 'InformationLevel', 'TraceRoute'] as const;

  execute(ctx: CmdletContext): PSValue {
    const net = requireNetwork(ctx);
    const target = psValueToString(
      ctx.named['computername'] ?? ctx.named['targetname'] ?? ctx.positional[0] ?? '',
    );
    if (!target) { ctx.emitError('Test-NetConnection requires -ComputerName'); return null; }

    let port: number | undefined;
    if (ctx.named['port'] !== undefined) {
      const n = Number(psValueToString(ctx.named['port']));
      if (Number.isFinite(n) && n > 0) port = n;
    } else if (ctx.named['commontcpport'] !== undefined) {
      const name = psValueToString(ctx.named['commontcpport']).toLowerCase();
      if (COMMON_TCP_PORTS[name] !== undefined) port = COMMON_TCP_PORTS[name];
    }

    const level = psValueToString(ctx.named['informationlevel'] ?? 'standard').toLowerCase();
    const detailed = level === 'detailed';
    const quiet = level === 'quiet';

    const probe = net.testPingProbe?.(target) ?? null;
    const remoteAddress = probe?.resolvedIp ?? target;
    const pingSucceeded = probe?.success ?? false;
    const rttMs = probe?.success ? Math.round(probe.rttMs) : 0;

    const tcpTested = port !== undefined;
    const tcpSucceeded = tcpTested && pingSucceeded
      ? (net.testTcpProbe?.(target, port!) ?? false)
      : false;

    const egress = probe ? (net.egressInfoFor?.(target) ?? null) : null;
    const sourceAddress = egress?.sourceIp ?? '0.0.0.0';
    const interfaceAlias = egress?.interfaceAlias ?? 'Ethernet';
    const nextHop = egress?.nextHop ?? '0.0.0.0';

    if (quiet) return tcpTested ? tcpSucceeded : pingSucceeded;

    const result: Record<string, PSValue> = {
      ComputerName:        target,
      RemoteAddress:       remoteAddress,
      InterfaceAlias:      interfaceAlias,
      SourceAddress:       sourceAddress,
      PingSucceeded:       pingSucceeded,
      PingReplyDetails:    rttMs,
    };
    if (tcpTested) {
      result.RemotePort = port!;
      result.TcpTestSucceeded = tcpSucceeded;
    }
    if (detailed) {
      result.NameResolutionResults = probe ? [remoteAddress] : [];
      result.NetRouteNextHop = nextHop;
    }
    if (ctx.named['traceroute'] !== undefined) {
      result.TraceRoute = net.traceRoute(target);
    }
    return result;
  }
}

// ── Enable / Disable / Rename-NetAdapter ──────────────────────────────────

export class EnableNetAdapterCmdlet implements ICmdlet {
  readonly name = 'enable-netadapter';
  readonly displayName = 'Enable-NetAdapter';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const net = requireNetwork(ctx);
    const name = psValueToString(ctx.named['name'] ?? ctx.positional[0] ?? '');
    if (!name) { ctx.emitError('Enable-NetAdapter requires -Name'); return null; }
    net.setAdapterStatus(name, 'Up');
    return null;
  }
}

export class DisableNetAdapterCmdlet implements ICmdlet {
  readonly name = 'disable-netadapter';
  readonly displayName = 'Disable-NetAdapter';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const net = requireNetwork(ctx);
    const name = psValueToString(ctx.named['name'] ?? ctx.positional[0] ?? '');
    if (!name) { ctx.emitError('Disable-NetAdapter requires -Name'); return null; }
    net.setAdapterStatus(name, 'Down');
    return null;
  }
}

export class RenameNetAdapterCmdlet implements ICmdlet {
  readonly name = 'rename-netadapter';
  readonly displayName = 'Rename-NetAdapter';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const net = requireNetwork(ctx);
    const name    = psValueToString(ctx.named['name']    ?? ctx.positional[0] ?? '');
    const newName = psValueToString(ctx.named['newname'] ?? ctx.positional[1] ?? '');
    if (!name || !newName) {
      ctx.emitError('Rename-NetAdapter requires -Name and -NewName');
      return null;
    }
    net.renameAdapter(name, newName);
    return null;
  }
}

// ── Get / Set-DnsClientServerAddress + Clear-DnsClientCache ────────────────

export class GetDnsClientServerAddressCmdlet implements ICmdlet {
  readonly name = 'get-dnsclientserveraddress';
  readonly displayName = 'Get-DnsClientServerAddress';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const net = requireNetwork(ctx);
    const ifAlias = ctx.named['interfacealias']
      ? psValueToString(ctx.named['interfacealias'])
      : undefined;
    const adapters = net.getAdapters();
    const filtered = ifAlias
      ? (() => { const match = net.getAdapter(ifAlias); return match ? [match] : []; })()
      : adapters;
    return filtered.map(a => ({
      InterfaceAlias: a.name,
      InterfaceIndex: a.ifIndex,
      AddressFamily:  'IPv4',
      ServerAddresses: net.getDnsServers(a.name),
    } as Record<string, PSValue>)) as PSValue;
  }
}

export class SetDnsClientServerAddressCmdlet implements ICmdlet {
  readonly name = 'set-dnsclientserveraddress';
  readonly displayName = 'Set-DnsClientServerAddress';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const net = requireNetwork(ctx);
    const ifAlias = psValueToString(ctx.named['interfacealias'] ?? ctx.positional[0] ?? '');
    const raw     = ctx.named['serveraddresses'];
    if (!ifAlias) { ctx.emitError('Set-DnsClientServerAddress requires -InterfaceAlias'); return null; }
    if (raw === undefined || raw === null) {
      ctx.emitError('Set-DnsClientServerAddress requires -ServerAddresses');
      return null;
    }
    const servers = (Array.isArray(raw) ? raw : [raw]).map(psValueToString);
    net.setDnsServers(ifAlias, servers);
    return null;
  }
}

export class GetDnsClientCacheCmdlet implements ICmdlet {
  readonly name = 'get-dnsclientcache';
  readonly displayName = 'Get-DnsClientCache';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const entries = requireNetwork(ctx).getDnsClientCache?.() ?? [];
    const rawFilter = ctx.named['name'] ?? ctx.positional[0];
    const nameFilter = rawFilter !== undefined ? psValueToString(rawFilter).toLowerCase() : null;
    return entries
      .filter(e => !nameFilter || e.name.toLowerCase() === nameFilter)
      .map(e => ({
        Entry:      e.name,
        RecordName: e.name,
        RecordType: e.type,
        Status:     'Success',
        Section:    'Answer',
        TimeToLive: e.ttl,
        Data:       e.value,
      } as Record<string, PSValue>)) as PSValue;
  }
}

export class ClearDnsClientCacheCmdlet implements ICmdlet {
  readonly name = 'clear-dnsclientcache';
  readonly displayName = 'Clear-DnsClientCache';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    requireNetwork(ctx).clearDnsClientCache?.();
    return null;
  }
}

// ── Get / New / Set / Enable / Disable / Remove-NetFirewallRule ────────────

export class GetNetFirewallRuleCmdlet implements ICmdlet {
  readonly name = 'get-netfirewallrule';
  readonly displayName = 'Get-NetFirewallRule';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const displayName = ctx.named['displayname'] !== undefined
      ? psValueToString(ctx.named['displayname']).toLowerCase() : null;
    const name = ctx.named['name'] !== undefined
      ? psValueToString(ctx.named['name']).toLowerCase() : null;
    const rules = requireNetwork(ctx).getFirewallRules()
      .filter(r => !displayName || r.displayName?.toLowerCase() === displayName || r.name.toLowerCase() === displayName)
      .filter(r => !name || r.name.toLowerCase() === name);
    return rules.map(r => ({
      Name: r.name,
      DisplayName: r.displayName,
      Enabled: r.enabled,
      Action: r.action,
      Direction: r.direction,
      Protocol: r.protocol,
      LocalPort: r.localPort,
      RemotePort: r.remotePort,
      Description: r.description,
    } as Record<string, PSValue>)) as PSValue;
  }
}

export class NewNetFirewallRuleCmdlet implements ICmdlet {
  readonly name = 'new-netfirewallrule';
  readonly displayName = 'New-NetFirewallRule';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const net = requireNetwork(ctx);
    const displayName = psValueToString(ctx.named['displayname'] ?? '');
    const name        = psValueToString(ctx.named['name']        ?? displayName);
    const action      = psValueToString(ctx.named['action']      ?? 'Allow');
    const direction   = psValueToString(ctx.named['direction']   ?? 'Inbound');
    if (!displayName) {
      ctx.emitError('New-NetFirewallRule requires -DisplayName');
      return null;
    }
    net.addFirewallRule({
      name,
      displayName,
      enabled: ctx.named['enabled'] === undefined ? true : ctx.named['enabled'] === true,
      action,
      direction,
      protocol:    ctx.named['protocol']    ? psValueToString(ctx.named['protocol'])    : undefined,
      localPort:   ctx.named['localport']   ? psValueToString(ctx.named['localport'])   : undefined,
      remotePort:  ctx.named['remoteport']  ? psValueToString(ctx.named['remoteport'])  : undefined,
      description: ctx.named['description'] ? psValueToString(ctx.named['description']) : undefined,
    });
    return null;
  }
}

abstract class FirewallToggleCmdlet implements ICmdlet {
  abstract readonly name: string;
  abstract readonly aliases: readonly string[];
  protected abstract enabled: boolean;

  execute(ctx: CmdletContext): PSValue {
    const net = requireNetwork(ctx);
    const name = psValueToString(ctx.named['displayname'] ?? ctx.named['name'] ?? ctx.positional[0] ?? '');
    if (!name) { ctx.emitError(`${this.name} requires -DisplayName or -Name`); return null; }
    const msg = net.setFirewallRule(name, { enabled: this.enabled });
    if (msg) ctx.emitError(msg);
    return null;
  }
}

export class EnableNetFirewallRuleCmdlet extends FirewallToggleCmdlet {
  readonly name = 'enable-netfirewallrule';
  readonly displayName = 'Enable-NetFirewallRule';
  readonly aliases = [] as const;
  protected enabled = true;
}
export class DisableNetFirewallRuleCmdlet extends FirewallToggleCmdlet {
  readonly name = 'disable-netfirewallrule';
  readonly displayName = 'Disable-NetFirewallRule';
  readonly aliases = [] as const;
  protected enabled = false;
}

export class SetNetFirewallRuleCmdlet implements ICmdlet {
  readonly name = 'set-netfirewallrule';
  readonly displayName = 'Set-NetFirewallRule';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const net = requireNetwork(ctx);
    const name = psValueToString(ctx.named['displayname'] ?? ctx.named['name'] ?? ctx.positional[0] ?? '');
    if (!name) { ctx.emitError('Set-NetFirewallRule requires -DisplayName or -Name'); return null; }
    const opts: { enabled?: boolean; action?: string } = {};
    if (ctx.named['enabled'] !== undefined) opts.enabled = ctx.named['enabled'] === true;
    if (ctx.named['action']  !== undefined) opts.action  = psValueToString(ctx.named['action']);
    const msg = net.setFirewallRule(name, opts);
    if (msg) ctx.emitError(msg);
    return null;
  }
}

export class RemoveNetFirewallRuleCmdlet implements ICmdlet {
  readonly name = 'remove-netfirewallrule';
  readonly displayName = 'Remove-NetFirewallRule';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const net = requireNetwork(ctx);
    const name = psValueToString(ctx.named['displayname'] ?? ctx.named['name'] ?? ctx.positional[0] ?? '');
    if (!name) { ctx.emitError('Remove-NetFirewallRule requires -DisplayName or -Name'); return null; }
    const msg = net.removeFirewallRule(name);
    if (msg) ctx.emitError(msg);
    return null;
  }
}

// ── Get / Set-NetConnectionProfile ────────────────────────────────────────

export class GetNetConnectionProfileCmdlet implements ICmdlet {
  readonly name = 'get-netconnectionprofile';
  readonly displayName = 'Get-NetConnectionProfile';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const net = requireNetwork(ctx);
    const adapters = net.getAdapters();
    return adapters.map(a => ({
      Name:                    a.name,
      InterfaceAlias:          a.name,
      InterfaceIndex:          a.ifIndex,
      NetworkCategory:         net.getNetworkProfile(a.ifIndex),
      IPv4Connectivity:        'Internet',
      IPv6Connectivity:        'NoTraffic',
    } as Record<string, PSValue>)) as PSValue;
  }
}

export class SetNetConnectionProfileCmdlet implements ICmdlet {
  readonly name = 'set-netconnectionprofile';
  readonly displayName = 'Set-NetConnectionProfile';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const net = requireNetwork(ctx);
    const ifAlias  = psValueToString(ctx.named['interfacealias'] ?? '');
    const category = psValueToString(ctx.named['networkcategory'] ?? '');
    if (!ifAlias || !category) {
      ctx.emitError('Set-NetConnectionProfile requires -InterfaceAlias and -NetworkCategory');
      return null;
    }
    const adapter = net.getAdapter(ifAlias);
    if (!adapter) { ctx.emitError(`Interface ${ifAlias} not found`); return null; }
    net.setNetworkProfile(adapter.ifIndex, category);
    return null;
  }
}

// ── hostname / whoami (native-command shims) ──────────────────────────────
// These are CMD-style tools, not real cmdlets — but PowerShell happily runs
// them by name. Keeping them in the interpreter avoids the bypass list and
// keeps state coherent (the executor would otherwise own the source of
// truth for `whoami` admin context).

export class HostnameCmdlet implements ICmdlet {
  readonly name = 'hostname';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    return requireNetwork(ctx).getHostname();
  }
}

export class WhoamiCmdlet implements ICmdlet {
  readonly name = 'whoami';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    if (!ctx.providers.network) throw new PSRuntimeError('whoami is not recognized in this context');
    const host = ctx.providers.network.getHostname();
    const user = ctx.env.get('env:username') ?? ctx.runtime.executeForValue('$env:USERNAME') ?? 'user';
    const domain = ctx.providers.environment?.get('USERDOMAIN') ?? host;
    return `${domain}\\${user}`;
  }
}
