import type { SocketEntry, SocketState, SocketTable } from '@/network/core/SocketTable';
import type { TcpListener, TcpSocket, TcpStack } from '@/network/tcp/TcpStack';
import type { TcpInfo, TcpListenerQueues, TcpQueues, TcpSocketFacts, TcpTimer } from '@/network/tcp/TcpInfo';
import { kernelComm } from '../LinuxProcessManager';
import { socketStateOfTcp } from './TcpSocketStateProjection';

export interface SocketOwner {
  readonly pid: number;
  readonly uid: number;
  readonly name: string;
  readonly fd: number | null;
}

export interface ProcessDirectory {
  get(pid: number): { readonly pid: number; readonly uid: number; readonly comm: string } | undefined;
  firstWithName(comm: string): number | undefined;
  socketDescriptorsOf(pid: number): ReadonlyMap<number, number>;
}

export interface KernelSocketRow {
  readonly entry: SocketEntry;
  readonly state: SocketState;
  readonly owner: SocketOwner | null;
  readonly queues: TcpQueues;
  readonly listener: TcpListenerQueues | null;
  readonly timer: TcpTimer | null;
  readonly info: TcpInfo | null;
  readonly facts: TcpSocketFacts | null;
}

export interface KernelSocketSources {
  readonly table: SocketTable;
  readonly stack: Pick<TcpStack,
    'listSockets' | 'listListeners' | 'infoOf' | 'queuesOf' | 'timerOf' | 'listenerQueuesOf' | 'factsOf'> | null;
  readonly processes: ProcessDirectory;
}

const NO_QUEUES: TcpQueues = { receive: 0, send: 0 };

function connectionKey(localAddress: string, localPort: number, remoteAddress: string, remotePort: number): string {
  return `${localAddress}|${localPort}|${remoteAddress}|${remotePort}`;
}

function listenerKey(localAddress: string, localPort: number): string {
  return `${localAddress}|${localPort}`;
}

export function ownerPidOf(entry: SocketEntry, processes: Pick<ProcessDirectory, 'firstWithName'>): number | undefined {
  if (entry.pid !== undefined && entry.pid !== 0) return entry.pid;
  return entry.processName === undefined ? undefined : processes.firstWithName(entry.processName);
}

export function socketIdsOwnedBy(
  table: SocketTable, processes: Pick<ProcessDirectory, 'firstWithName'>, pid: number,
): number[] {
  return table.getAll().filter((entry) => ownerPidOf(entry, processes) === pid).map((entry) => entry.id);
}

function ownerOf(
  entry: SocketEntry, pid: number | undefined, processes: ProcessDirectory,
  descriptors: (pid: number) => ReadonlyMap<number, number>,
): SocketOwner | null {
  if (pid === undefined) return null;
  const process = processes.get(pid);
  if (process === undefined) return null;
  return {
    pid, uid: entry.uid ?? process.uid, name: kernelComm(entry.processName ?? process.comm),
    fd: descriptors(pid).get(entry.id) ?? null,
  };
}

export function kernelSocketRows(sources: KernelSocketSources): KernelSocketRow[] {
  const { table, stack, processes } = sources;
  const descriptorTables = new Map<number, ReadonlyMap<number, number>>();
  const descriptors = (pid: number): ReadonlyMap<number, number> => {
    let known = descriptorTables.get(pid);
    if (known === undefined) {
      known = processes.socketDescriptorsOf(pid);
      descriptorTables.set(pid, known);
    }
    return known;
  };
  const connections = new Map<string, TcpSocket>();
  const listeners = new Map<string, TcpListener>();
  if (stack !== null) {
    for (const socket of stack.listSockets()) {
      connections.set(connectionKey(socket.localIp, socket.localPort, socket.remoteIp, socket.remotePort), socket);
    }
    for (const listener of stack.listListeners()) listeners.set(listenerKey(listener.localIp, listener.localPort), listener);
  }

  const rows: KernelSocketRow[] = [];
  for (const entry of table.getAll()) {
    const ownerPid = ownerPidOf(entry, processes);
    if (entry.protocol !== 'tcp' || stack === null) {
      rows.push({
        entry, state: entry.state, owner: ownerOf(entry, ownerPid, processes, descriptors),
        queues: NO_QUEUES, listener: null, timer: null, info: null, facts: null,
      });
      continue;
    }
    if (entry.state === 'LISTEN') {
      const listener = listeners.get(listenerKey(entry.localAddress, entry.localPort));
      rows.push({
        entry, state: 'LISTEN', owner: ownerOf(entry, ownerPid, processes, descriptors),
        queues: NO_QUEUES, listener: listener === undefined ? null : stack.listenerQueuesOf(listener),
        timer: null, info: null, facts: null,
      });
      continue;
    }
    const socket = connections.get(connectionKey(entry.localAddress, entry.localPort, entry.remoteAddress, entry.remotePort));
    if (socket === undefined) {
      rows.push({
        entry, state: entry.state, owner: ownerOf(entry, ownerPid, processes, descriptors),
        queues: NO_QUEUES, listener: null, timer: null, info: null, facts: null,
      });
      continue;
    }
    const fullSocket = !socket.isRequestSock && socket.state !== 'time-wait';
    rows.push({
      entry,
      state: socketStateOfTcp(socket.state) ?? entry.state,
      owner: ownerOf(entry, ownerPid ?? socket.ownerPid ?? undefined, processes, descriptors),
      queues: stack.queuesOf(socket), listener: null, timer: stack.timerOf(socket),
      info: fullSocket ? stack.infoOf(socket) : null,
      facts: fullSocket ? stack.factsOf(socket) : null,
    });
  }
  return [
    ...rows.filter((row) => row.state === 'LISTEN'),
    ...rows.filter((row) => row.state !== 'LISTEN'),
  ];
}
