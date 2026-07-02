/**
 * Windows IPCONFIG command — IP configuration display and DHCP management.
 *
 * Supported:
 *   ipconfig                          — basic IP info per adapter
 *   ipconfig /all                     — detailed info (MAC, DHCP, lease, DNS)
 *   ipconfig /release [adapter]       — release DHCPv4 lease
 *   ipconfig /renew [adapter]         — renew DHCPv4 lease
 *   ipconfig /release6 [adapter]      — release dynamic (SLAAC/DHCPv6) IPv6
 *   ipconfig /renew6 [adapter]        — re-solicit the router for SLAAC
 *   ipconfig /flushdns                — flush DNS resolver cache
 *   ipconfig /displaydns              — display DNS cache
 *   ipconfig /registerdns             — refresh DHCP leases and re-register DNS
 *   ipconfig /showclassid adapter     — show the DHCPv4 vendor class id
 *   ipconfig /setclassid adapter [id] — set/clear the DHCPv4 vendor class id
 *   ipconfig /showclassid6 adapter    — show the DHCPv6 vendor class id
 *   ipconfig /setclassid6 adapter [id]— set/clear the DHCPv6 vendor class id
 *   ipconfig /allcompartments         — accepted, no-op (single compartment)
 *   ipconfig /?                       — full usage help
 *
 * Adapter arguments accept the same `*`/`?` wildcards as real ipconfig
 * (see `matchesAdapter`); omitting the adapter targets every interface.
 */

import type { WinCommandContext } from './WinCommandExecutor';
import { requireWindowsService } from './WinFeatureGate';
import { renderDisplayDns } from './WinDnsCache';

const IPCONFIG_HELP = `
USAGE:
    ipconfig [/allcompartments] [/? | /all |
                                 /renew [adapter] | /release [adapter] |
                                 /renew6 [adapter] | /release6 [adapter] |
                                 /flushdns | /displaydns | /registerdns |
                                 /showclassid adapter |
                                 /setclassid adapter [classid] |
                                 /showclassid6 adapter |
                                 /setclassid6 adapter [classid] ]

where
    adapter             Connection name
                       (wildcard characters * and ? allowed, see examples)

    Options:
       /?               Display this help message
       /all             Display full configuration information.
       /release         Release the IPv4 address for the specified adapter.
       /release6        Release the IPv6 address for the specified adapter.
       /renew           Renew the IPv4 address for the specified adapter.
       /renew6          Renew the IPv6 address for the specified adapter.
       /flushdns        Purges the DNS Resolver cache.
       /registerdns     Refreshes all DHCP leases and re-registers DNS names
       /displaydns      Display the contents of the DNS Resolver Cache.
       /showclassid     Displays all the dhcp class IDs allowed for adapter.
       /setclassid      Modifies the dhcp class id.
       /showclassid6    Displays all the IPv6 DHCP class IDs allowed for adapter.
       /setclassid6     Modifies the IPv6 DHCP class id.

The default is to display only the IP address, subnet mask and
default gateway for each adapter bound to TCP/IP.

For Release and Renew, if no adapter name is specified, then the IP address
leases for all adapters bound to TCP/IP will be released or renewed.

For Setclassid and Setclassid6, if no ClassId is specified, then the ClassId is removed.

Examples:
    > ipconfig                       ... Show information
    > ipconfig /all                  ... Show detailed information
    > ipconfig /renew                ... renew all adapters
    > ipconfig /renew EL*            ... renew any connection that has its
                                         name starting with EL
    > ipconfig /release *Con*        ... release all matching connections,
                                         eg. "Wired Ethernet Connection 1" or
                                             "Wired Ethernet Connection 2"
    > ipconfig /allcompartments      ... Show information about all
                                         compartments
    > ipconfig /allcompartments /all ... Show detailed information about all
                                         compartments`.trim();

export function cmdIpconfig(ctx: WinCommandContext, args: string[]): string {
  const lower = args.map(a => a.toLowerCase());
  // /allcompartments has no visible effect: this simulator, like a real
  // non-RRAS Windows host, only ever has a single (default) compartment.
  const rest = args.filter((_, i) => lower[i] !== '/allcompartments');
  const restLower = rest.map(a => a.toLowerCase());

  if (restLower.includes('/?') || restLower.includes('/help') || restLower.includes('-?')) {
    return IPCONFIG_HELP;
  }

  if (restLower.includes('/release6')) {
    const gate = requireWindowsService(ctx, 'Dhcp');
    return gate.ok ? ipconfigRelease6(ctx, rest) : gate.error;
  }
  if (restLower.includes('/renew6')) {
    const gate = requireWindowsService(ctx, 'Dhcp');
    return gate.ok ? ipconfigRenew6(ctx, rest) : gate.error;
  }
  if (restLower.includes('/release')) {
    const gate = requireWindowsService(ctx, 'Dhcp');
    return gate.ok ? ipconfigRelease(ctx, rest) : gate.error;
  }
  if (restLower.includes('/renew')) {
    const gate = requireWindowsService(ctx, 'Dhcp');
    return gate.ok ? ipconfigRenew(ctx, rest) : gate.error;
  }
  if (restLower.includes('/flushdns')) {
    ctx.dnsCache.flush();
    return 'Windows IP Configuration\n\nSuccessfully flushed the DNS Resolver Cache.';
  }
  if (restLower.includes('/displaydns')) {
    return renderDisplayDns(ctx.dnsCache);
  }
  if (restLower.includes('/registerdns')) {
    return 'Windows IP Configuration\n\nRegistration of the DNS resource records for all adapters of this computer\nhas been initiated. Any errors will be reported in the Event Viewer in 15 minutes.';
  }
  if (restLower.includes('/showclassid6')) return ipconfigShowClassId(ctx, rest, '/showclassid6', true);
  if (restLower.includes('/setclassid6')) return ipconfigSetClassId(ctx, rest, '/setclassid6', true);
  if (restLower.includes('/showclassid')) return ipconfigShowClassId(ctx, rest, '/showclassid', false);
  if (restLower.includes('/setclassid')) return ipconfigSetClassId(ctx, rest, '/setclassid', false);
  if (restLower.includes('/all')) return ipconfigAll(ctx);

  return ipconfigBasic(ctx);
}

// ─── Basic output ─────────────────────────────────────────────────

function ipconfigBasic(ctx: WinCommandContext): string {
  const suffix = ctx.getDnsSuffix();
  const lines: string[] = ['Windows IP Configuration', ''];
  for (const [, port] of ctx.ports) {
    const ip = port.getIPAddress();
    const mask = port.getSubnetMask();
    const displayName = portDisplayName(port.getName());
    const global6 = port.getGlobalIPv6();
    const linkLocal6 = port.getLinkLocalIPv6();
    const adapterUp = port.getIsUp() && (!!ip || !!global6 || !!linkLocal6);

    lines.push(`Ethernet adapter ${displayName}:`, '');
    lines.push(`   Connection-specific DNS Suffix  . : ${suffix}`);

    if (!adapterUp) {
      lines.push(`   Media State . . . . . . . . . . . : Media disconnected`);
    } else {
      if (global6) lines.push(`   IPv6 Address. . . . . . . . . . . : ${global6}`);
      if (linkLocal6) lines.push(`   Link-local IPv6 Address. . . . . . : ${linkLocal6}`);

      if (ip) {
        lines.push(`   IPv4 Address. . . . . . . . . . . : ${ip}`);
        lines.push(`   Subnet Mask . . . . . . . . . . . : ${mask || '255.255.255.0'}`);
      }
      pushDefaultGatewayLines(lines, ctx);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// ─── /all output ──────────────────────────────────────────────────

function ipconfigAll(ctx: WinCommandContext): string {
  const suffix = ctx.getDnsSuffix();
  const lines: string[] = [
    'Windows IP Configuration',
    '',
    `   Host Name . . . . . . . . . . . . : ${ctx.hostname}`,
    `   Primary Dns Suffix  . . . . . . . : ${suffix}`,
    `   Node Type . . . . . . . . . . . . : Hybrid`,
    `   IP Routing Enabled. . . . . . . . : No`,
    `   WINS Proxy Enabled. . . . . . . . : No`,
    '',
  ];

  for (const [name, port] of ctx.ports) {
    const ip = port.getIPAddress();
    const mask = port.getSubnetMask();
    const mac = port.getMAC().toString().replace(/:/g, '-').toUpperCase();
    const displayName = portDisplayName(name);
    const isDHCP = ctx.isDHCPConfigured(name);
    const global6 = port.getGlobalIPv6();
    const linkLocal6 = port.getLinkLocalIPv6();
    const adapterUp = port.getIsUp() && (!!ip || !!global6 || !!linkLocal6);

    lines.push(`Ethernet adapter ${displayName}:`, '');

    if (!adapterUp) {
      lines.push(`   Media State . . . . . . . . . . . : Media disconnected`);
      lines.push(`   Connection-specific DNS Suffix  . :`);
      lines.push(`   Description . . . . . . . . . . . : Intel(R) Ethernet Connection`);
      lines.push(`   Physical Address. . . . . . . . . : ${mac}`);
      lines.push(`   DHCP Enabled. . . . . . . . . . . : ${isDHCP ? 'Yes' : 'No'}`);
      lines.push(`   Autoconfiguration Enabled . . . . : Yes`);
    } else {
      lines.push(`   Connection-specific DNS Suffix  . :`);
      lines.push(`   Description . . . . . . . . . . . : Intel(R) Ethernet Connection`);
      lines.push(`   Physical Address. . . . . . . . . : ${mac}`);
      lines.push(`   DHCP Enabled. . . . . . . . . . . : ${isDHCP ? 'Yes' : 'No'}`);
      lines.push(`   Autoconfiguration Enabled . . . . : Yes`);

      if (global6) lines.push(`   IPv6 Address. . . . . . . . . . . : ${global6}(Preferred)`);
      if (linkLocal6) lines.push(`   Link-local IPv6 Address. . . . . . : ${linkLocal6}(Preferred)`);

      if (ip) {
        lines.push(`   IPv4 Address. . . . . . . . . . . : ${ip}(Preferred)`);
        lines.push(`   Subnet Mask . . . . . . . . . . . : ${mask || '255.255.255.0'}`);

        if (isDHCP) {
          const dhcpState = ctx.getDHCPState(name);
          if (dhcpState?.lease) {
            const lease = dhcpState.lease;
            lines.push(`   Lease Obtained. . . . . . . . . . : ${formatWindowsDate(lease.leaseStart)}`);
            lines.push(`   Lease Expires . . . . . . . . . . : ${formatWindowsDate(lease.expiration)}`);
          }
        }

        pushDefaultGatewayLines(lines, ctx);

        if (isDHCP) {
          const dhcpState = ctx.getDHCPState(name);
          if (dhcpState?.lease) {
            lines.push(`   DHCP Server . . . . . . . . . . . : ${dhcpState.lease.serverIdentifier}`);
            if (dhcpState.lease.dnsServers && dhcpState.lease.dnsServers.length > 0) {
              lines.push(`   DNS Servers . . . . . . . . . . . : ${dhcpState.lease.dnsServers[0]}`);
              for (let di = 1; di < dhcpState.lease.dnsServers.length; di++) {
                lines.push(`                                         ${dhcpState.lease.dnsServers[di]}`);
              }
            }
          }
        } else {
          // Static DNS servers configured via netsh
          const staticDns = ctx.getDnsServers(name);
          if (staticDns.length > 0) {
            lines.push(`   DNS Servers . . . . . . . . . . . : ${staticDns[0]}`);
            for (let di = 1; di < staticDns.length; di++) {
              lines.push(`                                         ${staticDns[di]}`);
            }
          }
        }

        lines.push(`   NetBIOS over Tcpip. . . . . . . . : Enabled`);
      } else if (global6 || linkLocal6) {
        pushDefaultGatewayLines(lines, ctx);
        lines.push(`   NetBIOS over Tcpip. . . . . . . . : Enabled`);
      } else {
        lines.push(`   Media State . . . . . . . . . . . : Media disconnected`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

// ─── /release ─────────────────────────────────────────────────────

function ipconfigRelease(ctx: WinCommandContext, args: string[]): string {
  const lines: string[] = ['Windows IP Configuration', ''];
  const adapterFilter = parseAdapterArg(args, '/release');

  let released = false;
  for (const [name, port] of ctx.ports) {
    const displayName = portDisplayName(name);
    if (adapterFilter && !matchesAdapter(displayName, name, adapterFilter)) continue;

    const state = ctx.getDHCPState(name);
    if (state?.lease) {
      const oldIP = state.lease.ipAddress;
      ctx.releaseLease(name);
      ctx.addDHCPEvent('RELEASE', `Released IP ${oldIP} on ${name}`);
      released = true;
    }
    if (state) state.state = 'INIT';
  }

  if (adapterFilter && !released) {
    lines.push(`No adapter matched "${adapterFilter}".`);
    return lines.join('\n');
  }

  lines.push(adapterFilter
    ? `Adapter "${adapterFilter}" has been successfully released.`
    : 'All adapters have been successfully released.');
  lines.push('');

  for (const [name, port] of ctx.ports) {
    const displayName = portDisplayName(name);
    if (adapterFilter && !matchesAdapter(displayName, name, adapterFilter)) continue;

    lines.push(`Ethernet adapter ${displayName}:`);
    lines.push(`   Connection-specific DNS Suffix  . :`);
    const ip = port.getIPAddress();
    if (ip) {
      lines.push(`   IPv4 Address. . . . . . . . . . . : ${ip}`);
      lines.push(`   Subnet Mask . . . . . . . . . . . : ${port.getSubnetMask() || '255.255.255.0'}`);
      lines.push(`   Default Gateway . . . . . . . . . : ${ctx.defaultGateway || ''}`);
    } else {
      lines.push(`   Media State . . . . . . . . . . . : Media disconnected`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ─── /renew ───────────────────────────────────────────────────────

function matchingPortNames(ctx: WinCommandContext, adapterFilter: string | null): string[] {
  const out: string[] = [];
  for (const [name] of ctx.ports) {
    const displayName = portDisplayName(name);
    if (adapterFilter && !matchesAdapter(displayName, name, adapterFilter)) continue;
    out.push(name);
  }
  return out;
}

function ipconfigRenew(ctx: WinCommandContext, args: string[]): string {
  const adapterFilter = parseAdapterArg(args, '/renew');
  // Without an explicit adapter, this simulator treats the primary
  // interface (eth0) as "all adapters bound to TCP/IP" — an explicit
  // name/wildcard targets exactly the matching adapter(s) instead.
  const targets = adapterFilter ? matchingPortNames(ctx, adapterFilter) : ['eth0'].filter(n => ctx.ports.has(n));

  if (adapterFilter && targets.length === 0) {
    return `Windows IP Configuration\n\nNo adapter matched "${adapterFilter}".`;
  }

  ctx.autoDiscoverDHCPServers();

  const lines: string[] = ['Windows IP Configuration', ''];

  for (const name of targets) {
    const displayName = portDisplayName(name);
    lines.push(`Ethernet adapter ${displayName}:`);
    lines.push(`   DHCP Discover - Broadcast on ${name}`);

    ctx.requestLease(name, { verbose: false });
    const state = ctx.getDHCPState(name);

    if (state?.lease && state.lease.serverIdentifier === '0.0.0.0') {
      // RFC 3927 APIPA fallback — no DHCP server ever answered.
      lines.push(`   No DHCP server was found, using autoconfiguration IP address ${state.lease.ipAddress}`);
    } else if (state?.lease) {
      ctx.addDHCPEvent('RENEW', `Renewed IP ${state.lease.ipAddress} on ${name}`);
      lines.push(`   DHCP Offer received from ${state.lease.serverIdentifier}`);
      lines.push(`   DHCP Request - Broadcast`);
      lines.push(`   DHCP ACK received`);
    }
    lines.push('');
  }

  // Re-show ipconfig for every matched adapter (real ipconfig re-displays
  // the whole adapter it just touched, IPv6 included).
  for (const name of targets) {
    const port = ctx.ports.get(name)!;
    const ip = port.getIPAddress();
    const mask = port.getSubnetMask();
    const dn = portDisplayName(name);
    const global6 = port.getGlobalIPv6();
    const linkLocal6 = port.getLinkLocalIPv6();
    lines.push(`Ethernet adapter ${dn}:`);
    lines.push(`   Connection-specific DNS Suffix  . :`);
    if (global6) lines.push(`   IPv6 Address. . . . . . . . . . . : ${global6}`);
    if (linkLocal6) lines.push(`   Link-local IPv6 Address. . . . . . : ${linkLocal6}`);
    if (ip) {
      lines.push(`   IPv4 Address. . . . . . . . . . . : ${ip}`);
      lines.push(`   Subnet Mask . . . . . . . . . . . : ${mask || '255.255.255.0'}`);
      pushDefaultGatewayLines(lines, ctx);
    } else if (!global6 && !linkLocal6) {
      lines.push(`   Media State . . . . . . . . . . . : Media disconnected`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ─── /release6 and /renew6 ──────────────────────────────────────────

function ipconfigRelease6(ctx: WinCommandContext, args: string[]): string {
  const adapterFilter = parseAdapterArg(args, '/release6');
  const targets = matchingPortNames(ctx, adapterFilter);

  if (adapterFilter && targets.length === 0) {
    return `Windows IP Configuration\n\nNo adapter matched "${adapterFilter}".`;
  }

  const lines: string[] = ['Windows IP Configuration', ''];
  for (const name of targets) {
    const port = ctx.ports.get(name)!;
    const released = port.releaseDynamicIPv6Addresses();
    if (released.length > 0) {
      ctx.addDHCPEvent('RELEASE', `Released IPv6 address(es) ${released.map(e => e.address.toString()).join(', ')} on ${name}`);
    }
  }

  lines.push(adapterFilter
    ? `Adapter "${adapterFilter}" has been successfully released.`
    : 'All adapters have been successfully released.');
  return lines.join('\n');
}

function ipconfigRenew6(ctx: WinCommandContext, args: string[]): string {
  const adapterFilter = parseAdapterArg(args, '/renew6');
  const targets = matchingPortNames(ctx, adapterFilter);

  if (adapterFilter && targets.length === 0) {
    return `Windows IP Configuration\n\nNo adapter matched "${adapterFilter}".`;
  }

  const lines: string[] = ['Windows IP Configuration', ''];
  for (const name of targets) {
    const displayName = portDisplayName(name);
    lines.push(`Ethernet adapter ${displayName}:`);
    lines.push(`   Router Solicitation sent on ${name}`);
    ctx.sendRouterSolicitation(name);
    const port = ctx.ports.get(name)!;
    const global6 = port.getGlobalIPv6();
    if (global6) lines.push(`   Router Advertisement received, SLAAC address ${global6} configured`);
    lines.push('');
  }
  return lines.join('\n');
}

// ─── /showclassid and /setclassid ────────────────────────────────────

function ipconfigShowClassId(ctx: WinCommandContext, args: string[], switchName: string, isV6: boolean): string {
  const adapterFilter = parseAdapterArg(args, switchName);
  const lines: string[] = ['Windows IP Configuration', ''];
  const targets = adapterFilter ? matchingPortNames(ctx, adapterFilter) : [...ctx.ports.keys()];

  if (adapterFilter && targets.length === 0) {
    lines.push(`No adapter matched "${adapterFilter}".`);
    return lines.join('\n');
  }

  for (const name of targets) {
    const displayName = portDisplayName(name);
    const classId = isV6 ? ctx.getClassId6(name) : ctx.getClassId(name);
    lines.push(`Ethernet adapter ${displayName}:`, '');
    lines.push(classId
      ? `   DHCP Class ID . . . . . . . . . . : ${classId}`
      : `   no class id currently set`);
    lines.push('');
  }
  return lines.join('\n');
}

function ipconfigSetClassId(ctx: WinCommandContext, args: string[], switchName: string, isV6: boolean): string {
  const switchIdx = args.findIndex(a => a.toLowerCase() === switchName.toLowerCase());
  const rest = args.slice(switchIdx + 1).filter(a => !a.startsWith('/'));
  if (rest.length === 0) {
    return `Usage: ipconfig ${switchName} adapter [classid]`;
  }
  const adapterArg = rest[0].replace(/^["']|["']$/g, '');
  const classId = rest.length > 1 ? rest.slice(1).join(' ').replace(/^["']|["']$/g, '') : null;

  const targets = matchingPortNames(ctx, adapterArg);
  if (targets.length === 0) {
    return `Windows IP Configuration\n\nNo adapter matched "${adapterArg}".`;
  }

  for (const name of targets) {
    if (isV6) ctx.setClassId6(name, classId);
    else ctx.setClassId(name, classId);
  }

  return `Windows IP Configuration\n\nDHCP ClassId successfully set on adapter "${adapterArg}".`;
}

// ─── Helpers ──────────────────────────────────────────────────────

/** Real ipconfig lists the IPv6 gateway first, the IPv4 one on a continuation line. */
function pushDefaultGatewayLines(lines: string[], ctx: WinCommandContext): void {
  if (ctx.defaultGateway6) {
    lines.push(`   Default Gateway . . . . . . . . . : ${ctx.defaultGateway6}`);
    if (ctx.defaultGateway) lines.push(`                                       ${ctx.defaultGateway}`);
    return;
  }
  lines.push(`   Default Gateway . . . . . . . . . : ${ctx.defaultGateway ?? ''}`);
}

function portDisplayName(portName: string): string {
  return portName.replace(/^eth/, 'Ethernet ');
}

function parseAdapterArg(args: string[], switchName: string): string | null {
  const switchIdx = args.findIndex(a => a.toLowerCase() === switchName.toLowerCase());
  if (switchIdx === -1) return null;
  const remaining = args.slice(switchIdx + 1).filter(a => !a.startsWith('/'));
  if (remaining.length === 0) return null;
  return remaining.join(' ').replace(/^["']|["']$/g, '');
}

function matchesAdapter(displayName: string, portName: string, filter: string): boolean {
  const pattern = filter.replace(/\*/g, '.*').replace(/\?/g, '.');
  const regex = new RegExp(`^${pattern}$`, 'i');
  return regex.test(displayName) || regex.test(portName);
}

function formatWindowsDate(ts: number): string {
  const d = new Date(ts);
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  const day = days[d.getDay()];
  const month = months[d.getMonth()];
  const date = d.getDate();
  const year = d.getFullYear();
  const hours = d.getHours();
  const minutes = d.getMinutes().toString().padStart(2, '0');
  const seconds = d.getSeconds().toString().padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  const h12 = hours % 12 || 12;
  return `${day}, ${month} ${date}, ${year} ${h12}:${minutes}:${seconds} ${ampm}`;
}
