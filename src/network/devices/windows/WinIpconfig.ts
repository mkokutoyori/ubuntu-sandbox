/**
 * Windows IPCONFIG command — IP configuration display and DHCP management.
 *
 * Supported:
 *   ipconfig                       — basic IP info per adapter
 *   ipconfig /all                  — detailed info (MAC, DHCP, lease, DNS)
 *   ipconfig /release [adapter]    — release DHCP lease
 *   ipconfig /renew [adapter]      — renew DHCP lease
 *   ipconfig /flushdns             — flush DNS resolver cache
 *   ipconfig /displaydns           — display DNS cache (stub)
 *   ipconfig /registerdns          — refresh DHCP leases and re-register DNS
 *   ipconfig /?                    — full usage help
 */

import type { WinCommandContext } from './WinCommandExecutor';

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

  if (lower.includes('/?') || lower.includes('/help') || lower.includes('-?')) {
    return IPCONFIG_HELP;
  }

  if (lower.includes('/release')) return ipconfigRelease(ctx, args);
  if (lower.includes('/renew')) return ipconfigRenew(ctx, args);
  if (lower.includes('/flushdns')) {
    return 'Windows IP Configuration\n\nSuccessfully flushed the DNS Resolver Cache.';
  }
  if (lower.includes('/displaydns')) {
    return 'Windows IP Configuration\n\n  Record Name . . . . . : (no entries)';
  }
  if (lower.includes('/registerdns')) {
    return 'Windows IP Configuration\n\nRegistration of the DNS resource records for all adapters of this computer\nhas been initiated. Any errors will be reported in the Event Viewer in 15 minutes.';
  }
  if (lower.includes('/all')) return ipconfigAll(ctx);

  return ipconfigBasic(ctx);
}

// ─── Basic output ─────────────────────────────────────────────────

function ipconfigBasic(ctx: WinCommandContext): string {
  const lines: string[] = ['Windows IP Configuration', ''];
  for (const [, port] of ctx.ports) {
    const ip = port.getIPAddress();
    const mask = port.getSubnetMask();
    const displayName = portDisplayName(port.getName());
    const isConnected = port.isConnected();

    lines.push(`Ethernet adapter ${displayName}:`, '');
    lines.push(`   Connection-specific DNS Suffix  . :`);

    if (!isConnected && !ip) {
      lines.push(`   Media State . . . . . . . . . . . : Media disconnected`);
    } else if (ip) {
      lines.push(`   IPv4 Address. . . . . . . . . . . : ${ip}`);
      lines.push(`   Subnet Mask . . . . . . . . . . . : ${mask || '255.255.255.0'}`);
      lines.push(`   Default Gateway . . . . . . . . . : ${ctx.defaultGateway || ''}`);
    } else {
      lines.push(`   Media State . . . . . . . . . . . : Media disconnected`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// ─── /all output ──────────────────────────────────────────────────

function ipconfigAll(ctx: WinCommandContext): string {
  const lines: string[] = [
    'Windows IP Configuration',
    '',
    `   Host Name . . . . . . . . . . . . : ${ctx.hostname}`,
    `   Primary Dns Suffix  . . . . . . . :`,
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
    const isConnected = port.isConnected();

    lines.push(`Ethernet adapter ${displayName}:`, '');

    if (!isConnected && !ip) {
      lines.push(`   Media State . . . . . . . . . . . : Media disconnected`);
      lines.push(`   Connection-specific DNS Suffix  . :`);
      lines.push(`   Description . . . . . . . . . . . : Intel(R) Ethernet Connection`);
      lines.push(`   Physical Address. . . . . . . . . : ${mac}`);
      lines.push(`   DHCP Enabled. . . . . . . . . . . : ${isDHCP ? 'Yes' : 'Yes'}`);
      lines.push(`   Autoconfiguration Enabled . . . . : Yes`);
    } else {
      lines.push(`   Connection-specific DNS Suffix  . :`);
      lines.push(`   Description . . . . . . . . . . . : Intel(R) Ethernet Connection`);
      lines.push(`   Physical Address. . . . . . . . . : ${mac}`);
      lines.push(`   DHCP Enabled. . . . . . . . . . . : ${isDHCP ? 'Yes' : 'No'}`);
      lines.push(`   Autoconfiguration Enabled . . . . : Yes`);

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

        lines.push(`   Default Gateway . . . . . . . . . : ${ctx.defaultGateway || ''}`);

        if (isDHCP) {
          const dhcpState = ctx.getDHCPState(name);
          if (dhcpState?.lease) {
            lines.push(`   DHCP Server . . . . . . . . . . . : ${dhcpState.lease.serverIdentifier}`);
            if (dhcpState.lease.dnsServers && dhcpState.lease.dnsServers.length > 0) {
              lines.push(`   DNS Servers . . . . . . . . . . . : ${dhcpState.lease.dnsServers.join(', ')}`);
            }
          }
        }

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

function ipconfigRenew(ctx: WinCommandContext, args: string[]): string {
  ctx.autoDiscoverDHCPServers();

  const lines: string[] = ['Windows IP Configuration', ''];

  const primaryIface = 'eth0';
  const displayName = portDisplayName(primaryIface);
  lines.push(`Ethernet adapter ${displayName}:`);
  lines.push(`   DHCP Discover - Broadcast on ${primaryIface}`);

  ctx.requestLease(primaryIface, { verbose: false });
  const state = ctx.getDHCPState(primaryIface);

  if (state?.lease) {
    ctx.addDHCPEvent('RENEW', `Renewed IP ${state.lease.ipAddress} on ${primaryIface}`);
    lines.push(`   DHCP Offer received from ${state.lease.serverIdentifier}`);
    lines.push(`   DHCP Request - Broadcast`);
    lines.push(`   DHCP ACK received`);
  }
  lines.push('');

  // Re-show ipconfig
  for (const [, port] of ctx.ports) {
    const ip = port.getIPAddress();
    const mask = port.getSubnetMask();
    const dn = portDisplayName(port.getName());
    lines.push(`Ethernet adapter ${dn}:`);
    lines.push(`   Connection-specific DNS Suffix  . :`);
    if (ip) {
      lines.push(`   IPv4 Address. . . . . . . . . . . : ${ip}`);
      lines.push(`   Subnet Mask . . . . . . . . . . . : ${mask || '255.255.255.0'}`);
      lines.push(`   Default Gateway . . . . . . . . . : ${ctx.defaultGateway || ''}`);
    } else {
      lines.push(`   Media State . . . . . . . . . . . : Media disconnected`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ─── Helpers ──────────────────────────────────────────────────────

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
