import type { Port } from '../../hardware/Port';
import { isValidIPv4, isValidIPv6 } from '../../core/ip';
import { IPAddress } from '../../core/types';
import {
  LOOPBACK_IFINDEX, adapterIfIndex, toDisplayName, toPortName, formatLinkSpeedMbps,
} from './WindowsInterfaceNaming';
import { parsePSArgs } from './psArgs';
import type { PSDeviceContext } from './PowerShellExecutor';

export interface PSNetContext {
  device: PSDeviceContext;
}

export function buildAllIPEntries(ctx: PSNetContext): Array<{ ip: string; ifAlias: string; ifIndex: number; addressFamily: string; prefixLength: number; prefixOrigin: string; suffixOrigin: string; addressState: string; skipAsSource: boolean }> {
    const entries: Array<{ ip: string; ifAlias: string; ifIndex: number; addressFamily: string; prefixLength: number; prefixOrigin: string; suffixOrigin: string; addressState: string; skipAsSource: boolean }> = [];
    const ports = ctx.device.getPortsMap();
    let idx = 0;
    for (const [name, port] of ports) {
      const displayName = toDisplayName(name);
      const ip = port.getIPAddress()?.toString() ?? '';
      const mask = port.getSubnetMask()?.toString() ?? '';
      const prefixLength = mask ? maskToPrefixLength(mask) : 0;
      const isDhcp = ctx.device.isDHCPConfigured(name);
      // An unconfigured adapter simply has no IPv4 entry — the sim used to
      // invent a 192.168.1.10x address here, which made PowerShell disagree
      // with ipconfig about the machine's real addresses.
      if (ip) {
        // The address itself is owned by the port (single source of truth);
        // per-address attributes Windows tracks but the port model doesn't
        // (SkipAsSource, explicit PrefixOrigin) are merged from the metadata
        // side-map when present.
        const attr = ctx.device.extraIPs.get(ip.toLowerCase());
        entries.push({
          ip, ifAlias: displayName, ifIndex: adapterIfIndex(idx), addressFamily: 'IPv4', prefixLength,
          prefixOrigin: attr?.prefixOrigin ?? (isDhcp ? 'Dhcp' : 'Manual'),
          suffixOrigin: attr?.suffixOrigin ?? (isDhcp ? 'Dhcp' : 'Manual'),
          addressState: 'Preferred',
          skipAsSource: attr?.skipAsSource ?? false,
        });
      }
      // Link-local IPv6
      const macStr = port.getMAC()?.toString() ?? '00:00:00:00:00:00';
      const macParts = macStr.split(':');
      if (macParts.length === 6) {
        const fe80 = `fe80::${macParts[0]}${macParts[1]}:${macParts[2]}ff:fe${macParts[3]}:${macParts[4]}${macParts[5]}`;
        entries.push({ ip: fe80, ifAlias: displayName, ifIndex: adapterIfIndex(idx), addressFamily: 'IPv6', prefixLength: 64, prefixOrigin: 'WellKnown', suffixOrigin: 'Link', addressState: 'Preferred', skipAsSource: false });
      }
      idx++;
    }
    // Extra IPs: virtual-adapter addresses AND attribute-only metadata for
    // real port addresses. Skip any whose address already appears on a port
    // (that entry was emitted above with the merged attributes) so an
    // address is never listed twice.
    const portIps = new Set(entries.filter(e => e.addressFamily === 'IPv4').map(e => e.ip.toLowerCase()));
    for (const [ip, info] of ctx.device.extraIPs) {
      if (portIps.has(ip.toLowerCase())) continue;
      entries.push({ ip, ifAlias: info.ifAlias, ifIndex: adapterIfIndex(idx++), addressFamily: info.addressFamily, prefixLength: info.prefixLength, prefixOrigin: info.prefixOrigin, suffixOrigin: info.suffixOrigin, addressState: 'Preferred', skipAsSource: info.skipAsSource });
    }
    // Loopback
    entries.push({ ip: '127.0.0.1', ifAlias: 'Loopback Pseudo-Interface 1', ifIndex: LOOPBACK_IFINDEX, addressFamily: 'IPv4', prefixLength: 8, prefixOrigin: 'WellKnown', suffixOrigin: 'WellKnown', addressState: 'Preferred', skipAsSource: false });
    entries.push({ ip: '::1', ifAlias: 'Loopback Pseudo-Interface 1', ifIndex: LOOPBACK_IFINDEX, addressFamily: 'IPv6', prefixLength: 128, prefixOrigin: 'WellKnown', suffixOrigin: 'WellKnown', addressState: 'Preferred', skipAsSource: false });
    return entries;
  }

export function formatIPEntry(e: ReturnType<typeof buildAllIPEntries>[0]): string {
    return [
      `IPAddress         : ${e.ip}`,
      `InterfaceIndex    : ${e.ifIndex}`,
      `InterfaceAlias    : ${e.ifAlias}`,
      `AddressFamily     : ${e.addressFamily}`,
      `Type              : Unicast`,
      `PrefixLength      : ${e.prefixLength}`,
      `PrefixOrigin      : ${e.prefixOrigin}`,
      `SuffixOrigin      : ${e.suffixOrigin}`,
      `AddressState      : ${e.addressState}`,
      `SkipAsSource      : ${e.skipAsSource ? 'True' : 'False'}`,
    ].join('\n');
  }

export function handleGetNetIPAddress(ctx: PSNetContext, args: string[]): string {
    const params = parsePSArgs(args);
    const ipFilter = params.get('ipaddress') || params.get('_positional');
    const ifFilter = (params.get('interfacealias') ?? '').toLowerCase().replace(/^["']|["']$/g, '');
    const afFilter = (params.get('addressfamily') ?? '').toLowerCase();
    const plFilter = params.has('prefixlength') ? parseInt(params.get('prefixlength')!, 10) : undefined;
    const stateFilter = (params.get('addressstate') ?? '').toLowerCase();
    const poFilter = (params.get('prefixorigin') ?? '').toLowerCase();
    const soFilter = (params.get('suffixorigin') ?? '').toLowerCase();
    // -IncludeAllCompartments: just ignore in sim
    const errorAction = (params.get('erroraction') ?? '').toLowerCase();

    // Validate explicit IP address filter
    if (ipFilter && !isValidIP(ipFilter)) {
      return `Get-NetIPAddress : Invalid IP address: '${ipFilter}'.\nAt line:1 char:1\n    + CategoryInfo          : InvalidArgument`;
    }

    let entries = buildAllIPEntries(ctx);

    if (ipFilter) entries = entries.filter(e => e.ip.toLowerCase() === ipFilter.toLowerCase());
    if (ifFilter) entries = entries.filter(e => e.ifAlias.toLowerCase().includes(ifFilter) || e.ifAlias.toLowerCase() === ifFilter);
    if (afFilter === 'ipv4') entries = entries.filter(e => e.addressFamily === 'IPv4');
    if (afFilter === 'ipv6') entries = entries.filter(e => e.addressFamily === 'IPv6');
    if (plFilter !== undefined) entries = entries.filter(e => e.prefixLength === plFilter);
    if (stateFilter) entries = entries.filter(e => e.addressState.toLowerCase() === stateFilter);
    if (poFilter) entries = entries.filter(e => e.prefixOrigin.toLowerCase() === poFilter);
    if (soFilter) entries = entries.filter(e => e.suffixOrigin.toLowerCase() === soFilter);

    if (entries.length === 0) {
      if (ifFilter) {
        return `Get-NetIPAddress : No MSFT_NetIPAddress objects found with property 'InterfaceAlias' equal to '${ifFilter}'. Verify the value of the property and retry.`;
      }
      if (ipFilter) {
        return `Get-NetIPAddress : No MSFT_NetIPAddress objects found with property 'IPAddress' equal to '${ipFilter}'. Verify the value of the property and retry.`;
      }
      return '';
    }

    return entries.map(e => formatIPEntry(e)).join('\n\n');
  }

export function isValidIP(ip: string): boolean {
    return isValidIPv4(ip) || isValidIPv6(ip);
  }


export function resolveAdapterPort(ctx: PSNetContext, name: string): Port | undefined {
    const target = name.toLowerCase();
    const ports = ctx.device.getPortsMap();
    for (const [pname, port] of ports) {
      if (pname.toLowerCase() === target) return port;
      if (toDisplayName(pname).toLowerCase() === target) return port;
    }
    const resolved = toPortName(name);
    return resolved ? ports.get(resolved) : undefined;
  }



export function handleTestNetConnection(ctx: PSNetContext, args: string[]): string {
    const params = parsePSArgs(args);
    const target = (params.get('computername') ?? params.get('_positional') ?? '').replace(/^["']|["']$/g, '');
    const port = params.has('port') ? parseInt(params.get('port')!, 10) : undefined;
    if (!target) return 'Test-NetConnection requires -ComputerName';

    // Same resolution chain as ping: literal / hosts / own name first, then
    // the full DNS chain (cache + configured servers over the wire).
    let resolved = ctx.device.resolveHostnameSync(target);
    if (!resolved) {
      const viaDns = ctx.device.resolveDnsSync(target).find((ip) => !ip.includes(':'));
      if (viaDns) {
        try { resolved = new IPAddress(viaDns); } catch { resolved = null; }
      }
    }
    const remoteAddress = resolved?.toString() ?? target;
    const ping = resolved ? ctx.device.sendPingProbeSync(resolved) : { success: false, rttMs: 0, ttl: 0 };
    const egress = resolved ? ctx.device.getEgressFor(resolved) : null;

    let tcpSucceeded = false;
    if (port !== undefined && resolved && ping.success) {
      tcpSucceeded = ctx.device.tcpProbeSync(resolved, port);
    }

    return [
      `\nComputerName           : ${target}`,
      `RemoteAddress          : ${remoteAddress}`,
      port !== undefined ? `RemotePort             : ${port}` : '',
      `InterfaceAlias         : ${egress?.interfaceName ?? 'Ethernet'}`,
      `SourceAddress          : ${egress?.sourceIp.toString() ?? '0.0.0.0'}`,
      `PingSucceeded          : ${ping.success ? 'True' : 'False'}`,
      `PingReplyDetails (RTT) : ${Math.round(ping.success ? ping.rttMs : 0)} ms`,
      port !== undefined ? `TcpTestSucceeded       : ${tcpSucceeded ? 'True' : 'False'}` : '',
    ].filter(l => l !== '').join('\n');
  }

export function formatGetNetTCPConnection(ctx: PSNetContext, args: string[]): string {
    // Read the REAL socket table — the same one netstat (cmd) renders.
    const lines: string[] = [
      '',
      'LocalAddress           LocalPort RemoteAddress          RemotePort State       AppliedSetting',
      '------------           --------- -------------          ---------- -----       --------------',
    ];

    const params = parsePSArgs(args);
    const stateFilter = params.get('state')?.toLowerCase();

    for (const sock of ctx.device.getSocketTable().getAll()) {
      if (sock.protocol.toLowerCase() !== 'tcp') continue;
      const state = sock.state === 'LISTEN' ? 'Listen'
        : sock.state === 'ESTABLISHED' ? 'Established'
        : sock.state.charAt(0) + sock.state.slice(1).toLowerCase();
      if (stateFilter && state.toLowerCase() !== stateFilter) continue;
      const local = sock.localAddress || '0.0.0.0';
      const remote = sock.state === 'LISTEN' ? '0.0.0.0' : sock.remoteAddress;
      const remotePort = sock.state === 'LISTEN' ? 0 : sock.remotePort;
      lines.push(`${local.padEnd(23)}${String(sock.localPort).padEnd(10)}${remote.padEnd(23)}${String(remotePort).padEnd(11)}${state}`);
    }

    if (lines.length <= 3) return '';
    return lines.join('\n');
  }

export function maskToPrefixLength(mask: string): number {
    const parts = mask.split('.').map(Number);
    let bits = 0;
    for (const p of parts) {
      bits += (p >>> 0).toString(2).split('').filter(b => b === '1').length;
    }
    return bits;
  }

export function renderResolveDnsName(ctx: PSNetContext, target: string): string {
    // Resolve through the device's REAL chain (hosts file → resolver cache
    // → configured servers over the wire) — the same chain nslookup and
    // ping use. No hard-coded answers: an unresolvable name fails here
    // exactly like it fails in cmd.
    const header =
      'Name                                           Type   TTL   Section    IPAddress\n' +
      '----                                           ----   ---   -------    ---------';

    const isIPv4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(target);
    if (isIPv4) {
      const reversed = target.split('.').reverse().join('.');
      const ptrName = `${reversed}.in-addr.arpa`;
      if (target !== '127.0.0.1') {
        return `Resolve-DnsName : ${ptrName} : DNS name does not exist\n    + CategoryInfo          : ResourceUnavailable: (${ptrName}:String) [Resolve-DnsName], Win32Exception`;
      }
      const row = ptrName.padEnd(47) + 'PTR    ' + '3600  ' + 'Answer     ' + 'localhost';
      return `\n${header}\n${row}\n`;
    }

    if (target.toLowerCase() === 'localhost') {
      const row = 'localhost'.padEnd(47) + 'A      86400  Answer     127.0.0.1';
      return `\n${header}\n${row}\n`;
    }

    const ips = ctx.device.resolveDnsSync(target);
    if (ips.length === 0) {
      return `Resolve-DnsName : ${target} : DNS name does not exist\n    + CategoryInfo          : ResourceUnavailable: (${target}:String) [Resolve-DnsName], Win32Exception`;
    }
    const rows = ips.map((ip) =>
      target.padEnd(47) + (ip.includes(':') ? 'AAAA   ' : 'A      ') + '3600  ' + 'Answer     ' + ip);
    return `\n${header}\n${rows.join('\n')}\n`;
  }
