export const AF = {
  UNSPEC: 0, UNIX: 1, INET: 2, INET6: 10, NETLINK: 16, PACKET: 17, TIPC: 30, VSOCK: 40, XDP: 44,
} as const;

export const SS = {
  UNKNOWN: 0, ESTABLISHED: 1, SYN_SENT: 2, SYN_RECV: 3, FIN_WAIT1: 4, FIN_WAIT2: 5, TIME_WAIT: 6,
  CLOSE: 7, CLOSE_WAIT: 8, LAST_ACK: 9, LISTEN: 10, CLOSING: 11, MAX: 12,
} as const;

export const SS_ALL = (1 << SS.MAX) - 1;
export const SS_CONN = SS_ALL & ~((1 << SS.LISTEN) | (1 << SS.CLOSE) | (1 << SS.TIME_WAIT) | (1 << SS.SYN_RECV));
export const TIPC_SS_CONN = (1 << SS.ESTABLISHED) | (1 << SS.LISTEN) | (1 << SS.CLOSE);

export const DB = {
  TCP: 0, MPTCP: 1, DCCP: 2, UDP: 3, RAW: 4, UNIX_DG: 5, UNIX_ST: 6, UNIX_SQ: 7, PACKET_DG: 8, PACKET_R: 9,
  NETLINK: 10, SCTP: 11, VSOCK_ST: 12, VSOCK_DG: 13, TIPC: 14, XDP: 15, MAX: 16,
} as const;

const bit = (db: number): number => 1 << db;

export const PACKET_DBM = bit(DB.PACKET_DG) | bit(DB.PACKET_R);
export const UNIX_DBM = bit(DB.UNIX_DG) | bit(DB.UNIX_ST) | bit(DB.UNIX_SQ);
export const INET_L4_DBM = bit(DB.TCP) | bit(DB.MPTCP) | bit(DB.UDP) | bit(DB.DCCP) | bit(DB.SCTP);
export const INET_DBM = INET_L4_DBM | bit(DB.RAW);
export const VSOCK_DBM = bit(DB.VSOCK_ST) | bit(DB.VSOCK_DG);

export function familyMask(family: number): bigint {
  return 1n << BigInt(family);
}

const INET_FAMILIES = familyMask(AF.INET) | familyMask(AF.INET6);

export const DEFAULT_DBS: ReadonlyArray<{ readonly states: number; readonly families: bigint }> = [
  { states: SS_CONN, families: INET_FAMILIES },
  { states: SS_CONN, families: INET_FAMILIES },
  { states: SS_CONN, families: INET_FAMILIES },
  { states: 1 << SS.ESTABLISHED, families: INET_FAMILIES },
  { states: 1 << SS.ESTABLISHED, families: INET_FAMILIES },
  { states: 1 << SS.CLOSE, families: familyMask(AF.UNIX) },
  { states: SS_CONN, families: familyMask(AF.UNIX) },
  { states: SS_CONN, families: familyMask(AF.UNIX) },
  { states: 1 << SS.CLOSE, families: familyMask(AF.PACKET) },
  { states: 1 << SS.CLOSE, families: familyMask(AF.PACKET) },
  { states: 1 << SS.CLOSE, families: familyMask(AF.NETLINK) },
  { states: SS_CONN, families: INET_FAMILIES },
  { states: SS_CONN, families: familyMask(AF.VSOCK) },
  { states: SS_CONN, families: familyMask(AF.VSOCK) },
  { states: TIPC_SS_CONN, families: familyMask(AF.TIPC) },
  { states: 1 << SS.CLOSE, families: familyMask(AF.XDP) },
];

export const DEFAULT_AFS = new Map<number, { readonly dbs: number; readonly states: number }>([
  [AF.INET, { dbs: INET_DBM, states: SS_CONN }],
  [AF.INET6, { dbs: INET_DBM, states: SS_CONN }],
  [AF.UNIX, { dbs: UNIX_DBM, states: SS_CONN }],
  [AF.PACKET, { dbs: PACKET_DBM, states: 1 << SS.CLOSE }],
  [AF.NETLINK, { dbs: bit(DB.NETLINK), states: 1 << SS.CLOSE }],
  [AF.VSOCK, { dbs: VSOCK_DBM, states: SS_CONN }],
  [AF.TIPC, { dbs: bit(DB.TIPC), states: TIPC_SS_CONN }],
  [AF.XDP, { dbs: bit(DB.XDP), states: 1 << SS.CLOSE }],
]);

export class SsError extends Error {
  constructor(readonly stderr: string, readonly exitCode: number) {
    super(stderr);
  }
}

export interface HostCondition {
  readonly family: number;
  readonly address: Uint8Array;
  readonly bits: number;
  readonly port: number;
}

export type SsExpression =
  | { readonly type: 'autobound' }
  | { readonly type: 'destination' | 'source'; readonly conditions: readonly HostCondition[] }
  | { readonly type: 'destination-port-at-least' | 'destination-port-at-most'
      | 'source-port-at-least' | 'source-port-at-most'; readonly port: number }
  | { readonly type: 'device'; readonly index: number }
  | { readonly type: 'mark'; readonly mark: number; readonly mask: number }
  | { readonly type: 'and' | 'or'; readonly left: SsExpression; readonly right: SsExpression }
  | { readonly type: 'not'; readonly operand: SsExpression };

export class SsFilter {
  databases = 0;
  states = 0;
  families = 0n;
  expression: SsExpression | null = null;
  kill = false;
  doDefault = true;
  preferredFamily: number = AF.UNSPEC;

  setDatabase(database: number, enable: boolean): void {
    if (enable) {
      this.states |= DEFAULT_DBS[database].states;
      this.databases |= bit(database);
    } else {
      this.databases &= ~bit(database);
    }
    this.doDefault = false;
  }

  setFamily(family: number): void {
    this.states |= DEFAULT_AFS.get(family)?.states ?? 0;
    this.families |= familyMask(family);
    this.doDefault = false;
    this.preferredFamily = family;
  }

  setStates(states: number): void {
    if (states !== 0) this.states = states;
  }

  hasFamily(family: number): boolean {
    return (this.families & familyMask(family)) !== 0n;
  }

  mergeDefaults(): void {
    for (let database = 0; database < DB.MAX; database++) {
      if ((this.databases & bit(database)) === 0) continue;
      if ((DEFAULT_DBS[database].families & this.families) === 0n) this.families |= DEFAULT_DBS[database].families;
    }
    for (const [family, defaults] of DEFAULT_AFS) {
      if ((this.families & familyMask(family)) === 0n) continue;
      if ((defaults.dbs & this.databases) === 0) this.databases |= defaults.dbs;
    }
  }
}

const DATABASE_NAMES: ReadonlyArray<readonly [string, readonly number[]]> = [
  ['all', [DB.UDP, DB.DCCP, DB.TCP, DB.MPTCP, DB.RAW, DB.UNIX_ST, DB.UNIX_DG, DB.UNIX_SQ,
    DB.PACKET_R, DB.PACKET_DG, DB.NETLINK, DB.SCTP, DB.VSOCK_ST, DB.VSOCK_DG, DB.XDP]],
  ['inet', [DB.UDP, DB.DCCP, DB.TCP, DB.MPTCP, DB.SCTP, DB.RAW]],
  ['udp', [DB.UDP]],
  ['dccp', [DB.DCCP]],
  ['tcp', [DB.TCP]],
  ['mptcp', [DB.MPTCP]],
  ['sctp', [DB.SCTP]],
  ['raw', [DB.RAW]],
  ['unix', [DB.UNIX_ST, DB.UNIX_DG, DB.UNIX_SQ]],
  ['unix_stream', [DB.UNIX_ST]],
  ['u_str', [DB.UNIX_ST]],
  ['unix_dgram', [DB.UNIX_DG]],
  ['u_dgr', [DB.UNIX_DG]],
  ['unix_seqpacket', [DB.UNIX_SQ]],
  ['u_seq', [DB.UNIX_SQ]],
  ['packet', [DB.PACKET_R, DB.PACKET_DG]],
  ['packet_raw', [DB.PACKET_R]],
  ['p_raw', [DB.PACKET_R]],
  ['packet_dgram', [DB.PACKET_DG]],
  ['p_dgr', [DB.PACKET_DG]],
  ['netlink', [DB.NETLINK]],
  ['vsock', [DB.VSOCK_ST, DB.VSOCK_DG]],
  ['vsock_stream', [DB.VSOCK_ST]],
  ['v_str', [DB.VSOCK_ST]],
  ['vsock_dgram', [DB.VSOCK_DG]],
  ['v_dgr', [DB.VSOCK_DG]],
  ['xdp', [DB.XDP]],
];

export function parseDatabaseName(filter: SsFilter, name: string): boolean {
  const enable = !name.startsWith('!');
  const wanted = enable ? name : name.slice(1);
  const entry = DATABASE_NAMES.find(([candidate]) => candidate === wanted);
  if (entry === undefined) return false;
  for (const database of entry[1]) filter.setDatabase(database, enable);
  return true;
}

export const STATE_NAMES: readonly string[] = [
  'UNKNOWN', 'ESTAB', 'SYN-SENT', 'SYN-RECV', 'FIN-WAIT-1', 'FIN-WAIT-2', 'TIME-WAIT', 'UNCONN',
  'CLOSE-WAIT', 'LAST-ACK', 'LISTEN', 'CLOSING',
];

const STATE_FILTER_NAMES: readonly string[] = [
  'UNKNOWN', 'established', 'syn-sent', 'syn-recv', 'fin-wait-1', 'fin-wait-2', 'time-wait', 'unconnected',
  'close-wait', 'last-ack', 'listening', 'closing',
];

export function scanState(name: string): number {
  const lower = name.toLowerCase();
  if (lower === 'close' || lower === 'closed') return 1 << SS.CLOSE;
  if (lower === 'syn-rcv') return 1 << SS.SYN_RECV;
  if (lower === 'established') return 1 << SS.ESTABLISHED;
  if (lower === 'all') return SS_ALL;
  if (lower === 'connected') return SS_ALL & ~((1 << SS.CLOSE) | (1 << SS.LISTEN));
  if (lower === 'synchronized') return SS_ALL & ~((1 << SS.CLOSE) | (1 << SS.LISTEN) | (1 << SS.SYN_SENT));
  if (lower === 'bucket') return (1 << SS.SYN_RECV) | (1 << SS.TIME_WAIT);
  if (lower === 'big') return SS_ALL & ~((1 << SS.SYN_RECV) | (1 << SS.TIME_WAIT));
  const index = STATE_FILTER_NAMES.findIndex((candidate) => candidate.toLowerCase() === lower);
  if (index >= 0) return 1 << index;
  throw new SsError(`ss: wrong state name: ${name}\n`, 255);
}
