export const NCCS = 32;
export const KERNEL_NCCS = 19;

export const IFLAG = {
  IGNBRK: 0o1, BRKINT: 0o2, IGNPAR: 0o4, PARMRK: 0o10, INPCK: 0o20, ISTRIP: 0o40, INLCR: 0o100, IGNCR: 0o200,
  ICRNL: 0o400, IUCLC: 0o1000, IXON: 0o2000, IXANY: 0o4000, IXOFF: 0o10000, IMAXBEL: 0o20000, IUTF8: 0o40000,
  IBAUD0: 0x80000000,
} as const;

export const OFLAG = {
  OPOST: 0o1, OLCUC: 0o2, ONLCR: 0o4, OCRNL: 0o10, ONOCR: 0o20, ONLRET: 0o40, OFILL: 0o100, OFDEL: 0o200,
  NLDLY: 0o400, NL0: 0, NL1: 0o400,
  CRDLY: 0o3000, CR0: 0, CR1: 0o1000, CR2: 0o2000, CR3: 0o3000,
  TABDLY: 0o14000, TAB0: 0, TAB1: 0o4000, TAB2: 0o10000, TAB3: 0o14000,
  BSDLY: 0o20000, BS0: 0, BS1: 0o20000,
  VTDLY: 0o40000, VT0: 0, VT1: 0o40000,
  FFDLY: 0o100000, FF0: 0, FF1: 0o100000,
} as const;

export const CFLAG = {
  CBAUD: 0o10017, CBAUDEX: 0o10000,
  CSIZE: 0o60, CS5: 0, CS6: 0o20, CS7: 0o40, CS8: 0o60,
  CSTOPB: 0o100, CREAD: 0o200, PARENB: 0o400, PARODD: 0o1000, HUPCL: 0o2000, CLOCAL: 0o4000,
  ADDRB: 0o4000000000, CMSPAR: 0o10000000000, CRTSCTS: 0o20000000000,
} as const;

export const LFLAG = {
  ISIG: 0o1, ICANON: 0o2, XCASE: 0o4, ECHO: 0o10, ECHOE: 0o20, ECHOK: 0o40, ECHONL: 0o100, NOFLSH: 0o200,
  TOSTOP: 0o400, ECHOCTL: 0o1000, ECHOPRT: 0o2000, ECHOKE: 0o4000, FLUSHO: 0o10000, PENDIN: 0o40000,
  IEXTEN: 0o100000, EXTPROC: 0o200000,
} as const;

export const CC = {
  VINTR: 0, VQUIT: 1, VERASE: 2, VKILL: 3, VEOF: 4, VTIME: 5, VMIN: 6, VSWTC: 7, VSTART: 8, VSTOP: 9, VSUSP: 10,
  VEOL: 11, VREPRINT: 12, VDISCARD: 13, VWERASE: 14, VLNEXT: 15, VEOL2: 16,
} as const;

export const POSIX_VDISABLE = 0;

export interface BaudRate {
  readonly text: string;
  readonly code: number;
  readonly value: number;
}

export const BAUD_RATES: readonly BaudRate[] = [
  { text: '0', code: 0, value: 0 },
  { text: '50', code: 0o1, value: 50 },
  { text: '75', code: 0o2, value: 75 },
  { text: '110', code: 0o3, value: 110 },
  { text: '134', code: 0o4, value: 134 },
  { text: '134.5', code: 0o4, value: 134 },
  { text: '150', code: 0o5, value: 150 },
  { text: '200', code: 0o6, value: 200 },
  { text: '300', code: 0o7, value: 300 },
  { text: '600', code: 0o10, value: 600 },
  { text: '1200', code: 0o11, value: 1200 },
  { text: '1800', code: 0o12, value: 1800 },
  { text: '2400', code: 0o13, value: 2400 },
  { text: '4800', code: 0o14, value: 4800 },
  { text: '9600', code: 0o15, value: 9600 },
  { text: '19200', code: 0o16, value: 19200 },
  { text: '38400', code: 0o17, value: 38400 },
  { text: 'exta', code: 0o16, value: 19200 },
  { text: 'extb', code: 0o17, value: 38400 },
  { text: '57600', code: 0o10001, value: 57600 },
  { text: '115200', code: 0o10002, value: 115200 },
  { text: '230400', code: 0o10003, value: 230400 },
  { text: '460800', code: 0o10004, value: 460800 },
  { text: '500000', code: 0o10005, value: 500000 },
  { text: '576000', code: 0o10006, value: 576000 },
  { text: '921600', code: 0o10007, value: 921600 },
  { text: '1000000', code: 0o10010, value: 1000000 },
  { text: '1152000', code: 0o10011, value: 1152000 },
  { text: '1500000', code: 0o10012, value: 1500000 },
  { text: '2000000', code: 0o10013, value: 2000000 },
  { text: '2500000', code: 0o10014, value: 2500000 },
  { text: '3000000', code: 0o10015, value: 3000000 },
  { text: '3500000', code: 0o10016, value: 3500000 },
  { text: '4000000', code: 0o10017, value: 4000000 },
];

export const B38400 = 0o17;

function word(value: number): number {
  return value >>> 0;
}

export class Termios {
  iflag = 0;
  oflag = 0;
  cflag = 0;
  lflag = 0;
  line = 0;
  readonly cc = new Uint8Array(NCCS);

  static standard(): Termios {
    const termios = new Termios();
    termios.iflag = IFLAG.ICRNL | IFLAG.IXON | IFLAG.IUTF8;
    termios.oflag = OFLAG.OPOST | OFLAG.ONLCR;
    termios.cflag = B38400 | CFLAG.CS8 | CFLAG.CREAD;
    termios.lflag = LFLAG.ISIG | LFLAG.ICANON | LFLAG.ECHO | LFLAG.ECHOE | LFLAG.ECHOK | LFLAG.ECHOCTL
      | LFLAG.ECHOKE | LFLAG.IEXTEN;
    const cc = termios.cc;
    cc[CC.VINTR] = 3;
    cc[CC.VQUIT] = 28;
    cc[CC.VERASE] = 127;
    cc[CC.VKILL] = 21;
    cc[CC.VEOF] = 4;
    cc[CC.VTIME] = 0;
    cc[CC.VMIN] = 1;
    cc[CC.VSTART] = 17;
    cc[CC.VSTOP] = 19;
    cc[CC.VSUSP] = 26;
    cc[CC.VREPRINT] = 18;
    cc[CC.VDISCARD] = 15;
    cc[CC.VWERASE] = 23;
    cc[CC.VLNEXT] = 22;
    return termios;
  }

  clone(): Termios {
    const copy = new Termios();
    copy.iflag = this.iflag;
    copy.oflag = this.oflag;
    copy.cflag = this.cflag;
    copy.lflag = this.lflag;
    copy.line = this.line;
    copy.cc.set(this.cc);
    return copy;
  }

  equals(other: Termios): boolean {
    return this.iflag === other.iflag && this.oflag === other.oflag && this.cflag === other.cflag
      && this.lflag === other.lflag && this.line === other.line && this.inputSpeed() === other.inputSpeed()
      && this.outputSpeed() === other.outputSpeed() && this.cc.every((value, index) => value === other.cc[index]);
  }

  inputSpeed(): number {
    return (this.iflag & IFLAG.IBAUD0) !== 0 ? 0 : this.outputSpeed();
  }

  outputSpeed(): number {
    return this.cflag & (CFLAG.CBAUD | CFLAG.CBAUDEX);
  }

  setInputSpeed(code: number): void {
    if (code === 0) {
      this.iflag = word(this.iflag | IFLAG.IBAUD0);
      return;
    }
    this.iflag = word(this.iflag & ~IFLAG.IBAUD0);
    this.cflag = word((this.cflag & ~(CFLAG.CBAUD | CFLAG.CBAUDEX)) | code);
  }

  setOutputSpeed(code: number): void {
    this.cflag = word((this.cflag & ~(CFLAG.CBAUD | CFLAG.CBAUDEX)) | code);
  }
}

export function baudValue(code: number): number {
  return BAUD_RATES.find((rate) => rate.code === code)?.value ?? 0;
}

export function baudCode(text: string): number | null {
  return BAUD_RATES.find((rate) => rate.text === text)?.code ?? null;
}
