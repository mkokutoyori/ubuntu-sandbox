import { IPAddress, type IPv4Packet } from '../../../core/types';
import type { VtyLineConfigStore } from './VtyLineConfigStore';

export type VtyTransportKind = 'ssh' | 'telnet';

export type VtyAdmissionVerdict =
  | { accept: true }
  | { accept: false; kind: 'acl' | 'line-password' | 'no-line'; reason: string };

export interface VtyIncomingPolicyDeps {
  lines: () => VtyLineConfigStore;
  evaluateAcl: (name: string, packet: IPv4Packet) => 'permit' | 'deny' | null;
  localIp: () => string | null;
  hasFreeLine?: () => boolean;
}

export class VtyIncomingPolicy {
  constructor(private readonly deps: VtyIncomingPolicyDeps) {}

  admit(transport: VtyTransportKind, sourceIp: string): VtyAdmissionVerdict {
    const aclRefusal = this.aclRefusal(sourceIp);
    if (aclRefusal) return aclRefusal;
    if (this.deps.hasFreeLine && !this.deps.hasFreeLine()) {
      return { accept: false, kind: 'no-line', reason: 'All vty lines are in use' };
    }
    if (transport === 'telnet') {
      const lineVerdict = this.deps.lines().incomingVerdict();
      if (!lineVerdict.accept) {
        return { accept: false, kind: 'line-password', reason: lineVerdict.reason };
      }
    }
    return { accept: true };
  }

  private aclRefusal(sourceIp: string): VtyAdmissionVerdict | null {
    const src = IPAddress.tryParse(sourceIp);
    if (!src) return null;
    const dst = IPAddress.tryParse(this.deps.localIp() ?? '') ?? new IPAddress('0.0.0.0');
    const packet = synthTcpPacket(src, dst);
    for (const block of this.deps.lines().all()) {
      const aclName = block.accessClassIn ?? block.aclInbound;
      if (!aclName) continue;
      if (this.deps.evaluateAcl(String(aclName), packet) === 'deny') {
        return { accept: false, kind: 'acl', reason: 'refused by access-class' };
      }
    }
    return null;
  }
}

function synthTcpPacket(src: IPAddress, dst: IPAddress): IPv4Packet {
  return {
    type: 'ipv4',
    version: 4,
    ihl: 5,
    tos: 0,
    sourceIP: src,
    destinationIP: dst,
    protocol: 6,
    ttl: 64,
    totalLength: 40,
    identification: 0,
    flags: 0,
    fragmentOffset: 0,
    headerChecksum: 0,
    payload: new Uint8Array(),
  } as unknown as IPv4Packet;
}
