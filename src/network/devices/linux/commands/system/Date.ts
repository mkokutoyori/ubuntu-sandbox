import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { cmdDate } from '../../system/SystemInfo';

export const dateCommand: LinuxCommand = {
  name: 'date',
  needsNetworkContext: true,
  usage: 'date [-d DATESPEC] [-s DATESPEC] [-u] [+FORMAT]',
  run(ctx: LinuxCommandContext, args: string[]): string {
    const executor = ctx.executor;
    return cmdDate(args, executor.localZone(), {
      nowMs: executor.simulatedDate().getTime(),
      mayStepClock: executor.userMgr.currentUid === 0,
      setClock: (epochMs) => executor.setSystemTime(epochMs),
    });
  },
};
