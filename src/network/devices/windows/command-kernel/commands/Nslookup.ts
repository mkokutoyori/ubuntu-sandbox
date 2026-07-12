import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { executeNslookup } from '@/network/devices/linux/commands/dns/NslookupRunner';

export class NslookupCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'nslookup',
    summary: 'Interroge un serveur DNS',
    usage: 'nslookup [-type=TYPE] domain [server]',
    args: [{ name: 'targets', type: 'string', required: false, variadic: true, description: 'domaine [/serveur]' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'réseau',
    lenientOptions: true,
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.has('targets') ? ctx.args.get<string[]>('targets') : [];
    if (!ctx.machine.netConfig) {
      await ctx.io.stdout.write('NSLOOKUP: not supported on this device\n');
      return 1;
    }

    const host = args.find((a) => !a.startsWith('-')) ?? '';

    // The static hosts table (including the machine's own name) is
    // answered locally, ahead of any DNS query — same order as
    // resolveHostname()'s resolver.
    if (host && !/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      const ownHostName = ctx.machine.hostname.toLowerCase();
      const hostsIp = ctx.machine.netConfig.resolveViaHostsFile(host)
        ?? (ownHostName && host.toLowerCase() === ownHostName ? '127.0.0.1' : null);
      if (hostsIp) {
        await ctx.io.stdout.write(
          'Server:  UnKnown\nAddress:  127.0.0.1\n\n' +
          `Name:    ${host}\nAddress:  ${hostsIp}\n`,
        );
        return EXIT_OK;
      }
    }

    if (!ctx.machine.services?.isRunning('Dnscache')) {
      await ctx.io.stdout.write(
        `*** Can't find ${host}: No DNS servers available\n` +
        `The DNS Client (Dnscache) service is not running.\n`,
      );
      return 1;
    }

    // Allow specifying server as second argument: nslookup domain server.
    // Queries travel over UDP/53 through the simulated network — an
    // unreachable server now times out for real.
    const server = ctx.machine.netConfig.firstConfiguredDnsServer();
    const queryFn = (s: string, n: string, t: string, ms?: number) => ctx.machine.netConfig!.queryDnsServer(s, n, t, ms);
    const out = await executeNslookup(args, queryFn, server);
    await ctx.io.stdout.write(out + '\n');
    return EXIT_OK;
  }
}
