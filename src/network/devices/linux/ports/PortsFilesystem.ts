import type { VirtualFileSystem } from '../VirtualFileSystem';
import type { KernelSocketRow } from '../network/KernelSocketRows';
import {
  renderProcNetTcp, renderProcNetUdp, renderProcNetRaw, renderProcNetUnix, renderProcNetSockstat, renderProcNetSockstat6,
} from './ProcNetTables';
import type { ProtocolCounters } from '../../../layers/internet/ProtocolCounters';
import type { KernelIpFacts } from '../LinuxIpv4Settings';
import { linuxSnmpSnapshot, renderProcNetSnmp, renderProcNetSnmp6 } from './ProcNetSnmp';

/** Canonical filesystem locations the port subsystem maintains. */
export const PORT_PATHS = {
  services: '/etc/services',
  procNetTcp: '/proc/net/tcp',
  procNetTcp6: '/proc/net/tcp6',
  procNetUdp: '/proc/net/udp',
  procNetUdp6: '/proc/net/udp6',
  procNetUdpLite: '/proc/net/udplite',
  procNetUdpLite6: '/proc/net/udplite6',
  procNetRaw: '/proc/net/raw',
  procNetRaw6: '/proc/net/raw6',
  procNetUnix: '/proc/net/unix',
  procNetSnmp: '/proc/net/snmp',
  procNetSnmp6: '/proc/net/snmp6',
  procNetSockstat: '/proc/net/sockstat',
  procNetSockstat6: '/proc/net/sockstat6',
  procNetDir: '/proc/net',
} as const;

export class PortsFilesystem {
  constructor(private readonly vfs: VirtualFileSystem) {}

  registerProcNet(
    rows: () => KernelSocketRow[], counters?: () => ProtocolCounters, kernel?: () => KernelIpFacts,
  ): void {
    this.vfs.mkdirp(PORT_PATHS.procNetDir, 0o555, 0, 0);
    this.vfs.registerGeneratedFile(PORT_PATHS.procNetTcp, () => renderProcNetTcp(rows(), 4));
    this.vfs.registerGeneratedFile(PORT_PATHS.procNetTcp6, () => renderProcNetTcp(rows(), 6));
    this.vfs.registerGeneratedFile(PORT_PATHS.procNetUdp, () => renderProcNetUdp(rows(), 4, 'udp'));
    this.vfs.registerGeneratedFile(PORT_PATHS.procNetUdp6, () => renderProcNetUdp(rows(), 6, 'udp'));
    this.vfs.registerGeneratedFile(PORT_PATHS.procNetUdpLite, () => renderProcNetUdp(rows(), 4, 'udplite'));
    this.vfs.registerGeneratedFile(PORT_PATHS.procNetUdpLite6, () => renderProcNetUdp(rows(), 6, 'udplite'));
    this.vfs.registerGeneratedFile(PORT_PATHS.procNetRaw, () => renderProcNetRaw(4));
    this.vfs.registerGeneratedFile(PORT_PATHS.procNetRaw6, () => renderProcNetRaw(6));
    this.vfs.registerGeneratedFile(PORT_PATHS.procNetUnix, () => renderProcNetUnix());
    this.vfs.registerGeneratedFile(PORT_PATHS.procNetSockstat, () => renderProcNetSockstat(rows()));
    this.vfs.registerGeneratedFile(PORT_PATHS.procNetSockstat6, () => renderProcNetSockstat6(rows()));
    this.vfs.registerGeneratedFile(PORT_PATHS.procNetSnmp, () =>
      renderProcNetSnmp(linuxSnmpSnapshot(counters?.(), kernel?.())),
    );
    this.vfs.registerGeneratedFile(PORT_PATHS.procNetSnmp6, () =>
      renderProcNetSnmp6(linuxSnmpSnapshot(counters?.(), kernel?.())),
    );
  }
}
