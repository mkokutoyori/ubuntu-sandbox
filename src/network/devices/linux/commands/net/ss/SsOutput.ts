import { IPv6Address } from '@/network/core/types';
import type { TcpInfo } from '@/network/tcp/TcpInfo';
import type { KernelSocketRow } from '../../../network/KernelSocketRows';
import { TCP_INITIAL_CWND_SEGMENTS } from '@/network/tcp/TcpStack';
import { SS, STATE_NAMES } from './SsModel';
import { addressBytes, type SsFilterSubject } from './SsFilterExpression';
import type { SsRequest } from './SsArguments';
import { COLUMN, SsTable } from './SsTable';
import {
  bandwidthText, formatG, hexMask, printMsTimer, wholeJiffies, wholeMicroseconds,
} from './SsFormat';

export interface SsOutputHost {
  hostName(address: string): string | null;
  serviceName(port: number, protocol: 'tcp' | 'udp'): string | null;
  ephemeralPorts(): { readonly low: number; readonly high: number };
  cgroupOf(pid: number): string | null;
  cookieOf(socketId: number): number;
  defaultCongestionControl(): string;
  canInspectProcessOf(uid: number): boolean;
}

export interface SsSocketView {
  readonly row: KernelSocketRow;
  readonly protocol: 'tcp' | 'udp';
  readonly family: 4 | 6;
  readonly state: number;
  readonly localAddress: string;
  readonly remoteAddress: string;
  readonly localPort: number;
  readonly remotePort: number;
}

const TCP_STATE_OF: Record<KernelSocketRow['state'], number> = {
  ESTABLISHED: SS.ESTABLISHED,
  SYN_SENT: SS.SYN_SENT,
  SYN_RECEIVED: SS.SYN_RECV,
  FIN_WAIT_1: SS.FIN_WAIT1,
  FIN_WAIT_2: SS.FIN_WAIT2,
  TIME_WAIT: SS.TIME_WAIT,
  CLOSED: SS.CLOSE,
  CLOSE_WAIT: SS.CLOSE_WAIT,
  LAST_ACK: SS.LAST_ACK,
  LISTEN: SS.LISTEN,
  CLOSING: SS.CLOSING,
};

const TIMER_NAME = { on: 'on', keepalive: 'keepalive', timewait: 'timewait', persist: 'persist' } as const;

export function socketViewOf(row: KernelSocketRow): SsSocketView | null {
  const { entry } = row;
  const family = entry.localAddress.includes(':') ? 6 : 4;
  const unspecified = family === 6 ? '::' : '0.0.0.0';
  const remoteAddress = entry.remoteAddress === '*' ? unspecified : entry.remoteAddress;
  const common = {
    row, family, remoteAddress, localAddress: entry.localAddress,
    localPort: entry.localPort, remotePort: entry.remotePort,
  } as const;
  if (entry.protocol === 'tcp') {
    if (row.state === 'CLOSED') return null;
    return { ...common, protocol: 'tcp', state: TCP_STATE_OF[row.state] };
  }
  if (entry.protocol === 'udp') {
    return { ...common, protocol: 'udp', state: row.state === 'ESTABLISHED' ? SS.ESTABLISHED : SS.CLOSE };
  }
  return null;
}

export function filterSubjectOf(view: SsSocketView, interfaceIndexOf: (name: string) => number | null): SsFilterSubject {
  const endpoint = (address: string, port: number) => {
    const parsed = addressBytes(address);
    return {
      family: view.family === 6 ? 10 : 2,
      address: parsed === null ? new Uint8Array(16) : parsed.bytes,
      port,
    };
  };
  return {
    local: endpoint(view.localAddress, view.localPort),
    remote: endpoint(view.remoteAddress, view.remotePort),
    interfaceIndex: view.row.entry.boundDevice === undefined ? 0 : interfaceIndexOf(view.row.entry.boundDevice) ?? 0,
    mark: 0,
  };
}

function isFullSocket(view: SsSocketView): boolean {
  return view.protocol === 'udp' || (view.state !== SS.SYN_RECV && view.state !== SS.TIME_WAIT);
}

function canonicalIpv6(address: string): string {
  const parsed = IPv6Address.tryParse(address);
  return parsed === null ? address : parsed.toString();
}

function isUnspecifiedIpv6(address: string): boolean {
  const parsed = IPv6Address.tryParse(address);
  return parsed !== null && parsed.isUnspecified();
}

export class SsRowPrinter {
  constructor(
    private readonly table: SsTable,
    private readonly request: SsRequest,
    private readonly host: SsOutputHost,
  ) {}

  printRow(view: SsSocketView): void {
    const full = isFullSocket(view);
    const v6only = view.family === 6 && (view.state === SS.LISTEN || view.state === SS.CLOSE);
    this.printState(view);
    this.printAddress(view.localAddress, view.localPort, view, v6only, view.row.entry.boundDevice ?? null);
    this.printAddress(view.remoteAddress, view.remotePort, view, v6only, null);
    if (full) this.printUsers(view);
    if (this.request.showOptions) this.printTimer(view);
    if (this.request.showDetails > 0) this.printDetails(view, full, v6only);
    if (this.request.showTos && full) this.printTos(view);
    if (this.request.showCgroup && full) this.printCgroup(view);
    if (this.request.showInetSockopt && full) this.printSocketOptions(view);
    if (this.request.showTcpInfo && view.protocol === 'tcp') this.printTcpInfo(view);
  }

  private printState(view: SsSocketView): void {
    const { table } = this;
    const { row } = view;
    table.set(COLUMN.NETID);
    table.out(view.protocol);
    table.set(COLUMN.STATE);
    table.out(STATE_NAMES[view.state]);
    const listening = view.state === SS.LISTEN;
    const receive = listening ? row.listener?.accept ?? 0 : row.queues.receive;
    const send = listening ? row.listener?.backlog ?? 0 : row.queues.send;
    table.set(COLUMN.RECVQ);
    table.out(String(receive).padEnd(6));
    table.set(COLUMN.SENDQ);
    table.out(String(send).padEnd(6));
    table.set(COLUMN.ADDR);
  }

  private printAddress(
    address: string, port: number, view: SsSocketView, v6only: boolean, device: string | null,
  ): void {
    const { table, request } = this;
    let shown: string;
    if (view.family === 4) {
      shown = (request.resolveHosts ? this.host.hostName(address) : null) ?? address;
    } else if (!v6only && isUnspecifiedIpv6(address)) {
      shown = '*';
    } else {
      const numeric = canonicalIpv6(address);
      const resolved = request.resolveHosts ? this.host.hostName(numeric) : null;
      shown = resolved ?? numeric;
      if (shown.includes(':')) shown = `[${shown}]`;
    }
    table.out(device === null ? `${shown}:` : `${shown}%${device}:`);
    table.next();
    table.out(this.portText(port, view.protocol));
    table.next();
  }

  private portText(port: number, protocol: 'tcp' | 'udp'): string {
    if (port === 0) return '*';
    if (this.request.numeric) return String(port);
    const { low, high } = this.host.ephemeralPorts();
    if (port >= low && port <= high) return String(port);
    return this.host.serviceName(port, protocol) ?? String(port);
  }

  private printUsers(view: SsSocketView): void {
    if (!this.request.showUsers) return;
    const { owner } = view.row;
    if (owner === null || owner.fd === null || !this.host.canInspectProcessOf(owner.uid)) return;
    this.table.out(` users:(("${owner.name}",pid=${owner.pid},fd=${owner.fd}))`);
  }

  private printTimer(view: SsSocketView): void {
    const { timer } = view.row;
    if (timer === null || view.protocol !== 'tcp') return;
    this.table.out(` timer:(${TIMER_NAME[timer.kind]},${printMsTimer(timer.expiresInMs)},${timer.retransmits})`);
  }

  private socketInode(view: SsSocketView): number {
    return view.state === SS.TIME_WAIT || view.state === SS.SYN_RECV ? 0 : view.row.entry.id;
  }

  private printDetails(view: SsSocketView, full: boolean, v6only: boolean): void {
    const { table } = this;
    const { row } = view;
    const uid = view.state === SS.TIME_WAIT ? 0 : row.owner?.uid ?? 0;
    if (uid !== 0) table.out(` uid:${uid}`);
    table.out(` ino:${this.socketInode(view)}`);
    table.out(` sk:${this.host.cookieOf(row.entry.id).toString(16)}`);
    this.printCgroup(view);
    if (!full) return;
    if (v6only) table.out(' v6only:1');
    const receiveShutdown = row.facts?.receiveShutdown === true;
    const sendShutdown = row.facts?.sendShutdown === true;
    table.out(` ${receiveShutdown ? '-' : '<'}-${sendShutdown ? '-' : '>'}`);
  }

  private printCgroup(view: SsSocketView): void {
    const owner = view.row.owner;
    if (owner === null || !isFullSocket(view)) return;
    const path = this.host.cgroupOf(owner.pid);
    if (path !== null) this.table.out(` cgroup:${path}`);
  }

  private printTos(view: SsSocketView): void {
    const tos = view.row.facts?.typeOfService ?? 0;
    this.table.out(` tos:${hexMask(tos)}`);
    if (view.family === 6) this.table.out(` tclass:${hexMask(tos)}`);
  }

  private printSocketOptions(view: SsSocketView): void {
    const { table, request } = this;
    table.out(request.oneline ? ' inet-sockopt: (' : '\n\tinet-sockopt: (');
    if (view.protocol === 'tcp') table.out(' is_icsk');
    table.out(' mc_loop');
    table.out(' mc_all');
    table.out(')');
  }

  private printTcpInfo(view: SsSocketView): void {
    const { table, request } = this;
    if (!request.oneline) table.out('\n\t');
    const { info, listener } = view.row;
    if (info !== null) {
      table.out(this.tcpInfoText(info));
      return;
    }
    if (view.state === SS.LISTEN) {
      table.out(` ${this.host.defaultCongestionControl()} cwnd:${TCP_INITIAL_CWND_SEGMENTS}`);
      if ((listener?.accept ?? 0) > 0) table.out(` unacked:${listener?.accept}`);
    }
  }

  private tcpInfoText(info: TcpInfo): string {
    const { request } = this;
    const parts: string[] = [];
    const add = (text: string): void => { parts.push(text); };
    if (request.showOptions) {
      if (info.timestamps) add(' ts');
      if (info.sack) add(' sack');
      if (info.ecn) add(' ecn');
      if (info.ecnSeen) add(' ecnseen');
    }
    if (info.congestionControl !== '') add(` ${info.congestionControl}`);
    if (info.windowScale !== null) add(` wscale:${info.windowScale.send},${info.windowScale.receive}`);
    if (info.rtoMs > 0 && wholeJiffies(info.rtoMs) !== 3000) add(` rto:${formatG(wholeJiffies(info.rtoMs))}`);
    if (info.backoff > 0) add(` backoff:${info.backoff}`);
    if (info.rttMs > 0) add(` rtt:${formatG(wholeMicroseconds(info.rttMs))}/${formatG(wholeMicroseconds(info.rttVarianceMs))}`);
    if (info.atoMs > 0) add(` ato:${formatG(wholeJiffies(info.atoMs))}`);
    if (info.sendMss > 0) add(` mss:${info.sendMss}`);
    if (info.pathMtu > 0) add(` pmtu:${info.pathMtu}`);
    if (info.receiveMss > 0) add(` rcvmss:${info.receiveMss}`);
    if (info.advertisedMss > 0) add(` advmss:${info.advertisedMss}`);
    if (info.sendCwnd > 0) add(` cwnd:${info.sendCwnd}`);
    if (info.sendSsthresh !== null && info.sendSsthresh > 0 && info.sendSsthresh < 0xffff) {
      add(` ssthresh:${info.sendSsthresh}`);
    }
    if (info.bytesSent > 0) add(` bytes_sent:${info.bytesSent}`);
    if (info.bytesRetrans > 0) add(` bytes_retrans:${info.bytesRetrans}`);
    if (info.bytesAcked > 0) add(` bytes_acked:${info.bytesAcked}`);
    if (info.bytesReceived > 0) add(` bytes_received:${info.bytesReceived}`);
    if (info.segmentsOut > 0) add(` segs_out:${info.segmentsOut}`);
    if (info.segmentsIn > 0) add(` segs_in:${info.segmentsIn}`);
    if (info.dataSegmentsOut > 0) add(` data_segs_out:${info.dataSegmentsOut}`);
    if (info.dataSegmentsIn > 0) add(` data_segs_in:${info.dataSegmentsIn}`);
    if (info.rttMs > 0 && info.sendMss > 0 && info.sendCwnd > 0) {
      const sendBitsPerSecond = (info.sendCwnd * info.sendMss * 8_000_000) / (wholeMicroseconds(info.rttMs) * 1000);
      add(` send ${bandwidthText(sendBitsPerSecond, request.numeric)}bps`);
    }
    if (info.lastDataSentMs >= 1) add(` lastsnd:${Math.floor(info.lastDataSentMs)}`);
    if (info.lastDataReceivedMs >= 1) add(` lastrcv:${Math.floor(info.lastDataReceivedMs)}`);
    if (info.lastAckReceivedMs >= 1) add(` lastack:${Math.floor(info.lastAckReceivedMs)}`);
    if (info.delivered > 0) add(` delivered:${info.delivered}`);
    if (info.unacked > 0) add(` unacked:${info.unacked}`);
    if (info.retrans > 0 || info.totalRetrans > 0) add(` retrans:${info.retrans}/${info.totalRetrans}`);
    if (info.lost > 0) add(` lost:${info.lost}`);
    if (info.sacked > 0) add(` sacked:${info.sacked}`);
    if (info.reordering !== 3) add(` reordering:${info.reordering}`);
    if (info.receiveSpace > 0) add(` rcv_space:${info.receiveSpace}`);
    if (info.receiveSsthresh > 0) add(` rcv_ssthresh:${info.receiveSsthresh}`);
    if (info.notSentBytes > 0) add(` notsent:${info.notSentBytes}`);
    if (info.minRttMs !== null && info.minRttMs > 0) add(` minrtt:${formatG(wholeMicroseconds(info.minRttMs))}`);
    return parts.join('');
  }
}
