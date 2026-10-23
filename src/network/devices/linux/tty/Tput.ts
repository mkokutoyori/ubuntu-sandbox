import type { TtyCommandResult } from './Stty';
import type { WindowSize } from './TtyDevice';

export function runTput(args: readonly string[], size: WindowSize): TtyCommandResult {
  const lines: string[] = [];
  let stderr = '';
  let exitCode = 0;
  for (const capability of args) {
    if (capability.startsWith('-')) continue;
    if (capability === 'cols') lines.push(String(size.cols));
    else if (capability === 'lines') lines.push(String(size.rows));
    else if (['clear', 'init', 'reset', 'sgr0', 'bold', 'smso', 'rmso', 'cnorm', 'civis'].includes(capability)) continue;
    else {
      stderr = `tput: unknown terminfo capability '${capability}'`;
      exitCode = 4;
      break;
    }
  }
  return { stdout: lines.join('\n'), stderr, exitCode };
}
