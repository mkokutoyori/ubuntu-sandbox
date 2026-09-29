import { bsdGetoptDiagnostic, shortOptions, type ShortOption } from '@/network/devices/linux/commands/Getopt';
import type { OpenSshRelease } from './OpenSshRelease';
import { sshOptionRefusal } from './SshClientOptions';

const SSH_OPTSTRING = '+1246ab:c:e:fgi:kl:m:no:p:qstvxAB:CD:E:F:GI:J:KL:MNO:PQ:R:S:TVw:W:XYy';

export interface SshReplyWithoutSession {
  readonly output: string;
  readonly exitCode: number;
}

interface SshOptionStretch {
  readonly options: readonly ShortOption[];
  readonly operand: number | null;
}

interface SshCommandLine {
  readonly options: readonly ShortOption[];
  readonly hasDestination: boolean;
}

function readStretch(args: readonly string[]): SshOptionStretch {
  const options: ShortOption[] = [];
  for (const option of shortOptions(args, SSH_OPTSTRING)) {
    if (option.kind === 'operand') return { options, operand: option.index };
    options.push(option);
  }
  return { options, operand: null };
}

function readCommandLine(args: readonly string[]): SshCommandLine {
  const beforeDestination = readStretch(args);
  if (beforeDestination.operand === null) return { options: beforeDestination.options, hasDestination: false };
  const afterDestination = readStretch(args.slice(beforeDestination.operand + 1));
  return { options: [...beforeDestination.options, ...afterDestination.options], hasDestination: true };
}

export function sshOptionValues(args: readonly string[]): string[] {
  return readCommandLine(args).options.flatMap(option =>
    option.kind === 'option' && option.letter === 'o' && option.argument !== undefined ? [option.argument] : []);
}

export function sshReplyWithoutSession(
  args: readonly string[], release: OpenSshRelease,
): SshReplyWithoutSession | null {
  const line = readCommandLine(args);
  for (const option of line.options) {
    if (option.kind === 'invalid' || option.kind === 'missing-argument') {
      return { output: `${bsdGetoptDiagnostic(option)}\n${release.sshUsage}`, exitCode: 255 };
    }
    if (option.kind !== 'option') continue;
    if (option.letter === 'V') return { output: release.clientVersion, exitCode: 0 };
    if (option.letter === '1') return { output: 'SSH protocol v.1 is no longer supported', exitCode: 255 };
    if (option.letter === 'o') {
      const refusal = sshOptionRefusal(option.argument ?? '', release.clientKeywords);
      if (refusal !== null) return { output: refusal, exitCode: 255 };
    }
  }
  return line.hasDestination ? null : { output: release.sshUsage, exitCode: 255 };
}
