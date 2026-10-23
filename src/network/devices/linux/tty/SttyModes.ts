import { CC, CFLAG, IFLAG, LFLAG, OFLAG, POSIX_VDISABLE } from './Termios';

export type ModeType = 'control' | 'input' | 'output' | 'local' | 'combination';

export const SANE_SET = 1;
export const SANE_UNSET = 2;
export const REV = 4;
export const OMIT = 8;

export interface ModeInfo {
  readonly name: string;
  readonly type: ModeType;
  readonly flags: number;
  readonly bits: number;
  readonly mask: number;
}

function mode(name: string, type: ModeType, flags: number, bits: number, mask = 0): ModeInfo {
  return { name, type, flags, bits, mask };
}

export const MODE_INFO: readonly ModeInfo[] = [
  mode('parenb', 'control', REV, CFLAG.PARENB),
  mode('parodd', 'control', REV, CFLAG.PARODD),
  mode('cmspar', 'control', REV, CFLAG.CMSPAR),
  mode('cs5', 'control', 0, CFLAG.CS5, CFLAG.CSIZE),
  mode('cs6', 'control', 0, CFLAG.CS6, CFLAG.CSIZE),
  mode('cs7', 'control', 0, CFLAG.CS7, CFLAG.CSIZE),
  mode('cs8', 'control', 0, CFLAG.CS8, CFLAG.CSIZE),
  mode('hupcl', 'control', REV, CFLAG.HUPCL),
  mode('hup', 'control', REV | OMIT, CFLAG.HUPCL),
  mode('cstopb', 'control', REV, CFLAG.CSTOPB),
  mode('cread', 'control', SANE_SET | REV, CFLAG.CREAD),
  mode('clocal', 'control', REV, CFLAG.CLOCAL),
  mode('crtscts', 'control', REV, CFLAG.CRTSCTS),

  mode('ignbrk', 'input', SANE_UNSET | REV, IFLAG.IGNBRK),
  mode('brkint', 'input', SANE_SET | REV, IFLAG.BRKINT),
  mode('ignpar', 'input', REV, IFLAG.IGNPAR),
  mode('parmrk', 'input', REV, IFLAG.PARMRK),
  mode('inpck', 'input', REV, IFLAG.INPCK),
  mode('istrip', 'input', REV, IFLAG.ISTRIP),
  mode('inlcr', 'input', SANE_UNSET | REV, IFLAG.INLCR),
  mode('igncr', 'input', SANE_UNSET | REV, IFLAG.IGNCR),
  mode('icrnl', 'input', SANE_SET | REV, IFLAG.ICRNL),
  mode('ixon', 'input', REV, IFLAG.IXON),
  mode('ixoff', 'input', SANE_UNSET | REV, IFLAG.IXOFF),
  mode('tandem', 'input', REV | OMIT, IFLAG.IXOFF),
  mode('iuclc', 'input', SANE_UNSET | REV, IFLAG.IUCLC),
  mode('ixany', 'input', SANE_UNSET | REV, IFLAG.IXANY),
  mode('imaxbel', 'input', SANE_SET | REV, IFLAG.IMAXBEL),
  mode('iutf8', 'input', SANE_UNSET | REV, IFLAG.IUTF8),

  mode('opost', 'output', SANE_SET | REV, OFLAG.OPOST),
  mode('olcuc', 'output', SANE_UNSET | REV, OFLAG.OLCUC),
  mode('ocrnl', 'output', SANE_UNSET | REV, OFLAG.OCRNL),
  mode('onlcr', 'output', SANE_SET | REV, OFLAG.ONLCR),
  mode('onocr', 'output', SANE_UNSET | REV, OFLAG.ONOCR),
  mode('onlret', 'output', SANE_UNSET | REV, OFLAG.ONLRET),
  mode('ofill', 'output', SANE_UNSET | REV, OFLAG.OFILL),
  mode('ofdel', 'output', SANE_UNSET | REV, OFLAG.OFDEL),
  mode('nl1', 'output', SANE_UNSET, OFLAG.NL1, OFLAG.NLDLY),
  mode('nl0', 'output', SANE_SET, OFLAG.NL0, OFLAG.NLDLY),
  mode('cr3', 'output', SANE_UNSET, OFLAG.CR3, OFLAG.CRDLY),
  mode('cr2', 'output', SANE_UNSET, OFLAG.CR2, OFLAG.CRDLY),
  mode('cr1', 'output', SANE_UNSET, OFLAG.CR1, OFLAG.CRDLY),
  mode('cr0', 'output', SANE_SET, OFLAG.CR0, OFLAG.CRDLY),
  mode('tab3', 'output', SANE_UNSET, OFLAG.TAB3, OFLAG.TABDLY),
  mode('tab2', 'output', SANE_UNSET, OFLAG.TAB2, OFLAG.TABDLY),
  mode('tab1', 'output', SANE_UNSET, OFLAG.TAB1, OFLAG.TABDLY),
  mode('tab0', 'output', SANE_SET, OFLAG.TAB0, OFLAG.TABDLY),
  mode('bs1', 'output', SANE_UNSET, OFLAG.BS1, OFLAG.BSDLY),
  mode('bs0', 'output', SANE_SET, OFLAG.BS0, OFLAG.BSDLY),
  mode('vt1', 'output', SANE_UNSET, OFLAG.VT1, OFLAG.VTDLY),
  mode('vt0', 'output', SANE_SET, OFLAG.VT0, OFLAG.VTDLY),
  mode('ff1', 'output', SANE_UNSET, OFLAG.FF1, OFLAG.FFDLY),
  mode('ff0', 'output', SANE_SET, OFLAG.FF0, OFLAG.FFDLY),

  mode('isig', 'local', SANE_SET | REV, LFLAG.ISIG),
  mode('icanon', 'local', SANE_SET | REV, LFLAG.ICANON),
  mode('iexten', 'local', SANE_SET | REV, LFLAG.IEXTEN),
  mode('echo', 'local', SANE_SET | REV, LFLAG.ECHO),
  mode('echoe', 'local', SANE_SET | REV, LFLAG.ECHOE),
  mode('crterase', 'local', REV | OMIT, LFLAG.ECHOE),
  mode('echok', 'local', SANE_SET | REV, LFLAG.ECHOK),
  mode('echonl', 'local', SANE_UNSET | REV, LFLAG.ECHONL),
  mode('noflsh', 'local', SANE_UNSET | REV, LFLAG.NOFLSH),
  mode('xcase', 'local', SANE_UNSET | REV, LFLAG.XCASE),
  mode('tostop', 'local', SANE_UNSET | REV, LFLAG.TOSTOP),
  mode('echoprt', 'local', SANE_UNSET | REV, LFLAG.ECHOPRT),
  mode('prterase', 'local', REV | OMIT, LFLAG.ECHOPRT),
  mode('echoctl', 'local', SANE_SET | REV, LFLAG.ECHOCTL),
  mode('ctlecho', 'local', REV | OMIT, LFLAG.ECHOCTL),
  mode('echoke', 'local', SANE_SET | REV, LFLAG.ECHOKE),
  mode('crtkill', 'local', REV | OMIT, LFLAG.ECHOKE),
  mode('flusho', 'local', SANE_UNSET | REV, LFLAG.FLUSHO),
  mode('extproc', 'local', SANE_UNSET | REV, LFLAG.EXTPROC),

  mode('evenp', 'combination', REV | OMIT, 0),
  mode('parity', 'combination', REV | OMIT, 0),
  mode('oddp', 'combination', REV | OMIT, 0),
  mode('nl', 'combination', REV | OMIT, 0),
  mode('ek', 'combination', OMIT, 0),
  mode('sane', 'combination', OMIT, 0),
  mode('cooked', 'combination', REV | OMIT, 0),
  mode('raw', 'combination', REV | OMIT, 0),
  mode('pass8', 'combination', REV | OMIT, 0),
  mode('litout', 'combination', REV | OMIT, 0),
  mode('cbreak', 'combination', REV | OMIT, 0),
  mode('decctlq', 'combination', REV | OMIT, 0),
  mode('tabs', 'combination', REV | OMIT, 0),
  mode('lcase', 'combination', REV | OMIT, 0),
  mode('LCASE', 'combination', REV | OMIT, 0),
  mode('crt', 'combination', OMIT, 0),
  mode('dec', 'combination', OMIT, 0),
];

export interface ControlInfo {
  readonly name: string;
  readonly saneValue: number;
  readonly offset: number;
}

export const CONTROL_INFO: readonly ControlInfo[] = [
  { name: 'intr', saneValue: 3, offset: CC.VINTR },
  { name: 'quit', saneValue: 28, offset: CC.VQUIT },
  { name: 'erase', saneValue: 127, offset: CC.VERASE },
  { name: 'kill', saneValue: 21, offset: CC.VKILL },
  { name: 'eof', saneValue: 4, offset: CC.VEOF },
  { name: 'eol', saneValue: POSIX_VDISABLE, offset: CC.VEOL },
  { name: 'eol2', saneValue: POSIX_VDISABLE, offset: CC.VEOL2 },
  { name: 'swtch', saneValue: POSIX_VDISABLE, offset: CC.VSWTC },
  { name: 'start', saneValue: 17, offset: CC.VSTART },
  { name: 'stop', saneValue: 19, offset: CC.VSTOP },
  { name: 'susp', saneValue: 26, offset: CC.VSUSP },
  { name: 'rprnt', saneValue: 18, offset: CC.VREPRINT },
  { name: 'werase', saneValue: 23, offset: CC.VWERASE },
  { name: 'lnext', saneValue: 22, offset: CC.VLNEXT },
  { name: 'flush', saneValue: 15, offset: CC.VDISCARD },
  { name: 'discard', saneValue: 15, offset: CC.VDISCARD },
  { name: 'min', saneValue: 1, offset: CC.VMIN },
  { name: 'time', saneValue: 0, offset: CC.VTIME },
];
