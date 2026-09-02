import type { UtmVerdict, UtmVerdictKind } from '../../../inspection/ContentInspector';
import type { PacketContext } from '../../../pipeline/PacketContext';
import type { FirewallLogDraft } from '../../../logging/FirewallLogStore';
import { portsOf } from '../../../diag/PacketCapture';
import type { IPv4Packet } from '../../../../../core/types';
import type { DosTraffic } from '../../../dos/DosGate';

interface UtmShape {
  readonly subtype: string;
  readonly logid: string;
  readonly category: number;
}

const UTM_SHAPE: Readonly<Record<Exclude<UtmVerdictKind, 'clean'>, UtmShape>> =
  Object.freeze({
    virus: { subtype: 'virus', logid: '0201009237', category: 2 },
    'url-blocked': { subtype: 'webfilter', logid: '0316013056', category: 3 },
    'category-blocked': { subtype: 'webfilter', logid: '0317013312', category: 3 },
    'dns-blocked': { subtype: 'dns', logid: '1501054600', category: 12 },
    'file-type-blocked': { subtype: 'file-filter', logid: '0317013318', category: 15 },
    'application-blocked': { subtype: 'app-ctrl', logid: '1059028704', category: 10 },
  });

export const UTM_CATEGORY_BY_SUBTYPE: Readonly<Record<string, number>> = Object.freeze({
  virus: 2, webfilter: 3, ips: 4, emailfilter: 5, anomaly: 7,
  voip: 8, dlp: 9, 'app-ctrl': 10, waf: 11, dns: 12,
  ssh: 13, ssl: 14, 'file-filter': 15, icap: 16,
});

export function anomalyLog(
  finding: {
    anomaly: string; action: string; observed: number; threshold: number;
  },
  iface: string, traffic: DosTraffic, now: number,
): FirewallLogDraft {
  return {
    at: now,
    type: 'utm',
    subtype: 'anomaly',
    level: finding.action === 'block' ? 'alert' : 'warning',
    id: '0720018432',
    fields: {
      srcip: traffic.sourceIP,
      srcport: traffic.sourcePort ?? 0,
      srcintf: iface,
      dstip: traffic.destIP,
      dstport: traffic.destPort ?? 0,
      proto: traffic.protocol,
      attack: finding.anomaly,
      action: finding.action === 'block' ? 'clear_session' : 'detected',
      count: finding.observed,
      crscore: finding.threshold,
    },
  };
}

export function utmLog(
  context: PacketContext, verdict: UtmVerdict, now: number,
): FirewallLogDraft | undefined {
  if (verdict.kind === 'clean') return undefined;

  const shape = UTM_SHAPE[verdict.kind];
  const packet = context.originalPacket as IPv4Packet;
  const ports = portsOf(packet);

  return {
    at: now,
    type: 'utm',
    subtype: shape.subtype,
    level: verdict.blocked ? 'warning' : 'notice',
    id: shape.logid,
    fields: {
      srcip: packet.sourceIP.toString(),
      srcport: ports.source ?? 0,
      srcintf: context.ingressPort,
      dstip: packet.destinationIP.toString(),
      dstport: ports.destination ?? 0,
      dstintf: context.egressPort ?? '',
      proto: packet.protocol,
      policyid: context.matchedPolicy?.id ?? '0',
      profile: verdict.profile ?? '',
      action: verdict.blocked ? 'blocked' : 'monitored',
      hostname: verdict.host ?? '',
      url: verdict.url ?? '',
      filetype: verdict.fileType ?? '',
      app: verdict.application ?? '',
      msg: verdict.detail,
    },
  };
}
