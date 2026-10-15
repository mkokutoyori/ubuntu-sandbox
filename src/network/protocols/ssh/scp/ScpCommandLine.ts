const SWITCHES = new Set(['1', '2', '3', '4', '6', 'A', 'B', 'C', 'O', 'T', 'd', 'f', 'p', 'q', 'r', 't', 'v']);
const VALUED = new Set(['c', 'F', 'J', 'P', 'S', 'i', 'l', 'o']);

export interface ScpCommandLine {
  readonly recursive: boolean;
  readonly preserve: boolean;
  readonly quiet: boolean;
  readonly verbosity: number;
  readonly viaClient: boolean;
  readonly limitKbit: number | null;
  readonly sshProgram: string | null;
  readonly sshArguments: readonly string[];
  readonly operands: readonly string[];
}

export type ScpCommandLineOutcome =
  | { readonly kind: 'parsed'; readonly line: ScpCommandLine }
  | { readonly kind: 'rejected'; readonly diagnostic: string | null };

export function parseScpCommandLine(args: readonly string[]): ScpCommandLineOutcome {
  const sshArguments: string[] = [];
  const switches = new Set<string>();
  let verbosity = 0;
  let limitKbit: number | null = null;
  let sshProgram: string | null = null;
  let index = 0;
  for (; index < args.length; index++) {
    const word = args[index];
    if (word === '--') {
      index++;
      break;
    }
    if (!word.startsWith('-') || word === '-') break;
    for (let at = 1; at < word.length; at++) {
      const letter = word[at];
      if (VALUED.has(letter)) {
        const attached = word.slice(at + 1);
        const value = attached !== '' ? attached : args[++index];
        if (value === undefined) return { kind: 'rejected', diagnostic: `scp: option requires an argument -- '${letter}'` };
        if (letter === 'P') sshArguments.push('-p', value);
        else if (letter === 'l') {
          if (!/^\d+$/.test(value) || Number(value) === 0) return { kind: 'rejected', diagnostic: `scp: bad bandwidth limit: ${value}` };
          limitKbit = Number(value);
        } else if (letter === 'S') sshProgram = value;
        else sshArguments.push(`-${letter}`, value);
        break;
      }
      if (!SWITCHES.has(letter)) return { kind: 'rejected', diagnostic: `scp: invalid option -- '${letter}'` };
      if (letter === 'v') verbosity++;
      switches.add(letter);
      if (['1', '2', '4', '6', 'C'].includes(letter)) sshArguments.push(`-${letter}`);
      if (letter === 'B') sshArguments.push('-o', 'BatchMode=yes');
      if (letter === 'q') sshArguments.push('-q');
    }
  }
  if (verbosity > 0) sshArguments.push(...Array<string>(verbosity).fill('-v'));
  const operands = args.slice(index);
  if (operands.length < 2) return { kind: 'rejected', diagnostic: null };
  return {
    kind: 'parsed',
    line: {
      recursive: switches.has('r'),
      preserve: switches.has('p'),
      quiet: switches.has('q'),
      verbosity,
      viaClient: switches.has('3'),
      limitKbit,
      sshProgram,
      sshArguments,
      operands,
    },
  };
}
