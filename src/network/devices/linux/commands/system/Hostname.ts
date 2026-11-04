import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { runHostname } from '../../hostname/HostnameTool';
import { linuxHostnameHost } from '../../hostname/LinuxHostnameHost';
import { commandResultOf, completeLinesResultOf } from '../ToolOutputShape';

const PROGRAMS: ReadonlyArray<{ name: string; usage: string; help: string }> = [
  { name: 'hostname', usage: 'hostname [-b] {hostname|-F file}', help: 'hostname - show or set the system host name' },
  { name: 'domainname', usage: 'domainname [nisdomain|-F file]', help: 'domainname - show or set the system NIS domain name' },
  { name: 'ypdomainname', usage: 'ypdomainname [nisdomain|-F file]', help: 'ypdomainname - show or set the system NIS domain name' },
  { name: 'nisdomainname', usage: 'nisdomainname [nisdomain|-F file]', help: 'nisdomainname - show or set the system NIS domain name' },
  { name: 'dnsdomainname', usage: 'dnsdomainname', help: 'dnsdomainname - show the system DNS domain name' },
];

function programNamed(program: { name: string; usage: string; help: string }): LinuxCommand {
  const outcome = (ctx: LinuxCommandContext, args: string[]) => runHostname(ctx.invokedAs ?? program.name, args, linuxHostnameHost(ctx));
  return {
    name: program.name,
    package: 'hostname',
    needsNetworkContext: true,
    ownsHelpOption: true,
    manSection: 1,
    usage: program.usage,
    help: program.help,
    run: async (ctx, args) => commandResultOf(await outcome(ctx, args)).interleaved,
    runWithStatus: async (ctx, args) => completeLinesResultOf(await outcome(ctx, args)),
  };
}

export const hostnameCommands: readonly LinuxCommand[] = PROGRAMS.map(programNamed);
