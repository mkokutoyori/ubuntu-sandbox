import type { Port } from '../../hardware/Port';
import { isValidIPv4, isValidIPv6 } from '../../core/ip';
import { IPAddress, SubnetMask } from '../../core/types';
import { toDisplayName, toPortName, formatLinkSpeedMbps } from './WindowsInterfaceNaming';
import { parsePSArgs } from './psArgs';
import type { PSDeviceContext } from './PowerShellExecutor';
import { WINDOWS_LOOPBACK_ROUTES, LOOPBACK_IFALIAS } from './WindowsLoopbackRoutes';

/** Dotted-quad mask for an IPv4 prefix length (24 → 255.255.255.0). */
function prefixToMaskString(prefixLength: number): string {
  const bits = 0xffffffff << (32 - prefixLength);
  if (prefixLength === 0) return '0.0.0.0';
  return [24, 16, 8, 0].map((shift) => (bits >>> shift) & 0xff).join('.');
}

export interface PSNetContext {
  device: PSDeviceContext;
}

export function handleGetNetIPConfiguration(ctx: PSNetContext, args: string[]): string {
    const params = parsePSArgs(args);
    const ifFilter = (params.get('interfacealias') ?? params.get('_positional') ?? '').replace(/^["']|["']$/g, '').toLowerCase();
    const detailed = params.has('detailed');
    const all = params.has('all');

    return formatGetNetIPConfiguration(ctx, ifFilter, detailed, all);
  }

export function formatGetNetIPConfiguration(ctx: PSNetContext, ifFilter = '', detailed = false, all = false): string {
    const ports = ctx.device.getPortsMap();
    const lines: string[] = [];
    let idx = 0;
    let found = false;

    const addEntry = (displayName: string, ip: string, mask: string, gw: string, dns: string[]) => {
      if (idx > 0) lines.push('');
      lines.push(`InterfaceAlias       : ${displayName}`);
      lines.push(`InterfaceIndex       : ${idx + 1}`);
      lines.push(`IPv4Address          : ${ip || 'Not configured'}`);
      if (mask) lines.push(`IPv4SubnetMask       : ${mask}`);
      lines.push(`IPv4DefaultGateway   : ${gw}`);
      lines.push(`DNSServer            : ${dns.length > 0 ? dns.join(', ') : ''}`);
      if (detailed) {
        lines.push(`ComputerName         : ${ctx.device.getHostname?.() ?? 'DESKTOP'}`);
      }
      idx++;
      found = true;
    };

    for (const [name, port] of ports) {
      const displayName = toDisplayName(name);
      if (ifFilter && !displayName.toLowerCase().includes(ifFilter) && displayName.toLowerCase() !== ifFilter) continue;
      const ip = port.getIPAddress()?.toString() ?? '';
      const mask = port.getSubnetMask()?.toString() ?? '';
      const gw = ctx.device.getDefaultGatewayString() ?? '';
      const dns = ctx.device.getDnsServers(name);
      addEntry(displayName, ip, mask, gw, dns);
    }

    // Loopback (shown with -All or when specifically requested)
    if (all && (!ifFilter || 'loopback'.includes(ifFilter))) {
      addEntry('Loopback Pseudo-Interface 1', '127.0.0.1', '255.0.0.0', '', []);
    }

    if (!found && ifFilter) {
      return `Get-NetIPConfiguration : Interface '${ifFilter}' not found. No MSFT_NetIPConfiguration objects found.`;
    }

    return lines.join('\n');
  }

export function buildAllIPEntries(ctx: PSNetContext): Array<{ ip: string; ifAlias: string; ifIndex: number; addressFamily: string; prefixLength: number; prefixOrigin: string; suffixOrigin: string; addressState: string; skipAsSource: boolean }> {
    const entries: Array<{ ip: string; ifAlias: string; ifIndex: number; addressFamily: string; prefixLength: number; prefixOrigin: string; suffixOrigin: string; addressState: string; skipAsSource: boolean }> = [];
    const ports = ctx.device.getPortsMap();
    let idx = 2;
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
          ip, ifAlias: displayName, ifIndex: idx, addressFamily: 'IPv4', prefixLength,
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
        entries.push({ ip: fe80, ifAlias: displayName, ifIndex: idx, addressFamily: 'IPv6', prefixLength: 64, prefixOrigin: 'WellKnown', suffixOrigin: 'Link', addressState: 'Preferred', skipAsSource: false });
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
      entries.push({ ip, ifAlias: info.ifAlias, ifIndex: idx++, addressFamily: info.addressFamily, prefixLength: info.prefixLength, prefixOrigin: info.prefixOrigin, suffixOrigin: info.suffixOrigin, addressState: 'Preferred', skipAsSource: info.skipAsSource });
    }
    // Loopback
    entries.push({ ip: '127.0.0.1', ifAlias: 'Loopback Pseudo-Interface 1', ifIndex: 1, addressFamily: 'IPv4', prefixLength: 8, prefixOrigin: 'WellKnown', suffixOrigin: 'WellKnown', addressState: 'Preferred', skipAsSource: false });
    entries.push({ ip: '::1', ifAlias: 'Loopback Pseudo-Interface 1', ifIndex: 1, addressFamily: 'IPv6', prefixLength: 128, prefixOrigin: 'WellKnown', suffixOrigin: 'WellKnown', addressState: 'Preferred', skipAsSource: false });
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

export function buildDefaultRoutes(ctx: PSNetContext): Array<{ dest: string; ifAlias: string; nextHop: string; metric: number }> {
    // Single source of truth: the SAME routing table `route print` renders.
    // (This function's name is kept for its many call sites; it no longer
    // synthesizes anything.)
    const routes: Array<{ dest: string; ifAlias: string; nextHop: string; metric: number }> = [];
    // Une seule declaration pour les deux vues : `Get-NetRoute` en
    // annoncait UNE, ecrite en dur ici, la ou `route print` n'en
    // montrait aucune.
    for (const lo of WINDOWS_LOOPBACK_ROUTES) {
      routes.push({
        dest: `${lo.network}/${lo.prefixLength}`,
        ifAlias: LOOPBACK_IFALIAS, nextHop: '0.0.0.0', metric: lo.metric,
      });
    }
    for (const r of ctx.device.getRoutingTable()) {
      const prefix = maskToPrefixLength(r.mask.toString());
      routes.push({
        dest: `${r.network.toString()}/${prefix}`,
        ifAlias: toDisplayName(r.iface),
        nextHop: r.nextHop ? r.nextHop.toString() : '0.0.0.0',
        metric: r.metric,
      });
    }
    return routes;
  }

/** Parse "a.b.c.d/len" into network + mask; null when malformed. */
function parseDestinationPrefix(dest: string): { network: IPAddress; mask: SubnetMask } | null {
    const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(dest);
    if (!m) return null;
    const prefix = parseInt(m[2], 10);
    if (prefix > 32 || !isValidIPv4(m[1])) return null;
    try {
      return { network: new IPAddress(m[1]), mask: new SubnetMask(prefixToMaskString(prefix)) };
    } catch {
      return null;
    }
  }

export function handleGetNetRoute(ctx: PSNetContext, args: string[]): string {
    const params = parsePSArgs(args);
    const destFilter = (params.get('destinationprefix') ?? '').replace(/^["']|["']$/g, '');
    const ifFilter = (params.get('interfacealias') ?? '').replace(/^["']|["']$/g, '').toLowerCase();
    const nhFilter = (params.get('nexthop') ?? '').replace(/^["']|["']$/g, '');
    const metricFilter = params.has('routemetric') ? parseInt(params.get('routemetric')!, 10) : undefined;

    // Validate destination prefix format — must be CIDR notation (ip/prefix or ipv6/prefix)
    if (destFilter && !destFilter.match(/^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/) && !destFilter.match(/^[0-9a-f:]+\/\d+$/i)) {
      return `Get-NetRoute : Invalid DestinationPrefix: '${destFilter}'.\nAt line:1 char:1\n    + CategoryInfo          : InvalidArgument`;
    }

    let routes = buildDefaultRoutes(ctx);
    if (destFilter) routes = routes.filter(r => r.dest === destFilter);
    if (ifFilter) routes = routes.filter(r => r.ifAlias.toLowerCase().includes(ifFilter));
    if (nhFilter) routes = routes.filter(r => r.nextHop === nhFilter);
    if (metricFilter !== undefined) routes = routes.filter(r => r.metric === metricFilter);

    if (routes.length === 0) return '';

    // Format as key-value blocks for pipeline compatibility (Select -ExpandProperty works on these)
    return routes.map((r, i) => [
      `DestinationPrefix : ${r.dest}`,
      `NextHop           : ${r.nextHop}`,
      `RouteMetric       : ${r.metric}`,
      `InterfaceAlias    : ${r.ifAlias}`,
      `InterfaceIndex    : ${i + 2}`,
      `AddressFamily     : IPv4`,
    ].join('\n')).join('\n\n');
  }

export function handleNewNetRoute(ctx: PSNetContext, args: string[]): string {
    const params = parsePSArgs(args);
    const dest = (params.get('destinationprefix') ?? params.get('_positional') ?? '').replace(/^["']|["']$/g, '');
    const ifAlias = (params.get('interfacealias') ?? '').replace(/^["']|["']$/g, '');
    const nextHop = (params.get('nexthop') ?? '').replace(/^["']|["']$/g, '');
    const metricStr = params.get('routemetric') ?? '0';
    const metric = parseInt(metricStr, 10);

    if (!dest) return `New-NetRoute : The -DestinationPrefix parameter is required.\nAt line:1 char:1\n    + CategoryInfo          : InvalidArgument`;
    if (!ifAlias) return `New-NetRoute : The -InterfaceAlias parameter is required.\nAt line:1 char:1\n    + CategoryInfo          : InvalidArgument`;
    if (!nextHop) return `New-NetRoute : The -NextHop parameter is required.\nAt line:1 char:1\n    + CategoryInfo          : InvalidArgument`;

    // Write to the REAL routing table (the same one `route add` uses).
    if (dest === '0.0.0.0/0') {
      if (!isValidIPv4(nextHop)) return `New-NetRoute : Invalid NextHop '${nextHop}'.`;
      ctx.device.setDefaultGateway(new IPAddress(nextHop));
    } else {
      const parsed = parseDestinationPrefix(dest);
      if (!parsed) return `New-NetRoute : Invalid DestinationPrefix: '${dest}'.\nAt line:1 char:1\n    + CategoryInfo          : InvalidArgument`;
      if (!isValidIPv4(nextHop)) return `New-NetRoute : Invalid NextHop '${nextHop}'.`;
      const dup = ctx.device.getRoutingTable().some(
        (r) => r.network.toString() === parsed.network.toString() && r.mask.toString() === parsed.mask.toString(),
      );
      if (dup) {
        return `New-NetRoute : Route '${dest}' already exists.\nAt line:1 char:1\n    + CategoryInfo          : InvalidArgument`;
      }
      if (!ctx.device.addStaticRoute(parsed.network, parsed.mask, new IPAddress(nextHop), metric)) {
        return `New-NetRoute : The gateway '${nextHop}' is not reachable.`;
      }
    }
    return [
      `DestinationPrefix : ${dest}`,
      `NextHop           : ${nextHop}`,
      `RouteMetric       : ${metric}`,
      `InterfaceAlias    : ${ifAlias}`,
      `InterfaceIndex    : 2`,
      `AddressFamily     : IPv4`,
    ].join('\n');
  }

export function handleRemoveNetRoute(ctx: PSNetContext, args: string[]): string {
    const params = parsePSArgs(args);
    const dest = (params.get('destinationprefix') ?? params.get('_positional') ?? '').replace(/^["']|["']$/g, '');
    const whatif = args.some(a => a.toLowerCase() === '-whatif');

    if (!dest) return `Remove-NetRoute : The -DestinationPrefix parameter is required.\nAt line:1 char:1\n    + CategoryInfo          : InvalidArgument`;

    const routes = buildDefaultRoutes(ctx);
    const found = routes.find(r => r.dest === dest);
    if (!found) {
      return `Remove-NetRoute : No MSFT_NetRoute objects found with property 'DestinationPrefix' equal to '${dest}'.`;
    }

    if (whatif) {
      return `What if: Performing the operation "Remove-NetRoute" on target "DestinationPrefix: ${dest}".`;
    }

    if (dest === '0.0.0.0/0') {
      ctx.device.clearDefaultGateway();
      return '';
    }
    const parsed = parseDestinationPrefix(dest);
    if (parsed) ctx.device.removeRoute(parsed.network, parsed.mask);
    return '';
  }

export function handleSetNetRoute(ctx: PSNetContext, args: string[]): string {
    const params = parsePSArgs(args);
    const dest = (params.get('destinationprefix') ?? params.get('_positional') ?? '').replace(/^["']|["']$/g, '');
    const nextHop = params.get('nexthop')?.replace(/^["']|["']$/g, '');
    const ifAlias = params.get('interfacealias')?.replace(/^["']|["']$/g, '');

    if (!dest) return `Set-NetRoute : The -DestinationPrefix parameter is required.`;

    // Update = remove + re-add on the REAL routing table.
    if (dest === '0.0.0.0/0') {
      if (nextHop && isValidIPv4(nextHop)) ctx.device.setDefaultGateway(new IPAddress(nextHop));
      return '';
    }
    const parsed = parseDestinationPrefix(dest);
    if (!parsed) return `Set-NetRoute : Invalid DestinationPrefix: '${dest}'.`;
    const current = ctx.device.getRoutingTable().find(
      (r) => r.network.toString() === parsed.network.toString() && r.mask.toString() === parsed.mask.toString(),
    );
    const newNextHop = nextHop && isValidIPv4(nextHop)
      ? new IPAddress(nextHop)
      : current?.nextHop ?? null;
    if (!newNextHop) return `Set-NetRoute : No MSFT_NetRoute objects found with property 'DestinationPrefix' equal to '${dest}'.`;
    if (current) ctx.device.removeRoute(parsed.network, parsed.mask);
    ctx.device.addStaticRoute(parsed.network, parsed.mask, newNextHop, current?.metric ?? 256);
    return '';
  }

export function handleGetNetAdapter(ctx: PSNetContext, args: string[]): string {
    const params = parsePSArgs(args);
    const nameFilter = (params.get('name') ?? params.get('_positional') ?? '').replace(/^["']|["']$/g, '').toLowerCase();
    const includeHidden = params.has('includehidden');
    const physical = params.has('physical');
    const cimSession = params.get('cimsession');

    if (cimSession) {
      return `Get-NetAdapter : Remote CIM sessions are not supported in this simulator.\n    + CategoryInfo          : NotImplemented: (:) [Get-NetAdapter], NotSupportedException`;
    }

    const ports = ctx.device.getPortsMap();
    const lines: string[] = ['Name                      InterfaceDescription                    ifIndex Status       MacAddress         LinkSpeed',
                              '----                      --------------------                    ------- ------       ----------         ---------'];

    // Collect all adapter entries (Ethernet ports + virtual Wi-Fi)
    type AdapterEntry = { displayName: string; desc: string; ifIndex: number; status: string; mac: string; speed: string };
    const adapterEntries: AdapterEntry[] = [];

    let idx = 0;
    for (const [name, port] of ports) {
      let displayName = toDisplayName(name);
      // Apply rename override
      const overrideKey = displayName.toLowerCase();
      const override = ctx.device.adapterOverrides.get(overrideKey);
      if (override?.displayName) displayName = override.displayName;

      const mac = port.getMAC()?.toString()?.replace(/:/g, '-').toUpperCase() ?? '00-00-00-00-00-00';
      const status = port.isAdminDown() ? 'Disabled' : (port.getIsUp() ? 'Up' : 'Disconnected');

      adapterEntries.push({ displayName, desc: 'Intel(R) Ethernet Connection', ifIndex: idx + 2, status, mac, speed: formatLinkSpeedMbps(port.getNegotiatedSpeed()) });
      idx++;
    }

    // Add virtual Wi-Fi adapter (always present on a Windows PC)
    const wifiOverride = ctx.device.adapterOverrides.get('wi-fi');
    const wifiDisplayName = wifiOverride?.displayName ?? 'Wi-Fi';
    const wifiStatus = wifiOverride?.status ?? 'Up';
    adapterEntries.push({ displayName: wifiDisplayName, desc: 'Intel(R) Wireless-AC 9560 160MHz', ifIndex: idx + 2, status: wifiStatus, mac: '02-00-00-FF-FF-01', speed: '54 Mbps' });

    // Filter by name — exact match unless wildcard '*' or '?' is present
    const filteredEntries = nameFilter
      ? adapterEntries.filter(e => {
          const dn = e.displayName.toLowerCase();
          if (nameFilter.includes('*') || nameFilter.includes('?')) {
            const regex = new RegExp('^' + nameFilter.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
            return regex.test(dn);
          }
          if (dn === nameFilter) return true;
          const resolvedPort = toPortName(nameFilter);
          return resolvedPort !== null && dn === toDisplayName(resolvedPort).toLowerCase();
        })
      : adapterEntries;

    // Apply -IncludeHidden (show Loopback)
    if (includeHidden && (!nameFilter || 'loopback'.includes(nameFilter))) {
      lines.push(`${'Loopback Pseudo-Interface 1'.padEnd(26)}${'Software Loopback Interface 1'.padEnd(40)}${String(1).padStart(7)} ${'Up'.padEnd(13)}${'00-00-00-00-00-00'.padEnd(19)}10 Gbps`);
    }

    if (filteredEntries.length === 0 && !includeHidden) {
      return `Get-NetAdapter : No MSFT_NetAdapter objects found with property 'Name' equal to '${nameFilter}'.`;
    }

    for (const e of filteredEntries) {
      lines.push(`${e.displayName.padEnd(26)}${e.desc.padEnd(40)}${String(e.ifIndex).padStart(7)} ${e.status.padEnd(13)}${e.mac.padEnd(19)}${e.speed}`);
    }

    return lines.join('\n');
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

export function handleDisableEnableNetAdapter(ctx: PSNetContext, args: string[], newStatus: string): string {
    const params = parsePSArgs(args);
    const name = (params.get('name') ?? params.get('_positional') ?? '').replace(/^["']|["']$/g, '');
    if (!name) return '';
    if (params.has('whatif')) {
      return `What if: Performing the operation "${newStatus === 'Disabled' ? 'Disable' : 'Enable'}-NetAdapter" on target "${name}".`;
    }
    const port = resolveAdapterPort(ctx, name);
    if (port) {
      port.setAdminDown(newStatus === 'Disabled');
      return '';
    }
    const key = name.toLowerCase();
    const override = ctx.device.adapterOverrides.get(key) ?? {};
    override.status = newStatus;
    ctx.device.adapterOverrides.set(key, override);
    return '';
  }

export function handleRenameNetAdapter(ctx: PSNetContext, args: string[]): string {
    const params = parsePSArgs(args);
    const oldName = (params.get('name') ?? params.get('_positional') ?? '').replace(/^["']|["']$/g, '');
    const newName = (params.get('newname') ?? '').replace(/^["']|["']$/g, '');
    if (!oldName || !newName) return '';
    const oldKey = oldName.toLowerCase();
    const existing = ctx.device.adapterOverrides.get(oldKey) ?? {};
    // Move entry to new name key
    existing.displayName = newName;
    ctx.device.adapterOverrides.set(oldKey, existing);
    // Also register under new name key pointing to same override
    ctx.device.adapterOverrides.set(newName.toLowerCase(), existing);
    return '';
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
