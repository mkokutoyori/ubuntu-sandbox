const SIGNAL_NAMES = [
  'EXIT', 'HUP', 'INT', 'QUIT', 'ILL', 'TRAP', 'ABRT', 'BUS', 'FPE', 'KILL', 'USR1', 'SEGV', 'USR2', 'PIPE', 'ALRM', 'TERM',
  'STKFLT', 'CHLD', 'CONT', 'STOP', 'TSTP', 'TTIN', 'TTOU', 'URG', 'XCPU', 'XFSZ', 'VTALRM', 'PROF', 'WINCH', 'IO', 'PWR', 'SYS',
] as const;

const IGNORED_BY_DEFAULT = new Set(['CHLD', 'CONT', 'URG', 'WINCH']);

export function signalName(spec: string): string | null {
  const upper = spec.toUpperCase();
  if (/^\d+$/.test(upper)) return SIGNAL_NAMES[Number(upper)] ?? null;
  const bare = upper.startsWith('SIG') ? upper.slice(3) : upper;
  if (['ERR', 'DEBUG', 'RETURN', 'EXIT'].includes(bare)) return bare;
  return (SIGNAL_NAMES as readonly string[]).includes(bare) ? bare : null;
}

export function signalNumber(name: string): number {
  return (SIGNAL_NAMES as readonly string[]).indexOf(name);
}

export function terminatesByDefault(name: string): boolean {
  return !IGNORED_BY_DEFAULT.has(name) && name !== 'EXIT';
}

export function signalListing(): string {
  return SIGNAL_NAMES.slice(1).map((name, index) => `${String(index + 1).padStart(2)}) SIG${name}`).join('\t').replace(/(?:[^\t]*\t){4}[^\t]*/g, (row) => `${row}\n`);
}
