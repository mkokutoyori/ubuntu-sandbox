import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { toDisplayName } from '@/network/devices/windows/WindowsInterfaceNaming';
import type { WindowsAdapterInfo, WindowsDnsCacheEntry, WindowsNetConfigApi } from '@/command-kernel/machine/types';

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

const DHCP_STOPPED_ERROR = 'An error occurred while renewing interface : The DHCP Client Service is not running.';

const DNS_TYPE_NUM: Record<string, number> = {
  A: 1, NS: 2, CNAME: 5, SOA: 6, PTR: 12, MX: 15, TXT: 16, AAAA: 28,
};

function portDisplayName(portName: string): string {
  return toDisplayName(portName);
}

function matchesAdapter(displayName: string, portName: string, filter: string): boolean {
  const pattern = filter.replace(/\*/g, '.*').replace(/\?/g, '.');
  const regex = new RegExp(`^${pattern}$`, 'i');
  return regex.test(displayName) || regex.test(portName);
}

function parseAdapterArg(args: string[], switchName: string): string | null {
  const switchIdx = args.findIndex((a) => a.toLowerCase() === switchName.toLowerCase());
  if (switchIdx === -1) return null;
  const remaining = args.slice(switchIdx + 1).filter((a) => !a.startsWith('/'));
  if (remaining.length === 0) return null;
  return remaining.join(' ').replace(/^["']|["']$/g, '');
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

export class IpconfigCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'ipconfig',
    summary: 'Affiche et gère la configuration IP',
    usage: IPCONFIG_HELP,
    args: [{ name: 'targets', type: 'string', required: false, variadic: true, description: 'options ipconfig' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'réseau',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const rawArgs = ctx.args.has('targets') ? ctx.args.get<string[]>('targets') : [];
    if (!ctx.machine.netConfig) {
      await ctx.io.stdout.write('IPCONFIG: not supported on this device\n');
      return 1;
    }
    const netConfig = ctx.machine.netConfig;

    const lower = rawArgs.map((a) => a.toLowerCase());
    // /allcompartments has no visible effect: this simulator, like a real
    // non-RRAS Windows host, only ever has a single (default) compartment.
    const rest = rawArgs.filter((_, i) => lower[i] !== '/allcompartments');
    const restLower = rest.map((a) => a.toLowerCase());

    let out: string;
    if (restLower.includes('/?') || restLower.includes('/help') || restLower.includes('-?')) {
      out = IPCONFIG_HELP;
    } else if (restLower.includes('/release6')) {
      out = ctx.machine.services?.isRunning('Dhcp') ? this.ipconfigRelease6(netConfig, rest) : DHCP_STOPPED_ERROR;
    } else if (restLower.includes('/renew6')) {
      out = ctx.machine.services?.isRunning('Dhcp') ? this.ipconfigRenew6(netConfig, rest) : DHCP_STOPPED_ERROR;
    } else if (restLower.includes('/release')) {
      out = ctx.machine.services?.isRunning('Dhcp') ? this.ipconfigRelease(netConfig, rest) : DHCP_STOPPED_ERROR;
    } else if (restLower.includes('/renew')) {
      out = ctx.machine.services?.isRunning('Dhcp') ? this.ipconfigRenew(netConfig, rest) : DHCP_STOPPED_ERROR;
    } else if (restLower.includes('/flushdns')) {
      netConfig.flushDnsCache();
      out = 'Windows IP Configuration\n\nSuccessfully flushed the DNS Resolver Cache.';
    } else if (restLower.includes('/displaydns')) {
      out = this.renderDisplayDns(netConfig.dnsCacheEntries());
    } else if (restLower.includes('/registerdns')) {
      out = 'Windows IP Configuration\n\nRegistration of the DNS resource records for all adapters of this computer\nhas been initiated. Any errors will be reported in the Event Viewer in 15 minutes.';
    } else if (restLower.includes('/showclassid6')) {
      out = this.ipconfigShowClassId(netConfig, rest, '/showclassid6', true);
    } else if (restLower.includes('/setclassid6')) {
      out = this.ipconfigSetClassId(netConfig, rest, '/setclassid6', true);
    } else if (restLower.includes('/showclassid')) {
      out = this.ipconfigShowClassId(netConfig, rest, '/showclassid', false);
    } else if (restLower.includes('/setclassid')) {
      out = this.ipconfigSetClassId(netConfig, rest, '/setclassid', false);
    } else if (restLower.includes('/all')) {
      out = this.ipconfigAll(ctx, netConfig);
    } else {
      out = this.ipconfigBasic(netConfig);
    }

    await ctx.io.stdout.write(out + '\n');
    return EXIT_OK;
  }

  private matchingPortNames(netConfig: WindowsNetConfigApi, adapterFilter: string | null): string[] {
    const out: string[] = [];
    for (const a of netConfig.adapters()) {
      const displayName = portDisplayName(a.name);
      if (adapterFilter && !matchesAdapter(displayName, a.name, adapterFilter)) continue;
      out.push(a.name);
    }
    return out;
  }

  private pushDefaultGatewayLines(lines: string[], netConfig: WindowsNetConfigApi): void {
    const gw6 = netConfig.defaultGateway6();
    const gw4 = netConfig.defaultGateway();
    if (gw6) {
      lines.push(`   Default Gateway . . . . . . . . . : ${gw6}`);
      if (gw4) lines.push(`                                       ${gw4}`);
      return;
    }
    lines.push(`   Default Gateway . . . . . . . . . : ${gw4 ?? ''}`);
  }

  private ipconfigBasic(netConfig: WindowsNetConfigApi): string {
    const lines: string[] = ['Windows IP Configuration', ''];
    for (const a of netConfig.adapters()) {
      const displayName = portDisplayName(a.name);
      const hasAddress = !!a.ip || !!a.globalIPv6 || !!a.linkLocalIPv6;
      const adapterUp = a.isUp && !a.isAdminDown && (a.isConnected || hasAddress);

      lines.push(`Ethernet adapter ${displayName}:`, '');
      lines.push(`   Connection-specific DNS Suffix  . : ${a.connectionDnsSuffix}`);

      if (!adapterUp) {
        lines.push(`   Media State . . . . . . . . . . . : Media disconnected`);
      } else {
        if (a.globalIPv6) lines.push(`   IPv6 Address. . . . . . . . . . . : ${a.globalIPv6}`);
        if (a.linkLocalIPv6) lines.push(`   Link-local IPv6 Address. . . . . . : ${a.linkLocalIPv6}`);

        if (a.ip) {
          lines.push(`   IPv4 Address. . . . . . . . . . . : ${a.ip}`);
          lines.push(`   Subnet Mask . . . . . . . . . . . : ${a.mask || '255.255.255.0'}`);
        }
        this.pushDefaultGatewayLines(lines, netConfig);
      }
      lines.push('');
    }
    return lines.join('\n');
  }

  private ipconfigAll(ctx: CommandContext, netConfig: WindowsNetConfigApi): string {
    const suffix = netConfig.primaryDnsSuffix();
    const lines: string[] = [
      'Windows IP Configuration',
      '',
      `   Host Name . . . . . . . . . . . . : ${ctx.machine.hostname}`,
      `   Primary Dns Suffix  . . . . . . . : ${suffix}`,
      `   Node Type . . . . . . . . . . . . : Hybrid`,
      `   IP Routing Enabled. . . . . . . . : No`,
      `   WINS Proxy Enabled. . . . . . . . : No`,
      '',
    ];

    for (const a of netConfig.adapters()) {
      const mac = a.mac.replace(/:/g, '-').toUpperCase();
      const displayName = portDisplayName(a.name);
      const hasAddress = !!a.ip || !!a.globalIPv6 || !!a.linkLocalIPv6;
      const adapterUp = a.isUp && !a.isAdminDown && (a.isConnected || hasAddress);

      lines.push(`Ethernet adapter ${displayName}:`, '');

      if (!adapterUp) {
        lines.push(`   Media State . . . . . . . . . . . : Media disconnected`);
        lines.push(`   Connection-specific DNS Suffix  . :`);
        lines.push(`   Description . . . . . . . . . . . : Intel(R) Ethernet Connection`);
        lines.push(`   Physical Address. . . . . . . . . : ${mac}`);
        lines.push(`   DHCP Enabled. . . . . . . . . . . : ${a.isDhcp ? 'Yes' : 'No'}`);
        lines.push(`   Autoconfiguration Enabled . . . . : Yes`);
      } else {
        lines.push(`   Connection-specific DNS Suffix  . : ${a.connectionDnsSuffix}`.trimEnd());
        lines.push(`   Description . . . . . . . . . . . : Intel(R) Ethernet Connection`);
        lines.push(`   Physical Address. . . . . . . . . : ${mac}`);
        lines.push(`   DHCP Enabled. . . . . . . . . . . : ${a.isDhcp ? 'Yes' : 'No'}`);
        lines.push(`   Autoconfiguration Enabled . . . . : Yes`);

        if (a.globalIPv6) lines.push(`   IPv6 Address. . . . . . . . . . . : ${a.globalIPv6}(Preferred)`);
        if (a.linkLocalIPv6) lines.push(`   Link-local IPv6 Address. . . . . . : ${a.linkLocalIPv6}(Preferred)`);

        if (a.ip) {
          lines.push(`   IPv4 Address. . . . . . . . . . . : ${a.ip}(Preferred)`);
          lines.push(`   Subnet Mask . . . . . . . . . . . : ${a.mask || '255.255.255.0'}`);

          const lease = a.isDhcp ? netConfig.dhcpLease(a.name) : null;
          if (lease) {
            lines.push(`   Lease Obtained. . . . . . . . . . : ${formatWindowsDate(lease.leaseStartMs)}`);
            lines.push(`   Lease Expires . . . . . . . . . . : ${formatWindowsDate(lease.expirationMs)}`);
          }

          this.pushDefaultGatewayLines(lines, netConfig);

          if (lease) {
            lines.push(`   DHCP Server . . . . . . . . . . . : ${lease.serverIdentifier}`);
            if (lease.dnsServers.length > 0) {
              lines.push(`   DNS Servers . . . . . . . . . . . : ${lease.dnsServers[0]}`);
              for (let di = 1; di < lease.dnsServers.length; di++) {
                lines.push(`                                         ${lease.dnsServers[di]}`);
              }
            }
          } else if (!a.isDhcp) {
            const staticDns = netConfig.staticDnsServers(a.name);
            if (staticDns.length > 0) {
              lines.push(`   DNS Servers . . . . . . . . . . . : ${staticDns[0]}`);
              for (let di = 1; di < staticDns.length; di++) {
                lines.push(`                                         ${staticDns[di]}`);
              }
            }
          }

          lines.push(`   NetBIOS over Tcpip. . . . . . . . : Enabled`);
        } else if (a.globalIPv6 || a.linkLocalIPv6) {
          this.pushDefaultGatewayLines(lines, netConfig);
          lines.push(`   NetBIOS over Tcpip. . . . . . . . : Enabled`);
        }
      }
      lines.push('');
    }
    return lines.join('\n');
  }

  private ipconfigRelease(netConfig: WindowsNetConfigApi, args: string[]): string {
    const lines: string[] = ['Windows IP Configuration', ''];
    const adapterFilter = parseAdapterArg(args, '/release');

    let released = false;
    for (const a of netConfig.adapters()) {
      const displayName = portDisplayName(a.name);
      if (adapterFilter && !matchesAdapter(displayName, a.name, adapterFilter)) continue;

      if (netConfig.dhcpLease(a.name)) released = true;
      netConfig.releaseLease(a.name);
    }

    if (adapterFilter && !released) {
      lines.push(`No adapter matched "${adapterFilter}".`);
      return lines.join('\n');
    }

    lines.push(adapterFilter
      ? `Adapter "${adapterFilter}" has been successfully released.`
      : 'All adapters have been successfully released.');
    lines.push('');

    for (const a of netConfig.adapters()) {
      const displayName = portDisplayName(a.name);
      if (adapterFilter && !matchesAdapter(displayName, a.name, adapterFilter)) continue;

      lines.push(`Ethernet adapter ${displayName}:`);
      lines.push(`   Connection-specific DNS Suffix  . :`);
      const adapterUp = a.isUp && !a.isAdminDown && a.isConnected;
      if (a.ip) {
        lines.push(`   IPv4 Address. . . . . . . . . . . : ${a.ip}`);
        lines.push(`   Subnet Mask . . . . . . . . . . . : ${a.mask || '255.255.255.0'}`);
        lines.push(`   Default Gateway . . . . . . . . . : ${netConfig.defaultGateway() || ''}`);
      } else if (!adapterUp) {
        lines.push(`   Media State . . . . . . . . . . . : Media disconnected`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  private ipconfigRenew(netConfig: WindowsNetConfigApi, args: string[]): string {
    const adapterFilter = parseAdapterArg(args, '/renew');
    // Without an explicit adapter, this simulator treats the primary
    // interface (eth0) as "all adapters bound to TCP/IP" — an explicit
    // name/wildcard targets exactly the matching adapter(s) instead.
    const targets = adapterFilter
      ? this.matchingPortNames(netConfig, adapterFilter)
      : netConfig.adapters().filter((a) => a.name === 'eth0').map((a) => a.name);

    if (adapterFilter && targets.length === 0) {
      return `Windows IP Configuration\n\nNo adapter matched "${adapterFilter}".`;
    }

    netConfig.autoDiscoverDhcpServers();

    const lines: string[] = ['Windows IP Configuration', ''];
    const failed = new Set<string>();

    for (const name of targets) {
      const displayName = portDisplayName(name);
      netConfig.requestLease(name);
      const lease = netConfig.dhcpLease(name);

      if (lease && lease.serverIdentifier === '0.0.0.0') {
        lines.push(`Ethernet adapter ${displayName}:`, '');
        lines.push(`   No DHCP server was found, using autoconfiguration IP address ${lease.ipAddress}`, '');
      } else if (lease) {
        lines.push(`Ethernet adapter ${displayName}:`, '');
        lines.push(`   DHCP Offer received from ${lease.serverIdentifier}`);
        lines.push(`   DHCP Request - Broadcast`);
        lines.push(`   DHCP ACK received`, '');
      } else {
        failed.add(name);
        lines.push(`An error occurred while renewing interface ${displayName} : unable to contact your DHCP server. Request has timed out.`, '');
      }
    }

    // Re-show ipconfig for every matched adapter that still has addressing
    // (real ipconfig re-displays the whole adapter it just touched, IPv6
    // included); a hard-failure adapter already got its error line above.
    for (const name of targets) {
      if (failed.has(name)) continue;
      const a = netConfig.adapters().find((x) => x.name === name);
      if (!a) continue;
      const dn = portDisplayName(name);
      lines.push(`Ethernet adapter ${dn}:`);
      lines.push(`   Connection-specific DNS Suffix  . : ${a.connectionDnsSuffix}`.trimEnd());
      if (a.globalIPv6) lines.push(`   IPv6 Address. . . . . . . . . . . : ${a.globalIPv6}`);
      if (a.linkLocalIPv6) lines.push(`   Link-local IPv6 Address. . . . . . : ${a.linkLocalIPv6}`);
      if (a.ip) {
        lines.push(`   IPv4 Address. . . . . . . . . . . : ${a.ip}`);
        lines.push(`   Subnet Mask . . . . . . . . . . . : ${a.mask || '255.255.255.0'}`);
        this.pushDefaultGatewayLines(lines, netConfig);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  private ipconfigRelease6(netConfig: WindowsNetConfigApi, args: string[]): string {
    const adapterFilter = parseAdapterArg(args, '/release6');
    const targets = this.matchingPortNames(netConfig, adapterFilter);

    if (adapterFilter && targets.length === 0) {
      return `Windows IP Configuration\n\nNo adapter matched "${adapterFilter}".`;
    }

    for (const name of targets) {
      netConfig.releaseDynamicIPv6(name);
    }

    return adapterFilter
      ? `Windows IP Configuration\n\nAdapter "${adapterFilter}" has been successfully released.`
      : 'Windows IP Configuration\n\nAll adapters have been successfully released.';
  }

  private ipconfigRenew6(netConfig: WindowsNetConfigApi, args: string[]): string {
    const adapterFilter = parseAdapterArg(args, '/renew6');
    const targets = this.matchingPortNames(netConfig, adapterFilter);

    if (adapterFilter && targets.length === 0) {
      return `Windows IP Configuration\n\nNo adapter matched "${adapterFilter}".`;
    }

    const lines: string[] = ['Windows IP Configuration', ''];
    for (const name of targets) {
      const displayName = portDisplayName(name);
      netConfig.sendRouterSolicitation(name);
      const a: WindowsAdapterInfo | undefined = netConfig.adapters().find((x) => x.name === name);
      lines.push(`Ethernet adapter ${displayName}:`);
      lines.push(`   Connection-specific DNS Suffix  . : ${a?.connectionDnsSuffix ?? ''}`.trimEnd());
      if (a?.globalIPv6) lines.push(`   IPv6 Address. . . . . . . . . . . : ${a.globalIPv6}`);
      lines.push('');
    }
    return lines.join('\n');
  }

  private ipconfigShowClassId(netConfig: WindowsNetConfigApi, args: string[], switchName: string, isV6: boolean): string {
    const adapterFilter = parseAdapterArg(args, switchName);
    const lines: string[] = ['Windows IP Configuration', ''];
    const targets = adapterFilter ? this.matchingPortNames(netConfig, adapterFilter) : netConfig.adapters().map((a) => a.name);

    if (adapterFilter && targets.length === 0) {
      lines.push(`No adapter matched "${adapterFilter}".`);
      return lines.join('\n');
    }

    for (const name of targets) {
      const displayName = portDisplayName(name);
      const classId = netConfig.classId(name, isV6);
      lines.push(`Ethernet adapter ${displayName}:`, '');
      lines.push(classId
        ? `   DHCP Class ID . . . . . . . . . . : ${classId}`
        : `   no class id currently set`);
      lines.push('');
    }
    return lines.join('\n');
  }

  private ipconfigSetClassId(netConfig: WindowsNetConfigApi, args: string[], switchName: string, isV6: boolean): string {
    const switchIdx = args.findIndex((a) => a.toLowerCase() === switchName.toLowerCase());
    const rest = args.slice(switchIdx + 1).filter((a) => !a.startsWith('/'));
    if (rest.length === 0) {
      return `Usage: ipconfig ${switchName} adapter [classid]`;
    }
    const adapterArg = rest[0].replace(/^["']|["']$/g, '');
    const classId = rest.length > 1 ? rest.slice(1).join(' ').replace(/^["']|["']$/g, '') : null;

    const targets = this.matchingPortNames(netConfig, adapterArg);
    if (targets.length === 0) {
      return `Windows IP Configuration\n\nNo adapter matched "${adapterArg}".`;
    }

    for (const name of targets) {
      netConfig.setClassId(name, isV6, classId);
    }

    return `Windows IP Configuration\n\nDHCP ClassId successfully set on adapter "${adapterArg}".`;
  }

  private renderDisplayDns(entries: readonly WindowsDnsCacheEntry[]): string {
    if (entries.length === 0) {
      return 'Windows IP Configuration\n\n  Record Name . . . . . : (no entries)';
    }
    const out: string[] = ['Windows IP Configuration\n'];
    for (const r of entries) {
      out.push(`    ${r.name}`);
      out.push(`    ----------------------------------------`);
      out.push(`    Record Name . . . . . : ${r.name}`);
      out.push(`    Record Type . . . . . : ${DNS_TYPE_NUM[r.type.toUpperCase()] ?? 0}`);
      out.push(`    Time To Live  . . . . : ${r.ttlRemainingSec}`);
      out.push(`    Data Length . . . . . : ${r.value.length}`);
      out.push(`    Section . . . . . . . : Answer`);
      const valueLabel = (r.type === 'A' || r.type === 'AAAA') ? 'Record' : 'Data';
      out.push(`    ${r.type} (Host) ${valueLabel}  . . . : ${r.value}`);
      out.push('');
    }
    return out.join('\n').trimEnd();
  }
}
