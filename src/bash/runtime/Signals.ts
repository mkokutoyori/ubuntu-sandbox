const SIGNAL_NAMES = [
  'EXIT', 'HUP', 'INT', 'QUIT', 'ILL', 'TRAP', 'ABRT', 'BUS', 'FPE', 'KILL', 'USR1', 'SEGV', 'USR2', 'PIPE', 'ALRM', 'TERM',
  'STKFLT', 'CHLD', 'CONT', 'STOP', 'TSTP', 'TTIN', 'TTOU', 'URG', 'XCPU', 'XFSZ', 'VTALRM', 'PROF', 'WINCH', 'IO', 'PWR', 'SYS',
  '', '', 'RTMIN',
  ...Array.from({ length: 15 }, (_, index) => `RTMIN+${index + 1}`),
  ...Array.from({ length: 14 }, (_, index) => `RTMAX-${14 - index}`),
  'RTMAX',
] as readonly string[];

const IGNORED_BY_DEFAULT = new Set(['CHLD', 'CONT', 'URG', 'WINCH']);

export function signalName(spec: string): string | null {
  const upper = spec.toUpperCase();
  if (/^\d+$/.test(upper)) return SIGNAL_NAMES[Number(upper)] || null;
  const bare = upper.startsWith('SIG') ? upper.slice(3) : upper;
  if (['ERR', 'DEBUG', 'RETURN', 'EXIT'].includes(bare)) return bare;
  return (bare !== '' && SIGNAL_NAMES.includes(bare)) ? bare : null;
}

export function signalNumber(name: string): number {
  return SIGNAL_NAMES.indexOf(name);
}

export function terminatesByDefault(name: string): boolean {
  return !IGNORED_BY_DEFAULT.has(name) && name !== 'EXIT';
}

export function signalListing(): string {
  const cells = SIGNAL_NAMES.flatMap((name, number) => (number === 0 || name === '' ? [] : [`${String(number).padStart(2)}) SIG${name}`]));
  const rows: string[] = [];
  for (let start = 0; start < cells.length; start += 5) {
    const row = cells.slice(start, start + 5);
    rows.push(row.join('\t') + (row.length < 5 ? '\t' : ''));
  }
  return `${rows.join('\n')}\n`;
}

export interface SignalConversion {
  readonly output: string;
  readonly diagnostics: string;
  readonly exitCode: number;
}

export function convertSignalSpecs(specs: readonly string[]): SignalConversion {
  let output = '';
  let diagnostics = '';
  let exitCode = 0;
  for (const spec of specs) {
    if (/^\d+$/.test(spec)) {
      const number = Number(spec);
      const reduced = number > 128 ? number - 128 : number;
      if (number > 256 || reduced > 64) {
        diagnostics += `bash: kill: ${spec}: invalid signal specification\n`;
        exitCode = 1;
      } else {
        output += `${SIGNAL_NAMES[reduced]}\n`;
      }
      continue;
    }
    const name = signalName(spec);
    if (name === null || ['ERR', 'DEBUG', 'RETURN'].includes(name)) {
      diagnostics += `bash: kill: ${spec}: invalid signal specification\n`;
      exitCode = 1;
    } else {
      output += `${signalNumber(name)}\n`;
    }
  }
  return { output, diagnostics, exitCode };
}
