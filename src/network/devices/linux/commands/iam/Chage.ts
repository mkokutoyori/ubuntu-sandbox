import type { LinuxCommand, LinuxCommandOption } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { mapArgsToAttributes } from '../LinuxCommandArgs';
import { parseChageDate } from '../../LinuxUserCommands';

const CHAGE_OPTIONS: readonly LinuxCommandOption[] = [
  { flag: '-M', aliases: ['--maxdays'], dest: 'M', takesArg: true, argName: 'days', description: 'Set maximum number of days before password change' },
  { flag: '-m', aliases: ['--mindays'], dest: 'm', takesArg: true, argName: 'days', description: 'Set minimum number of days before password change' },
  { flag: '-W', aliases: ['--warndays'], dest: 'W', takesArg: true, argName: 'days', description: 'Set expiration warning days' },
  { flag: '-I', aliases: ['--inactive'], dest: 'I', takesArg: true, argName: 'days', description: 'Set password inactive after expiration' },
  { flag: '-d', aliases: ['--lastday'], dest: 'd', takesArg: true, argName: 'lastday', description: 'Set date of last password change' },
  { flag: '-E', aliases: ['--expiredate'], dest: 'E', takesArg: true, argName: 'date', description: 'Set account expiration date' },
  { flag: '-l', aliases: ['--list'], dest: 'l', description: 'Show account aging information' },
];

export const chageCommand: LinuxCommand = {
  name: 'chage',
  needsNetworkContext: true,
  usage: 'chage [options] LOGIN',
  options: CHAGE_OPTIONS,
  run(ctx: LinuxCommandContext, args: string[]): string {
    const { attrs, positionals } = mapArgsToAttributes(CHAGE_OPTIONS, args);
    const username = positionals[0];
    if (!username) return 'Usage: chage [options] LOGIN';

    const opts: { M?: number; m?: number; W?: number; d?: number; E?: number; I?: number; l?: boolean } = {};
    if (typeof attrs.M === 'string') opts.M = parseInt(attrs.M, 10);
    if (typeof attrs.m === 'string') opts.m = parseInt(attrs.m, 10);
    if (typeof attrs.W === 'string') opts.W = parseInt(attrs.W, 10);
    if (typeof attrs.I === 'string') opts.I = parseInt(attrs.I, 10);
    if (typeof attrs.d === 'string') opts.d = parseChageDate(attrs.d);
    if (typeof attrs.E === 'string') opts.E = parseChageDate(attrs.E);
    if (attrs.l === true) opts.l = true;

    return ctx.executor.userMgr.chage(username, opts);
  },
};
