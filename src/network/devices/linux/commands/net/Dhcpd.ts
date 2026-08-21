import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { makeArgCompleter } from '../completionHelpers';
import {
  DHCPD_BANNER, DHCPD_BINARY, DHCPD_CONF_PATH, DHCPD_LEASES_PATH, DHCPD_VERSION,
} from '../../dhcp/DhcpdFiles';

const UNIT = 'isc-dhcp-server';

interface Outcome { output: string; exitCode: number }

const USAGE = 'Usage: dhcpd [-p <UDP port #>] [-f] [-d] [-q] [-t|-T]\n'
  + '                [-4|-6] [-cf config-file] [-lf lease-file]\n'
  + '                [-pf pidfile] [--no-pid] [-s server]\n'
  + '                [if0 [...ifN]]';

function service(ctx: LinuxCommandContext) {
  return ctx.dhcpd ?? null;
}

function configTest(ctx: LinuxCommandContext): Outcome {
  const daemon = service(ctx);
  if (!daemon) return { output: `${DHCPD_BINARY}: not available on this machine`, exitCode: 1 };
  const verdict = daemon.checkConfig();
  return { output: verdict.output, exitCode: verdict.ok ? 0 : 1 };
}

export const dhcpdCommand: LinuxCommand = {
  name: 'dhcpd',
  needsNetworkContext: true,
  binaryPath: DHCPD_BINARY,
  manSection: 8,
  usage: 'dhcpd [-p port] [-f] [-d] [-q] [-t] [-cf config-file] [interface ...]',
  help: `Internet Systems Consortium DHCP Server ${DHCPD_VERSION}.`,
  complete: makeArgCompleter({ flags: ['-t', '-T', '-4', '-6', '-q', '-d', '-f', '-cf', '--version'] }),
  options: [
    { flag: '-t', description: 'Test the configuration file and exit.' },
    { flag: '-T', description: 'Test the lease file and exit.' },
    { flag: '-q', description: 'Do not print the startup banner.' },
    { flag: '-4', description: 'Serve DHCPv4.' },
    { flag: '--version', description: 'Print the version and exit.' },
  ],

  run(ctx: LinuxCommandContext, args: string[]): string {
    return this.runWithStatusSync!(ctx, args).output;
  },

  runWithStatusSync(ctx: LinuxCommandContext, args: string[]): Outcome {
    if (args.includes('--version')) {
      return { output: `isc-dhcpd-${DHCPD_VERSION}`, exitCode: 0 };
    }
    if (args.includes('--help') || args.includes('-h')) {
      return { output: USAGE, exitCode: 0 };
    }
    if (args.includes('-t')) return configTest(ctx);
    if (args.includes('-T')) {
      const leases = ctx.executor.vfs.readFile(DHCPD_LEASES_PATH);
      return leases === null
        ? { output: `Can't open lease database ${DHCPD_LEASES_PATH}: No such file or directory`, exitCode: 1 }
        : { output: [...DHCPD_BANNER, `Lease file: ${DHCPD_LEASES_PATH}`].join('\n'), exitCode: 0 };
    }

    const daemon = service(ctx);
    if (!daemon) return { output: `${DHCPD_BINARY}: not available on this machine`, exitCode: 1 };
    if (daemon.isRunning()) {
      return {
        output: [...DHCPD_BANNER,
          `Can't open ${DHCPD_CONF_PATH}: address already in use`,
          'exiting.'].join('\n'),
        exitCode: 1,
      };
    }

    const result = ctx.executor.serviceMgr.start(UNIT);
    return result.ok
      ? { output: '', exitCode: 0 }
      : { output: result.error ?? 'dhcpd: failed to start', exitCode: 1 };
  },
};

export const dhcpLeaseListCommand: LinuxCommand = {
  name: 'dhcp-lease-list',
  needsNetworkContext: true,
  binaryPath: '/usr/sbin/dhcp-lease-list',
  manSection: 1,
  usage: 'dhcp-lease-list [--parsable] [--all] [--lease <file>]',
  help: 'Print the leases recorded in the ISC DHCP lease database.',
  options: [
    { flag: '--parsable', description: 'One lease per line, tab separated.' },
    { flag: '--all', description: 'Include expired leases.' },
  ],

  run(ctx: LinuxCommandContext, args: string[]): string {
    const text = ctx.executor.vfs.readFile(DHCPD_LEASES_PATH);
    if (text === null) {
      return `Cannot open ${DHCPD_LEASES_PATH}: No such file or directory`;
    }
    const leases = readLeases(text);
    if (args.includes('--parsable')) {
      return leases.map(l => `MAC ${l.mac} IP ${l.ip} HOSTNAME ${l.hostname ?? '-NA-'} BEGIN ${l.starts} END ${l.ends}`).join('\n');
    }
    if (leases.length === 0) return 'To get manufacturer names please download http://standards.ieee.org/regauth/oui/oui.txt to /usr/local/etc/oui.txt';
    const rows = leases.map(l => [
      l.mac, l.ip, l.hostname ?? '-NA-', l.ends,
    ]);
    const head = ['MAC', 'IP', 'hostname', 'valid until'];
    const widths = head.map((title, index) =>
      Math.max(title.length, ...rows.map(row => row[index].length)));
    const line = (cells: readonly string[]) =>
      cells.map((cell, index) => cell.padEnd(widths[index])).join(' ').trimEnd();
    return [line(head), widths.map(w => '='.repeat(w)).join(' '), ...rows.map(line)].join('\n');
  },
};

interface LeaseRow {
  ip: string; mac: string; hostname: string | null; starts: string; ends: string;
}

function readLeases(text: string): LeaseRow[] {
  const rows = new Map<string, LeaseRow>();
  let current: Partial<LeaseRow> & { ip?: string } = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const open = /^lease (\d{1,3}(?:\.\d{1,3}){3}) \{$/.exec(line);
    if (open) { current = { ip: open[1] }; continue; }
    if (line === '}') {
      if (current.ip && current.mac) {
        rows.set(current.ip, {
          ip: current.ip, mac: current.mac, hostname: current.hostname ?? null,
          starts: current.starts ?? '', ends: current.ends ?? '',
        });
      }
      current = {};
      continue;
    }
    const hardware = /^hardware ethernet ([0-9a-f:]+);$/i.exec(line);
    if (hardware) { current.mac = hardware[1]; continue; }
    const hostname = /^client-hostname "(.*)";$/.exec(line);
    if (hostname) { current.hostname = hostname[1]; continue; }
    const starts = /^starts \d (.*);$/.exec(line);
    if (starts) { current.starts = starts[1]; continue; }
    const ends = /^ends \d (.*);$/.exec(line);
    if (ends) { current.ends = ends[1]; continue; }
  }
  return [...rows.values()];
}
