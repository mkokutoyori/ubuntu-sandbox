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
import type {
  NetworkAdapterInfo, IPAddressInfo, INetworkProvider,
} from '@/powershell/providers/PSProviders';
import { psValueToString } from '@/powershell/runtime/PSExpansion';

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
    MacAddress:   a.macAddress,
    LinkSpeed:    a.linkSpeed,
  };
}

function ipToPSObject(ip: IPAddressInfo): Record<string, PSValue> {
  return {
    IPAddress:     ip.ipAddress,
    PrefixLength:  ip.prefixLength,
    InterfaceAlias: ip.ifAlias,
    ifIndex:       ip.ifIndex,
    PrefixOrigin:  ip.prefixOrigin,
    SuffixOrigin:  ip.suffixOrigin,
    AddressFamily: ip.addressFamily,
  };
}

// ── Get-NetAdapter ────────────────────────────────────────────────────────

export class GetNetAdapterCmdlet implements ICmdlet {
  readonly name = 'get-netadapter';
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
      const found = adapters.find(a => a.name.toLowerCase() === n.toLowerCase());
      if (found) out.push(found);
      else ctx.emitError(`No MSFT_NetAdapter objects found with property 'Name' equal to '${n}'.`);
    }
    return out.map(adapterToPSObject) as PSValue;
  }
}

// ── Get-NetIPAddress ──────────────────────────────────────────────────────

export class GetNetIPAddressCmdlet implements ICmdlet {
  readonly name = 'get-netipaddress';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const net = requireNetwork(ctx);
    const ifAlias = ctx.named['interfacealias']
      ? psValueToString(ctx.named['interfacealias'])
      : undefined;
    const ips = net.getIPAddresses(ifAlias);
    return ips.map(ipToPSObject) as PSValue;
  }
}

// ── Test-Connection (basic) ───────────────────────────────────────────────

export class TestConnectionCmdlet implements ICmdlet {
  readonly name = 'test-connection';
  readonly aliases = [] as const;

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
    const reachable = net.testConnection(target);
    if (ctx.named['quiet'] === true) return reachable;
    // Mimic the column layout of real Test-Connection (subset).
    const out: PSValue[] = [];
    for (let i = 1; i <= count; i++) {
      out.push({
        Source: 'localhost',
        Destination: target,
        IPV4Address: '0.0.0.0',
        IPV6Address: '',
        Bytes: 32,
        Time: reachable ? 1 : 0,
      } as Record<string, PSValue>);
    }
    return out as PSValue;
  }
}

// ── Resolve-DnsName ───────────────────────────────────────────────────────

export class ResolveDnsNameCmdlet implements ICmdlet {
  readonly name = 'resolve-dnsname';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const net = requireNetwork(ctx);
    const name = psValueToString(ctx.named['name'] ?? ctx.positional[0] ?? '');
    if (!name) { ctx.emitError('Resolve-DnsName requires -Name'); return null; }
    const ips = net.resolveDns(name);
    if (ips.length === 0) { ctx.emitError(`${name} : DNS name does not exist`); return null; }
    return ips.map(ip => ({
      Name: name,
      Type: ip.includes(':') ? 'AAAA' : 'A',
      TTL:  300,
      Section: 'Answer',
      IPAddress: ip,
    } as Record<string, PSValue>)) as PSValue;
  }
}

// ── Get-NetIPConfiguration ────────────────────────────────────────────────
// Composite: rolls adapter + IP + DNS + gateway into one row per adapter
// (matches what real PS prints when invoked without arguments).

export class GetNetIPConfigurationCmdlet implements ICmdlet {
  readonly name = 'get-netipconfiguration';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const net = requireNetwork(ctx);
    const adapters = net.getAdapters();
    const gateway = net.getDefaultGateway() ?? '';
    return adapters.map(a => {
      const ips = net.getIPAddresses(a.name);
      const v4  = ips.find(ip => ip.addressFamily === 'IPv4');
      return {
        InterfaceAlias:       a.name,
        InterfaceDescription: a.displayName,
        InterfaceIndex:       a.ifIndex,
        IPv4Address:          v4 ? v4.ipAddress : '',
        IPv6Address:          ips.find(ip => ip.addressFamily === 'IPv6')?.ipAddress ?? '',
        IPv4DefaultGateway:   gateway,
        DNSServer:            net.getDnsServers(a.name).join(', '),
        NetAdapter:           { Status: a.status } as Record<string, PSValue>,
      } as Record<string, PSValue>;
    }) as PSValue;
  }
}

// ── Get-NetRoute / Get-NetTCPConnection (read-only) ──────────────────────
// The provider currently returns [] for both — fall back to the legacy
// executor (it has the formatted-table output) when there's nothing
// structured to emit, so users still see the header columns.

export class GetNetRouteCmdlet implements ICmdlet {
  readonly name = 'get-netroute';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const net = requireNetwork(ctx);
    const routes = net.getRoutes();
    if (routes.length === 0) throw new PSRuntimeError('Get-NetRoute is not recognized in this provider context');
    return routes.map(r => ({
      DestinationPrefix: r.destinationPrefix,
      InterfaceAlias:    r.ifAlias,
      NextHop:           r.nextHop,
      RouteMetric:       r.routeMetric,
    } as Record<string, PSValue>)) as PSValue;
  }
}

export class GetNetTCPConnectionCmdlet implements ICmdlet {
  readonly name = 'get-nettcpconnection';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const net = requireNetwork(ctx);
    const conns = net.getTcpConnections();
    if (conns.length === 0) throw new PSRuntimeError('Get-NetTCPConnection is not recognized in this provider context');
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
    // The simulator stores the current user on env via $env:USERNAME — use
    // it if available so output stays consistent with `$env:USERNAME`.
    const user = ctx.env.get('env:username') ?? ctx.runtime.executeForValue('$env:USERNAME') ?? 'user';
    return `${host}\\${user}`.toLowerCase();
  }
}
