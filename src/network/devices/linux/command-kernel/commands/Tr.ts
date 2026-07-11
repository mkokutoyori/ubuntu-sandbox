import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const POSIX_CLASSES: Record<string, string> = {
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  lower: 'abcdefghijklmnopqrstuvwxyz',
  digit: '0123456789',
  alpha: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
  alnum: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
  space: ' \t\n\r\f\v',
  punct: '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~',
};

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\' };

function decodeTrSet(spec: string): string {
  let out = '';
  for (let i = 0; i < spec.length; i++) {
    if (spec[i] === '\\' && i + 1 < spec.length) {
      out += ESCAPES[spec[i + 1]] ?? spec[i + 1];
      i++;
      continue;
    }
    if (spec.startsWith('[:', i)) {
      const end = spec.indexOf(':]', i);
      if (end !== -1) {
        out += POSIX_CLASSES[spec.slice(i + 2, end)] ?? '';
        i = end + 1;
        continue;
      }
    }
    if (spec[i + 1] === '-' && i + 2 < spec.length && spec[i + 2] !== '\\') {
      const start = spec.charCodeAt(i);
      const end = spec.charCodeAt(i + 2);
      for (let c = start; c <= end; c++) out += String.fromCharCode(c);
      i += 2;
      continue;
    }
    out += spec[i];
  }
  return out;
}

export class TrCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'tr',
    summary: 'Traduit ou supprime des caractères sur l\'entrée standard',
    usage: 'tr [-cds] SET1 [SET2]',
    args: [
      { name: 'set1', type: 'string', required: true, description: 'ensemble source' },
      { name: 'set2', type: 'string', required: false, description: 'ensemble cible' },
    ],
    options: [
      { long: 'delete', short: 'd', takesValue: false, description: 'supprime les caractères de SET1' },
      { long: 'squeeze-repeats', short: 's', takesValue: false, description: 'compresse les répétitions consécutives' },
      { long: 'complement', short: 'c', takesValue: false, description: 'complémente SET1' },
    ],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'texte',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const set1 = decodeTrSet(ctx.args.get<string>('set1'));
    const set2 = ctx.args.has('set2') ? decodeTrSet(ctx.args.get<string>('set2')) : '';
    const deleteMode = ctx.args.flag('delete');
    const squeeze = ctx.args.flag('squeeze-repeats');
    const complement = ctx.args.flag('complement');

    const inSet1 = (ch: string): boolean => {
      const present = set1.includes(ch);
      return complement ? !present : present;
    };

    const input = await ctx.io.stdin.readAll();
    let result = '';
    let lastOut: string | null = null;
    for (const ch of input) {
      const matches = inSet1(ch);
      let out: string | null = ch;
      if (matches) {
        if (deleteMode) out = null;
        else if (set2.length > 0) {
          const idx = complement ? 0 : set1.indexOf(ch);
          out = set2[Math.min(idx, set2.length - 1)];
        }
      }
      if (out === null) continue;
      if (squeeze && matches && out === lastOut) continue;
      result += out;
      lastOut = out;
    }

    await ctx.io.stdout.write(result);
    return EXIT_OK;
  }
}
