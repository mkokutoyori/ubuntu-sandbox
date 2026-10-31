export interface RmanInvocation {
  readonly commandFile: string | null;
  readonly logFile: string | null;
  readonly appendToLog: boolean;
}

const OPTION = /^(cmdfile|log)\s*=\s*(.*)$/i;

export function parseRmanInvocation(args: readonly string[]): RmanInvocation {
  let commandFile: string | null = null;
  let logFile: string | null = null;
  let appendToLog = false;
  for (const arg of args) {
    const option = OPTION.exec(arg);
    if (option !== null) {
      const value = option[2].replace(/^(['"])(.*)\1$/, '$2');
      if (option[1].toLowerCase() === 'cmdfile') commandFile = value;
      else logFile = value;
    } else if (arg.startsWith('@') && arg.length > 1) {
      commandFile = arg.slice(1);
    } else if (arg.toLowerCase() === 'append') {
      appendToLog = true;
    }
  }
  return { commandFile, logFile, appendToLog };
}

export function isBatchRmanLine(line: string): boolean {
  const { commandFile } = parseRmanInvocation(line.trim().split(/\s+/).slice(1));
  return commandFile !== null;
}
