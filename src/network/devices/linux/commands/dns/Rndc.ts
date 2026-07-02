import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { RndcChannel } from '../../bind9/RndcChannel';

export const rndcCommand: LinuxCommand = {
  name: 'rndc',
  needsNetworkContext: true,
  manSection: 8,
  usage: 'rndc command [zone]',
  help:
    'Name server control utility.\n\n' +
    'Controls the operation of a name server over the control channel\n' +
    '(127.0.0.1#953).\n\n' +
    'COMMANDS\n' +
    '  status                Display status of the server.\n' +
    '  reload [zone]         Reload configuration file and zones.\n' +
    '  reconfig              Reload configuration file and new zones only.\n' +
    '  flush                 Flush the server cache.\n' +
    '  freeze [zone]         Suspend updates to a dynamic zone.\n' +
    '  thaw [zone]           Enable updates to a frozen dynamic zone and\n' +
    '                        reload it.\n' +
    '  querylog [on|off]     Enable / disable query logging.',

  run(ctx: LinuxCommandContext, args: string[]): string {
    return new RndcChannel(ctx.bind9).dispatch(args);
  },
};
