export type Vendor = 'U98' | 'XXX' | 'DEC' | 'AIX' | 'SCO' | 'LNX' | 'BSD' | 'SUN' | 'HPU' | 'SGI' | 'SOE' | 'TST';
export type Justify = 'USER' | 'LEFT' | 'RIGHT' | 'UNLIMITED' | 'WCHAN' | 'SIGNAL' | 'AIX';
export type PrintClass = 'TO' | 'PO' | 'ET' | 'AN';

export type SelectionType =
  | 'RUID' | 'EUID' | 'SUID' | 'FUID' | 'RGID' | 'EGID' | 'SGID' | 'FGID'
  | 'PGRP' | 'PID' | 'TTY' | 'SESS' | 'COMM' | 'PPID' | 'PID_QUICK';

export const SELECTION_TYPES_BY_NUMBER: readonly SelectionType[] = [
  'RUID', 'EUID', 'SUID', 'FUID', 'RGID', 'EGID', 'SGID', 'FGID', 'PGRP', 'PID', 'TTY', 'SESS', 'COMM', 'PPID', 'PID_QUICK',
];

export const OUTBUF_SIZE = 2 * 64 * 1024;
export const SIGNAL_NAME_WIDTH = 27;
export const SPACE_AMOUNT = 144;

export const TF_B_H = 0x0001;
export const TF_B_m = 0x0002;
export const TF_U_m = 0x0004;
export const TF_U_T = 0x0008;
export const TF_U_L = 0x0010;
export const TF_SHOW_PROC = 0x0100;
export const TF_SHOW_TASK = 0x0200;
export const TF_SHOW_BOTH = 0x0400;
export const TF_LOOSE_TASKS = 0x0800;
export const TF_NO_SORT = 0x1000;
export const TF_MUST_USE = 0x4000;

export const PER_BROKEN_o = 0x0001;
export const PER_BSD_h = 0x0002;
export const PER_BSD_m = 0x0004;
export const PER_IRIX_l = 0x0008;
export const PER_FORCE_BSD = 0x0010;
export const PER_GOOD_o = 0x0020;
export const PER_OLD_m = 0x0040;
export const PER_NO_DEFAULT_g = 0x0080;
export const PER_ZAP_ADDR = 0x0100;
export const PER_SANE_USER = 0x0200;
export const PER_HPUX_x = 0x0400;
export const PER_SVR4_x = 0x0800;

export const SS_B_x = 0x01;
export const SS_B_g = 0x02;
export const SS_U_d = 0x04;
export const SS_U_a = 0x08;
export const SS_B_a = 0x10;

export const FF_Uf = 0x0001;
export const FF_Uj = 0x0002;
export const FF_Ul = 0x0004;
export const FF_Bj = 0x0008;
export const FF_Bl = 0x0010;
export const FF_Bs = 0x0020;
export const FF_Bu = 0x0040;
export const FF_Bv = 0x0080;
export const FF_LX = 0x0100;
export const FF_Lm = 0x0200;
export const FF_Fc = 0x0400;

export const FM_c = 0x0001;
export const FM_j = 0x0002;
export const FM_y = 0x0004;
export const FM_P = 0x0010;
export const FM_M = 0x0020;
export const FM_F = 0x0080;

export type SortSource = 'U_O' | 'U_o' | 'B_O' | 'B_o' | 'B_m' | 'G_sort' | 'G_format';

export type HeaderType = 'single' | 'none' | 'multi';

export interface SelectionNode {
  typecode: SelectionType;
  values: (number | string)[];
}

export interface FormatNode {
  name: string;
  printer: string | null;
  width: number;
  vendor: Vendor;
  justify: Justify;
  print: PrintClass;
  pidMax: boolean;
}

export interface SortNode {
  sort: string;
  order: number;
}

export interface DeferredOption {
  source: SortSource;
  text: string;
  formats: FormatNode[];
  sorts: SortNode[];
}

export class PsExit extends Error {
  constructor(readonly code: number) {
    super(`ps exit ${code}`);
  }
}
