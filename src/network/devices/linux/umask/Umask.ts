const PERMISSION_MASK = 0o777;
const OCTAL_LIMIT = 0o7777;
const USAGE = 'umask: usage: umask [-p] [-S] [mode]';

const HELP_TEXT = [
  'umask: umask [-p] [-S] [mode]',
  '    Display or set file mode mask.',
  '    ',
  '    Sets the user file-creation mask to MODE.  If MODE is omitted, prints',
  '    the current value of the mask.',
  '    ',
  '    If MODE begins with a digit, it is interpreted as an octal number;',
  '    otherwise it is a symbolic mode string like that accepted by chmod(1).',
  '    ',
  '    Options:',
  '      -p\tif MODE is omitted, output in a form that may be reused as input',
  '      -S\tmakes the output symbolic; otherwise an octal number is output',
  '    ',
  '    Exit Status:',
  '    Returns success unless MODE is invalid or an invalid option is given.',
  '',
].join('\n');

const WHO_BITS: Readonly<Record<string, number>> = { u: 0o700, g: 0o070, o: 0o007, a: 0o777 };
const PERMISSION_BITS: Readonly<Record<string, number>> = { r: 0o444, w: 0o222, x: 0o111 };

export interface UmaskOutcome {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly mask?: number;
}

function readOctal(text: string): number {
  let result = 0;
  let digits = 0;
  let index = 0;
  while (index < text.length && text[index] >= '0' && text[index] <= '7') {
    digits++;
    result = result * 8 + (text.charCodeAt(index) - 48);
    index++;
    if (result > OCTAL_LIMIT) return -1;
  }
  return digits === 0 || index < text.length ? -1 : result;
}

function symbolicOf(mask: number): string {
  const triplet = (shift: number): string => {
    const bits = (mask >> shift) & 0o7;
    return `${(bits & 4) === 0 ? 'r' : ''}${(bits & 2) === 0 ? 'w' : ''}${(bits & 1) === 0 ? 'x' : ''}`;
  };
  return `u=${triplet(6)},g=${triplet(3)},o=${triplet(0)}\n`;
}

type SymbolicResult = { readonly bits: number } | { readonly error: string };

function parseSymbolicMode(mode: string, initialBits: number): SymbolicResult {
  let bits = initialBits;
  let position = 0;
  for (;;) {
    let who = 0;
    while (position < mode.length && 'agou'.includes(mode[position])) who |= WHO_BITS[mode[position++]];
    const operator = position < mode.length ? mode[position] : '\0';
    position++;
    if (operator !== '+' && operator !== '-' && operator !== '=') return { error: `\`${operator}': invalid symbolic mode operator` };
    let permission = 0;
    while (position < mode.length && 'rwx'.includes(mode[position])) permission |= PERMISSION_BITS[mode[position++]];
    if (who === 0) who = PERMISSION_MASK;
    if (operator === '+') bits |= permission & who;
    else if (operator === '-') bits &= ~(permission & who);
    else bits = (bits & ~who) | (permission & who);
    const next = position < mode.length ? mode[position] : '\0';
    position++;
    if (next === '\0') return { bits };
    if (next !== ',') return { error: `\`${next}': invalid symbolic mode character` };
  }
}

export function runUmask(args: readonly string[], current: number): UmaskOutcome {
  let symbolic = false;
  let reusable = false;
  let index = 0;
  while (index < args.length) {
    const argument = args[index];
    if (argument === '--') {
      index++;
      break;
    }
    if (argument.length < 2 || argument[0] !== '-') break;
    if (argument === '--help') return { stdout: HELP_TEXT, stderr: '', exitCode: 2 };
    for (const letter of argument.slice(1)) {
      if (letter === 'S') symbolic = true;
      else if (letter === 'p') reusable = true;
      else return { stdout: '', stderr: `bash: umask: -${letter}: invalid option\n${USAGE}\n`, exitCode: 2 };
    }
    index++;
  }
  const operand = args[index];
  if (operand === undefined) {
    const prefix = reusable ? `umask${symbolic ? ' -S' : ''} ` : '';
    return { stdout: `${prefix}${symbolic ? symbolicOf(current) : `${current.toString(8).padStart(4, '0')}\n`}`, stderr: '', exitCode: 0 };
  }
  let mask: number;
  if (operand[0] >= '0' && operand[0] <= '9') {
    const value = readOctal(operand);
    if (value < 0) return { stdout: '', stderr: `bash: umask: ${operand}: octal number out of range\n`, exitCode: 1 };
    mask = value & PERMISSION_MASK;
  } else {
    const parsed = parseSymbolicMode(operand, ~current & PERMISSION_MASK);
    if ('error' in parsed) return { stdout: '', stderr: `bash: umask: ${parsed.error}\n`, exitCode: 1 };
    mask = ~parsed.bits & PERMISSION_MASK;
  }
  return { stdout: symbolic ? symbolicOf(mask) : '', stderr: '', exitCode: 0, mask };
}
