import { HUAWEI_ERRORS } from '../cli-utils';

function wrongAt(command: string, args: readonly string[], index: number): string {
  const typed = [command, ...args].join(' ');
  const offset = [command, ...args.slice(0, index)].join(' ').length + 1;
  return HUAWEI_ERRORS.WRONG(typed, offset);
}

const isDecimal = (word: string | undefined, min: number, max: number): boolean =>
  word !== undefined && /^\d+$/.test(word) && Number(word) >= min && Number(word) <= max;

export function judgeBgpEntry(args: readonly string[]): string | null {
  if (args.length === 0) return HUAWEI_ERRORS.INCOMPLETE('bgp');
  if (!isDecimal(args[0], 1, 4294967295)) return wrongAt('bgp', args, 0);
  if (args[1] !== undefined && args[1].toLowerCase() !== 'instance') return wrongAt('bgp', args, 1);
  if (args[1] !== undefined && args.length !== 3) {
    return args.length < 3 ? HUAWEI_ERRORS.INCOMPLETE(`bgp ${args.join(' ')}`) : wrongAt('bgp', args, 3);
  }
  return null;
}

export function judgeIsisEntry(args: readonly string[]): string | null {
  if (args.length === 0) return null;
  if (args[0].toLowerCase() !== 'vpn-instance' && !isDecimal(args[0], 1, 65535)) return wrongAt('isis', args, 0);
  const rest = args[0].toLowerCase() === 'vpn-instance' ? 0 : 1;
  if (args[rest] === undefined) return null;
  if (args[rest].toLowerCase() !== 'vpn-instance') return wrongAt('isis', args, rest);
  if (args[rest + 1] === undefined) return HUAWEI_ERRORS.INCOMPLETE(`isis ${args.join(' ')}`);
  return args.length > rest + 2 ? wrongAt('isis', args, rest + 2) : null;
}

export function judgeUserInterfaceVty(args: readonly string[]): string | null {
  if (args[0]?.toLowerCase() !== 'vty') return null;
  if (args[1] === undefined) return HUAWEI_ERRORS.INCOMPLETE(`user-interface ${args.join(' ')}`);
  if (!isDecimal(args[1], 0, 20)) return wrongAt('user-interface', args, 1);
  if (args[2] !== undefined && !isDecimal(args[2], 0, 20)) return wrongAt('user-interface', args, 2);
  return args.length > 3 ? wrongAt('user-interface', args, 3) : null;
}
