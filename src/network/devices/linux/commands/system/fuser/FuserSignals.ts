const SIGNALS: ReadonlyArray<readonly [number, string]> = [
  [1, 'HUP'], [2, 'INT'], [3, 'QUIT'], [4, 'ILL'], [5, 'TRAP'], [6, 'ABRT'], [7, 'BUS'], [8, 'FPE'], [9, 'KILL'], [10, 'USR1'],
  [11, 'SEGV'], [12, 'USR2'], [13, 'PIPE'], [14, 'ALRM'], [15, 'TERM'], [16, 'STKFLT'], [17, 'CHLD'], [18, 'CONT'], [19, 'STOP'],
  [20, 'TSTP'], [21, 'TTIN'], [22, 'TTOU'], [23, 'URG'], [24, 'XCPU'], [25, 'XFSZ'], [26, 'VTALRM'], [27, 'PROF'], [28, 'WINCH'],
  [29, 'POLL'], [30, 'PWR'], [31, 'SYS'],
];

const LINE_WIDTH = 80;

export function listSignals(): string {
  let text = '';
  let column = 0;
  for (const [, name] of SIGNALS) {
    if (column + name.length + 1 > LINE_WIDTH) {
      text += '\n';
      column = 0;
    }
    text += `${column > 0 ? ' ' : ''}${name}`;
    column += name.length + 1;
  }
  return `${text}\n`;
}

export function signalNumber(name: string): number | null {
  if (/^[0-9]/.test(name)) return Number.parseInt(name, 10);
  const bare = name.startsWith('SIG') ? name.slice(3) : name;
  const found = SIGNALS.find(([, candidate]) => candidate === bare);
  return found === undefined ? null : found[0];
}
