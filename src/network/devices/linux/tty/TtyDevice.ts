import { CFLAG, IFLAG, KERNEL_NCCS, NCCS, Termios } from './Termios';

export interface WindowSize {
  readonly rows: number;
  readonly cols: number;
}

export const DEFAULT_WINDOW_SIZE: WindowSize = { rows: 24, cols: 80 };

export type TcsetattrOutcome = 'ok' | 'EINVAL';

function word(value: number): number {
  return value >>> 0;
}

export class TtyDevice {
  private current: Termios = Termios.standard();
  windowSize: WindowSize = DEFAULT_WINDOW_SIZE;

  constructor(readonly name: string = 'pts/0') {}

  tcgetattr(): Termios {
    return this.current.clone();
  }

  tcsetattr(requested: Termios): TcsetattrOutcome {
    const before = this.current;
    const applied = requested.clone();
    applied.iflag = word(applied.iflag & ~IFLAG.IBAUD0);
    applied.cc.fill(0, KERNEL_NCCS, NCCS);
    applied.cflag = word((applied.cflag & ~(CFLAG.CSIZE | CFLAG.PARENB | CFLAG.ADDRB)) | CFLAG.CS8 | CFLAG.CREAD);
    this.current = applied;
    const forcedBits = CFLAG.PARENB | CFLAG.CREAD;
    const refused = (requested.cflag & forcedBits) !== (applied.cflag & forcedBits)
      || ((requested.cflag & CFLAG.CSIZE) !== 0 && (requested.cflag & CFLAG.CSIZE) !== (applied.cflag & CFLAG.CSIZE));
    const unchanged = before.iflag === applied.iflag && before.oflag === applied.oflag
      && before.cflag === applied.cflag && before.lflag === applied.lflag && before.line === applied.line;
    return refused && unchanged ? 'EINVAL' : 'ok';
  }
}
