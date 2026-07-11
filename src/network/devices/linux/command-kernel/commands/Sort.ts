import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { readTextInput, splitLines } from './textInput';

interface SortKey {
  startField: number;
  startChar: number;
  endField?: number;
  endChar?: number;
  numeric?: boolean;
  human?: boolean;
  version?: boolean;
  reverse?: boolean;
  ignoreCase?: boolean;
}

function parseSortKey(spec: string): SortKey {
  const [start, end] = spec.split(',');
  const parseHalf = (s: string) => {
    const m = /^(\d+)(?:\.(\d+))?([bdfghnMRrV]*)$/.exec(s);
    if (!m) return { field: 1, char: undefined as number | undefined, opts: '' };
    return { field: parseInt(m[1], 10), char: m[2] ? parseInt(m[2], 10) : undefined, opts: m[3] };
  };
  const s = parseHalf(start);
  const e = end ? parseHalf(end) : null;
  const opts = s.opts + (e?.opts ?? '');
  const flag = (c: string): true | undefined => (opts.includes(c) ? true : undefined);
  return {
    startField: s.field,
    startChar: s.char ?? 1,
    endField: e?.field,
    endChar: e?.char,
    numeric: flag('n'),
    human: flag('h'),
    version: flag('V'),
    reverse: flag('r'),
    ignoreCase: flag('f'),
  };
}

const MONTH_RANK: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

function humanToBytes(s: string): number {
  const m = /^([+-]?\d+(?:\.\d+)?)\s*([KMGTP]?)/i.exec(s);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const u = (m[2] ?? '').toUpperCase();
  const mul: Record<string, number> = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4, P: 1024 ** 5 };
  return n * (mul[u] ?? 1);
}

function versionCompare(a: string, b: string): number {
  const split = (s: string): string[] => s.match(/(\d+|\D+)/g) ?? [];
  const aa = split(a);
  const bb = split(b);
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    const x = aa[i] ?? '';
    const y = bb[i] ?? '';
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const d = parseInt(x, 10) - parseInt(y, 10);
      if (d !== 0) return d;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

export class SortCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'sort',
    summary: 'Trie les lignes d\'un fichier ou de l\'entrée standard',
    usage: 'sort [-n] [-r] [-u] [-h] [-V] [-M] [-f] [-t DELIM] [-k KEY] [fichier...]',
    args: [{ name: 'files', type: 'path', required: false, variadic: true, description: 'fichiers à trier' }],
    options: [
      { long: 'numeric-sort', short: 'n', takesValue: false, description: 'tri numérique' },
      { long: 'reverse', short: 'r', takesValue: false, description: 'ordre inverse' },
      { long: 'unique', short: 'u', takesValue: false, description: 'supprime les doublons' },
      { long: 'human-numeric-sort', short: 'h', takesValue: false, description: 'tri numérique avec suffixes K/M/G' },
      { long: 'version-sort', short: 'V', takesValue: false, description: 'tri de type version' },
      { long: 'month-sort', short: 'M', takesValue: false, description: 'tri par nom de mois' },
      { long: 'ignore-case', short: 'f', takesValue: false, description: 'ignore la casse' },
      { long: 'key', short: 'k', takesValue: true, type: 'string', description: 'clé de tri, ex: 2,2n' },
      { long: 'field-separator', short: 't', takesValue: true, type: 'string', description: 'délimiteur de champ' },
    ],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'texte',
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const files = ctx.args.has('files') ? ctx.args.get<string[]>('files') : [];
    const numeric = ctx.args.flag('numeric-sort');
    const reverse = ctx.args.flag('reverse');
    const unique = ctx.args.flag('unique');
    const human = ctx.args.flag('human-numeric-sort');
    const version = ctx.args.flag('version-sort');
    const monthSort = ctx.args.flag('month-sort');
    const ignoreCase = ctx.args.flag('ignore-case');
    const delimiter = ctx.args.has('field-separator') ? ctx.args.get<string>('field-separator') : undefined;
    const key = ctx.args.has('key') ? parseSortKey(ctx.args.get<string>('key')) : undefined;

    const content = await readTextInput(ctx, files);
    const { lines } = splitLines(content);

    const fieldOf = (line: string, n: number): string => {
      if (delimiter !== undefined) {
        return line.split(delimiter)[n - 1] ?? '';
      }
      return line.trim().split(/\s+/)[n - 1] ?? '';
    };

    const extractKey = (line: string): string => {
      if (!key) return line;
      let val = fieldOf(line, key.startField);
      if (key.startChar > 1) val = val.slice(key.startChar - 1);
      if (key.endField !== undefined && key.endField > key.startField) {
        const tail = fieldOf(line, key.endField);
        const endTail = key.endChar !== undefined ? tail.slice(0, key.endChar) : tail;
        const pieces: string[] = [val];
        for (let f = key.startField + 1; f < key.endField; f++) pieces.push(fieldOf(line, f));
        pieces.push(endTail);
        val = pieces.join(' ');
      } else if (key.endField === key.startField && key.endChar !== undefined) {
        val = val.slice(0, key.endChar - (key.startChar - 1));
      }
      return val;
    };

    const compareValues = (a: string, b: string): number => {
      const useNumeric = key?.numeric ?? numeric;
      const useHuman = key?.human ?? human;
      const useVersion = key?.version ?? version;
      const useIgnoreCase = key?.ignoreCase ?? ignoreCase;
      const A = useIgnoreCase ? a.toLowerCase() : a;
      const B = useIgnoreCase ? b.toLowerCase() : b;
      if (useHuman) return humanToBytes(A) - humanToBytes(B);
      if (useNumeric) return (parseFloat(A) || 0) - (parseFloat(B) || 0);
      if (useVersion) return versionCompare(A, B);
      if (monthSort) {
        const ra = MONTH_RANK[A.trim().slice(0, 3).toUpperCase()] ?? 0;
        const rb = MONTH_RANK[B.trim().slice(0, 3).toUpperCase()] ?? 0;
        return ra - rb;
      }
      return A < B ? -1 : A > B ? 1 : 0;
    };

    let sorted = [...lines].sort((a, b) => {
      const d = compareValues(extractKey(a), extractKey(b));
      return key?.reverse ? -d : d;
    });
    if (reverse) sorted.reverse();
    if (unique) sorted = sorted.filter((line, i) => i === 0 || compareValues(extractKey(line), extractKey(sorted[i - 1])) !== 0);

    await ctx.io.stdout.write(sorted.length ? sorted.join('\n') + '\n' : '');
    return EXIT_OK;
  }
}
