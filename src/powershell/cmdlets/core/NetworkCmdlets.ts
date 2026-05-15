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
    // Mimic the column layout of real Test-Connection (subset). Status
    // is the last column so a trailing-`Success` regex picks up each row.
    const out: PSValue[] = [];
    for (let i = 1; i <= count; i++) {
      out.push({
        Source: 'localhost',
        Destination: target,
        IPV4Address: target.includes(':') ? '' : (target === 'localhost' ? '127.0.0.1' : target),
        Bytes: 32,
        'Time(ms)': reachable ? 1 : 0,
        Status: reachable ? 'Success' : 'Failure',
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
    const routes = requireNetwork(ctx).getRoutes();
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

// ── New / Remove-NetIPAddress ─────────────────────────────────────────────

export class NewNetIPAddressCmdlet implements ICmdlet {
  readonly name = 'new-netipaddress';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const net = requireNetwork(ctx);
    const ip          = psValueToString(ctx.named['ipaddress']  ?? '');
    const ifAlias     = psValueToString(ctx.named['interfacealias'] ?? '');
    const prefix      = Number(ctx.named['prefixlength'] ?? 24);
    const gatewayRaw  = ctx.named['defaultgateway'];
    if (!ip || !ifAlias) {
      ctx.emitError('New-NetIPAddress requires -IPAddress and -InterfaceAlias');
      return null;
    }
    try {
      net.addIPAddress(ip, prefix, ifAlias, {
        gateway: gatewayRaw ? psValueToString(gatewayRaw) : undefined,
      });
    } catch (e) {
      ctx.emitError(e instanceof Error ? e.message : String(e));
      return null;
    }
    return null;
  }
}

export class RemoveNetIPAddressCmdlet implements ICmdlet {
  readonly name = 'remove-netipaddress';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const net = requireNetwork(ctx);
    const ip      = psValueToString(ctx.named['ipaddress'] ?? ctx.positional[0] ?? '');
    const ifAlias = ctx.named['interfacealias'] ? psValueToString(ctx.named['interfacealias']) : undefined;
    if (!ip) { ctx.emitError('Remove-NetIPAddress requires -IPAddress'); return null; }
    try {
      net.removeIPAddress(ip, ifAlias);
    } catch (e) {
      ctx.emitError(e instanceof Error ? e.message : String(e));
    }
    return null;
  }
}

// ── New / Remove-NetRoute ─────────────────────────────────────────────────

export class NewNetRouteCmdlet implements ICmdlet {
  readonly name = 'new-netroute';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const net = requireNetwork(ctx);
    const dest    = psValueToString(ctx.named['destinationprefix'] ?? '');
    const ifAlias = psValueToString(ctx.named['interfacealias'] ?? '');
    const nextHop = psValueToString(ctx.named['nexthop'] ?? '');
    const metric  = Number(ctx.named['routemetric'] ?? 256);
    if (!dest || !ifAlias || !nextHop) {
      ctx.emitError('New-NetRoute requires -DestinationPrefix, -InterfaceAlias, -NextHop');
      return null;
    }
    net.addRoute(dest, ifAlias, nextHop, metric);
    return null;
  }
}

export class RemoveNetRouteCmdlet implements ICmdlet {
  readonly name = 'remove-netroute';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const net = requireNetwork(ctx);
    const dest = psValueToString(ctx.named['destinationprefix'] ?? ctx.positional[0] ?? '');
    if (!dest) { ctx.emitError('Remove-NetRoute requires -DestinationPrefix'); return null; }
    const ifAlias = ctx.named['interfacealias'] ? psValueToString(ctx.named['interfacealias']) : undefined;
    net.removeRoute(dest, ifAlias);
    return null;
  }
}

// ── Set-NetIPAddress / Set-NetRoute ───────────────────────────────────────

export class SetNetIPAddressCmdlet implements ICmdlet {
  readonly name = 'set-netipaddress';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const net = requireNetwork(ctx);
    const ip = psValueToString(ctx.named['ipaddress'] ?? ctx.positional[0] ?? '');
    if (!ip) { ctx.emitError('Set-NetIPAddress requires -IPAddress'); return null; }
    const opts: { prefixLength?: number } = {};
    if (ctx.named['prefixlength'] !== undefined) opts.prefixLength = Number(ctx.named['prefixlength']);
    const msg = net.setIPAddress(ip, opts);
    if (msg) ctx.emitError(msg);
    return null;
  }
}

export class SetNetRouteCmdlet implements ICmdlet {
  readonly name = 'set-netroute';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const net = requireNetwork(ctx);
    const dest = psValueToString(ctx.named['destinationprefix'] ?? ctx.positional[0] ?? '');
    if (!dest) { ctx.emitError('Set-NetRoute requires -DestinationPrefix'); return null; }
    const opts: { nextHop?: string; routeMetric?: number; ifAlias?: string } = {};
    if (ctx.named['nexthop']        !== undefined) opts.nextHop      = psValueToString(ctx.named['nexthop']);
    if (ctx.named['routemetric']    !== undefined) opts.routeMetric  = Number(ctx.named['routemetric']);
    if (ctx.named['interfacealias'] !== undefined) opts.ifAlias      = psValueToString(ctx.named['interfacealias']);
    const msg = net.setRoute(dest, opts);
    if (msg) ctx.emitError(msg);
    return null;
  }
}

// ── Restart-NetAdapter (cycle adapter status) ────────────────────────────

export class RestartNetAdapterCmdlet implements ICmdlet {
  readonly name = 'restart-netadapter';
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

// ── Test-NetConnection (TCP-port-aware sibling of Test-Connection) ────────

export class TestNetConnectionCmdlet implements ICmdlet {
  readonly name = 'test-netconnection';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const net = requireNetwork(ctx);
    const target = psValueToString(
      ctx.named['computername'] ?? ctx.named['targetname'] ?? ctx.positional[0] ?? '',
    );
    if (!target) { ctx.emitError('Test-NetConnection requires -ComputerName'); return null; }
    const port = ctx.named['port']
      ? Number(ctx.named['port'])
      : (ctx.named['commontcpport'] ? psValueToString(ctx.named['commontcpport']) : null);
    const reachable = net.testConnection(target);
    return {
      ComputerName:        target,
      RemoteAddress:       target,
      RemotePort:          port ?? 0,
      InterfaceAlias:      'eth0',
      SourceAddress:       net.getDefaultGateway() ?? '0.0.0.0',
      PingSucceeded:       reachable,
      PingReplyDetails:    { RoundtripTime: reachable ? 1 : 0 },
      TcpTestSucceeded:    !!port && reachable,
    } as Record<string, PSValue>;
  }
}

// ── Enable / Disable / Rename-NetAdapter ──────────────────────────────────

export class EnableNetAdapterCmdlet implements ICmdlet {
  readonly name = 'enable-netadapter';
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
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const net = requireNetwork(ctx);
    const ifAlias = ctx.named['interfacealias']
      ? psValueToString(ctx.named['interfacealias'])
      : undefined;
    const adapters = net.getAdapters();
    const filtered = ifAlias
      ? adapters.filter(a => a.name.toLowerCase() === ifAlias.toLowerCase())
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

export class ClearDnsClientCacheCmdlet implements ICmdlet {
  readonly name = 'clear-dnsclientcache';
  readonly aliases = [] as const;

  execute(): PSValue {
    // No DNS cache simulated — silent no-op, matches real PowerShell when
    // there are no entries to clear.
    return null;
  }
}

// ── Get / New / Set / Enable / Disable / Remove-NetFirewallRule ────────────

export class GetNetFirewallRuleCmdlet implements ICmdlet {
  readonly name = 'get-netfirewallrule';
  readonly aliases = [] as const;

  execute(ctx: CmdletContext): PSValue {
    const rules = requireNetwork(ctx).getFirewallRules();
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
  readonly aliases = [] as const;
  protected enabled = true;
}
export class DisableNetFirewallRuleCmdlet extends FirewallToggleCmdlet {
  readonly name = 'disable-netfirewallrule';
  readonly aliases = [] as const;
  protected enabled = false;
}

export class SetNetFirewallRuleCmdlet implements ICmdlet {
  readonly name = 'set-netfirewallrule';
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
    // The simulator stores the current user on env via $env:USERNAME — use
    // it if available so output stays consistent with `$env:USERNAME`.
    const user = ctx.env.get('env:username') ?? ctx.runtime.executeForValue('$env:USERNAME') ?? 'user';
    return `${host}\\${user}`.toLowerCase();
  }
}
