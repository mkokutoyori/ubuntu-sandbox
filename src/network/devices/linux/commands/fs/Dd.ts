import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandExecutor } from '../../LinuxCommandExecutor';

const ZERO_SOURCES = new Set(['/dev/zero', '/dev/urandom', '/dev/random']);
const SINKS = new Set(['/dev/null']);
const DEFAULT_BLOCK = 512;

const SUFFIXES: Readonly<Record<string, number>> = {
  '': 1, c: 1, w: 2, b: 512,
  kb: 1000, k: 1024, kib: 1024,
  mb: 1000 ** 2, m: 1024 ** 2, mib: 1024 ** 2,
  gb: 1000 ** 3, g: 1024 ** 3, gib: 1024 ** 3,
  tb: 1000 ** 4, t: 1024 ** 4, tib: 1024 ** 4,
};

export function parseDdNumber(raw: string): number | null {
  const m = /^(\d+)(c|w|b|kB|K|KiB|MB|M|MiB|GB|G|GiB|TB|T|TiB)?$/.exec(raw.trim());
  if (!m) return null;
  const factor = SUFFIXES[(m[2] ?? '').toLowerCase()];
  return factor === undefined ? null : Number(m[1]) * factor;
}

/**
 * Les deux formes lisibles que coreutils accole au compte d'octets. Le
 * seuil de chacune est RELEVE sur `dd (coreutils) 9.4` : la forme SI
 * parait a 1000 octets, la forme IEC seulement a 1024 — d'ou
 * `1000 bytes (1.0 kB)` mais `1024 bytes (1.0 kB, 1.0 KiB)`.
 */
const SI_UNITS = ['B', 'kB', 'MB', 'GB', 'TB', 'PB'];
const IEC_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];

function scaled(bytes: number, base: number, units: readonly string[], decimalBelow: number): string {
  let value = bytes;
  let index = 0;
  while (value >= 1000 && index < units.length - 1) { value /= base; index++; }
  const rendered = value < decimalBelow ? value.toFixed(1) : String(Math.round(value));
  return `${rendered} ${units[index]}`;
}

export function ddByteCount(bytes: number): string {
  const parts: string[] = [];
  if (bytes >= 1000) parts.push(scaled(bytes, 1000, SI_UNITS, 10));
  if (bytes >= 1024) parts.push(scaled(bytes, 1024, IEC_UNITS, 10));
  return parts.length === 0 ? `${bytes} bytes` : `${bytes} bytes (${parts.join(', ')})`;
}

/**
 * Le debit suit la meme echelle SI que le compte d'octets, mais garde
 * sa decimale jusqu'a 100 (`87.0 MB/s`, `511 kB/s`) — releve sur la
 * machine reelle, comme le `0.0 kB/s` d'une copie vide.
 */
export function ddRate(bytes: number, seconds: number): string {
  const perSecond = seconds > 0 ? bytes / seconds : 0;
  if (perSecond === 0) return '0.0 kB/s';
  return `${scaled(perSecond, 1000, SI_UNITS, 100)}/s`;
}

/** `%g` a six chiffres significatifs, la mise en forme de `printf` que dd emploie. */
export function formatSeconds(x: number): string {
  const exponent = x === 0 ? 0 : Math.floor(Math.log10(Math.abs(x)));
  if (exponent >= -4 && exponent < 6) return String(Number(x.toPrecision(6)));
  const [mantissa, e] = x.toExponential(5).split('e');
  const sign = e.startsWith('-') ? '-' : '+';
  return `${mantissa.replace(/\.?0+$/, '')}e${sign}${e.replace(/[+-]/, '').padStart(2, '0')}`;
}

function elapsedSeconds(startMs: number): number {
  const seconds = (performance.now() - startMs) / 1000;
  return seconds > 0 ? seconds : 1e-6;
}

interface Operands {
  input: string;
  output: string;
  blockSize: number;
  outBlockSize: number;
  count: number | null;
  seek: number;
  skip: number;
  status: 'default' | 'none' | 'noxfer' | 'progress';
  notrunc: boolean;
}

type Refusal = { output: string; exitCode: number };

const CONVERSIONS = new Set(['notrunc', 'sync', 'noerror', 'fsync']);
const STATUS_LEVELS = new Set(['none', 'noxfer', 'progress']);

function tryHelp(message: string): Refusal {
  return { output: `${message}\nTry 'dd --help' for more information.`, exitCode: 1 };
}

function parseOperands(args: string[]): Operands | Refusal {
  const o: Operands = {
    input: '', output: '', blockSize: DEFAULT_BLOCK, outBlockSize: DEFAULT_BLOCK,
    count: null, seek: 0, skip: 0, status: 'default', notrunc: false,
  };
  let blockSizeSet = false;
  for (const arg of args) {
    const eq = arg.indexOf('=');
    if (eq <= 0) return tryHelp(`dd: unrecognized operand '${arg}'`);
    const key = arg.slice(0, eq);
    const value = arg.slice(eq + 1);
    const number = (): number | Refusal => {
      const n = parseDdNumber(value);
      return n === null ? { output: `dd: invalid number: '${value}'`, exitCode: 1 } : n;
    };
    switch (key) {
      case 'if': o.input = value; break;
      case 'of': o.output = value; break;
      case 'bs': {
        const n = number();
        if (typeof n !== 'number') return n;
        o.blockSize = n; o.outBlockSize = n; blockSizeSet = true;
        break;
      }
      case 'ibs': case 'obs': {
        const n = number();
        if (typeof n !== 'number') return n;
        if (!blockSizeSet) { if (key === 'ibs') o.blockSize = n; else o.outBlockSize = n; }
        break;
      }
      case 'count': case 'seek': case 'skip': {
        const n = number();
        if (typeof n !== 'number') return n;
        if (key === 'count') o.count = n; else if (key === 'seek') o.seek = n; else o.skip = n;
        break;
      }
      case 'status':
        if (!STATUS_LEVELS.has(value)) return tryHelp(`dd: invalid status level: '${value}'`);
        o.status = value as Operands['status'];
        break;
      case 'conv':
        for (const c of value.split(',')) {
          if (!CONVERSIONS.has(c)) return tryHelp(`dd: invalid conversion: '${c}'`);
          if (c === 'notrunc') o.notrunc = true;
        }
        break;
      default:
        return tryHelp(`dd: unrecognized operand '${arg}'`);
    }
  }
  return o;
}

function report(o: Operands, full: number, partial: number, bytes: number, startMs: number): string {
  if (o.status === 'none') return '';
  const records = [`${full}+${partial} records in`, `${full}+${partial} records out`];
  if (o.status === 'noxfer') return records.join('\n');
  const seconds = elapsedSeconds(startMs);
  return [
    ...records,
    `${ddByteCount(bytes)} copied, ${formatSeconds(seconds)} s, ${ddRate(bytes, seconds)}`,
  ].join('\n');
}

/**
 * `dd` sans contenu materialise quand la source est `/dev/zero` : la
 * taille est portee par `declaredSizeBytes`, le meme joint que
 * `truncate` emprunte, si bien que `ls -l`, `du`, `stat` et `df` lisent
 * un seul nombre. Une source qui est un VRAI fichier est copiee pour de
 * bon, sans quoi `dd if=a of=b` rendrait un fichier vide de la bonne
 * taille.
 */
export function runDd(
  exec: LinuxCommandExecutor, args: string[],
): { output: string; exitCode: number } {
  const parsed = parseOperands(args);
  if ('exitCode' in parsed) return parsed;
  const o = parsed;
  const startMs = performance.now();

  const cwd = exec.getCwd();
  let source: string | null = null;
  if (o.input && !ZERO_SOURCES.has(o.input)) {
    const abs = exec.vfs.normalizePath(o.input, cwd);
    source = exec.vfs.readFile(abs);
    if (source === null) {
      return {
        output: `dd: failed to open '${o.input}': No such file or directory`,
        exitCode: 1,
      };
    }
    exec.publishAuditFsAccess(abs, 'r', 'dd');
  }

  const skipBytes = o.skip * o.blockSize;
  const available = source === null
    ? (o.count === null ? 0 : o.count * o.blockSize)
    : Math.max(0, source.length - skipBytes);
  const wanted = o.count === null ? available : Math.min(available, o.count * o.blockSize);

  const full = Math.floor(wanted / o.blockSize);
  const partial = wanted % o.blockSize === 0 ? 0 : 1;

  if (!o.output || SINKS.has(o.output)) {
    return { output: report(o, full, partial, wanted, startMs), exitCode: 0 };
  }

  const abs = exec.vfs.normalizePath(o.output, cwd);
  const existing = o.notrunc || o.seek > 0 ? exec.vfs.readFile(abs) ?? '' : '';
  const offset = o.seek * o.outBlockSize;
  const payload = source === null ? '' : source.slice(skipBytes, skipBytes + wanted);
  const declared = offset + wanted;
  const tail = o.notrunc && existing.length > declared ? existing.slice(declared) : '';
  const content = source === null
    ? existing.slice(0, offset)
    : existing.slice(0, offset) + payload + tail;

  exec.publishAuditFsAccess(abs, 'w', 'dd');
  exec.publishAuditSyscall('write', abs);
  const ok = exec.vfs.writeFile(
    abs, content, exec.userMgr.currentUid, exec.userMgr.currentGid, exec.getUmask(),
    false, Math.max(declared + tail.length, content.length),
  );
  if (!ok) {
    return {
      output: [
        `dd: error writing '${o.output}': No space left on device`,
        report(o, full, 0, 0, startMs),
      ].filter((l) => l.length > 0).join('\n'),
      exitCode: 1,
    };
  }
  return { output: report(o, full, partial, wanted, startMs), exitCode: 0 };
}

export const ddCommand: LinuxCommand = {
  name: 'dd',
  needsNetworkContext: false,
  usage: 'dd [if=FILE] [of=FILE] [bs=BYTES] [count=N] [seek=N] [skip=N] [status=LEVEL] [conv=CONVS]',
  help: 'Convert and copy a file.',
  run: (ctx, args) => runDd(ctx.executor, args).output,
  runWithStatusSync: (ctx, args) => runDd(ctx.executor, args),
  runWithStatus: (ctx, args) => Promise.resolve(runDd(ctx.executor, args)),
};
