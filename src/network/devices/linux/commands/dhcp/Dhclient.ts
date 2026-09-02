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
  package: 'isc-dhcp-client',
  needsNetworkContext: true,
  manSection: 8,
  usage: 'dhclient [-v] [-d] [-r] [-x] [-s server] [-w] [-t timeout] <interface>',
  help:
    'Dynamic Host Configuration Protocol Client.\n\n' +
    'Requests an IP address lease from a DHCP server for the specified\n' +
    'network interface.',
  options: [
    { flag: '-v', description: 'Enable verbose log messages.', takesArg: false },
    { flag: '-d', description: 'Run in daemon mode.', takesArg: false },
    { flag: '-r', description: 'Release the current lease.', takesArg: false },
    { flag: '-x', description: 'Stop the running dhclient process.', takesArg: false },
    { flag: '-w', description: 'Wait for a lease to be acquired.', takesArg: false },
    { flag: '-s', description: 'Send requests to a specific DHCP server.', takesArg: true, argName: 'server' },
    { flag: '-t', description: 'Timeout for the lease request in seconds.', takesArg: true, argName: 'timeout' },
    { flag: '-6', description: 'Use DHCPv6 (RFC 8415) instead of DHCPv4.', takesArg: false },
    { flag: '-S', description: 'Stateless DHCPv6: ask for configuration only, no address.', takesArg: false },
  ],

  complete(ctx: LinuxCommandContext, args: string[]): string[] {
    const partial = args[args.length - 1] ?? '';
    if (partial.startsWith('-')) {
      return ['-v', '-d', '-r', '-x', '-w', '-s', '-S', '-t', '-6'].filter(f => f.startsWith(partial));
    }
    return Array.from(ctx.net.getPorts().keys());
  },

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
    let v6 = false;
    let stateless = false;

    for (let i = 0; i < args.length; i++) {
      switch (args[i]) {
        case '-v': verbose = true; break;
        case '-d': daemon = true; break;
        case '-r': release = true; break;
        case '-x': exit = true; break;
        case '-w': wait = true; break;
        case '-6': v6 = true; break;
        case '-S': stateless = true; break;
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

    if (v6) {
      if (!iface) return 'Usage: dhclient -6 [-v] <interface>';
      if (!ctx.net.getPorts().has(iface)) return `RTNETLINK answers: No such device ${iface}`;
      // `-S` asks for the configuration WITHOUT an address
      // (INFORMATION-REQUEST, RFC 8415 §18.2.6).
      return stateless
        ? ctx.net.requestDhcpv6Information(iface, verbose)
        : ctx.net.requestDhcpv6Lease(iface, verbose);
    }

    const dhcp = ctx.net.getDhcpClient();
    const ports = ctx.net.getPorts();

    // dhclient -x: stop dhclient process(es) and release lease
    if (exit) {
      if (iface) {
        dhcp.stopProcess(iface);
        dhcp.releaseLease(iface);
        syncDhclientProcesses(ctx);
        return '';
      }
      for (const [name] of ports) {
        dhcp.stopProcess(name);
        dhcp.releaseLease(name);
      }
      syncDhclientProcesses(ctx);
      return '';
    }

    // dhclient -r without interface: release all interfaces
    if (release && !iface) {
      const outputs: string[] = [];
      for (const [name] of ports) {
        const result = dhcp.releaseLease(name);
        if (result) outputs.push(result);
      }
      syncDhclientProcesses(ctx);
      return outputs.join('\n');
    }

    if (!iface) return 'Usage: dhclient [-v] [-d] [-r] [-x] [-s server] [-w] [-t timeout] <interface>';
    if (!ports.has(iface)) return `RTNETLINK answers: No such device ${iface}`;

    if (release) {
      const out = dhcp.releaseLease(iface);
      writeLeaseFiles(ctx);
      syncDhclientProcesses(ctx);
      return out;
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
    const output = dhcp.requestLease(iface, opts);
    writeLeaseFiles(ctx);
    syncDhclientProcesses(ctx);
    return output;
  },
};

function syncDhclientProcesses(ctx: LinuxCommandContext): void {
  const dhcp = ctx.net.getDhcpClient();
  const pm = ctx.executor.processMgr;
  const entries = pm.list({ comm: 'dhclient' });
  for (const [name] of ctx.net.getPorts()) {
    const command = `dhclient ${name}`;
    const existing = entries.find((p) => p.command === command);
    if (dhcp.isProcessRunning(name) && !existing) {
      pm.spawn({ command, comm: 'dhclient', user: 'root', uid: 0, gid: 0, ppid: 1, tty: '?' });
    } else if (!dhcp.isProcessRunning(name) && existing) {
      pm.kill(existing.pid, 'SIGTERM', { silent: true });
    }
  }
}

function writeLeaseFiles(ctx: LinuxCommandContext): void {
  const dhcp = ctx.net.getDhcpClient();
  const vfs = ctx.executor.vfs;
  if (!vfs.exists('/var/lib/dhcp')) vfs.mkdirp('/var/lib/dhcp', 0o755, 0, 0);
  const all: string[] = [];
  for (const [name] of ctx.net.getPorts()) {
    const content = dhcp.formatLeaseFile(name);
    if (!content) continue;
    all.push(content);
    vfs.writeFile(`/var/lib/dhcp/dhclient.${name}.leases`, `${content}\n`, 0, 0, 0o022);
  }
  if (all.length > 0) {
    vfs.writeFile('/var/lib/dhcp/dhclient.leases', `${all.join('\n\n')}\n`, 0, 0, 0o022);
  }
}
