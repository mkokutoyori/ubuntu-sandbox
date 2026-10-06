import type { SocketProtocol, SocketState } from '@/network/core/SocketTable';
import { IPv6Address } from '@/network/core/types';
import { TCP_INITIAL_CWND_SEGMENTS } from '@/network/tcp/TcpStack';
import type { KernelSocketRow } from '../network/KernelSocketRows';

export type ProcNetFamily = 4 | 6;

const PROC_STATE_HEX: Record<SocketState, string> = {
  ESTABLISHED: '01',
  SYN_SENT: '02',
  SYN_RECEIVED: '03',
  FIN_WAIT_1: '04',
  FIN_WAIT_2: '05',
  TIME_WAIT: '06',
  CLOSED: '07',
  CLOSE_WAIT: '08',
  LAST_ACK: '09',
  LISTEN: '0A',
  CLOSING: '0B',
};

const PROC_TIMER_CODE = { on: 1, keepalive: 2, timewait: 3, persist: 4 } as const;
const TCP4_ROW_WIDTH = 149;
const UDP4_ROW_WIDTH = 127;
const LISTENER_RTO_CLOCK_TICKS = 100;
const ROW_POINTER = '0000000000000000';
const FRESH_RTO_MS = 200;
const FRESH_ATO_MS = 40;

const TCP4_HEADER = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';
const UDP4_HEADER = '   sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode ref pointer drops';
const IPV6_SPACING = `${'local_address'.padEnd(38)}${'remote_address'.padEnd(38)}`;
const TCP6_HEADER = `  sl  ${IPV6_SPACING}st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode`;
const UDP6_HEADER = `  sl  ${IPV6_SPACING}st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode ref pointer drops`;

function hex(value: number, digits: number): string {
  return (value >>> 0).toString(16).toUpperCase().padStart(digits, '0');
}

function littleEndianWord(bytes: readonly number[]): string {
  return bytes.map((byte) => hex(byte, 2)).reverse().join('');
}

function addressHex(address: string, family: ProcNetFamily): string {
  if (family === 4) {
    const octets = address.split('.').map((octet) => parseInt(octet, 10));
    if (octets.length !== 4 || octets.some((octet) => Number.isNaN(octet))) return '00000000';
    return littleEndianWord(octets);
  }
  const parsed = IPv6Address.tryParse(address);
  const hextets = parsed === null ? new Array<number>(8).fill(0) : parsed.getHextets();
  let out = '';
  for (let word = 0; word < 4; word++) {
    const high = hextets[word * 2];
    const low = hextets[word * 2 + 1];
    out += littleEndianWord([high >> 8, high & 0xff, low >> 8, low & 0xff]);
  }
  return out;
}

function endpoint(address: string, port: number, family: ProcNetFamily): string {
  return `${addressHex(address, family)}:${hex(port, 4)}`;
}

function clockTicks(milliseconds: number): number {
  return Math.floor(milliseconds / 10);
}

function pad(line: string, width: number): string {
  return line.length >= width ? line : line.padEnd(width);
}

function rowFamily(row: KernelSocketRow): ProcNetFamily {
  return row.entry.localAddress.includes(':') ? 6 : 4;
}

function remoteOf(row: KernelSocketRow, family: ProcNetFamily): string {
  return row.entry.remoteAddress === '*' ? (family === 6 ? '::' : '0.0.0.0') : row.entry.remoteAddress;
}

function connectionLine(index: number, row: KernelSocketRow, family: ProcNetFamily): string {
  const { entry, state, info, timer, owner, queues, listener } = row;
  const head = `${String(index).padStart(4)}: ${endpoint(entry.localAddress, entry.localPort, family)} `
    + `${endpoint(remoteOf(row, family), entry.remotePort, family)} ${PROC_STATE_HEX[state]}`;
  const uid = owner?.uid ?? 0;
  if (state === 'SYN_RECEIVED') {
    const expires = clockTicks(timer?.expiresInMs ?? 0);
    return `${head} 00000000:00000000 01:${hex(expires, 8)} ${hex(timer?.retransmits ?? 0, 8)} ${String(uid).padStart(5)} `
      + `${String(0).padStart(8)} 0 0 ${ROW_POINTER}`;
  }
  if (state === 'TIME_WAIT') {
    const expires = clockTicks(timer?.expiresInMs ?? 0);
    return `${head} 00000000:00000000 03:${hex(expires, 8)} 00000000 ${String(0).padStart(5)} ${String(0).padStart(8)} 0 1 ${ROW_POINTER}`;
  }
  const sendQueue = state === 'LISTEN' ? 0 : queues.send;
  const receiveQueue = state === 'LISTEN' ? listener?.accept ?? 0 : queues.receive;
  const timerCode = timer === null ? 0 : PROC_TIMER_CODE[timer.kind];
  const expires = timer === null ? 0 : clockTicks(timer.expiresInMs);
  const common = `${head} ${hex(sendQueue, 8)}:${hex(receiveQueue, 8)} ${hex(timerCode, 2)}:${hex(expires, 8)} `
    + `${hex(info?.retransmits ?? 0, 8)} ${String(uid).padStart(5)} ${String(info?.probes ?? 0).padStart(8)} `
    + `${entry.id} 1 ${ROW_POINTER}`;
  if (state === 'LISTEN') return `${common} ${LISTENER_RTO_CLOCK_TICKS} 0 0 ${TCP_INITIAL_CWND_SEGMENTS} 0`;
  if (info === null) return `${common} ${clockTicks(FRESH_RTO_MS)} ${clockTicks(FRESH_ATO_MS)} 0 ${TCP_INITIAL_CWND_SEGMENTS} -1`;
  return `${common} ${clockTicks(info.rtoMs)} ${clockTicks(info.atoMs)} 0 ${info.sendCwnd} ${info.sendSsthresh ?? -1}`;
}

export function renderProcNetTcp(rows: readonly KernelSocketRow[], family: ProcNetFamily): string {
  const own = rows.filter((row) => row.entry.protocol === 'tcp' && rowFamily(row) === family);
  if (family === 6) {
    return [TCP6_HEADER, ...own.map((row, index) => connectionLine(index, row, 6)), ''].join('\n');
  }
  return [
    pad(TCP4_HEADER, TCP4_ROW_WIDTH),
    ...own.map((row, index) => pad(connectionLine(index, row, 4), TCP4_ROW_WIDTH)),
    '',
  ].join('\n');
}

export function renderProcNetUdp(
  rows: readonly KernelSocketRow[], family: ProcNetFamily, protocol: Exclude<SocketProtocol, 'tcp'>,
): string {
  const own = rows.filter((row) => row.entry.protocol === protocol && rowFamily(row) === family);
  const lines = own.map((row, index) => {
    const { entry, owner } = row;
    const connected = entry.remoteAddress !== '*' && entry.remotePort !== 0;
    return `${String(index).padStart(5)}: ${endpoint(entry.localAddress, entry.localPort, family)} `
      + `${endpoint(remoteOf(row, family), entry.remotePort, family)} ${connected ? '01' : '07'} `
      + `00000000:00000000 00:00000000 00000000 ${String(owner?.uid ?? 0).padStart(5)} ${String(0).padStart(8)} `
      + `${entry.id} 2 ${ROW_POINTER} 0`;
  });
  if (family === 6) return [UDP6_HEADER, ...lines, ''].join('\n');
  return [pad(UDP4_HEADER, UDP4_ROW_WIDTH), ...lines.map((line) => pad(line, UDP4_ROW_WIDTH)), ''].join('\n');
}

export function renderProcNetRaw(family: ProcNetFamily): string {
  return family === 6 ? [UDP6_HEADER, ''].join('\n') : [pad(UDP4_HEADER, UDP4_ROW_WIDTH), ''].join('\n');
}

export function renderProcNetUnix(): string {
  return 'Num       RefCount Protocol Flags    Type St Inode Path\n';
}

const PAGE_BYTES = 4096;

function countRows(
  rows: readonly KernelSocketRow[], protocol: SocketProtocol, family: ProcNetFamily,
): number {
  return rows.filter((row) => row.entry.protocol === protocol && rowFamily(row) === family
    && row.state !== 'TIME_WAIT' && row.state !== 'SYN_RECEIVED').length;
}

function tcpPages(rows: readonly KernelSocketRow[]): number {
  return rows.filter((row) => row.entry.protocol === 'tcp')
    .reduce((pages, row) => pages + Math.ceil((row.queues.receive + row.queues.send) / PAGE_BYTES), 0);
}

export function renderProcNetSockstat(rows: readonly KernelSocketRow[]): string {
  const tcp = countRows(rows, 'tcp', 4) + countRows(rows, 'tcp', 6);
  const udp = countRows(rows, 'udp', 4) + countRows(rows, 'udp', 6);
  const udpLite = countRows(rows, 'udplite', 4) + countRows(rows, 'udplite', 6);
  const orphans = rows.filter((row) => row.facts?.orphaned === true).length;
  const timeWait = rows.filter((row) => row.state === 'TIME_WAIT').length;
  return [
    `sockets: used ${tcp + udp + udpLite}`,
    `TCP: inuse ${countRows(rows, 'tcp', 4)} orphan ${orphans} tw ${timeWait} alloc ${tcp} mem ${tcpPages(rows)}`,
    `UDP: inuse ${countRows(rows, 'udp', 4)} mem 0`,
    `UDPLITE: inuse ${countRows(rows, 'udplite', 4)}`,
    'RAW: inuse 0',
    'FRAG: inuse 0 memory 0',
    '',
  ].join('\n');
}

export function renderProcNetSockstat6(rows: readonly KernelSocketRow[]): string {
  return [
    `TCP6: inuse ${countRows(rows, 'tcp', 6)}`,
    `UDP6: inuse ${countRows(rows, 'udp', 6)}`,
    `UDPLITE6: inuse ${countRows(rows, 'udplite', 6)}`,
    'RAW6: inuse 0',
    'FRAG6: inuse 0 memory 0',
    '',
  ].join('\n');
}
