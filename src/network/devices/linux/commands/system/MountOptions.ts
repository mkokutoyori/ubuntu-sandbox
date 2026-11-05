import { getoptDiagnostic, shortOptions, type GetoptFailure, type LongOption } from '../Getopt';

const MOUNT_SHORT = 'acfFhilL:mMnNo:O:rRsT:t:U:vVw';
const UMOUNT_SHORT = 'aAcdfhilnqRrt:vVO:N:';

const MOUNT_LONG: readonly LongOption[] = [
  { name: 'all', letter: 'a', takesArgument: false },
  { name: 'no-canonicalize', letter: 'c', takesArgument: false },
  { name: 'fake', letter: 'f', takesArgument: false },
  { name: 'fork', letter: 'F', takesArgument: false },
  { name: 'fstab', letter: 'T', takesArgument: true },
  { name: 'help', letter: 'h', takesArgument: false },
  { name: 'internal-only', letter: 'i', takesArgument: false },
  { name: 'show-labels', letter: 'l', takesArgument: false },
  { name: 'label', letter: 'L', takesArgument: true },
  { name: 'mkdir', letter: 'm', takesArgument: false, optionalArgument: true },
  { name: 'move', letter: 'M', takesArgument: false },
  { name: 'no-mtab', letter: 'n', takesArgument: false },
  { name: 'namespace', letter: 'N', takesArgument: true },
  { name: 'options', letter: 'o', takesArgument: true },
  { name: 'test-opts', letter: 'O', takesArgument: true },
  { name: 'read-only', letter: 'r', takesArgument: false },
  { name: 'rbind', letter: 'R', takesArgument: false },
  { name: 'bind', letter: 'B', takesArgument: false },
  { name: 'types', letter: 't', takesArgument: true },
  { name: 'uuid', letter: 'U', takesArgument: true },
  { name: 'verbose', letter: 'v', takesArgument: false },
  { name: 'version', letter: 'V', takesArgument: false },
  { name: 'rw', letter: 'w', takesArgument: false },
  { name: 'read-write', letter: 'w', takesArgument: false },
  { name: 'source', letter: '', takesArgument: true },
  { name: 'target', letter: '', takesArgument: true },
  { name: 'target-prefix', letter: '', takesArgument: true },
  { name: 'options-mode', letter: '', takesArgument: true },
  { name: 'options-source', letter: '', takesArgument: true },
  { name: 'options-source-force', letter: '', takesArgument: false },
  { name: 'onlyonce', letter: '', takesArgument: false },
  { name: 'make-shared', letter: '', takesArgument: false },
  { name: 'make-slave', letter: '', takesArgument: false },
  { name: 'make-private', letter: '', takesArgument: false },
  { name: 'make-unbindable', letter: '', takesArgument: false },
  { name: 'make-rshared', letter: '', takesArgument: false },
  { name: 'make-rslave', letter: '', takesArgument: false },
  { name: 'make-rprivate', letter: '', takesArgument: false },
  { name: 'make-runbindable', letter: '', takesArgument: false },
];

const UMOUNT_LONG: readonly LongOption[] = [
  { name: 'all', letter: 'a', takesArgument: false },
  { name: 'all-targets', letter: 'A', takesArgument: false },
  { name: 'no-canonicalize', letter: 'c', takesArgument: false },
  { name: 'detach-loop', letter: 'd', takesArgument: false },
  { name: 'fake', letter: '', takesArgument: false },
  { name: 'force', letter: 'f', takesArgument: false },
  { name: 'help', letter: 'h', takesArgument: false },
  { name: 'internal-only', letter: 'i', takesArgument: false },
  { name: 'lazy', letter: 'l', takesArgument: false },
  { name: 'no-mtab', letter: 'n', takesArgument: false },
  { name: 'quiet', letter: 'q', takesArgument: false },
  { name: 'recursive', letter: 'R', takesArgument: false },
  { name: 'read-only', letter: 'r', takesArgument: false },
  { name: 'types', letter: 't', takesArgument: true },
  { name: 'test-opts', letter: 'O', takesArgument: true },
  { name: 'verbose', letter: 'v', takesArgument: false },
  { name: 'version', letter: 'V', takesArgument: false },
  { name: 'namespace', letter: 'N', takesArgument: true },
];

export interface MountUsageRefusal {
  readonly output: string;
  readonly exitCode: number;
}

export function mountUsageRefusal(program: 'mount' | 'umount', args: readonly string[]): MountUsageRefusal | null {
  const optstring = program === 'mount' ? MOUNT_SHORT : UMOUNT_SHORT;
  const longOptions = program === 'mount' ? MOUNT_LONG : UMOUNT_LONG;
  for (const item of shortOptions(args, optstring, longOptions)) {
    if (item.kind === 'operand' || item.kind === 'option') continue;
    const failure: GetoptFailure = item;
    return {
      output: `${getoptDiagnostic(program, failure)}\nTry '${program} --help' for more information.`,
      exitCode: 1,
    };
  }
  return null;
}

export function umountBadUsage(): MountUsageRefusal {
  return { output: "umount: bad usage\nTry 'umount --help' for more information.", exitCode: 1 };
}
