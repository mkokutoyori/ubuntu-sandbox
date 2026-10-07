import type { SocketTable } from '@/network/core/SocketTable';
import { kernelSocketRows, type KernelSocketRow } from '@/network/devices/linux/network/KernelSocketRows';
import {
  renderProcNetTcp, renderProcNetUdp, renderProcNetRaw, renderProcNetUnix,
} from '@/network/devices/linux/ports/ProcNetTables';
import { runNetstat, type NetstatHost, type NetstatResult } from '@/network/devices/linux/commands/net/netstat/NetstatRun';
import { fixtureProcesses, type FixtureProcess } from './ssHost';

export function netstatHostOver(
  table: SocketTable, overrides: Partial<NetstatHost> = {}, processes: readonly FixtureProcess[] = [],
): NetstatHost {
  const rows = (): KernelSocketRow[] => kernelSocketRows({ table, stack: null, processes: fixtureProcesses(processes) });
  const files: Record<string, () => string> = {
    '/proc/net/tcp': () => renderProcNetTcp(rows(), 4),
    '/proc/net/tcp6': () => renderProcNetTcp(rows(), 6),
    '/proc/net/udp': () => renderProcNetUdp(rows(), 4, 'udp'),
    '/proc/net/udp6': () => renderProcNetUdp(rows(), 6, 'udp'),
    '/proc/net/udplite': () => renderProcNetUdp(rows(), 4, 'udplite'),
    '/proc/net/udplite6': () => renderProcNetUdp(rows(), 6, 'udplite'),
    '/proc/net/raw': () => renderProcNetRaw(4),
    '/proc/net/raw6': () => renderProcNetRaw(6),
    '/proc/net/unix': () => renderProcNetUnix(),
  };
  return {
    procFile: (path) => files[path]?.() ?? null,
    hostName: () => null,
    serviceName: () => null,
    userName: () => null,
    programOf: () => null,
    programNotice: () => '',
    routes: () => '',
    interfaces: () => '',
    statistics: () => '',
    ...overrides,
  };
}

export function runNetstatOver(
  args: string[], table: SocketTable, overrides: Partial<NetstatHost> = {}, processes: readonly FixtureProcess[] = [],
): NetstatResult {
  return runNetstat(args, netstatHostOver(table, overrides, processes));
}
