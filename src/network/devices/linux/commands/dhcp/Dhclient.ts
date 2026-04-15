/**
 * `dhclient` — ISC DHCP client.
 *
 * Supports:
 *   dhclient <iface>                — request a lease
 *   dhclient -v|-d|-w|-t N <iface>  — verbose / daemon / wait / timeout
 *   dhclient -s <ip> <iface>        — target a specific server
 *   dhclient -r [<iface>]           — release lease(s)
 *   dhclient -x [<iface>]           — stop dhclient process(es)
 *
 * Drives the real DHCP client of the underlying `EndHost` through
 * `ctx.net.getDhcpClient()` + `ctx.net.autoDiscoverDHCPServers()`.
 *
 * Extracted from `LinuxPC.cmdDhclient`. See `linux_gap.md` §8.4 (PR 9).
 */

import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';

export const dhclientCommand: LinuxCommand = {
  name: 'dhclient',
  needsNetworkContext: true,
  manSection: 8,
  usage: 'dhclient [-v] [-d] [-r] [-x] [-s server] [-w] [-t timeout] <interface>',
  help:
    'Dynamic Host Configuration Protocol Client.\n\n' +
    'Requests an IP address lease from a DHCP server for the specified\n' +
    'network interface.\n\n' +
    'OPTIONS\n' +
    '  -v            Enable verbose log messages.\n' +
    '  -d            Run in daemon mode.\n' +
    '  -r            Release the current lease.\n' +
    '  -x            Stop the running dhclient process.\n' +
    '  -s server     Send requests to a specific DHCP server.\n' +
    '  -w            Wait for a lease to be acquired.\n' +
    '  -t timeout    Timeout for the lease request in seconds.',

  run(ctx: LinuxCommandContext, args: string[]): string {
    let verbose = false;
    let daemon = false;
    let release = false;
    let exit = false;
    let wait = false;
    let hasTimeout = false;
    let timeout = 30;
    let specificServer: string | null = null;
    let iface = '';

    for (let i = 0; i < args.length; i++) {
      switch (args[i]) {
        case '-v': verbose = true; break;
        case '-d': daemon = true; break;
        case '-r': release = true; break;
        case '-x': exit = true; break;
        case '-w': wait = true; break;
        case '-s':
          if (args[i + 1]) { specificServer = args[i + 1]; i++; }
          break;
        case '-t':
          hasTimeout = true;
          if (args[i + 1]) { timeout = parseInt(args[i + 1], 10); i++; }
          break;
        default:
          if (!args[i].startsWith('-')) iface = args[i];
          break;
      }
    }

    const dhcp = ctx.net.getDhcpClient();
    const ports = ctx.net.getPorts();

    // dhclient -x: stop dhclient process(es) and release lease
    if (exit) {
      if (iface) {
        dhcp.stopProcess(iface);
        dhcp.releaseLease(iface);
        return '';
      }
      for (const [name] of ports) {
        dhcp.stopProcess(name);
        dhcp.releaseLease(name);
      }
      return '';
    }

    // dhclient -r without interface: release all interfaces
    if (release && !iface) {
      const outputs: string[] = [];
      for (const [name] of ports) {
        const result = dhcp.releaseLease(name);
        if (result) outputs.push(result);
      }
      return outputs.join('\n');
    }

    if (!iface) return 'Usage: dhclient [-v] [-d] [-r] [-x] [-s server] [-w] [-t timeout] <interface>';
    if (!ports.has(iface)) return `RTNETLINK answers: No such device ${iface}`;

    if (release) {
      return dhcp.releaseLease(iface);
    }

    // Discover DHCP servers via broadcast (simulated through topology)
    ctx.net.autoDiscoverDHCPServers();
    if (specificServer) {
      // -s flag: filter the in-memory `connectedServers` list to only the
      // requested IP. Reaches into the DHCPClient internals because there
      // is no public setter — kept identical to the legacy LinuxPC
      // behaviour (see `linux_gap.md` §4).
      const dhcpAny = dhcp as unknown as { connectedServers: Array<{ server: unknown; serverIP: string }> };
      const servers = dhcpAny.connectedServers;
      const filtered = servers.filter(s => s.serverIP === specificServer);
      dhcpAny.connectedServers = filtered.length > 0 ? filtered : servers;
    }

    const opts: { verbose?: boolean; timeout?: number; daemon?: boolean } = { verbose, daemon };
    if (hasTimeout) opts.timeout = timeout;
    if (wait) opts.timeout = opts.timeout || 60; // -w: wait indefinitely (use long timeout)
    return dhcp.requestLease(iface, opts);
  },
};
