import type { SocketTable } from '@/network/core/SocketTable';
import { kernelSocketRows, type KernelSocketRow, type ProcessDirectory } from '@/network/devices/linux/network/KernelSocketRows';
import { SocketCookies } from '@/network/devices/linux/network/SocketCookies';
import { runSs, type SsHost, type SsResult } from '@/network/devices/linux/commands/net/ss/SsRun';

export interface FixtureProcess {
  readonly pid: number;
  readonly uid: number;
  readonly comm: string;
  readonly descriptors?: Readonly<Record<number, number>>;
}

export function fixtureProcesses(list: readonly FixtureProcess[] = []): ProcessDirectory {
  return {
    get: (pid) => list.find((process) => process.pid === pid),
    firstWithName: (comm) => list.find((process) => process.comm === comm)?.pid,
    socketDescriptorsOf: (pid) => new Map(Object.entries(list.find((process) => process.pid === pid)?.descriptors ?? {})
      .map(([inode, fd]) => [Number(inode), fd])),
  };
}

export function ssHostOver(table: SocketTable, overrides: Partial<SsHost> = {}, processes: readonly FixtureProcess[] = []): SsHost {
  const cookies = new SocketCookies();
  const rows = (): KernelSocketRow[] => kernelSocketRows({ table, stack: null, processes: fixtureProcesses(processes) });
  return {
    rows,
    procFile: () => null,
    destroy: () => 'unsupported',
    screenWidth: () => null,
    hostName: () => null,
    serviceName: () => null,
    ephemeralPorts: () => ({ low: 32768, high: 60999 }),
    cgroupOf: () => null,
    cookieOf: (socketId) => cookies.of(socketId),
    defaultCongestionControl: () => 'reno',
    canInspectProcessOf: () => true,
    servicePort: () => null,
    hostAddresses: () => [],
    interfaceIndex: () => null,
    readFilterFile: () => null,
    stdin: undefined,
    namespaceExists: () => false,
    ...overrides,
  };
}

export function runSsOver(
  args: string[], table: SocketTable, overrides: Partial<SsHost> = {}, processes: readonly FixtureProcess[] = [],
): SsResult {
  return runSs(args, ssHostOver(table, overrides, processes));
}
