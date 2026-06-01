/**
 * GNU `seq` — arithmetic sequence generator.
 *
 *   seq LAST                       → 1,2,…,LAST   (step = 1)
 *   seq FIRST LAST                 → FIRST,…,LAST (step = 1; step = −1 if FIRST > LAST)
 *   seq FIRST INCREMENT LAST       → FIRST, FIRST+INC, …
 *
 * Flags:
 *   -s, --separator=STRING   inter-number separator (default newline)
 *   -t, --terminator=STRING  trailing terminator    (default newline)
 *   -w, --equal-width        zero-pad to common integer width
 *   -f, --format=FMT         printf-style format applied to each number
 */

export interface SeqOptions {
  separator?: string;
  terminator?: string | null;
  equalWidth?: boolean;
  format?: string | null;
}

export interface SeqResult {
  output: string;
  exitCode: number;
}

interface ParsedArgs extends Required<Omit<SeqOptions, 'terminator' | 'format'>> {
  terminator: string | null;
  format: string | null;
  operands: string[];
}

/**
 * Parse the option set and numeric operands following standard GNU
 * conventions: long form `--name=VALUE` and `--name VALUE`, short form
 * `-x VALUE`. Negative numbers are recognised so `-1 -3 -10` works.
 */
export function parseSeqArgs(argv: readonly string[]): ParsedArgs {
  const out: ParsedArgs = {
    separator: '\n', terminator: null, equalWidth: false,
    format: null, operands: [],
  };
  let i = 0;
  const take = (k: string, opt: string) => {
    const v = argv[++i];
    if (v === undefined) throw new SeqError(`option '${opt}' requires an argument`);
    return v;
  };
  while (i < argv.length) {
    const a = argv[i];
    if (a === '--') { out.operands.push(...argv.slice(i + 1)); break; }
    if (a === '-s' || a === '--separator')   { out.separator  = take('separator', a);  i++; continue; }
    if (a === '-t' || a === '--terminator')  { out.terminator = take('terminator', a); i++; continue; }
    if (a === '-f' || a === '--format')      { out.format     = take('format', a);     i++; continue; }
    if (a === '-w' || a === '--equal-width') { out.equalWidth = true;                  i++; continue; }
    if (a.startsWith('--separator='))        { out.separator  = a.slice('--separator='.length);  i++; continue; }
    if (a.startsWith('--terminator='))       { out.terminator = a.slice('--terminator='.length); i++; continue; }
    if (a.startsWith('--format='))           { out.format     = a.slice('--format='.length);     i++; continue; }
    out.operands.push(a);
    i++;
  }
  return out;
}

class SeqError extends Error {}

/** Number of digits after `.` in a decimal literal (0 for integers). */
function decimalPlaces(token: string): number {
  const m = /\.([0-9]+)/.exec(token);
  return m ? m[1].length : 0;
}

/** Width of the integer part (including a leading minus). */
function intWidth(n: number, precision: number): number {
  const s = n.toFixed(precision);
  const dot = s.indexOf('.');
  return dot < 0 ? s.length : dot;
}

/** Minimal printf-handler supporting just enough of `%f %g %e %d %s`. */
function applyFormat(fmt: string, value: number): string {
  return fmt.replace(/%%|%([-0+ #]*)(\d+)?(?:\.(\d+))?([efgds])/g,
    (m, flags, widthStr, precStr, spec) => {
      if (m === '%%') return '%';
      const width = widthStr ? Number.parseInt(widthStr, 10) : 0;
      const prec  = precStr !== undefined ? Number.parseInt(precStr, 10) : 6;
      const left  = flags.includes('-');
      const zero  = flags.includes('0') && !left;
      let body: string;
      switch (spec) {
        case 'd': body = String(Math.trunc(value)); break;
        case 's': body = String(value); break;
        case 'f': body = value.toFixed(prec); break;
        case 'e': body = value.toExponential(prec); break;
        case 'g': body = value.toPrecision(prec).replace(/\.?0+$/, ''); break;
        default:  body = String(value);
      }
      if (body.length >= width) return body;
      const padChar = zero ? '0' : ' ';
      const pad = padChar.repeat(width - body.length);
      if (left)            return body + pad;
      if (zero && body.startsWith('-')) return '-' + pad + body.slice(1);
      return pad + body;
    });
}

/**
 * Render the sequence implied by `argv` into the GNU `seq` output
 * format. Returns `{ output, exitCode }` with `exitCode === 1` on
 * malformed numeric operands and a usage line on argument-count errors.
 */
export function runSeq(argv: readonly string[]): SeqResult {
  let parsed: ParsedArgs;
  try { parsed = parseSeqArgs(argv); }
  catch (e) { return { output: `seq: ${e instanceof Error ? e.message : 'error'}`, exitCode: 1 }; }

  const { operands, separator, format, equalWidth } = parsed;
  if (operands.length < 1 || operands.length > 3) {
    return { output: 'seq: missing operand', exitCode: 1 };
  }
  for (const o of operands) {
    if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(o)) {
      return { output: `seq: invalid floating point argument: ${o}`, exitCode: 1 };
    }
  }

  let first = 1, increment = 1, last: number;
  let precision = 0;
  if (operands.length === 1) {
    last = Number.parseFloat(operands[0]);
  } else if (operands.length === 2) {
    first = Number.parseFloat(operands[0]);
    last  = Number.parseFloat(operands[1]);
    precision = Math.max(decimalPlaces(operands[0]), decimalPlaces(operands[1]));
  } else {
    first     = Number.parseFloat(operands[0]);
    increment = Number.parseFloat(operands[1]);
    last      = Number.parseFloat(operands[2]);
    precision = Math.max(...operands.map(decimalPlaces));
  }
  if (increment === 0) return { output: 'seq: invalid Zero increment value: 0', exitCode: 1 };
  const ascending = increment > 0;

  const nums: number[] = [];
  for (let v = first;
       ascending ? v <= last + 1e-12 : v >= last - 1e-12;
       v += increment) {
    nums.push(precision === 0 ? Math.round(v) : Number.parseFloat(v.toFixed(precision + 6)));
  }
  if (nums.length === 0) return { output: '', exitCode: 0 };

  const widest = equalWidth
    ? Math.max(...nums.map(n => intWidth(n, precision)))
    : 0;

  const renderOne = (n: number): string => {
    if (format) return applyFormat(format, n);
    let body = precision === 0 ? String(Math.trunc(n)) : n.toFixed(precision);
    if (equalWidth) {
      const neg = body.startsWith('-');
      const stem = neg ? body.slice(1) : body;
      const dot = stem.indexOf('.');
      const intLen = dot < 0 ? stem.length : dot;
      if (intLen < widest) {
        const pad = '0'.repeat(widest - intLen);
        body = (neg ? '-' : '') + pad + stem;
      }
    }
    return body;
  };

  const rendered = nums.map(renderOne);
  const terminator = parsed.terminator ?? '';
  return { output: rendered.join(separator) + terminator, exitCode: 0 };
}
