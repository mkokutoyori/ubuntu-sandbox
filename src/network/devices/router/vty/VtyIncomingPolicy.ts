import { IPAddress, type IPv4Packet } from '../../../core/types';
import type { VtyLineConfigStore } from './VtyLineConfigStore';
import { transportAdmet, type VtyTransport } from './VtyLineConfig';

export type VtyTransportKind = 'ssh' | 'telnet';

export type VtyAdmissionVerdict =
  | { accept: true }
  | { accept: false; kind: 'acl' | 'line-password' | 'no-line' | 'quiet-mode' | 'transport'; reason: string };

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
  /**
   * L'indice de la ligne qu'une session entrante prendrait, ou `null`
   * si la reserve est pleine. `transport input`, `access-class` et
   * `login` sont des directives de LIGNE : sans savoir laquelle, on ne
   * peut que les appliquer a tout l'equipement, ce qui fait refuser une
   * vty ouverte parce qu'une AUTRE est fermee.
   */
  ligneCandidate?: () => number | null;
  /** Reglage d'equipement, utilise par les lignes qui n'en declarent pas. */
  transportParDefaut?: () => VtyTransport;
}

export class VtyIncomingPolicy {
  constructor(private readonly deps: VtyIncomingPolicyDeps) {}

  admit(transport: VtyTransportKind, sourceIp: string): VtyAdmissionVerdict {
    const ligne = this.deps.ligneCandidate ? this.deps.ligneCandidate() : null;
    const transportRefusal = this.transportRefusal(transport, ligne);
    if (transportRefusal) return transportRefusal;
    const quietModeRefusal = this.quietModeRefusal(sourceIp);
    if (quietModeRefusal) return quietModeRefusal;
    const aclRefusal = this.aclRefusal(sourceIp, ligne);
    if (aclRefusal) return aclRefusal;
    if (this.deps.hasFreeLine && !this.deps.hasFreeLine()) {
      return { accept: false, kind: 'no-line', reason: 'All vty lines are in use' };
    }
    if (transport === 'telnet') {
      const lineVerdict = this.deps.lines().incomingVerdict(ligne);
      if (!lineVerdict.accept) {
        return { accept: false, kind: 'line-password', reason: lineVerdict.reason };
      }
    }
    return { accept: true };
  }

  /**
   * Le premier controle d'IOS, et celui qui decide avant tous les
   * autres : un protocole que la ligne n'admet pas ne se voit meme pas
   * demander de mot de passe.
   */
  private transportRefusal(transport: VtyTransportKind, ligne: number | null): VtyAdmissionVerdict | null {
    const defaut = this.deps.transportParDefaut?.() ?? 'all';
    const admis = ligne == null
      ? this.deps.lines().admetQuelquePart(transport, defaut)
      : (this.deps.lines().blocPourLigne(ligne)?.admetTransport(transport, defaut)
        ?? transportAdmet(defaut, transport));
    if (admis) return null;
    return { accept: false, kind: 'transport', reason: `${transport} is not permitted by transport input` };
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

  private aclRefusal(sourceIp: string, ligne: number | null): VtyAdmissionVerdict | null {
    const src = IPAddress.tryParse(sourceIp);
    if (!src) return null;
    const dst = IPAddress.tryParse(this.deps.localIp() ?? '') ?? new IPAddress('0.0.0.0');
    const packet = synthTcpPacket(src, dst);
    const bloc = ligne == null ? undefined : this.deps.lines().blocPourLigne(ligne);
    for (const block of bloc ? [bloc] : this.deps.lines().all()) {
      const aclName = block.accessClassIn ?? block.aclInbound;
      if (!aclName) continue;
      if (this.deps.evaluateAcl(String(aclName), packet) === 'deny') {
        return { accept: false, kind: 'acl', reason: 'refused by access-class' };
      }
    }
    return null;
  }
}

/**
 * Le paquet que l'on soumet à une ACL pour décider d'une CONNEXION
 * entrante, faute d'en avoir un vrai sous la main : une ACL juge un
 * paquet, alors qu'`access-class` juge une session. Exporté pour que le
 * serveur HTTP (`ip http access-class`) pose la question de la même
 * façon — deux synthèses différentes rendraient deux verdicts pour la
 * même liste et la même adresse.
 */
export function synthTcpPacket(src: IPAddress, dst: IPAddress): IPv4Packet {
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
