import type { LinuxCommand } from '../LinuxCommand';
import { commandResultOf, completeLinesResultOf } from '../ToolOutputShape';
import { runHost } from './host/HostTool';
import { linuxHostPort } from './host/LinuxHostPort';

export const hostCommand: LinuxCommand = {
  name: 'host',
  needsNetworkContext: true,
  foregroundClient: true,
  ownsHelpOption: true,
  manSection: 1,
  usage: 'host [-aCdlnrsTUwv] [-c class] [-N ndots] [-t type] [-W time] [-R number] [-m flag] [-p port] hostname [server]',
  help:
    'host - DNS lookup utility.\n\n' +
    'host is a simple utility for performing DNS lookups. It is normally used\n' +
    'to convert names to IP addresses and vice versa.',

  run: async (ctx, args) => commandResultOf(await runHost(args, linuxHostPort(ctx))).interleaved,
  runWithStatus: async (ctx, args) => completeLinesResultOf(await runHost(args, linuxHostPort(ctx))),
};
