import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { ChronycSession } from '../../time/ChronycClient';
import { ChronyDaemonView } from '../../time/ChronyDaemonView';
import { simulatedWait } from '@/network/core/SimulatedWait';

async function runChronyc(ctx: LinuxCommandContext, args: string[], stdin?: string) {
  const service = ctx.executor.chronyService;
  const agent = service ? ctx.executor.ntpAgent?.() ?? null : null;
  const addresses: string[] = [];
  for (const port of ctx.net.getPorts().values()) {
    const address = port.getIPAddress();
    if (address) addresses.push(address.toString());
  }
  const session = new ChronycSession({
    service,
    view: service && agent ? new ChronyDaemonView(service, agent) : null,
    privileged: ctx.executor.userMgr.currentUid === 0,
    programName: 'chronyc',
    localAddresses: addresses,
    hostsFile: () => ctx.executor.vfs.readFile('/etc/hosts') ?? '',
    wait: simulatedWait,
  });
  const result = await session.run(args, stdin);
  return { output: result.stdout.replace(/\n$/, ''), exitCode: result.exitCode, stderr: result.stderr.replace(/\n$/, '') };
}

export const chronycCommand: LinuxCommand = {
  name: 'chronyc',
  needsNetworkContext: true,
  binaryPath: '/usr/bin/chronyc',
  usage: 'chronyc [-4|-6] [-n] [-N] [-c] [-e] [-m] [-h host] [-p port] [-v] [command]',
  async run(ctx: LinuxCommandContext, argv: string[], stdin?: string): Promise<string> {
    const result = await runChronyc(ctx, argv, stdin);
    return `${result.output}${result.stderr}`;
  },
  runWithStatus(ctx: LinuxCommandContext, argv: string[], stdin?: string) {
    return runChronyc(ctx, argv, stdin);
  },
};
