import { bsdGetoptDiagnostic, shortOptions } from '@/network/devices/linux/commands/Getopt';
import type { OpenSshRelease } from './OpenSshRelease';

const SSH_OPTSTRING = '+1246ab:c:e:fgi:kl:m:no:p:qstvxAB:CD:E:F:GI:J:KL:MNO:PQ:R:S:TVw:W:XYy';

export interface SshReplyWithoutSession {
  readonly output: string;
  readonly exitCode: number;
}

function earlyReply(args: readonly string[], release: OpenSshRelease): SshReplyWithoutSession | number {
  for (const option of shortOptions(args, SSH_OPTSTRING)) {
    if (option.kind === 'operand') return option.index;
    if (option.kind === 'invalid' || option.kind === 'missing-argument') {
      return { output: `${bsdGetoptDiagnostic(option)}\n${release.sshUsage}`, exitCode: 255 };
    }
    if (option.kind !== 'option') continue;
    if (option.letter === 'V') return { output: release.clientVersion, exitCode: 0 };
    if (option.letter === '1') return { output: 'SSH protocol v.1 is no longer supported', exitCode: 255 };
  }
  return args.length;
}

export function sshReplyWithoutSession(
  args: readonly string[], release: OpenSshRelease,
): SshReplyWithoutSession | null {
  const beforeDestination = earlyReply(args, release);
  if (typeof beforeDestination !== 'number') return beforeDestination;
  if (beforeDestination >= args.length) return { output: release.sshUsage, exitCode: 255 };
  const afterDestination = earlyReply(args.slice(beforeDestination + 1), release);
  return typeof afterDestination === 'number' ? null : afterDestination;
}
