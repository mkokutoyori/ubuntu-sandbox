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
  NetAdapterEntry, IPAddressInfo, INetworkProvider, NetIPAddressUpdate, RouteInfo,
  NeighborInfo,
} from '@/powershell/providers/PSProviders';
import { psValueToString } from '@/powershell/runtime/PSExpansion';
import { makeTimeSpan } from './DateTimeCmdlets';
import { NON_INTERACTIVE_HOST, confirmationDue } from '../confirmation';
import { remoteCimRefusal } from '../cimCommon';
import {
  type NetFirewallRuleEntry, type NetFirewallSelection, generatedFirewallRuleName,
  noMatchingFirewallRule, planNetFirewallRule, selectFirewallRules,
} from '@/network/devices/windows/netFirewallRule';
import {
  type NetIPAddressSelection, NET_ADDRESS_FAMILIES, NET_POLICY_STORES,
  NO_MATCHING_INTERFACE, TIMESPAN_MAX_SECONDS, matchEnumValue,
  noMatchingNetIPAddress, planNetIPAddress, prefixLengthProblem, selectNetIPAddresses,
} from '@/network/devices/windows/netIpAddress';
import { LOOPBACK_IFALIAS } from '@/network/devices/windows/WindowsLoopbackRoutes';
import { LOOPBACK_IFINDEX } from '@/network/devices/windows/WindowsInterfaceNaming';
import {
  type NetRouteSelection, type NetRouteUpdate, MAX_ROUTE_METRIC, NET_ROUTE_PUBLISH,
  netRouteKey, noMatchingNetRoute, planNetRoute, selectNetRoutes,
} from '@/network/devices/windows/netRoute';
import {
  type NetAdapterSelection, adapterNameProblem, adapterNameTaken, formatNetAdapterMac,
  noMatchingNetAdapter, parseNetAdapterMac, selectNetAdapters, selectionIsEmpty,
} from '@/network/devices/windows/netAdapter';
import {
  type DnsCacheSelection, dnsCacheEnumProblem, dnsCacheSelectionIsEmpty,
  noMatchingDnsCacheEntry, selectDnsCacheEntries,
} from '@/network/devices/windows/dnsClientCache';
import {
  type NetUdpEndpointRow, type NetUdpEndpointSelection, noMatchingNetUdpEndpoint,
  selectNetUdpEndpoints, udpEndpointSelectionIsEmpty, udpPortProblem,
} from '@/network/devices/windows/netUdpEndpoint';
import {
  type NetNeighborSelection, NET_NEIGHBOR_STATES, neighborSelectionIsEmpty,
  noMatchingNetNeighbor, planNetNeighbor, selectNetNeighbors,
} from '@/network/devices/windows/netNeighbor';
import {
  type NetTcpConnectionRow, type NetTcpConnectionSelection, NET_TCP_APPLIED_SETTINGS,
  NET_TCP_OFFLOAD_STATES, NET_TCP_STATES, netTcpSelectionIsEmpty, netTcpStateOf,
  noMatchingNetTcpConnection, selectNetTcpConnections,
} from '@/network/devices/windows/netTcpConnection';
import {
  type NetConnectionProfileRow, type NetConnectionProfileSelection, NETWORK_CATEGORIES,
  SETTABLE_NETWORK_CATEGORIES, connectivityOf, noMatchingNetConnectionProfile,
  profileSelectionIsEmpty, selectNetConnectionProfiles,
} from '@/network/devices/windows/netConnectionProfile';
import {
  type DnsClientServerAddressRow, type DnsClientServerAddressSelection,
  dnsServerSelectionIsEmpty, noMatchingDnsClientServerAddress, selectDnsClientServerAddresses,
} from '@/network/devices/windows/dnsClientServerAddress';
import type { NetAddressFamily } from '@/network/devices/windows/netIpAddress';
import { applyCimCriteria, cimNotFound } from '@/network/devices/windows/cimQuery';
import { PortNumber } from '@/network/core/ports/PortNumber';
import { commandNotFoundMessage } from '@/powershell/commandNotFound';

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
    throw new PSRuntimeError(commandNotFoundMessage('This cmdlet'));
  }
  return ctx.providers.network;
}

function adapterToPSObject(a: NetAdapterEntry): Record<string, PSValue> {
  return {
    Name:         a.name,
    InterfaceDescription: a.interfaceDescription,
    ifIndex:      a.ifIndex,
    Status:       a.status,
    MacAddress:   formatNetAdapterMac(a.macAddress),
    LinkSpeed:    a.linkSpeed,
  };
}

const NET_ADAPTER_FILTERS = ['Name', 'InterfaceDescription', 'InterfaceIndex',
  'IncludeHidden', 'Physical', 'CimSession'] as const;

const NET_ADAPTER_ACTION_PARAMS = [...NET_ADAPTER_FILTERS,
  'PassThru', 'WhatIf', 'Confirm'] as const;

function cimFilterReader(
  ctx: CmdletContext, filters?: readonly string[],
): (key: string) => string[] | undefined {
  const allowed = filters === undefined ? null : new Set(filters.map(f => f.toLowerCase()));
  return (key: string): string[] | undefined => {
    const raw = allowed !== null && !allowed.has(key) ? undefined : ctx.named[key];
    if (raw === undefined) return undefined;
    return (Array.isArray(raw) ? raw : [raw]).map(psValueToString);
  };
}

function resolvedAliases(
  net: INetworkProvider, aliases: string[] | undefined,
): string[] | undefined {
  return aliases?.map(a => net.resolveNetInterface({ alias: a })?.alias ?? a);
}

function netAdapterSelectionOf(ctx: CmdletContext): NetAdapterSelection {
  const list = cimFilterReader(ctx);
  const positional = ctx.positional[0];
  return {
    name: list('name') ?? (positional === undefined ? undefined : [psValueToString(positional)]),
    interfaceDescription: list('interfacedescription') ?? list('ifdesc'),
    interfaceIndex: list('interfaceindex') ?? list('ifindex'),
    includeHidden: ctx.named['includehidden'] === true,
    physical: ctx.named['physical'] === true,
  };
}

function selectedAdapters(
  ctx: CmdletContext, net: INetworkProvider, cmdlet: string,
): NetAdapterEntry[] | null {
  const remote = remoteCimRefusal(ctx, cmdlet);
  if (remote !== null) { ctx.emitError(remote); return null; }
  const selection = netAdapterSelectionOf(ctx);
  const matched = selectNetAdapters(net.getAdapters(), selection);
  if (matched.length === 0 && !selectionIsEmpty(selection)) {
    ctx.emitError(`${cmdlet} : ${noMatchingNetAdapter(selection)}`);
    return null;
  }
  return matched;
}

function adapterActionAllowed(
  ctx: CmdletContext, cmdlet: string, targets: readonly NetAdapterEntry[], impact: 'None' | 'High',
): boolean {
  if (ctx.named['whatif'] === true) {
    for (const a of targets) {
      ctx.emit(`What if: Performing the operation "${cmdlet}" on target "${a.name}".`);
    }
    return false;
  }
  if (confirmationDue(ctx, impact)) {
    ctx.emitError(`${cmdlet} : ${NON_INTERACTIVE_HOST}`);
    return false;
  }
  return true;
}

function adapterPassThru(
  ctx: CmdletContext, net: INetworkProvider, touched: readonly NetAdapterEntry[],
): PSValue {
  if (ctx.named['passthru'] !== true) return null;
  const ports = new Set(touched.map(a => a.portName));
  return net.getAdapters().filter(a => ports.has(a.portName)).map(adapterToPSObject) as PSValue;
}

function ipToPSObject(ip: IPAddressInfo): Record<string, PSValue> {
  // ValidLifetime/PreferredLifetime are TimeSpans on a real host; leased
  // addresses carry the residual lease time, everything else is "forever"
  // (TimeSpan.MaxValue, ~10675199 days — what Get-NetIPAddress prints).
  const validMs = (ip.validLifetimeSeconds ?? TIMESPAN_MAX_SECONDS) * 1000;
  const prefMs = (ip.preferredLifetimeSeconds ?? TIMESPAN_MAX_SECONDS) * 1000;
  return {
    IPAddress:      ip.ipAddress,
    PrefixLength:   ip.prefixLength,
    InterfaceAlias: ip.ifAlias,
    InterfaceIndex: ip.ifIndex,
    PrefixOrigin:  ip.prefixOrigin,
    SuffixOrigin:  ip.suffixOrigin,
    AddressFamily: ip.addressFamily,
    AddressState:  'Preferred',
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
  readonly description = 'Gets the basic network adapter properties.';
  readonly parameters = NET_ADAPTER_FILTERS;

  execute(ctx: CmdletContext): PSValue {
    const net = requireNetwork(ctx);
    const matched = selectedAdapters(ctx, net, 'Get-NetAdapter');
    if (matched === null) return null;
    return matched.map(adapterToPSObject) as PSValue;
  }
}

// ── Get-NetIPAddress ──────────────────────────────────────────────────────

const NET_IP_FILTERS = ['IPAddress', 'InterfaceAlias', 'InterfaceIndex', 'AddressFamily',
  'AddressState', 'PrefixLength', 'PrefixOrigin', 'SuffixOrigin', 'SkipAsSource',
  'Type', 'PolicyStore'] as const;

function netIPSelectionOf(ctx: CmdletContext, net: INetworkProvider): NetIPAddressSelection {
  const list = cimFilterReader(ctx);
  const aliases = list('interfacealias');
  return {
    ipAddress: list('ipaddress'),
    interfaceAlias: resolvedAliases(net, aliases),
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

const NET_IP_INTERFACE_FILTERS = ['InterfaceAlias', 'InterfaceIndex', 'AddressFamily',
  'NlMtuBytes', 'Dhcp', 'ConnectionState', 'CimSession'] as const;

const NET_IP_INTERFACE_UNSUPPORTED: ReadonlyArray<readonly [string, string, string]> = [
  ['forwarding', 'Forwarding', 'per-interface IP forwarding is not modelled'],
  ['advertising', 'Advertising', 'router advertisement is not modelled on a Windows host'],
  ['clampmss', 'ClampMss', 'MSS clamping is not modelled'],
  ['interfacemetric', 'InterfaceMetric', 'a per-interface routing metric is not modelled'],
  ['automaticmetric', 'AutomaticMetric', 'a per-interface routing metric is not modelled'],
  ['neighborunreachabilitydetection', 'NeighborUnreachabilityDetection', 'NUD state is not modelled'],
  ['basereachabletimems', 'BaseReachableTimeMs', 'NUD timers are not modelled'],
  ['reachabletimems', 'ReachableTimeMs', 'NUD timers are not modelled'],
  ['retransmittimems', 'RetransmitTimeMs', 'NUD timers are not modelled'],
  ['dadtransmits', 'DadTransmits', 'duplicate address detection is not modelled'],
  ['dadretransmittimems', 'DadRetransmitTimeMs', 'duplicate address detection is not modelled'],
  ['routerdiscovery', 'RouterDiscovery', 'router discovery is not modelled on a Windows host'],
  ['managedaddressconfiguration', 'ManagedAddressConfiguration', 'router advertisement flags are not modelled'],
  ['otherstatefulconfiguration', 'OtherStatefulConfiguration', 'router advertisement flags are not modelled'],
  ['weakhostsend', 'WeakHostSend', 'the weak host model is not modelled'],
  ['weakhostreceive', 'WeakHostReceive', 'the weak host model is not modelled'],
  ['ignoredefaultroutes', 'IgnoreDefaultRoutes', 'per-interface route policy is not modelled'],
  ['advertisedrouterlifetime', 'AdvertisedRouterLifetime', 'router advertisement is not modelled on a Windows host'],
  ['advertisedefaultroute', 'AdvertiseDefaultRoute', 'router advertisement is not modelled on a Windows host'],
  ['currenthoplimit', 'CurrentHopLimit', 'a per-interface hop limit is not modelled'],
  ['forcearpndwolpattern', 'ForceArpNdWolPattern', 'wake-on-LAN is not modelled'],
  ['directedmacwolpattern', 'DirectedMacWolPattern', 'wake-on-LAN is not modelled'],
  ['ecnmarking', 'EcnMarking', 'ECN is not modelled'],
  ['neighbordiscoverysupported', 'NeighborDiscoverySupported', 'NDP capability is not modelled'],
  ['compartmentid', 'CompartmentId', 'network compartments are not modelled'],
  ['includeallcompartments', 'IncludeAllCompartments', 'network compartments are not modelled'],
  ['associatedroute', 'AssociatedRoute', 'the by-route parameter set is not modelled'],
  ['associatedipaddress', 'AssociatedIPAddress', 'the by-address parameter set is not modelled'],
  ['associatedneighbor', 'AssociatedNeighbor', 'the by-neighbor parameter set is not modelled'],
  ['associatedadapter', 'AssociatedAdapter', 'the by-adapter parameter set is not modelled'],
];

interface NetIPInterfaceRow {
  ifAlias: string;
  ifIndex: number;
  addressFamily: NetAddressFamily;
  nlMtu: number;
  dhcp: string;
  connectionState: string;
}

export class GetNetIPInterfaceCmdlet implements ICmdlet {
  readonly name = 'get-netipinterface';
  readonly displayName = 'Get-NetIPInterface';
  readonly aliases = [] as const;
  readonly description = 'Gets the IP interface properties.';
  readonly parameters = NET_IP_INTERFACE_FILTERS;

  execute(ctx: CmdletContext): PSValue {
    const net = requireNetwork(ctx);
    const remote = remoteCimRefusal(ctx, this.displayName);
    if (remote !== null) { ctx.emitError(remote); return null; }
    for (const [key, name, why] of NET_IP_INTERFACE_UNSUPPORTED) {
      if (ctx.named[key] === undefined) continue;
      ctx.emitError(`${this.displayName} : The -${name} parameter is not implemented`
        + ` in this simulator: ${why}.`);
      return null;
    }
    const list = cimFilterReader(ctx, NET_IP_INTERFACE_FILTERS);
    const positional = ctx.positional[0];
    const aliases = list('interfacealias')
      ?? (positional === undefined ? undefined : [psValueToString(positional)]);
    const family = list('addressfamily');
    const bad = family?.find(v => matchEnumValue(NET_ADDRESS_FAMILIES, v) === null);
    if (bad !== undefined) {
      ctx.emitError(`${this.displayName} : Cannot validate argument on parameter 'AddressFamily'.`
        + ` The argument does not belong to the set "${NET_ADDRESS_FAMILIES.join(',')}".`);
      return null;
    }

    const rows: NetIPInterfaceRow[] = [];
    for (const a of net.getAdapters()) {
      for (const addressFamily of NET_ADDRESS_FAMILIES) {
        rows.push({
          ifAlias: a.name,
          ifIndex: a.ifIndex,
          addressFamily,
          nlMtu: a.mtu,
          dhcp: net.isDHCPConfigured(a.name) ? 'Enabled' : 'Disabled',
          connectionState: a.status === 'Up' ? 'Connected' : 'Disconnected',
        });
      }
    }
    const selection = {
      interfaceAlias: resolvedAliases(net, aliases),
      interfaceIndex: list('interfaceindex'),
      addressFamily: family,
      nlMtuBytes: list('nlmtubytes'),
      dhcp: list('dhcp'),
      connectionState: list('connectionstate'),
    };
    const matched = applyCimCriteria(rows, [
      [selection.interfaceAlias, r => r.ifAlias],
      [selection.interfaceIndex, r => String(r.ifIndex)],
      [selection.addressFamily, r => r.addressFamily],
      [selection.nlMtuBytes, r => String(r.nlMtu)],
      [selection.dhcp, r => r.dhcp],
      [selection.connectionState, r => r.connectionState],
    ]);
    if (matched.length === 0 && Object.values(selection).some(v => v !== undefined)) {
      ctx.emitError(`${this.displayName} : ${cimNotFound('MSFT_NetIPInterface', [
        ['InterfaceAlias', selection.interfaceAlias],
        ['InterfaceIndex', selection.interfaceIndex],
        ['AddressFamily', selection.addressFamily],
        ['Dhcp', selection.dhcp],
        ['ConnectionState', selection.connectionState],
      ])}`);
      return null;
    }
    return matched.map(r => ({
      ifIndex:         r.ifIndex,
      InterfaceAlias:  r.ifAlias,
      AddressFamily:   r.addressFamily,
      NlMtu:           r.nlMtu,
      Dhcp:            r.dhcp,
      ConnectionState: r.connectionState,
    } as Record<string, PSValue>)) as PSValue;
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
      if (a !== '127') { ctx.emitError(`${ptrName} : DNS name does not exist`); return null; }
      return [{
        Name: ptrName,
        Type: 'PTR',
        TTL: 300,
        Section: 'Answer',
        NameHost: 'localhost',
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
      cacheEntries.find(e => e.recordName.toLowerCase() === name.toLowerCase() && e.data === ip)?.timeToLive ?? 300;
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
  readonly parameters = ['InterfaceAlias', 'InterfaceIndex', 'All', 'Detailed',
    'CimSession'] as const;

  execute(ctx: CmdletContext): PSValue {
    const net = requireNetwork(ctx);
    const remote = remoteCimRefusal(ctx, this.displayName);
    if (remote !== null) { ctx.emitError(remote); return null; }
    for (const [key, name] of [['allcompartments', 'AllCompartments'], ['compartmentid', 'CompartmentId']] as const) {
      if (ctx.named[key] !== undefined) {
        ctx.emitError(`Get-NetIPConfiguration : The -${name} parameter is not implemented in this simulator: network compartments are not modelled.`);
        return null;
      }
    }
    const all = ctx.named['all'] === true;
    const detailed = ctx.named['detailed'] === true;
    const defaultRoutes = net.getRoutes().filter(r => r.destinationPrefix === '0.0.0.0/0');
    const rows: Array<{ alias: string; description: string; ifIndex: number; connected: boolean }> =
      net.getAdapters().map(a => ({
        alias: a.name, description: a.interfaceDescription, ifIndex: a.ifIndex, connected: a.status === 'Up',
      }));
    rows.push({
      alias: LOOPBACK_IFALIAS, description: 'Software Loopback Interface 1',
      ifIndex: LOOPBACK_IFINDEX, connected: true,
    });

    const alias = ctx.named['interfacealias'] ?? ctx.positional[0];
    const index = ctx.named['interfaceindex'];
    const named = alias !== undefined && alias !== null
      ? rows.find(r => r.alias.toLowerCase() === psValueToString(alias).toLowerCase()
          || r.alias.toLowerCase() === (net.resolveNetInterface({ alias: psValueToString(alias) })?.alias ?? '').toLowerCase())
      : index !== undefined && index !== null
        ? rows.find(r => String(r.ifIndex) === psValueToString(index).trim())
        : undefined;
    const asked = (alias !== undefined && alias !== null) || (index !== undefined && index !== null);
    if (asked && named === undefined) {
      ctx.emitError(`Get-NetIPConfiguration : ${NO_MATCHING_INTERFACE}`);
      return null;
    }

    const kept = named !== undefined ? [named]
      : all ? rows : rows.filter(r => r.connected && r.ifIndex !== LOOPBACK_IFINDEX);
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
      if (detailed) row.ComputerName = net.getHostname();
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
  const list = cimFilterReader(ctx, filters);
  const spans = (key: string): string[] | undefined => {
    const raw = allowed.has(key) ? ctx.named[key] : undefined;
    if (raw === undefined) return undefined;
    return (Array.isArray(raw) ? raw : [raw])
      .map(v => String(lifetimeSeconds(v) ?? TIMESPAN_MAX_SECONDS));
  };
  const aliases = list('interfacealias');
  return {
    destinationPrefix: list('destinationprefix'),
    interfaceAlias: resolvedAliases(net, aliases),
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

const NET_NEIGHBOR_FILTERS = ['IPAddress', 'InterfaceIndex', 'InterfaceAlias',
  'LinkLayerAddress', 'State', 'AddressFamily', 'PolicyStore',
  'AssociatedIPInterface', 'IncludeAllCompartments', 'CimSession'] as const;

const NET_NEIGHBOR_UNSUPPORTED: ReadonlyArray<readonly [string, string]> = [
  ['associatedipinterface', 'no CIM instance pipeline binds an IP interface object'],
  ['includeallcompartments', 'network compartments are not modelled'],
  ['cimsession', 'no remote CIM session exists in this simulator'],
];

function netNeighborUnsupported(ctx: CmdletContext, displayName: string): string | null {
  for (const [key, why] of NET_NEIGHBOR_UNSUPPORTED) {
    if (ctx.named[key] !== undefined) {
      return `${displayName} : -${key} is not supported by this simulator: ${why}.`;
    }
  }
  return null;
}

function netNeighborSelectionOf(ctx: CmdletContext, net: INetworkProvider): NetNeighborSelection {
  const list = cimFilterReader(ctx, NET_NEIGHBOR_FILTERS);
  const positional = ctx.positional[0] === undefined
    ? undefined : [psValueToString(ctx.positional[0])];
  return {
    ipAddress: list('ipaddress') ?? positional,
    interfaceIndex: list('interfaceindex'),
    interfaceAlias: resolvedAliases(net, list('interfacealias')),
    linkLayerAddress: list('linklayeraddress'),
    state: list('state'),
    addressFamily: list('addressfamily'),
    policyStore: list('policystore'),
  };
}

const NET_NEIGHBOR_ENUMS: ReadonlyArray<readonly [keyof NetNeighborSelection, string, readonly string[]]> = [
  ['state', 'State', NET_NEIGHBOR_STATES],
  ['addressFamily', 'AddressFamily', NET_ADDRESS_FAMILIES],
  ['policyStore', 'PolicyStore', NET_POLICY_STORES],
];

function netNeighborEnumProblem(selection: NetNeighborSelection): string | null {
  for (const [key, label, table] of NET_NEIGHBOR_ENUMS) {
    for (const given of (selection[key] ?? []) as string[]) {
      if (matchEnumValue(table, given) === null) {
        return `Cannot validate argument on parameter '${label}'. The argument "${given}" does not belong to the set "${table.join(',')}".`;
      }
    }
  }
  return null;
}

function selectedNeighbors(
  ctx: CmdletContext, net: INetworkProvider, displayName: string,
): NeighborInfo[] | null {
  const unsupported = netNeighborUnsupported(ctx, displayName);
  if (unsupported) { ctx.emitError(unsupported); return null; }
  const selection = netNeighborSelectionOf(ctx, net);
  const enumProblem = netNeighborEnumProblem(selection);
  if (enumProblem) { ctx.emitError(`${displayName} : ${enumProblem}`); return null; }
  const matched = selectNetNeighbors(net.getNeighbors(), selection);
  if (matched.length === 0 && !neighborSelectionIsEmpty(selection)) {
    ctx.emitError(`${displayName} : ${noMatchingNetNeighbor(selection)}`);
    return null;
  }
  return matched;
}

function neighborToPSObject(n: NeighborInfo): Record<string, PSValue> {
  return {
    InterfaceIndex:   n.ifIndex,
    InterfaceAlias:   n.ifAlias,
    IPAddress:        n.ipAddress,
    LinkLayerAddress: n.linkLayerAddress,
    State:            n.state,
    AddressFamily:    n.addressFamily,
    PolicyStore:      n.policyStore,
  };
}

export class GetNetNeighborCmdlet implements ICmdlet {
  readonly name = 'get-netneighbor';
  readonly displayName = 'Get-NetNeighbor';
  readonly aliases = [] as const;
  readonly description = 'Gets the neighbor cache entries.';
  readonly parameters = NET_NEIGHBOR_FILTERS;

  execute(ctx: CmdletContext): PSValue {
    const matched = selectedNeighbors(ctx, requireNetwork(ctx), this.displayName);
    if (matched === null) return null;
    return matched.map(neighborToPSObject) as PSValue;
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

const NET_NEIGHBOR_WRITE_PARAMS = [...NET_NEIGHBOR_FILTERS,
  'PassThru', 'WhatIf', 'Confirm'] as const;

export class NewNetNeighborCmdlet implements ICmdlet {
  readonly name = 'new-netneighbor';
  readonly displayName = 'New-NetNeighbor';
  readonly aliases = [] as const;
  readonly parameters = NET_NEIGHBOR_WRITE_PARAMS;

  execute(ctx: CmdletContext): PSValue {
    const net = requireNetwork(ctx);
    const unsupported = netNeighborUnsupported(ctx, this.displayName);
    if (unsupported) { ctx.emitError(unsupported); return null; }
    const named = (key: string): string | undefined =>
      ctx.named[key] === undefined ? undefined : psValueToString(ctx.named[key]);
    const decision = planNetNeighbor({
      ipAddress: named('ipaddress') ?? (ctx.positional[0] === undefined
        ? undefined : psValueToString(ctx.positional[0])),
      interfaceAlias: named('interfacealias'),
      interfaceIndex: named('interfaceindex'),
      linkLayerAddress: named('linklayeraddress'),
      state: named('state'),
      addressFamily: named('addressfamily'),
      policyStore: named('policystore'),
    });
    if (!decision.ok) { ctx.emitError(`${this.displayName} : ${decision.message}`); return null; }
    if (ctx.named['whatif'] !== undefined) {
      ctx.emit(`What if: Creating a neighbor entry for ${decision.plan.address.text}.`);
      return null;
    }
    const failure = net.addNeighbor(decision.plan);
    if (failure) { ctx.emitError(`${this.displayName} : ${failure}`); return null; }
    if (ctx.named['passthru'] === undefined) return null;
    const created = selectNetNeighbors(net.getNeighbors(), { ipAddress: [decision.plan.address.text] });
    return created.map(neighborToPSObject) as PSValue;
  }
}

export class RemoveNetNeighborCmdlet implements ICmdlet {
  readonly name = 'remove-netneighbor';
  readonly displayName = 'Remove-NetNeighbor';
  readonly aliases = [] as const;
  readonly parameters = NET_NEIGHBOR_WRITE_PARAMS;

  execute(ctx: CmdletContext): PSValue {
    const net = requireNetwork(ctx);
    const matched = selectedNeighbors(ctx, net, this.displayName);
    if (matched === null) return null;
    if (ctx.named['whatif'] !== undefined) {
      for (const row of matched) {
        ctx.emit(`What if: Removing the neighbor entry for ${row.ipAddress}.`);
      }
      return null;
    }
    net.removeNeighbors(matched);
    if (ctx.named['passthru'] === undefined) return null;
    return matched.map(neighborToPSObject) as PSValue;
  }
}

export class SetNetNeighborCmdlet implements ICmdlet {
  readonly name = 'set-netneighbor';
  readonly displayName = 'Set-NetNeighbor';
  readonly aliases = [] as const;
  readonly parameters = NET_NEIGHBOR_WRITE_PARAMS;

  execute(ctx: CmdletContext): PSValue {
    const net = requireNetwork(ctx);
    const raw = ctx.named['linklayeraddress'];
    if (raw === undefined) {
      ctx.emitError(`${this.displayName} : Cannot process command because of one or more missing mandatory parameters: LinkLayerAddress.`);
      return null;
    }
    let mac: MACAddress;
    try { mac = new MACAddress(psValueToString(raw).trim()); }
    catch {
      ctx.emitError(`${this.displayName} : Cannot validate argument on parameter 'LinkLayerAddress'. The argument "${psValueToString(raw)}" is not a valid link-layer address.`);
      return null;
    }
    const selectionCtx = { ...ctx, named: { ...ctx.named } };
    delete selectionCtx.named['linklayeraddress'];
    const matched = selectedNeighbors(selectionCtx as CmdletContext, net, this.displayName);
    if (matched === null) return null;
    if (ctx.named['whatif'] !== undefined) {
      for (const row of matched) {
        ctx.emit(`What if: Setting the neighbor entry for ${row.ipAddress}.`);
      }
      return null;
    }
    net.setNeighborLinkLayer(matched, mac);
    if (ctx.named['passthru'] === undefined) return null;
    const after = selectNetNeighbors(net.getNeighbors(),
      { ipAddress: matched.map(r => r.ipAddress) });
    return after.map(neighborToPSObject) as PSValue;
  }
}

const NET_TCP_FILTERS = ['LocalAddress', 'LocalPort', 'RemoteAddress', 'RemotePort',
  'State', 'AppliedSetting', 'OffloadState', 'OwningProcess', 'CreationTime',
  'CimSession'] as const;

function netTcpSelectionOf(ctx: CmdletContext): NetTcpConnectionSelection {
  const list = cimFilterReader(ctx, NET_TCP_FILTERS);
  const positional = (n: number): string[] | undefined =>
    ctx.positional[n] === undefined ? undefined : [psValueToString(ctx.positional[n])];
  return {
    localAddress: list('localaddress') ?? list('ipaddress') ?? positional(0),
    localPort: list('localport') ?? positional(1),
    remoteAddress: list('remoteaddress'),
    remotePort: list('remoteport'),
    state: list('state'),
    appliedSetting: list('appliedsetting'),
    offloadState: list('offloadstate'),
    owningProcess: list('owningprocess'),
    creationTime: list('creationtime'),
  };
}

const NET_TCP_ENUMS: ReadonlyArray<readonly [keyof NetTcpConnectionSelection, string, readonly string[]]> = [
  ['state', 'State', NET_TCP_STATES],
  ['appliedSetting', 'AppliedSetting', NET_TCP_APPLIED_SETTINGS],
  ['offloadState', 'OffloadState', NET_TCP_OFFLOAD_STATES],
];

export class GetNetTCPConnectionCmdlet implements ICmdlet {
  readonly name = 'get-nettcpconnection';
  readonly displayName = 'Get-NetTCPConnection';
  readonly aliases = [] as const;
  readonly description = 'Gets TCP connections.';
  readonly parameters = NET_TCP_FILTERS;

  execute(ctx: CmdletContext): PSValue {
    const remote = remoteCimRefusal(ctx, this.displayName);
    if (remote !== null) { ctx.emitError(remote); return null; }
    const selection = netTcpSelectionOf(ctx);
    for (const [key, name, table] of NET_TCP_ENUMS) {
      const given = selection[key];
      if (given === undefined) continue;
      const bad = given.find(v => matchEnumValue(table, v) === null);
      if (bad !== undefined) {
        ctx.emitError(`${this.displayName} : Cannot validate argument on parameter '${name}'.`
          + ` The argument does not belong to the set "${table.join(',')}".`);
        return null;
      }
    }
    for (const [key, name] of [['localPort', 'LocalPort'], ['remotePort', 'RemotePort']] as const) {
      const given = selection[key];
      const bad = given?.find(v => !PortNumber.isValid(Number(v.trim())));
      if (bad !== undefined) {
        ctx.emitError(`${this.displayName} : Cannot convert value "${bad}" to type "System.UInt16".`
          + ' Error: "Value was either too large or too small for a UInt16."');
        return null;
      }
    }

    const rows: NetTcpConnectionRow[] = requireNetwork(ctx).getTcpConnections().map(c => ({
      localAddress:   c.localAddress,
      localPort:      c.localPort,
      remoteAddress:  c.remoteAddress,
      remotePort:     c.remotePort,
      state:          netTcpStateOf(c.state),
      appliedSetting: 'Internet',
      offloadState:   'InHost',
      owningProcess:  c.pid,
      creationTime:   '',
    }));
    const matched = selectNetTcpConnections(rows, selection);
    if (matched.length === 0 && !netTcpSelectionIsEmpty(selection)) {
      ctx.emitError(`${this.displayName} : ${noMatchingNetTcpConnection(selection)}`);
      return null;
    }
    return matched.map(r => ({
      LocalAddress:   r.localAddress,
      LocalPort:      r.localPort,
      RemoteAddress:  r.remoteAddress,
      RemotePort:     r.remotePort,
      State:          r.state,
      AppliedSetting: r.appliedSetting,
      OwningProcess:  r.owningProcess,
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
const NET_UDP_FILTERS = ['LocalAddress', 'LocalPort', 'OwningProcess',
  'CreationTime', 'CimSession'] as const;

export class GetNetUDPEndpointCmdlet implements ICmdlet {
  readonly name = 'get-netudpendpoint';
  readonly displayName = 'Get-NetUDPEndpoint';
  readonly aliases = [] as const;
  readonly description = 'Gets current statistics for UDP endpoints.';
  readonly parameters = NET_UDP_FILTERS;

  execute(ctx: CmdletContext): PSValue {
    const refusal = remoteCimRefusal(ctx, this.displayName);
    if (refusal) { ctx.emitError(refusal); return null; }
    const net = requireNetwork(ctx);
    const list = cimFilterReader(ctx, NET_UDP_FILTERS);
    const positional = (n: number): string[] | undefined =>
      ctx.positional[n] === undefined ? undefined : [psValueToString(ctx.positional[n])];
    const selection: NetUdpEndpointSelection = {
      localAddress: list('localaddress') ?? positional(0),
      localPort: list('localport') ?? positional(1),
      owningProcess: list('owningprocess'),
      creationTime: list('creationtime'),
    };
    for (const given of selection.localPort ?? []) {
      const problem = udpPortProblem(given);
      if (problem) { ctx.emitError(`${this.displayName} : ${problem}`); return null; }
    }
    const rows = (net.getUdpEndpoints?.() ?? []) as NetUdpEndpointRow[];
    const matched = selectNetUdpEndpoints(rows, selection);
    if (matched.length === 0 && !udpEndpointSelectionIsEmpty(selection)) {
      ctx.emitError(`${this.displayName} : ${noMatchingNetUdpEndpoint(selection)}`);
      return null;
    }
    return matched.map(e => ({
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


const COMMON_TCP_PORTS: Record<string, number> = {
  http: 80, smb: 445, rdp: 3389, winrm: 5985,
};

const INFORMATION_LEVELS = ['Detailed', 'Quiet'] as const;

export class TestNetConnectionCmdlet implements ICmdlet {
  readonly name = 'test-netconnection';
  readonly displayName = 'Test-NetConnection';
  readonly aliases = [] as const;
  readonly parameters = ['ComputerName', 'Port', 'CommonTCPPort', 'InformationLevel',
    'TraceRoute', 'Hops'] as const;

  execute(ctx: CmdletContext): PSValue {
    const net = requireNetwork(ctx);
    const target = psValueToString(
      ctx.named['computername'] ?? ctx.named['remoteaddress'] ?? ctx.named['cn']
      ?? ctx.positional[0] ?? '',
    );
    if (!target) {
      ctx.emitError(`${this.displayName} : Cannot process command because of one or more`
        + ' missing mandatory parameters: ComputerName.');
      return null;
    }
    for (const [key, name, why] of [
      ['diagnoserouting', 'DiagnoseRouting', 'route selection diagnostics are not modelled'],
      ['constrainsourceaddress', 'ConstrainSourceAddress', 'route selection diagnostics are not modelled'],
      ['constraininterface', 'ConstrainInterface', 'route selection diagnostics are not modelled'],
    ] as const) {
      if (ctx.named[key] === undefined) continue;
      ctx.emitError(`${this.displayName} : The -${name} parameter is not implemented`
        + ` in this simulator: ${why}.`);
      return null;
    }

    let port: number | undefined;
    if (ctx.named['port'] !== undefined) {
      const given = psValueToString(ctx.named['port']).trim();
      const n = Number(given);
      if (!/^\d+$/.test(given) || !PortNumber.isValid(n)) {
        ctx.emitError(`${this.displayName} : Cannot validate argument on parameter 'Port'.`
          + ` The "${given}" value is not a valid TCP port number.`);
        return null;
      }
      port = n;
    } else if (ctx.named['commontcpport'] !== undefined) {
      const given = psValueToString(ctx.named['commontcpport']);
      const known = COMMON_TCP_PORTS[given.trim().toLowerCase()];
      if (known === undefined) {
        ctx.emitError(`${this.displayName} : Cannot validate argument on parameter 'CommonTCPPort'.`
          + ` The argument does not belong to the set "${Object.keys(COMMON_TCP_PORTS)
            .map(k => k.toUpperCase()).join(',')}".`);
        return null;
      }
      port = known;
    }

    let detailed = false;
    let quiet = false;
    if (ctx.named['informationlevel'] !== undefined) {
      const given = psValueToString(ctx.named['informationlevel']);
      const level = matchEnumValue(INFORMATION_LEVELS, given);
      if (level === null) {
        ctx.emitError(`${this.displayName} : Cannot validate argument on parameter`
          + ` 'InformationLevel'. The argument does not belong to the set`
          + ` "${INFORMATION_LEVELS.join(',')}".`);
        return null;
      }
      detailed = level === 'Detailed';
      quiet = level === 'Quiet';
    }

    const probe = net.testPingProbe?.(target) ?? null;
    const resolved = probe?.resolvedIp ?? '';
    const pingSucceeded = probe?.success ?? false;
    const rttMs = probe?.success ? Math.round(probe.rttMs) : 0;

    const tcpTested = port !== undefined;
    const tcpSucceeded = tcpTested && resolved !== ''
      ? (net.testTcpProbe?.(target, port!) ?? false)
      : false;

    if (quiet) return tcpTested ? tcpSucceeded : pingSucceeded;

    const egress = resolved === '' ? null : (net.egressInfoFor?.(target) ?? null);

    const result: Record<string, PSValue> = {
      ComputerName:  target,
      RemoteAddress: resolved,
    };
    if (tcpTested) result.RemotePort = port!;
    if (detailed) result.NameResolutionResults = resolved === '' ? [] : [resolved];
    result.InterfaceAlias = egress?.interfaceAlias ?? '';
    result.SourceAddress = egress?.sourceIp ?? '';
    if (detailed) result['NetRoute (NextHop)'] = egress?.nextHop ?? '';
    if (tcpTested) {
      result.TcpTestSucceeded = tcpSucceeded;
    } else {
      result.PingSucceeded = pingSucceeded;
      result['PingReplyDetails (RTT)'] = `${rttMs} ms`;
    }
    if (ctx.named['traceroute'] === true) result.TraceRoute = net.traceRoute(target);
    return result;
  }
}

// ── Enable / Disable / Rename / Restart / Set-NetAdapter ──────────────────

export class EnableNetAdapterCmdlet implements ICmdlet {
  readonly pipelineByPropertyName = true as const;
  readonly name = 'enable-netadapter';
  readonly displayName = 'Enable-NetAdapter';
  readonly aliases = [] as const;
  readonly description = 'Enables a network adapter.';
  readonly parameters = NET_ADAPTER_ACTION_PARAMS;

  execute(ctx: CmdletContext): PSValue {
    const net = requireNetwork(ctx);
    const matched = selectedAdapters(ctx, net, 'Enable-NetAdapter');
    if (matched === null) return null;
    if (!adapterActionAllowed(ctx, 'Enable-NetAdapter', matched, 'None')) return null;
    for (const a of matched) net.setAdapterStatus(a.portName, 'Up');
    return adapterPassThru(ctx, net, matched);
  }
}

export class DisableNetAdapterCmdlet implements ICmdlet {
  readonly pipelineByPropertyName = true as const;
  readonly name = 'disable-netadapter';
  readonly displayName = 'Disable-NetAdapter';
  readonly aliases = [] as const;
  readonly description = 'Disables a network adapter.';
  readonly parameters = NET_ADAPTER_ACTION_PARAMS;

  execute(ctx: CmdletContext): PSValue {
    const net = requireNetwork(ctx);
    const matched = selectedAdapters(ctx, net, 'Disable-NetAdapter');
    if (matched === null) return null;
    if (!adapterActionAllowed(ctx, 'Disable-NetAdapter', matched, 'High')) return null;
    for (const a of matched) net.setAdapterStatus(a.portName, 'Down');
    return adapterPassThru(ctx, net, matched);
  }
}

export class RestartNetAdapterCmdlet implements ICmdlet {
  readonly pipelineByPropertyName = true as const;
  readonly name = 'restart-netadapter';
  readonly displayName = 'Restart-NetAdapter';
  readonly aliases = [] as const;
  readonly description = 'Restarts a network adapter.';
  readonly parameters = NET_ADAPTER_ACTION_PARAMS;

  execute(ctx: CmdletContext): PSValue {
    const net = requireNetwork(ctx);
    const matched = selectedAdapters(ctx, net, 'Restart-NetAdapter');
    if (matched === null) return null;
    if (!adapterActionAllowed(ctx, 'Restart-NetAdapter', matched, 'None')) return null;
    for (const a of matched) {
      net.setAdapterStatus(a.portName, 'Down');
      net.setAdapterStatus(a.portName, 'Up');
    }
    return adapterPassThru(ctx, net, matched);
  }
}

export class RenameNetAdapterCmdlet implements ICmdlet {
  readonly pipelineByPropertyName = true as const;
  readonly name = 'rename-netadapter';
  readonly displayName = 'Rename-NetAdapter';
  readonly aliases = [] as const;
  readonly description = 'Renames a network adapter.';
  readonly parameters = [...NET_ADAPTER_ACTION_PARAMS, 'NewName'] as const;

  execute(ctx: CmdletContext): PSValue {
    const net = requireNetwork(ctx);
    const newName = psValueToString(ctx.named['newname'] ?? ctx.positional[1] ?? '');
    if (newName === '') {
      ctx.emitError('Rename-NetAdapter : Cannot bind argument to parameter \'NewName\' because it is an empty string.');
      return null;
    }
    const matched = selectedAdapters(ctx, net, 'Rename-NetAdapter');
    if (matched === null) return null;
    const problem = adapterNameProblem(newName);
    if (problem !== null) { ctx.emitError(`Rename-NetAdapter : ${problem}`); return null; }
    if (matched.length > 1) {
      ctx.emitError('Rename-NetAdapter : Cannot rename more than one network adapter to the same name.');
      return null;
    }
    if (adapterNameTaken(net.getAdapters(), newName, matched[0].portName)) {
      ctx.emitError(`Rename-NetAdapter : A network adapter named '${newName}' already exists.`);
      return null;
    }
    if (!adapterActionAllowed(ctx, 'Rename-NetAdapter', matched, 'None')) return null;
    net.renameAdapter(matched[0].portName, newName);
    return adapterPassThru(ctx, net, matched);
  }
}

const NET_ADAPTER_UNSUPPORTED: Record<string, string> = {
  vlanid: 'VLAN tagging on a physical adapter is not modelled by this simulator; '
    + 'use Set-NetLbfoTeamNic to set the VLAN of a team interface.',
};

export class SetNetAdapterCmdlet implements ICmdlet {
  readonly pipelineByPropertyName = true as const;
  readonly name = 'set-netadapter';
  readonly displayName = 'Set-NetAdapter';
  readonly aliases = [] as const;
  readonly description = 'Sets the basic network adapter properties.';
  readonly parameters = [...NET_ADAPTER_ACTION_PARAMS, 'MacAddress', 'NoRestart'] as const;

  execute(ctx: CmdletContext): PSValue {
    const net = requireNetwork(ctx);
    for (const [key, reason] of Object.entries(NET_ADAPTER_UNSUPPORTED)) {
      if (ctx.named[key] !== undefined) {
        ctx.emitError(`Set-NetAdapter : ${reason}`);
        return null;
      }
    }
    const raw = ctx.named['macaddress'] ?? ctx.named['linklayeraddress'];
    if (raw === undefined) {
      ctx.emitError('Set-NetAdapter : No property was specified. Specify -MacAddress and retry.');
      return null;
    }
    const mac = parseNetAdapterMac(psValueToString(raw));
    if (mac === null) {
      ctx.emitError(`Set-NetAdapter : The MAC address '${psValueToString(raw)}' is not valid.`);
      return null;
    }
    const matched = selectedAdapters(ctx, net, 'Set-NetAdapter');
    if (matched === null) return null;
    if (!adapterActionAllowed(ctx, 'Set-NetAdapter', matched, 'None')) return null;
    for (const a of matched) {
      net.setAdapterMac(a.portName, mac);
      if (ctx.named['norestart'] !== true) {
        net.setAdapterStatus(a.portName, 'Down');
        net.setAdapterStatus(a.portName, 'Up');
      }
    }
    return adapterPassThru(ctx, net, matched);
  }
}

// ── Get / Set-DnsClientServerAddress + Clear-DnsClientCache ────────────────

const DNS_SERVER_FILTERS = ['InterfaceAlias', 'InterfaceIndex', 'AddressFamily',
  'CimSession'] as const;

export class GetDnsClientServerAddressCmdlet implements ICmdlet {
  readonly name = 'get-dnsclientserveraddress';
  readonly displayName = 'Get-DnsClientServerAddress';
  readonly aliases = [] as const;
  readonly description = 'Gets the DNS server IP addresses of an interface.';
  readonly parameters = DNS_SERVER_FILTERS;

  execute(ctx: CmdletContext): PSValue {
    const net = requireNetwork(ctx);
    const remote = remoteCimRefusal(ctx, this.displayName);
    if (remote !== null) { ctx.emitError(remote); return null; }
    const list = cimFilterReader(ctx, DNS_SERVER_FILTERS);
    const positional = ctx.positional[0];
    const aliases = list('interfacealias')
      ?? (positional === undefined ? undefined : [psValueToString(positional)]);
    const selection: DnsClientServerAddressSelection = {
      interfaceAlias: resolvedAliases(net, aliases),
      interfaceIndex: list('interfaceindex'),
      addressFamily: list('addressfamily'),
    };
    const bad = selection.addressFamily?.find(v => matchEnumValue(NET_ADDRESS_FAMILIES, v) === null);
    if (bad !== undefined) {
      ctx.emitError(`${this.displayName} : Cannot validate argument on parameter 'AddressFamily'.`
        + ` The argument does not belong to the set "${NET_ADDRESS_FAMILIES.join(',')}".`);
      return null;
    }

    const rows: DnsClientServerAddressRow[] = [];
    for (const a of net.getAdapters()) {
      const configured = net.getDnsServers(a.name);
      for (const family of NET_ADDRESS_FAMILIES) {
        rows.push({
          ifAlias: a.name,
          ifIndex: a.ifIndex,
          addressFamily: family,
          serverAddresses: configured.filter(s => (s.includes(':') ? 'IPv6' : 'IPv4') === family),
        });
      }
    }
    const matched = selectDnsClientServerAddresses(rows, selection);
    if (matched.length === 0 && !dnsServerSelectionIsEmpty(selection)) {
      ctx.emitError(`${this.displayName} : ${noMatchingDnsClientServerAddress(selection)}`);
      return null;
    }
    return matched.map(r => ({
      InterfaceAlias:  r.ifAlias,
      InterfaceIndex:  r.ifIndex,
      AddressFamily:   r.addressFamily,
      ServerAddresses: r.serverAddresses,
    } as Record<string, PSValue>)) as PSValue;
  }
}

export class SetDnsClientServerAddressCmdlet implements ICmdlet {
  readonly name = 'set-dnsclientserveraddress';
  readonly displayName = 'Set-DnsClientServerAddress';
  readonly aliases = [] as const;
  readonly description = 'Sets DNS server addresses associated with the TCP/IP properties on an interface.';

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

const DNS_CACHE_FILTERS = ['Entry', 'Name', 'Type', 'Status', 'Section',
  'TimeToLive', 'DataLength', 'Data', 'CimSession'] as const;

export class GetDnsClientCacheCmdlet implements ICmdlet {
  readonly name = 'get-dnsclientcache';
  readonly displayName = 'Get-DnsClientCache';
  readonly aliases = [] as const;
  readonly description = 'Retrieves the contents of the DNS client cache.';
  readonly parameters = DNS_CACHE_FILTERS;

  execute(ctx: CmdletContext): PSValue {
    const refusal = remoteCimRefusal(ctx, this.displayName);
    if (refusal) { ctx.emitError(refusal); return null; }
    const list = cimFilterReader(ctx, DNS_CACHE_FILTERS);
    const positional = ctx.positional[0] === undefined
      ? undefined : [psValueToString(ctx.positional[0])];
    const selection: DnsCacheSelection = {
      entry: list('entry') ?? positional,
      name: list('name'),
      type: list('type'),
      status: list('status'),
      section: list('section'),
      timeToLive: list('timetolive'),
      dataLength: list('datalength'),
      data: list('data'),
    };
    const enumProblem = dnsCacheEnumProblem(selection);
    if (enumProblem) { ctx.emitError(`${this.displayName} : ${enumProblem}`); return null; }
    const rows = requireNetwork(ctx).getDnsClientCache?.() ?? [];
    const matched = selectDnsCacheEntries(rows, selection);
    if (matched.length === 0 && !dnsCacheSelectionIsEmpty(selection)) {
      ctx.emitError(`${this.displayName} : ${noMatchingDnsCacheEntry(selection)}`);
      return null;
    }
    return matched.map(r => ({
      Entry:      r.entry,
      RecordName: r.recordName,
      RecordType: r.recordType,
      Status:     r.status,
      Section:    r.section,
      TimeToLive: r.timeToLive,
      DataLength: r.dataLength,
      Data:       r.data,
    } as Record<string, PSValue>)) as PSValue;
  }
}

export class ClearDnsClientCacheCmdlet implements ICmdlet {
  readonly name = 'clear-dnsclientcache';
  readonly displayName = 'Clear-DnsClientCache';
  readonly aliases = [] as const;
  readonly description = 'Removes the contents of the DNS client cache.';
  readonly parameters = ['CimSession', 'WhatIf', 'Confirm'] as const;

  execute(ctx: CmdletContext): PSValue {
    const refusal = remoteCimRefusal(ctx, this.displayName);
    if (refusal) { ctx.emitError(refusal); return null; }
    if (ctx.named['whatif'] !== undefined) {
      ctx.emit('What if: Clearing the DNS client cache.');
      return null;
    }
    requireNetwork(ctx).clearDnsClientCache?.();
    return null;
  }
}

// ── Get / New / Set / Enable / Disable / Remove-NetFirewallRule ────────────

const NET_FIREWALL_FILTERS = ['Name', 'DisplayName', 'Description', 'Group', 'Enabled',
  'Action', 'Direction'] as const;

const NET_FIREWALL_UNSUPPORTED: ReadonlyArray<readonly [string, string, string]> = [
  ['program', 'Program', 'a firewall rule cannot be tied to a process here'],
  ['service', 'Service', 'a firewall rule cannot be tied to a service here'],
  ['package', 'Package', 'application packages are not modelled'],
  ['localuser', 'LocalUser', 'a firewall rule carries no security descriptor here'],
  ['remoteuser', 'RemoteUser', 'a firewall rule carries no security descriptor here'],
  ['remotemachine', 'RemoteMachine', 'a firewall rule carries no security descriptor here'],
  ['authentication', 'Authentication', 'connection security rules are not modelled'],
  ['encryption', 'Encryption', 'connection security rules are not modelled'],
  ['icmptype', 'IcmpType', 'an ICMP type filter is not evaluated here'],
  ['interfacetype', 'InterfaceType', 'an interface carries no media type here'],
  ['edgetraversalpolicy', 'EdgeTraversalPolicy', 'edge traversal is not modelled'],
  ['policystore', 'PolicyStore', 'only the active store is modelled'],
];

function unsupportedFirewallParameter(ctx: CmdletContext): string | null {
  for (const [key, name, reason] of NET_FIREWALL_UNSUPPORTED) {
    if (ctx.named[key] !== undefined) {
      return `The -${name} parameter is not implemented in this simulator: ${reason}.`;
    }
  }
  return null;
}

function firewallSelectionOf(ctx: CmdletContext, filters: readonly string[]): NetFirewallSelection {
  const list = cimFilterReader(ctx, filters);
  return {
    name: list('name'),
    displayName: list('displayname'),
    description: list('description'),
    group: list('group'),
    enabled: list('enabled'),
    action: list('action'),
    direction: list('direction'),
  };
}

function firewallRuleToPSObject(rule: NetFirewallRuleEntry): Record<string, PSValue> {
  return {
    Name:          rule.name,
    DisplayName:   rule.displayName,
    Description:   rule.description,
    Group:         rule.group,
    Enabled:       rule.enabled,
    Profile:       rule.profile,
    Direction:     rule.direction,
    Action:        rule.action,
    Protocol:      rule.protocol,
    LocalPort:     rule.localPort,
    RemotePort:    rule.remotePort,
    LocalAddress:  rule.localAddress,
    RemoteAddress: rule.remoteAddress,
    PolicyStoreSource: 'PersistentStore',
    PolicyStoreSourceType: 'Local',
  };
}

function selectedFirewallRules(
  ctx: CmdletContext, cmdlet: string, filters: readonly string[],
): NetFirewallRuleEntry[] | null {
  const net = requireNetwork(ctx);
  const selection = firewallSelectionOf(ctx, filters);
  if (selection.name === undefined && ctx.positional[0] !== undefined) {
    selection.name = [psValueToString(ctx.positional[0])];
  }
  const matched = selectFirewallRules(net.getFirewallRules(), selection);
  if (matched.length === 0) {
    ctx.emitError(`${cmdlet} : ${noMatchingFirewallRule(selection)}`);
    return null;
  }
  return matched;
}

export class GetNetFirewallRuleCmdlet implements ICmdlet {
  readonly name = 'get-netfirewallrule';
  readonly displayName = 'Get-NetFirewallRule';
  readonly aliases = [] as const;
  readonly description = 'Retrieves firewall rules from the target computer.';
  readonly parameters = [...NET_FIREWALL_FILTERS, 'All'] as const;

  execute(ctx: CmdletContext): PSValue {
    const unsupported = unsupportedFirewallParameter(ctx);
    if (unsupported) { ctx.emitError(`Get-NetFirewallRule : ${unsupported}`); return null; }
    const matched = selectedFirewallRules(ctx, 'Get-NetFirewallRule', NET_FIREWALL_FILTERS);
    return matched === null ? null : (matched.map(firewallRuleToPSObject) as PSValue);
  }
}

export class NewNetFirewallRuleCmdlet implements ICmdlet {
  readonly name = 'new-netfirewallrule';
  readonly displayName = 'New-NetFirewallRule';
  readonly aliases = [] as const;
  readonly pipelineByPropertyName = true as const;
  readonly description = 'Creates a new inbound or outbound firewall rule.';
  readonly parameters = ['Name', 'DisplayName', 'Description', 'Group', 'Enabled', 'Profile',
    'Direction', 'Action', 'Protocol', 'LocalPort', 'RemotePort', 'LocalAddress',
    'RemoteAddress', 'WhatIf', 'Confirm'] as const;

  execute(ctx: CmdletContext): PSValue {
    const net = requireNetwork(ctx);
    const unsupported = unsupportedFirewallParameter(ctx);
    if (unsupported) { ctx.emitError(`New-NetFirewallRule : ${unsupported}`); return null; }
    const arg = (key: string): string | undefined =>
      ctx.named[key] === undefined ? undefined : psValueToString(ctx.named[key]);
    const list = (key: string): string[] | undefined => {
      const raw = ctx.named[key];
      if (raw === undefined) return undefined;
      return (Array.isArray(raw) ? raw : [raw]).map(psValueToString);
    };
    const decision = planNetFirewallRule({
      name: arg('name'),
      displayName: arg('displayname'),
      description: arg('description'),
      group: arg('group'),
      enabled: arg('enabled'),
      action: arg('action'),
      direction: arg('direction'),
      profile: arg('profile'),
      protocol: arg('protocol'),
      localPort: list('localport'),
      remotePort: list('remoteport'),
      localAddress: list('localaddress'),
      remoteAddress: list('remoteaddress'),
    }, () => generatedFirewallRuleName(net.getFirewallRules().length));
    if (!decision.ok) { ctx.emitError(`New-NetFirewallRule : ${decision.message}`); return null; }

    if (ctx.named['whatif'] === true) {
      ctx.emit(`What if: Performing the operation "Create" on target "${decision.rule.displayName}".`);
      return null;
    }
    const message = net.addFirewallRule(decision.rule);
    if (message) { ctx.emitError(`New-NetFirewallRule : ${message}`); return null; }
    return firewallRuleToPSObject(decision.rule) as PSValue;
  }
}

abstract class FirewallToggleCmdlet implements ICmdlet {
  abstract readonly name: string;
  abstract readonly displayName: string;
  abstract readonly aliases: readonly string[];
  readonly pipelineByPropertyName = true as const;
  readonly parameters = [...NET_FIREWALL_FILTERS, 'PassThru'] as const;
  protected abstract enabled: boolean;

  execute(ctx: CmdletContext): PSValue {
    const net = requireNetwork(ctx);
    const matched = selectedFirewallRules(ctx, this.displayName, NET_FIREWALL_FILTERS);
    if (matched === null) return null;
    for (const rule of matched) net.updateFirewallRule(rule.name, { enabled: this.enabled });
    if (ctx.named['passthru'] !== true) return null;
    return matched.map(r => firewallRuleToPSObject({ ...r, enabled: this.enabled })) as PSValue;
  }
}

export class EnableNetFirewallRuleCmdlet extends FirewallToggleCmdlet {
  readonly name = 'enable-netfirewallrule';
  readonly displayName = 'Enable-NetFirewallRule';
  readonly aliases = [] as const;
  readonly description = 'Enables a previously disabled firewall rule.';
  protected enabled = true;
}
export class DisableNetFirewallRuleCmdlet extends FirewallToggleCmdlet {
  readonly name = 'disable-netfirewallrule';
  readonly displayName = 'Disable-NetFirewallRule';
  readonly aliases = [] as const;
  readonly description = 'Disables a firewall rule.';
  protected enabled = false;
}

const NET_FIREWALL_SET_FILTERS = ['Name', 'DisplayName', 'Description', 'Group'] as const;

export class SetNetFirewallRuleCmdlet implements ICmdlet {
  readonly name = 'set-netfirewallrule';
  readonly displayName = 'Set-NetFirewallRule';
  readonly aliases = [] as const;
  readonly pipelineByPropertyName = true as const;
  readonly description = 'Modifies existing firewall rules.';
  readonly parameters = [...NET_FIREWALL_SET_FILTERS, 'NewDisplayName', 'Enabled', 'Profile',
    'Direction', 'Action', 'Protocol', 'LocalPort', 'RemotePort', 'LocalAddress',
    'RemoteAddress', 'PassThru', 'WhatIf', 'Confirm'] as const;

  execute(ctx: CmdletContext): PSValue {
    const net = requireNetwork(ctx);
    const unsupported = unsupportedFirewallParameter(ctx);
    if (unsupported) { ctx.emitError(`Set-NetFirewallRule : ${unsupported}`); return null; }
    const matched = selectedFirewallRules(ctx, 'Set-NetFirewallRule', NET_FIREWALL_SET_FILTERS);
    if (matched === null) return null;

    const arg = (key: string): string | undefined =>
      ctx.named[key] === undefined ? undefined : psValueToString(ctx.named[key]);
    const list = (key: string): string[] | undefined => {
      const raw = ctx.named[key];
      if (raw === undefined) return undefined;
      return (Array.isArray(raw) ? raw : [raw]).map(psValueToString);
    };
    const reference = matched[0];
    const decision = planNetFirewallRule({
      name: reference.name,
      displayName: arg('newdisplayname') ?? reference.displayName,
      description: arg('description') ?? reference.description,
      group: arg('group') ?? reference.group,
      enabled: arg('enabled') ?? (reference.enabled ? 'True' : 'False'),
      action: arg('action') ?? reference.action,
      direction: arg('direction') ?? reference.direction,
      profile: arg('profile') ?? reference.profile,
      protocol: arg('protocol') ?? reference.protocol,
      localPort: list('localport') ?? reference.localPort,
      remotePort: list('remoteport') ?? reference.remotePort,
      localAddress: list('localaddress') ?? reference.localAddress,
      remoteAddress: list('remoteaddress') ?? reference.remoteAddress,
    }, () => reference.name);
    if (!decision.ok) { ctx.emitError(`Set-NetFirewallRule : ${decision.message}`); return null; }

    if (ctx.named['whatif'] === true) {
      for (const rule of matched) {
        ctx.emit(`What if: Performing the operation "Modify" on target "${rule.displayName}".`);
      }
      return null;
    }
    const { name: _ignored, builtIn: _kept, ...patch } = decision.rule;
    for (const rule of matched) {
      net.updateFirewallRule(rule.name, {
        ...patch,
        displayName: arg('newdisplayname') ?? rule.displayName,
      });
    }
    if (ctx.named['passthru'] !== true) return null;
    const refreshed = net.getFirewallRules()
      .filter(r => matched.some(m => m.name === r.name));
    return refreshed.map(firewallRuleToPSObject) as PSValue;
  }
}

export class RemoveNetFirewallRuleCmdlet implements ICmdlet {
  readonly name = 'remove-netfirewallrule';
  readonly displayName = 'Remove-NetFirewallRule';
  readonly aliases = [] as const;
  readonly pipelineByPropertyName = true as const;
  readonly description = 'Deletes one or more firewall rules.';
  readonly parameters = [...NET_FIREWALL_FILTERS, 'PassThru', 'WhatIf'] as const;

  execute(ctx: CmdletContext): PSValue {
    const net = requireNetwork(ctx);
    const matched = selectedFirewallRules(ctx, 'Remove-NetFirewallRule', NET_FIREWALL_FILTERS);
    if (matched === null) return null;
    if (ctx.named['whatif'] === true) {
      for (const rule of matched) {
        ctx.emit(`What if: Performing the operation "Delete" on target "${rule.displayName}".`);
      }
      return null;
    }
    const removed = matched.map(firewallRuleToPSObject);
    for (const rule of matched) net.removeFirewallRule(rule.name);
    return ctx.named['passthru'] === true ? (removed as PSValue) : null;
  }
}

// ── Get / Set-NetConnectionProfile ────────────────────────────────────────

const NET_PROFILE_FILTERS = ['Name', 'InterfaceAlias', 'InterfaceIndex', 'NetworkCategory',
  'IPv4Connectivity', 'IPv6Connectivity', 'CimSession'] as const;

const NET_PROFILE_SET_FILTERS = NET_PROFILE_FILTERS
  .filter(f => f !== 'NetworkCategory');

const NET_PROFILE_SET_PARAMS = [...NET_PROFILE_FILTERS,
  'PassThru', 'WhatIf', 'Confirm'] as const;

function netProfileSelectionOf(
  ctx: CmdletContext, net: INetworkProvider, filters: readonly string[],
): NetConnectionProfileSelection {
  const list = cimFilterReader(ctx, filters);
  return {
    name: list('name'),
    interfaceAlias: resolvedAliases(net, list('interfacealias')),
    interfaceIndex: list('interfaceindex'),
    networkCategory: list('networkcategory'),
    ipv4Connectivity: list('ipv4connectivity'),
    ipv6Connectivity: list('ipv6connectivity'),
  };
}

function connectionProfiles(net: INetworkProvider): NetConnectionProfileRow[] {
  const defaultRoutes = net.getRoutes()
    .filter(r => r.destinationPrefix === '0.0.0.0/0' || r.destinationPrefix === '::/0');
  return net.getAdapters()
    .filter(a => a.status === 'Up' && a.physical)
    .map(a => {
      const ips = net.getIPAddresses(a.name);
      const gateway = (prefix: string): boolean =>
        defaultRoutes.some(r => r.destinationPrefix === prefix
          && r.ifAlias.toLowerCase() === a.name.toLowerCase());
      return {
        name: a.name,
        ifAlias: a.name,
        ifIndex: a.ifIndex,
        networkCategory: matchEnumValue(NETWORK_CATEGORIES, net.getNetworkProfile(a.ifIndex))
          ?? 'DomainAuthenticated',
        ipv4Connectivity: connectivityOf(
          ips.some(ip => ip.addressFamily === 'IPv4'), gateway('0.0.0.0/0')),
        ipv6Connectivity: connectivityOf(
          ips.some(ip => ip.addressFamily === 'IPv6'), gateway('::/0')),
      };
    });
}

function profileToPSObject(r: NetConnectionProfileRow): Record<string, PSValue> {
  return {
    Name:             r.name,
    InterfaceAlias:   r.ifAlias,
    InterfaceIndex:   r.ifIndex,
    NetworkCategory:  r.networkCategory,
    IPv4Connectivity: r.ipv4Connectivity,
    IPv6Connectivity: r.ipv6Connectivity,
  };
}

function matchedProfiles(
  ctx: CmdletContext, net: INetworkProvider, cmdlet: string, filters: readonly string[],
): NetConnectionProfileRow[] | null {
  const remote = remoteCimRefusal(ctx, cmdlet);
  if (remote !== null) { ctx.emitError(remote); return null; }
  const selection = netProfileSelectionOf(ctx, net, filters);
  const matched = selectNetConnectionProfiles(connectionProfiles(net), selection);
  if (matched.length === 0 && !profileSelectionIsEmpty(selection)) {
    ctx.emitError(`${cmdlet} : ${noMatchingNetConnectionProfile(selection)}`);
    return null;
  }
  return matched;
}

export class GetNetConnectionProfileCmdlet implements ICmdlet {
  readonly name = 'get-netconnectionprofile';
  readonly displayName = 'Get-NetConnectionProfile';
  readonly aliases = [] as const;
  readonly description = 'Gets a connection profile.';
  readonly parameters = NET_PROFILE_FILTERS;

  execute(ctx: CmdletContext): PSValue {
    const matched = matchedProfiles(ctx, requireNetwork(ctx), this.displayName,
      NET_PROFILE_FILTERS);
    if (matched === null) return null;
    return matched.map(profileToPSObject) as PSValue;
  }
}

export class SetNetConnectionProfileCmdlet implements ICmdlet {
  readonly pipelineByPropertyName = true as const;
  readonly name = 'set-netconnectionprofile';
  readonly displayName = 'Set-NetConnectionProfile';
  readonly aliases = [] as const;
  readonly description = 'Changes the network category of a connection profile.';
  readonly parameters = NET_PROFILE_SET_PARAMS;

  execute(ctx: CmdletContext): PSValue {
    const net = requireNetwork(ctx);
    const raw = ctx.named['networkcategory'];
    if (raw === undefined) {
      ctx.emitError(`${this.displayName} : Cannot process command because of one or more`
        + " missing mandatory parameters: NetworkCategory.");
      return null;
    }
    const wanted = psValueToString(raw);
    const category = matchEnumValue(NETWORK_CATEGORIES, wanted);
    if (category === null) {
      ctx.emitError(`${this.displayName} : Cannot validate argument on parameter 'NetworkCategory'.`
        + ` The argument does not belong to the set "${NETWORK_CATEGORIES.join(',')}".`);
      return null;
    }
    if (!SETTABLE_NETWORK_CATEGORIES.includes(category)) {
      ctx.emitError(`${this.displayName} : The DomainAuthenticated network category cannot be set.`
        + ' It is set automatically when the network is authenticated to a domain controller.');
      return null;
    }

    const matched = matchedProfiles(ctx, net, this.displayName, NET_PROFILE_SET_FILTERS);
    if (matched === null) return null;
    if (ctx.named['whatif'] === true) {
      for (const r of matched) {
        ctx.emit(`What if: Performing the operation "${this.displayName}" on target "${r.ifAlias}".`);
      }
      return null;
    }
    if (confirmationDue(ctx, 'None')) {
      ctx.emitError(`${this.displayName} : ${NON_INTERACTIVE_HOST}`);
      return null;
    }
    for (const r of matched) net.setNetworkProfile(r.ifIndex, category);
    if (ctx.named['passthru'] !== true) return null;
    return selectNetConnectionProfiles(connectionProfiles(net), {
      interfaceIndex: matched.map(r => String(r.ifIndex)),
    }).map(profileToPSObject) as PSValue;
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
    if (!ctx.providers.network) throw new PSRuntimeError(commandNotFoundMessage('whoami'));
    const host = ctx.providers.network.getHostname();
    const user = ctx.env.get('env:username') ?? ctx.runtime.executeForValue('$env:USERNAME') ?? 'user';
    const domain = ctx.providers.environment?.get('USERDOMAIN') ?? host;
    return `${domain}\\${user}`;
  }
}
