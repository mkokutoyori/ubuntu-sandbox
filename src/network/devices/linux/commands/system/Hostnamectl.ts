import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';

export const hostnamectlCommand: LinuxCommand = {
  name: 'hostnamectl',
  needsNetworkContext: true,
  usage: 'hostnamectl [set-hostname NAME]',
  run(ctx: LinuxCommandContext, args: string[]): string {
    if (args[0] === 'set-hostname') {
      const newName = args[1];
      if (!newName) return 'hostnamectl: missing hostname';
      const oldName = (ctx.executor.vfs.readFile('/etc/hostname') ?? 'localhost').trim();
      ctx.executor.vfs.writeFile('/etc/hostname', newName + '\n', 0, 0, 0o022);
      if (newName !== oldName) {
        ctx.executor.logMgr.logSystemd('systemd-hostnamed', `Changed static host name to '${newName}' (was '${oldName}')`);
      }
      return '';
    }
    const hn = (ctx.executor.vfs.readFile('/etc/hostname') ?? 'localhost').trim();
    return ctx.executor.identity.toHostnamectl(hn);
  },
};
