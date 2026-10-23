import { CC, LFLAG, POSIX_VDISABLE, type Termios } from './Termios';

export interface Keystroke {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
}

export function characterCodeOf(stroke: Keystroke): number | null {
  if (stroke.altKey || stroke.metaKey || stroke.key.length !== 1) return null;
  if (!stroke.ctrlKey) return stroke.key.charCodeAt(0);
  if (stroke.key === '?') return 127;
  const code = stroke.key.toUpperCase().charCodeAt(0);
  return code >= 0x40 && code <= 0x5f ? code - 0x40 : null;
}

export function interruptsOn(termios: Termios, stroke: Keystroke): boolean {
  const interrupt = termios.cc[CC.VINTR];
  if ((termios.lflag & LFLAG.ISIG) === 0 || interrupt === POSIX_VDISABLE) return false;
  return characterCodeOf(stroke) === interrupt;
}

export function echoesInput(termios: Termios): boolean {
  return (termios.lflag & LFLAG.ECHO) !== 0;
}

export function echoedControl(code: number): string {
  if (code === 127) return '^?';
  return code < 32 ? `^${String.fromCharCode(code + 64)}` : String.fromCharCode(code);
}
