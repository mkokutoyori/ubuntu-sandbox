import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { STATIC_HOSTNAME_PATH, kernelHostname, staticHostname } from '../../KernelHostname';

export const hostnamectlCommand: LinuxCommand = {
  name: 'hostnamectl',
  needsNetworkContext: true,
  usage: 'hostnamectl [set-hostname NAME]',
  run(ctx: LinuxCommandContext, args: string[]): string {
    if (args[0] === 'set-hostname') {
      const newName = args[1];
      if (!newName) return 'hostnamectl: missing hostname';
      const oldName = staticHostname(ctx.executor.vfs);
      ctx.executor.vfs.writeFile(STATIC_HOSTNAME_PATH, newName + '\n', 0, 0, 0o022);
      ctx.executor.setKernelHostname(newName);
      if (newName !== oldName) {
        ctx.executor.logMgr.logSystemd('systemd-hostnamed', `Changed static host name to '${newName}' (was '${oldName}')`);
      }
      return '';
    }
    return ctx.executor.identity.toHostnamectl(staticHostname(ctx.executor.vfs), kernelHostname(ctx.executor.vfs));
  },
};
