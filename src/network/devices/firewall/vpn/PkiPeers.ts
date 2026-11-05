import { canonicalDistinguishedName } from '../../../pki/der/DistinguishedName';
import type { X509Certificate } from '../../../pki/X509Certificate';

export interface PkiPeer {
  readonly name: string;
  readonly ca: string;
  readonly cn: string;
  readonly subject: string;
}

export class PkiPeerStore {
  private readonly peers = new Map<string, PkiPeer>();
  private readonly groups = new Map<string, readonly string[]>();

  setPeer(peer: PkiPeer): void { this.peers.set(peer.name, peer); }
  removePeer(name: string): void { this.peers.delete(name); }
  setGroup(name: string, members: readonly string[]): void { this.groups.set(name, [...members]); }
  removeGroup(name: string): void { this.groups.delete(name); }
  peer(name: string): PkiPeer | undefined { return this.peers.get(name); }
  peerNames(): readonly string[] { return [...this.peers.keys()]; }
  groupNames(): readonly string[] { return [...this.groups.keys()]; }

  accepts(
    peerName: string | undefined, groupName: string | undefined,
    cert: X509Certificate, issuerOf: (ca: string) => string | undefined,
  ): boolean {
    const candidates = groupName !== undefined
      ? (this.groups.get(groupName) ?? [])
      : peerName === undefined ? [] : [peerName];
    return candidates.some((name) => {
      const peer = this.peers.get(name);
      return peer !== undefined && this.matches(peer, cert, issuerOf);
    });
  }

  private matches(peer: PkiPeer, cert: X509Certificate, issuerOf: (ca: string) => string | undefined): boolean {
    if (peer.ca !== '') {
      const issuer = issuerOf(peer.ca);
      if (issuer === undefined || cert.issuer !== issuer) return false;
    }
    if (peer.subject !== '' && cert.subject !== canonicalDistinguishedName(peer.subject)) return false;
    if (peer.cn !== '' && commonNameOf(cert.subject) !== peer.cn) return false;
    return true;
  }
}

function commonNameOf(subject: string): string | undefined {
  return /(?:^|[,/])\s*CN\s*=\s*([^,/]+)/i.exec(subject)?.[1]?.trim();
}
