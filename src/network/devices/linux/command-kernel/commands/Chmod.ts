import { ParsedArgs } from '@/command-kernel/args/parsed-args';
import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { UsageError } from '@/command-kernel/errors';
import { toFileSystemActor } from '@/command-kernel/machine/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const WHO_SHIFT: Record<'u' | 'g' | 'o', number> = { u: 6, g: 3, o: 0 };
const SPECIAL_BIT: Record<'u' | 'g' | 'o', number> = { u: 0o4000, g: 0o2000, o: 0o1000 };

function applySymbolicMode(current: number, spec: string): number {
  let mode = current;
  for (const clause of spec.split(',')) {
    const match = /^([ugoa]*)([+\-=])([rwxXst]*)$/.exec(clause);
    if (!match) throw new UsageError(`mode invalide : ${clause}`);
    const [, whoRaw, op, permsRaw] = match;
    const who: Array<'u' | 'g' | 'o'> =
      whoRaw === '' || whoRaw.includes('a') ? ['u', 'g', 'o'] : [...new Set(whoRaw.split(''))] as Array<'u' | 'g' | 'o'>;

    let base = 0;
    if (permsRaw.includes('r')) base |= 4;
    if (permsRaw.includes('w')) base |= 2;
    if (permsRaw.includes('x') || (permsRaw.includes('X') && (mode & 0o111) !== 0)) base |= 1;

    for (const w of who) {
      const shift = WHO_SHIFT[w];
      const specialBit = SPECIAL_BIT[w];
      const wantsSpecial =
        (w === 'u' || w === 'g') ? permsRaw.includes('s') : permsRaw.includes('t');

      if (op === '=') {
        mode = (mode & ~(0o7 << shift)) | (base << shift);
        mode = wantsSpecial ? mode | specialBit : mode & ~specialBit;
      } else if (op === '+') {
        mode |= base << shift;
        if (wantsSpecial) mode |= specialBit;
      } else {
        mode &= ~(base << shift);
        if (wantsSpecial) mode &= ~specialBit;
      }
    }
  }
  return mode;
}

const OCTAL_PATTERN = /^[0-7]{3,4}$/;
const SYMBOLIC_PATTERN = /^[ugoa]*[+\-=][rwxXst]*(,[ugoa]*[+\-=][rwxXst]*)*$/;

export class ChmodCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'chmod',
    summary: 'Modifie les permissions d\'un fichier',
    usage: 'chmod <mode> <fichier...>',
    args: [
      { name: 'mode', type: 'string', required: true, description: 'mode octal (755) ou symbolique (u+x,g-w)' },
      { name: 'targets', type: 'path', required: true, variadic: true, description: 'fichiers cibles' },
    ],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'fichiers',
  };

  protected override validate(args: ParsedArgs): void {
    const mode = args.get<string>('mode');
    if (!OCTAL_PATTERN.test(mode) && !SYMBOLIC_PATTERN.test(mode)) {
      throw new UsageError(`mode invalide : ${mode}`);
    }
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const modeSpec = ctx.args.get<string>('mode');
    const targets = ctx.args.get<string[]>('targets');
    const actor = toFileSystemActor(ctx.session.user);
    const isOctal = OCTAL_PATTERN.test(modeSpec);
    for (const target of targets) {
      const path = ctx.machine.fs.resolve(ctx.session.cwd, target);
      const mode = isOctal
        ? parseInt(modeSpec, 8)
        : applySymbolicMode((await ctx.machine.fs.stat(path, actor)).mode, modeSpec);
      await ctx.machine.fs.chmod(path, mode, actor);
      ctx.machine.audit?.fsAccess(path, 'a', 'chmod');
      ctx.machine.audit?.syscall('chmod', path);
    }
    return EXIT_OK;
  }
}
