export const TELOPT_NAMES: readonly string[] = [
  'BINARY', 'ECHO', 'RCP', 'SUPPRESS GO AHEAD', 'NAME', 'STATUS', 'TIMING MARK', 'RCTE', 'NAOL', 'NAOP', 'NAOCRD', 'NAOHTS', 'NAOHTD',
  'NAOFFD', 'NAOVTS', 'NAOVTD', 'NAOLFD', 'EXTEND ASCII', 'LOGOUT', 'BYTE MACRO', 'DATA ENTRY TERMINAL', 'SUPDUP', 'SUPDUP OUTPUT',
  'SEND LOCATION', 'TERMINAL TYPE', 'END OF RECORD', 'TACACS UID', 'OUTPUT MARKING', 'TTYLOC', '3270 REGIME', 'X.3 PAD', 'NAWS', 'TSPEED',
  'LFLOW', 'LINEMODE', 'XDISPLOC', 'OLD-ENVIRON', 'AUTHENTICATION', 'ENCRYPT', 'NEW-ENVIRON',
];

export const TELCMD_FIRST = 236;

export const TELCMD_NAMES: readonly string[] = [
  'EOF', 'SUSP', 'ABORT', 'EOR', 'SE', 'NOP', 'DMARK', 'BRK', 'IP', 'AO', 'AYT', 'EC', 'EL', 'GA', 'SB', 'WILL', 'WONT', 'DO', 'DONT', 'IAC',
];

export const SLC_NAMES: readonly string[] = [
  '0', 'SYNCH', 'BRK', 'IP', 'AO', 'AYT', 'EOR', 'ABORT', 'EOF', 'SUSP', 'EC', 'EL', 'EW', 'RP', 'LNEXT', 'XON', 'XOFF', 'FORW1', 'FORW2',
];

export const NSLC = 18;

export function optionName(option: number): string | null {
  return option < TELOPT_NAMES.length ? TELOPT_NAMES[option] : null;
}

export function commandName(command: number): string | null {
  const index = command - TELCMD_FIRST;
  return index >= 0 && index < TELCMD_NAMES.length ? TELCMD_NAMES[index] : null;
}

export const TELCMD = {
  xEOF: 236, SUSP: 237, ABORT: 238, EOR: 239, SE: 240, NOP: 241, DM: 242, BREAK: 243, IP: 244, AO: 245, AYT: 246, EC: 247, EL: 248, GA: 249,
  SB: 250, WILL: 251, WONT: 252, DO: 253, DONT: 254, IAC: 255,
} as const;

export const TELOPT = {
  BINARY: 0, ECHO: 1, SGA: 3, STATUS: 5, TM: 6, LOGOUT: 18, TTYPE: 24, EOR: 25, NAWS: 31, TSPEED: 32, LFLOW: 33, LINEMODE: 34, XDISPLOC: 35,
  ENVIRON: 39, EXOPL: 255,
} as const;

export const TELQUAL = { IS: 0, SEND: 1, INFO: 2 } as const;

export const LM = { MODE: 1, FORWARDMASK: 2, SLC: 3 } as const;

export const MODE = {
  EDIT: 0x01, TRAPSIG: 0x02, ACK: 0x04, SOFT_TAB: 0x08, LIT_ECHO: 0x10, MASK: 0x1f, FLOW: 0x0100, ECHO: 0x0200, INBIN: 0x0400, OUTBIN: 0x0800,
  FORCE: 0x1000, OUT8: 0x8000,
} as const;

export const SLC = {
  SYNCH: 1, BRK: 2, IP: 3, AO: 4, AYT: 5, EOR: 6, ABORT: 7, EOF: 8, SUSP: 9, EC: 10, EL: 11, EW: 12, RP: 13, LNEXT: 14, XON: 15, XOFF: 16,
  FORW1: 17, FORW2: 18,
  NOSUPPORT: 0, CANTCHANGE: 1, VARIABLE: 2, DEFAULT: 3, LEVELBITS: 0x03, ACK: 0x80, FLUSHIN: 0x40, FLUSHOUT: 0x20,
} as const;

export const ENV = { VAR: 0, VALUE: 1, ESC: 2, USERVAR: 3 } as const;

export const DISABLED = 0;
