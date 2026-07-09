import type { Port } from '../../hardware/Port';
import { isValidIPv4, isValidIPv6 } from '../../core/ip';
import { toDisplayName, toPortName, formatLinkSpeedMbps } from './WindowsInterfaceNaming';
import { parsePSArgs } from './psArgs';
import type { PSDeviceContext } from './PowerShellExecutor';

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
    let ethIdx = 0;
    for (const [name, port] of ports) {
      const displayName = toDisplayName(name);
      const ip = port.getIPAddress()?.toString() ?? '';
      const mask = port.getSubnetMask()?.toString() ?? '';
      const prefixLength = mask ? maskToPrefixLength(mask) : 0;
      const isDhcp = ctx.device.isDHCPConfigured(name);
      if (ip) {
        entries.push({ ip, ifAlias: displayName, ifIndex: idx, addressFamily: 'IPv4', prefixLength, prefixOrigin: isDhcp ? 'Dhcp' : 'Manual', suffixOrigin: isDhcp ? 'Dhcp' : 'Manual', addressState: 'Preferred', skipAsSource: false });
      } else if (!ctx.device.extraIPs.has(displayName.toLowerCase())) {
        // Simulated default private IP for unconfigured adapters (192.168.1.100+offset/24)
        const simIp = `192.168.1.${100 + ethIdx}`;
        entries.push({ ip: simIp, ifAlias: displayName, ifIndex: idx, addressFamily: 'IPv4', prefixLength: 24, prefixOrigin: 'WellKnown', suffixOrigin: 'WellKnown', addressState: 'Preferred', skipAsSource: false });
      }
      // Link-local IPv6
      const macStr = port.getMAC()?.toString() ?? '00:00:00:00:00:00';
      const macParts = macStr.split(':');
      if (macParts.length === 6) {
        const fe80 = `fe80::${macParts[0]}${macParts[1]}:${macParts[2]}ff:fe${macParts[3]}:${macParts[4]}${macParts[5]}`;
        entries.push({ ip: fe80, ifAlias: displayName, ifIndex: idx, addressFamily: 'IPv6', prefixLength: 64, prefixOrigin: 'WellKnown', suffixOrigin: 'Link', addressState: 'Preferred', skipAsSource: false });
      }
      idx++;
      ethIdx++;
    }
    // Extra IPs (added via New-NetIPAddress)
    for (const [ip, info] of ctx.device.extraIPs) {
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

export function handleNewNetIPAddress(ctx: PSNetContext, args: string[]): string {
    const params = parsePSArgs(args);
    const ip = params.get('ipaddress') || params.get('_positional');
    const ifAlias = (params.get('interfacealias') ?? '').replace(/^["']|["']$/g, '');
    const prefixStr = params.get('prefixlength');
    const gateway = params.get('defaultgateway');
    const afParam = (params.get('addressfamily') ?? '').toLowerCase();
    const skipAsSource = (params.get('skipassource') ?? '').toLowerCase() === '$true' || params.get('skipassource') === 'true';

    if (!ip) return `New-NetIPAddress : The -IPAddress parameter is required.\nAt line:1 char:1\n    + CategoryInfo          : InvalidArgument`;
    if (!ifAlias) return `New-NetIPAddress : The -InterfaceAlias parameter is required.\nAt line:1 char:1\n    + CategoryInfo          : InvalidArgument`;
    if (!prefixStr) return `New-NetIPAddress : The -PrefixLength parameter is required.\nAt line:1 char:1\n    + CategoryInfo          : InvalidArgument`;
    if (!isValidIP(ip)) return `New-NetIPAddress : Invalid IP address: '${ip}'.\nAt line:1 char:1\n    + CategoryInfo          : InvalidArgument`;

    const prefixLength = parseInt(prefixStr, 10);
    const isIPv6 = ip.includes(':');
    const maxPrefix = isIPv6 ? 128 : 32;
    if (isNaN(prefixLength) || prefixLength < 0 || prefixLength > maxPrefix) {
      return `New-NetIPAddress : PrefixLength '${prefixStr}' is not in the valid range 0-${maxPrefix}.\nAt line:1 char:1\n    + CategoryInfo          : InvalidArgument`;
    }

    // Check for duplicate
    const existing = buildAllIPEntries(ctx);
    if (existing.some(e => e.ip.toLowerCase() === ip.toLowerCase())) {
      return `New-NetIPAddress : The IP address '${ip}' already exists on this system.\nAt line:1 char:1\n    + CategoryInfo          : InvalidArgument`;
    }

    const addressFamily = afParam === 'ipv6' || isIPv6 ? 'IPv6' : 'IPv4';
    ctx.device.extraIPs.set(ip.toLowerCase(), { ifAlias, prefixLength, prefixOrigin: 'Manual', suffixOrigin: 'Manual', skipAsSource, gateway, addressFamily });

    if (gateway) {
      ctx.device.extraRoutes.set('0.0.0.0/0', { ifAlias, nextHop: gateway, metric: 0 });
    }

    return formatIPEntry({ ip, ifAlias, ifIndex: 99, addressFamily, prefixLength, prefixOrigin: 'Manual', suffixOrigin: 'Manual', addressState: 'Preferred', skipAsSource });
  }

export function handleRemoveNetIPAddress(ctx: PSNetContext, args: string[]): string {
    const params = parsePSArgs(args);
    const ip = params.get('ipaddress') || params.get('_positional');
    const whatif = params.has('whatif') || args.some(a => a.toLowerCase() === '-whatif');

    if (!ip) return `Remove-NetIPAddress : The -IPAddress parameter is required.\nAt line:1 char:1\n    + CategoryInfo          : InvalidArgument`;

    if (ip === '127.0.0.1' || ip === '::1') {
      return `Remove-NetIPAddress : Cannot remove the loopback address '${ip}'. This address is required for network functionality.`;
    }

    const entries = buildAllIPEntries(ctx);
    const found = entries.find(e => e.ip.toLowerCase() === ip.toLowerCase());
    if (!found) {
      return `Remove-NetIPAddress : No MSFT_NetIPAddress objects found with property 'IPAddress' equal to '${ip}'. Verify the value of the property and retry.`;
    }

    if (whatif) {
      return `What if: Performing the operation "Remove-NetIPAddress" on target "IPAddress: ${ip}, InterfaceAlias: ${found.ifAlias}".`;
    }

    ctx.device.extraIPs.delete(ip.toLowerCase());
    return '';
  }

export function handleSetNetIPAddress(ctx: PSNetContext, args: string[]): string {
    const params = parsePSArgs(args);
    const ip = (params.get('ipaddress') || params.get('_positional'))?.replace(/^["']|["']$/g, '');
    const ifAlias = params.get('interfacealias')?.replace(/^["']|["']$/g, '');
    const prefixStr = params.get('prefixlength');
    const prefixLength = prefixStr ? parseInt(prefixStr, 10) : undefined;

    // When -InterfaceAlias is given, replace the existing IPv4 for that adapter with the new IP
    if (ifAlias && ip) {
      if (!isValidIP(ip)) return `Set-NetIPAddress : Invalid IP address '${ip}'.`;
      const all = buildAllIPEntries(ctx);
      const existing = all.find(e => e.ifAlias.toLowerCase() === ifAlias.toLowerCase() && e.addressFamily === 'IPv4');
      if (existing) ctx.device.extraIPs.delete(existing.ip.toLowerCase());
      ctx.device.extraIPs.set(ip.toLowerCase(), {
        ifAlias, prefixLength: prefixLength ?? existing?.prefixLength ?? 24,
        prefixOrigin: 'Manual', suffixOrigin: 'Manual', skipAsSource: false, addressFamily: 'IPv4',
      });
      return '';
    }

    if (!ip) return `Set-NetIPAddress : The -IPAddress parameter is required.\nAt line:1 char:1\n    + CategoryInfo          : InvalidArgument`;

    const entry = ctx.device.extraIPs.get(ip.toLowerCase());
    if (!entry) {
      const all = buildAllIPEntries(ctx);
      const found = all.find(e => e.ip.toLowerCase() === ip.toLowerCase());
      if (!found) {
        return `Set-NetIPAddress : No MSFT_NetIPAddress objects found with property 'IPAddress' equal to '${ip}'. Verify the value of the property and retry.`;
      }
      ctx.device.extraIPs.set(ip.toLowerCase(), { ifAlias: found.ifAlias, prefixLength: found.prefixLength, prefixOrigin: found.prefixOrigin, suffixOrigin: found.suffixOrigin, skipAsSource: found.skipAsSource, addressFamily: found.addressFamily });
    }

    const e = ctx.device.extraIPs.get(ip.toLowerCase())!;
    if (prefixLength !== undefined) e.prefixLength = prefixLength;
    if (params.has('prefixorigin')) e.prefixOrigin = params.get('prefixorigin')!;
    if (params.has('suffixorigin')) e.suffixOrigin = params.get('suffixorigin')!;
    if (params.has('skipassource')) e.skipAsSource = (params.get('skipassource') ?? '').toLowerCase() !== 'false' && (params.get('skipassource') ?? '') !== '$false';
    return '';
  }

export function buildDefaultRoutes(ctx: PSNetContext): Array<{ dest: string; ifAlias: string; nextHop: string; metric: number }> {
    const routes: Array<{ dest: string; ifAlias: string; nextHop: string; metric: number }> = [];
    const gw = ctx.device.getDefaultGatewayString();
    const ports = ctx.device.getPortsMap();
    let firstIF = '';
    for (const [name] of ports) { firstIF = toDisplayName(name); break; }
    // Default route — skip built-in if extraRoutes already has a 0.0.0.0/0 (set by New-NetIPAddress -DefaultGateway)
    if (!ctx.device.extraRoutes.has('0.0.0.0/0')) {
      routes.push({ dest: '0.0.0.0/0', ifAlias: firstIF || 'Ethernet', nextHop: gw || '0.0.0.0', metric: 0 });
    }
    // Loopback
    routes.push({ dest: '127.0.0.0/8', ifAlias: 'Loopback Pseudo-Interface 1', nextHop: '0.0.0.0', metric: 306 });
    // Connected network routes
    let idx = 2;
    for (const [name, port] of ports) {
      const displayName = toDisplayName(name);
      const ip = port.getIPAddress()?.toString() ?? '';
      const mask = port.getSubnetMask()?.toString() ?? '';
      if (ip && mask) {
        const prefix = maskToPrefixLength(mask);
        const network = ip.split('.').map((o, i) => (parseInt(o) & parseInt(mask.split('.')[i])).toString()).join('.');
        routes.push({ dest: `${network}/${prefix}`, ifAlias: displayName, nextHop: '0.0.0.0', metric: 256 });
      }
      idx++;
    }
    // Extra routes
    for (const [dest, info] of ctx.device.extraRoutes) {
      routes.push({ dest, ifAlias: info.ifAlias, nextHop: info.nextHop, metric: info.metric });
    }
    return routes;
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

    // Check for duplicates
    if (ctx.device.extraRoutes.has(dest)) {
      return `New-NetRoute : Route '${dest}' already exists.\nAt line:1 char:1\n    + CategoryInfo          : InvalidArgument`;
    }

    ctx.device.extraRoutes.set(dest, { ifAlias, nextHop, metric });
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
    if (!found && !ctx.device.extraRoutes.has(dest)) {
      return `Remove-NetRoute : No MSFT_NetRoute objects found with property 'DestinationPrefix' equal to '${dest}'.`;
    }

    if (whatif) {
      return `What if: Performing the operation "Remove-NetRoute" on target "DestinationPrefix: ${dest}".`;
    }

    ctx.device.extraRoutes.delete(dest);
    return '';
  }

export function handleSetNetRoute(ctx: PSNetContext, args: string[]): string {
    const params = parsePSArgs(args);
    const dest = (params.get('destinationprefix') ?? params.get('_positional') ?? '').replace(/^["']|["']$/g, '');
    const nextHop = params.get('nexthop')?.replace(/^["']|["']$/g, '');
    const ifAlias = params.get('interfacealias')?.replace(/^["']|["']$/g, '');

    if (!dest) return `Set-NetRoute : The -DestinationPrefix parameter is required.`;

    const existing = ctx.device.extraRoutes.get(dest);
    if (existing) {
      if (nextHop) existing.nextHop = nextHop;
      if (ifAlias) existing.ifAlias = ifAlias;
    } else {
      // Create if not exists
      ctx.device.extraRoutes.set(dest, { ifAlias: ifAlias ?? '', nextHop: nextHop ?? '0.0.0.0', metric: 256 });
    }
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

    const resolved = ctx.device.resolveHostnameSync(target);
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
    const ports = ctx.device.getPortsMap();
    // Simulate standard TCP connections for a Windows PC
    const lines: string[] = [
      '',
      'LocalAddress           LocalPort RemoteAddress          RemotePort State       AppliedSetting',
      '------------           --------- -------------          ---------- -----       --------------',
    ];

    // Listening ports based on running services
    const serviceMgr = ctx.device.getServiceManager();
    const runningServices = serviceMgr.getAllServices().filter(s => s.state === 'Running');
    const listeningPorts: Array<{ port: number; name: string }> = [
      { port: 135, name: 'RpcSs' },
      { port: 445, name: 'LanmanServer' },
      { port: 49152, name: 'Services' },
    ];
    for (const svc of runningServices) {
      if (svc.name === 'WinRM') listeningPorts.push({ port: 5985, name: 'WinRM' });
    }

    let localIp = '0.0.0.0';
    for (const port of ports.values()) {
      const ip = port.getIPAddress();
      if (ip) { localIp = ip.toString(); break; }
    }

    const params = parsePSArgs(args);
    const stateFilter = params.get('state')?.toLowerCase();

    for (const lp of listeningPorts) {
      if (!stateFilter || stateFilter === 'listen') {
        lines.push(`${('0.0.0.0').padEnd(23)}${String(lp.port).padEnd(10)}${'0.0.0.0'.padEnd(23)}${'0'.padEnd(11)}Listen`);
      }
    }

    // Simulate established connection to DNS server
    if (!stateFilter || stateFilter === 'established') {
      lines.push(`${localIp.padEnd(23)}${String(49153 + Math.floor(Math.random() * 100)).padEnd(10)}${'8.8.8.8'.padEnd(23)}${'53'.padEnd(11)}Established`);
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

export function renderResolveDnsName(target: string): string {
    const isIPv4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(target);
    const header =
      'Name                                           Type   TTL   Section    IPAddress\n' +
      '----                                           ----   ---   -------    ---------';
    let row: string;
    if (isIPv4) {
      const reversed = target.split('.').reverse().join('.');
      const ptrName = `${reversed}.in-addr.arpa`;
      const hostName = target === '127.0.0.1' ? 'localhost' : `host-${target.replace(/\./g, '-')}`;
      row =
        ptrName.padEnd(47) +
        'PTR    ' +
        '3600  ' +
        'Answer     ' +
        hostName;
    } else {
      const ip = target.toLowerCase() === 'localhost' ? '127.0.0.1' : '192.168.1.1';
      row =
        target.padEnd(47) +
        'A      ' +
        (target.toLowerCase() === 'localhost' ? '86400' : '3600 ') +
        ' Answer     ' +
        ip;
    }
    return `\n${header}\n${row}\n`;
  }
