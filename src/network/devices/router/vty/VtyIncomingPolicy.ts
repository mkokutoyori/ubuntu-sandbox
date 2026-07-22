import { IPAddress, type IPv4Packet } from '../../../core/types';
import type { VtyLineConfigStore } from './VtyLineConfigStore';

export type VtyTransportKind = 'ssh' | 'telnet';

export type VtyAdmissionVerdict =
  | { accept: true }
  | { accept: false; kind: 'acl' | 'line-password' | 'no-line' | 'quiet-mode'; reason: string };

/** Minimal surface `VtyIncomingPolicy` needs from a `LoginBlocker`. */
export interface QuietModeGate {
  isBlocked(ip?: string, at?: number): boolean;
  remainingBlockSeconds(ip?: string, at?: number): number;
}

export interface VtyIncomingPolicyDeps {
  lines: () => VtyLineConfigStore;
  evaluateAcl: (name: string, packet: IPv4Packet) => 'permit' | 'deny' | null;
  localIp: () => string | null;
  hasFreeLine?: () => boolean;
  /**
   * `login block-for` device-wide quiet-mode gate. Only VTY (SSH/Telnet)
   * admission is ever routed through here — real IOS never blocks the
   * console, so callers must not wire this into a console login path.
   */
  loginBlocker?: () => QuietModeGate | null;
  /** `login quiet-mode access-class NAME` — sources it permits stay admitted during quiet-mode. */
  quietModeAccessClass?: () => string | null;
}

export class VtyIncomingPolicy {
  constructor(private readonly deps: VtyIncomingPolicyDeps) {}

  admit(transport: VtyTransportKind, sourceIp: string): VtyAdmissionVerdict {
    const quietModeRefusal = this.quietModeRefusal(sourceIp);
    if (quietModeRefusal) return quietModeRefusal;
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

  private quietModeRefusal(sourceIp: string): VtyAdmissionVerdict | null {
    const blocker = this.deps.loginBlocker?.();
    if (!blocker || !blocker.isBlocked()) return null;
    const aclName = this.deps.quietModeAccessClass?.();
    if (aclName && this.aclPermits(aclName, sourceIp)) return null;
    const remaining = blocker.remainingBlockSeconds();
    return { accept: false, kind: 'quiet-mode', reason: `Blocking new login for ${remaining} secs (quota exceeded)` };
  }

  private aclPermits(aclName: string, sourceIp: string): boolean {
    const src = IPAddress.tryParse(sourceIp);
    if (!src) return false;
    const dst = IPAddress.tryParse(this.deps.localIp() ?? '') ?? new IPAddress('0.0.0.0');
    const packet = synthTcpPacket(src, dst);
    return this.deps.evaluateAcl(aclName, packet) === 'permit';
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
