export const TCPREPLAY_PROGRAM = 'tcpreplay';
export const TCPREPLAY_PROGRAM_PATH = '/usr/bin/tcpreplay';

export function fatalText(file: string, fn: string, line: number, message: string): string {
  return `\nFatal Error in ${file}:${fn}() line ${line}:\n ${message}\n`;
}

export function fatalErrText(file: string, fn: string, line: number, message: string): string {
  return `\nFatal Error in ${file}:${fn}() line ${line}:\n${message}\n`;
}

export function warningText(file: string, fn: string, line: number, message: string): string {
  return `Warning in ${file}:${fn}() line ${line}:\n${message}\n`;
}

export function debugText(level: number, file: string, fn: string, line: number, message: string): string {
  return `DEBUG${level} in ${file}:${fn}() line ${line}: ${message}\n`;
}

export function apiFailure(file: string, fn: string, line: number, message: string): string {
  return `From ${file}:${fn}() line ${line}:\n${message}`;
}
