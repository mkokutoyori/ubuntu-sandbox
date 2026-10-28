import type { UnixSocketRow, UnixSocketType } from '../../../unix/UnixSocketTable';
import { AF, DB, SS, STATE_NAMES } from './SsModel';
import type { SsFilterSubject } from './SsFilterExpression';
import type { SsRequest } from './SsArguments';
import { COLUMN, SsTable } from './SsTable';
import { skmemText, type SocketBufferSettings } from './SsMemory';
import { padToWidth } from '@/network/devices/shells/cli/TextTable';

export interface SsUnixOwner {
  readonly pid: number;
  readonly uid: number;
  readonly name: string;
  readonly fd: number;
}

export interface SsUnixHost {
  unixSockets(): readonly UnixSocketRow[];
  unixOwners(row: UnixSocketRow): readonly SsUnixOwner[];
  fileDevice(path: string): number;
  socketBuffers(): SocketBufferSettings;
  canInspectProcessOf(uid: number): boolean;
}

export interface SsUnixView {
  readonly row: UnixSocketRow;
  readonly database: number;
  readonly state: number;
}

const DATABASE_OF: Readonly<Record<UnixSocketType, number>> = {
  stream: DB.UNIX_ST, dgram: DB.UNIX_DG, seqpacket: DB.UNIX_SQ,
};

const NETID_OF: Readonly<Record<UnixSocketType, string>> = {
  stream: 'u_str', dgram: 'u_dgr', seqpacket: 'u_seq',
};

const IDLE_QUEUES = { receive: 0, send: 0, unread: 0 } as const;

export function unixViewOf(row: UnixSocketRow): SsUnixView | null {
  if (row.inode === 0) return null;
  const state = row.state === 'listening' ? SS.LISTEN : row.state === 'connected' ? SS.ESTABLISHED : SS.CLOSE;
  return { row, database: DATABASE_OF[row.type], state };
}

export function unixFilterSubject(view: SsUnixView): SsFilterSubject {
  const none = new Uint8Array(16);
  return {
    local: { family: AF.UNIX, address: none, port: view.row.inode, name: view.row.path ?? '' },
    remote: { family: AF.UNIX, address: none, port: view.row.peerInode, name: '' },
    interfaceIndex: 0,
    mark: 0,
  };
}

export class SsUnixPrinter {
  constructor(
    private readonly table: SsTable,
    private readonly request: SsRequest,
    private readonly host: SsUnixHost,
  ) {}

  printRow(view: SsUnixView): void {
    const { table, request, host } = this;
    const { row } = view;
    const listening = view.state === SS.LISTEN;
    table.set(COLUMN.NETID);
    table.out(NETID_OF[row.type]);
    table.set(COLUMN.STATE);
    table.out(STATE_NAMES[view.state]);
    table.set(COLUMN.RECVQ);
    table.out(padToWidth(String(listening ? row.pending : row.unread), 6));
    table.set(COLUMN.SENDQ);
    table.out(padToWidth(String(listening ? row.backlog : 0), 6));
    table.set(COLUMN.ADDR);
    table.out(`${row.path ?? '*'} `);
    table.next();
    table.out(String(row.inode));
    table.next();
    table.out('* ');
    table.next();
    table.out(String(row.peerInode));
    table.next();
    if (request.showUsers) this.printUsers(row);
    if (request.showDetails > 0) this.printDetails(row, listening);
    if (request.showMemory) table.out(skmemText({ protocol: 'udp', listening: false, queues: IDLE_QUEUES, info: null }, host.socketBuffers()));
  }

  private printUsers(row: UnixSocketRow): void {
    const owners = this.host.unixOwners(row).filter((owner) => this.host.canInspectProcessOf(owner.uid));
    if (owners.length === 0) return;
    const entries = owners.map((owner) => `("${owner.name}",pid=${owner.pid},${this.request.showThreads ? `tid=${owner.pid},` : ''}fd=${owner.fd})`);
    this.table.out(` users:(${entries.join(',')})`);
  }

  private printDetails(row: UnixSocketRow, listening: boolean): void {
    const { table, host } = this;
    table.out(' <->');
    if (row.path !== null && row.fileInode !== null) table.out(` ino:${row.fileInode} dev:0/${host.fileDevice(row.path)}`);
    if (listening) table.out(` peers:${row.pendingPeers.map((peer) => ` ${peer}`).join('')}`);
  }
}
