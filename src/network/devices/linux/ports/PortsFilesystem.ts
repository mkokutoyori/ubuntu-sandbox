import type { VirtualFileSystem } from '../VirtualFileSystem';
import type { KernelSocketRow } from '../network/KernelSocketRows';
import {
  renderProcNetTcp, renderProcNetUdp, renderProcNetRaw, renderProcNetUnix, renderProcNetSockstat, renderProcNetSockstat6,
} from './ProcNetTables';
import { newProtocolCounters, type ProtocolCounters } from '../../../layers/internet/ProtocolCounters';
import { STANDALONE_KERNEL_IP_FACTS, type KernelIpFacts } from '../LinuxIpv4Settings';

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
  }
}

export interface SnmpSnapshot {
  counters: ProtocolCounters;
  currEstab: number;
}

export interface LinuxSnmpSnapshot extends SnmpSnapshot {
  kernel: KernelIpFacts;
}

export function linuxSnmpSnapshot(counters?: ProtocolCounters, kernel?: KernelIpFacts): LinuxSnmpSnapshot {
  return { ...snmpSnapshot(counters), kernel: kernel ?? STANDALONE_KERNEL_IP_FACTS };
}

export function snmpSnapshot(counters?: ProtocolCounters): SnmpSnapshot {
  return {
    counters: counters ?? newProtocolCounters(),
    currEstab: counters?.tcpCurrEstab ?? 0,
  };
}

/** Render `/proc/net/snmp` — the per-protocol counter blocks (header/value pairs). */
export function renderProcNetSnmp(snapshot: LinuxSnmpSnapshot): string {
  const c = snapshot.counters;
  const k = snapshot.kernel;
  return [
    'Ip: Forwarding DefaultTTL InReceives InHdrErrors InAddrErrors ForwDatagrams InUnknownProtos InDiscards InDelivers OutRequests OutDiscards OutNoRoutes ReasmTimeout ReasmReqds ReasmOKs ReasmFails FragOKs FragFails FragCreates',
    `Ip: ${k.forwarding ? 1 : 2} ${k.defaultTtl} ${c.ipInReceives} ${c.ipInHdrErrors} ${c.ipInAddrErrors} ${c.ipForwDatagrams} ${c.ipInUnknownProtos} ${c.ipInDiscards} ${c.ipInDelivers} ${c.ipOutRequests} ${c.ipOutDiscards} ${c.ipOutNoRoutes} 0 ${c.ipReasmReqds} ${c.ipReasmOKs} ${c.ipReasmFails} ${c.ipFragOKs} ${c.ipFragFails} ${c.ipFragCreates}`,
    'Icmp: InMsgs InErrors InCsumErrors InDestUnreachs InTimeExcds InParmProbs InSrcQuenchs InRedirects InEchos InEchoReps InTimestamps InTimestampReps InAddrMasks InAddrMaskReps OutMsgs OutErrors OutDestUnreachs OutTimeExcds OutParmProbs OutSrcQuenchs OutRedirects OutEchos OutEchoReps OutTimestamps OutTimestampReps OutAddrMasks OutAddrMaskReps',
    `Icmp: ${c.icmpInMsgs} ${c.icmpInErrors} 0 ${c.icmpInDestUnreachs} ${c.icmpInTimeExcds} 0 0 ${c.icmpInRedirects} ${c.icmpInEchos} ${c.icmpInEchoReps} 0 0 0 0 ${c.icmpOutMsgs} ${c.icmpOutErrors} ${c.icmpOutDestUnreachs} ${c.icmpOutTimeExcds} 0 0 ${c.icmpOutRedirects} ${c.icmpOutEchos} ${c.icmpOutEchoReps} 0 0 0 0`,
    'IcmpMsg: InType8 OutType0',
    `IcmpMsg: ${c.icmpInEchos} ${c.icmpOutEchoReps}`,
    'Tcp: RtoAlgorithm RtoMin RtoMax MaxConn ActiveOpens PassiveOpens AttemptFails EstabResets CurrEstab InSegs OutSegs RetransSegs InErrs OutRsts InCsumErrors',
    `Tcp: 1 ${k.rtoMinMs} ${k.rtoMaxMs} -1 ${c.tcpActiveOpens} ${c.tcpPassiveOpens} ${c.tcpAttemptFails} ${c.tcpEstabResets} ${snapshot.currEstab} ${c.tcpInSegs} ${c.tcpOutSegs} ${c.tcpRetransSegs} ${c.tcpInErrs} ${c.tcpOutRsts} ${c.tcpInCsumErrors}`,
    'Udp: InDatagrams NoPorts InErrors OutDatagrams RcvbufErrors SndbufErrors InCsumErrors IgnoredMulti',
    `Udp: ${c.udpInDatagrams} ${c.udpNoPorts} ${c.udpInErrors} ${c.udpOutDatagrams} 0 0 ${c.udpInCsumErrors} 0`,
    'UdpLite: InDatagrams NoPorts InErrors OutDatagrams RcvbufErrors SndbufErrors InCsumErrors IgnoredMulti',
    `UdpLite: ${c.udpLiteInDatagrams} ${c.udpLiteNoPorts} ${c.udpLiteInErrors} ${c.udpLiteOutDatagrams} 0 0 ${c.udpLiteInCsumErrors} 0`,
    '',
  ].join('\n');
}
