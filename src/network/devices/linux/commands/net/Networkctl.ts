import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';

export const networkctlCommand: LinuxCommand = {
  name: 'networkctl',
  needsNetworkContext: true,
  usage: 'networkctl [ status [ INTERFACE ] | list ]',
  run(ctx: LinuxCommandContext, args: string[]): string {
    const filtered = args.filter(a => !a.startsWith('-'));
    const sub = filtered[0];
    if (!sub || sub === 'status') {
      return ctx.netConfig.networkctlStatus(ctx.net, filtered[1]);
    }
    if (sub === 'list') {
      const names = [...ctx.net.getPorts().keys()];
      return ['IDX LINK  TYPE   OPERATIONAL SETUP', ...names.map((n, i) => `${i + 1}   ${n}  ether  routable    configured`)].join('\n');
    }
    return `networkctl: unknown verb '${sub}'`;
  },
};
