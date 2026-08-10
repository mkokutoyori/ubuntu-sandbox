/**
 * VrrpAgent — VRRPv2 (RFC 3768/5798) on the shared FHRP foundation.
 * Only the protocol-specific pieces live here: the 3-state machine
 * (init/backup/master), the IP-protocol-112 wire format, and the
 * master-down-interval expiry (3×advert + skew).
 */
import {
  type VrrpConfig, type VrrpGroupRuntime, type VrrpPacket, type VrrpState,
  defaultGroupRuntime, makeKey, vrrpVirtualMac,
  compareCandidate, masterDownIntervalMs, effectivePriority,
  IP_PROTO_VRRP, VRRP_MULTICAST_IP, VRRP_MULTICAST_MAC,
} from './types';
import {
  MACAddress, IPAddress,
  type EthernetFrame, type IPv4Packet,
  ETHERTYPE_IPV4, nextIPv4Id, computeIPv4Checksum,
} from '../core/types';
import { Logger } from '../core/Logger';
import { FhrpAgentBase } from '../fhrp/FhrpAgentBase';
import type { FhrpHost, FhrpRecomputeReason } from '../fhrp/types';
import type { TimerHandle } from '@/events/Scheduler';

export type VrrpHost = FhrpHost;

export class VrrpAgent extends FhrpAgentBase<VrrpGroupRuntime> {
  getConfig(): Readonly<VrrpConfig> { return this.config; }

  // ── FhrpAgentBase hooks ───────────────────────────────────────────
  protected groupId(g: VrrpGroupRuntime): number { return g.vrid; }

  protected makeGroup(iface: string, vrid: number): VrrpGroupRuntime {
    return defaultGroupRuntime(iface, vrid);
  }

  protected isSpeakingState(g: VrrpGroupRuntime): boolean {
    return g.state === 'master';
  }

  protected clearPeerState(g: VrrpGroupRuntime): void {
    g.masterIp = null;
  }

  protected helloIntervalMs(): number { return 1000; }
  protected override expiryProbeMs(): number { return 250; }

  // ── Protocol-specific config ─────────────────────────────────────
  setAdvertiseSec(iface: string, vrid: number, sec: number): void {
    const g = this.ensureGroup(iface, vrid);
    g.advertiseSec = sec;
    this.restartTimers();
  }

  addTrack(iface: string, vrid: number, target: string, decrement: number): void {
    const g = this.ensureGroup(iface, vrid);
    const existing = g.tracks.find((t) => t.target === target);
    if (existing) {
      existing.decrement = decrement;
    } else {
      const port = this.host.getPort(target);
      const down = !!port && (!port.getIsUp() || !port.isConnected());
      g.tracks.push({ target, decrement, down });
    }
    this.recompute(g, 'priority');
    this.advertiseIfDue(g);
  }

  removeTrack(iface: string, vrid: number, target: string): void {
    const g = this.getGroup(iface, vrid);
    if (!g) return;
    const idx = g.tracks.findIndex((t) => t.target === target);
    if (idx < 0) return;
    g.tracks.splice(idx, 1);
    this.recompute(g, 'priority');
    this.advertiseIfDue(g);
  }

  // ── Receive path ─────────────────────────────────────────────────
  handleIp(inPort: string, srcIp: IPAddress, ipPkt: IPv4Packet): void {
    if (!this.config.enabled) return;
    if (ipPkt.protocol !== IP_PROTO_VRRP) return;
    const payload = ipPkt.payload as VrrpPacket | undefined;
    if (!payload || payload.type !== 'vrrp') return;
    const g = this.config.groups.get(makeKey(inPort, payload.vrid));
    if (!g) return;
    if (g.vip && payload.vips.length > 0 && !payload.vips.includes(g.vip)) return;
    // L'authentification s'applique AVANT que l'annonce ne serve a quoi
    // que ce soit : une annonce qui echoue est ECARTEE, elle ne devient
    // ni un maitre ni une preuve de vie. La poser d'abord et verifier
    // ensuite laisserait un imposteur remettre le minuteur a zero, donc
    // empecher le basculement — exactement ce que la commande existe
    // pour empecher.
    if (!this.annonceAuthentique(g, payload)) {
      this.getBus().publish({
        topic: 'vrrp.auth.rejected',
        payload: {
          ...this.deviceRef(), iface: inPort, vrid: g.vrid,
          fromIp: payload.senderIp,
          reason: (payload.authType ?? 0) !== this.numeroAuth(g) ? 'type' : 'key',
        },
      });
      return;
    }

    this.getBus().publish({
      topic: 'vrrp.packet.received',
      payload: {
        ...this.deviceRef(),
        iface: inPort, vrid: g.vrid,
        fromIp: payload.senderIp, fromPriority: payload.priority,
      },
    });

    const oldMasterIp = g.masterIp;
    g.masterIp = payload.senderIp;
    g.masterPriority = payload.priority;
    g.lastHeardMasterMs = Date.now();

    if (oldMasterIp !== g.masterIp) {
      this.getBus().publish({
        topic: 'vrrp.master.changed',
        payload: {
          ...this.deviceRef(),
          iface: inPort, vrid: g.vrid,
          masterIp: g.masterIp, masterPriority: g.masterPriority,
        },
      });
    }
    this.recompute(g, 'peer');
    this.maybeAdvertiseBack(g);
  }

  // ── Wire format ──────────────────────────────────────────────────
  protected advertise(g: VrrpGroupRuntime): void {
    const port = this.host.getPort(g.iface);
    if (!port) return;
    const srcIp = port.getIPAddress();
    if (!srcIp) return;
    const payload: VrrpPacket = {
      type: 'vrrp', version: 2, vrid: g.vrid,
      priority: this.prioriteReelle(g, srcIp.toString()), advertiseSec: g.advertiseSec,
      vips: g.vip ? [g.vip] : [],
      senderIp: srcIp.toString(),
      // Le type de VRRPv2 : 0 aucune, 1 mot de passe simple. `md5` n'a
      // pas de numero dans la RFC — c'est une extension de constructeur
      // — et prend donc le 2, celui de l'authentification forte.
      authType: g.authMode === 'simple' ? 1 : g.authMode === 'md5' ? 2 : 0,
      authData: g.authMode && g.authMode !== 'none' ? (g.authKey ?? '') : undefined,
    };
    const ipPkt: IPv4Packet = {
      type: 'ipv4', version: 4, ihl: 5, tos: 0xc0, totalLength: 20 + 8 + (g.vip ? 4 : 0),
      identification: nextIPv4Id(), flags: 0, fragmentOffset: 0,
      ttl: 255, protocol: IP_PROTO_VRRP, headerChecksum: 0,
      sourceIP: srcIp, destinationIP: new IPAddress(VRRP_MULTICAST_IP),
      payload,
    };
    ipPkt.headerChecksum = computeIPv4Checksum(ipPkt);
    const eth: EthernetFrame = {
      srcMAC: port.getMAC(), dstMAC: new MACAddress(VRRP_MULTICAST_MAC),
      etherType: ETHERTYPE_IPV4, payload: ipPkt,
    };
    this.sendGuarded(g, eth);
    this.getBus().publish({
      topic: 'vrrp.packet.sent',
      payload: {
        ...this.deviceRef(),
        iface: g.iface, vrid: g.vrid, state: g.state, priority: g.priority,
      },
    });
  }

  /**
   * La priorite REELLE de ce routeur pour ce groupe.
   *
   * RFC 5798 §6.1 : le routeur qui POSSEDE l'adresse du routeur virtuel
   * — son interface porte exactement cette adresse — tourne a la
   * priorite 255 et devient toujours maitre. Ce n'est pas une valeur
   * qu'on configure : la CLI refuse d'ailleurs 255 (« reserve au
   * proprietaire »), donc sans cette regle la priorite 255 etait
   * INATTEIGNABLE et tout le code qui la traite etait mort.
   *
   * La possession est deduite de l'adresse a chaque lecture plutot que
   * rangee : elle change des qu'on renumerote l'interface ou qu'on
   * change l'adresse virtuelle, et un drapeau stocke se serait mis a
   * mentir a la premiere des deux.
   */
  private prioriteReelle(g: VrrpGroupRuntime, myIp: string | null): number {
    if (g.vip && myIp && myIp === g.vip) return 255;
    return effectivePriority(g);
  }

  private estProprietaire(g: VrrpGroupRuntime): boolean {
    return !!g.vip && this.linkContext(g).myIp === g.vip;
  }

  // ── Authentification (extension VRRPv2) ──────────────────────────

  /** Le numero de type qu'annonce ce groupe. */
  private numeroAuth(g: VrrpGroupRuntime): number {
    return g.authMode === 'simple' ? 1 : g.authMode === 'md5' ? 2 : 0;
  }

  /**
   * Cette annonce est-elle authentique pour ce groupe ?
   *
   * Deux desaccords possibles et ils sont DISTINGUES, parce qu'ils
   * envoient l'operateur a deux endroits : un type qui differe veut dire
   * que les deux routeurs n'ont pas la meme commande, une cle qui differe
   * veut dire qu'ils ne partagent pas le secret.
   *
   * Un groupe sans authentification accepte tout, y compris une annonce
   * qui en porte une : c'est le comportement de VRRPv2 et c'est aussi
   * la seule facon de ne pas casser une maquette ou un seul cote a ete
   * configure — il faut que l'operateur VOIE l'asymetrie plutot que de
   * perdre les deux sens d'un coup.
   */
  private annonceAuthentique(g: VrrpGroupRuntime, pkt: VrrpPacket): boolean {
    const attendu = this.numeroAuth(g);
    if (attendu === 0) return true;
    if ((pkt.authType ?? 0) !== attendu) return false;
    return (pkt.authData ?? '') === (g.authKey ?? '');
  }

  // ── Delai de preemption (extension de constructeur) ──────────────

  /**
   * Le delai de `preempt-mode timer delay` est-il ecoule ?
   *
   * Il ne retarde PAS le basculement : quand il n'y a plus de maitre du
   * tout, la reprise est immediate — c'est le chemin de la panne, et le
   * retarder ferait perdre du trafic pour rien. Ce qu'il retarde est la
   * PREEMPTION d'un maitre vivant qui annonce encore, ce que la
   * documentation Huawei donne comme sa raison d'etre : « to prevent
   * frequent switching of the VRRP group status ».
   *
   * L'horloge part au moment ou ce routeur devient eligible et est
   * REMISE A ZERO des qu'il cesse de l'etre, sans quoi une eligibilite
   * intermittente finirait par accumuler assez de temps pour preempter
   * sans avoir jamais ete stable une seule seconde.
   */
  private delaiPreemptionEcoule(g: VrrpGroupRuntime): boolean {
    // Le proprietaire n'attend jamais : la regle est enoncee une seule
    // fois, ici et dans la machine a etats, pour qu'elles ne puissent
    // pas diverger.
    if (this.estProprietaire(g)) { g.preemptEligibleSinceMs = null; return true; }
    const delai = g.preemptDelaySec ?? 0;
    if (delai <= 0) { g.preemptEligibleSinceMs = null; return true; }
    const now = Date.now();
    if (g.preemptEligibleSinceMs == null) {
      g.preemptEligibleSinceMs = now;
      // Le minuteur est arme ici, et il faut que quelque chose le
      // reveille : sans ce rendez-vous, la preemption n'aurait lieu qu'a
      // la prochaine annonce recue, donc jamais si le maitre se tait.
      this.armerReveilPreemption(g, delai * 1000);
      return false;
    }
    return now - g.preemptEligibleSinceMs >= delai * 1000;
  }

  private reveilsPreemption = new Map<string, TimerHandle>();

  private armerReveilPreemption(g: VrrpGroupRuntime, dansMs: number): void {
    const cle = makeKey(g.iface, g.vrid);
    if (this.reveilsPreemption.has(cle)) return;
    const s = this.getScheduler();
    this.reveilsPreemption.set(cle, s.setTimeout(() => {
      this.reveilsPreemption.delete(cle);
      this.recompute(g, 'preempt');
      this.advertiseIfDue(g);
    }, dansMs));
  }

  // ── State machine (RFC 3768 §6) ──────────────────────────────────
  protected recompute(g: VrrpGroupRuntime, reason: FhrpRecomputeReason): void {
    const oldState = g.state;
    const { myIp, linkUp } = this.linkContext(g);
    const newState: VrrpState = (() => {
      if (!linkUp || !g.vip) return 'init';
      const myPri = this.prioriteReelle(g, myIp);
      if (!g.masterIp || g.masterIp === myIp) return 'master';
      const me = { priority: myPri, ip: myIp };
      const master = { priority: g.masterPriority, ip: g.masterIp };
      if (compareCandidate(me, master) < 0) {
        // RFC 5798 §6.1 : le PROPRIETAIRE de l'adresse (priorite 255)
        // preempte toujours, « independent of the setting of this flag »
        // — donc ni le drapeau ni le delai ne s'appliquent a lui.
        if (myPri === 255) return 'master';
        if (!g.preempt) return 'backup';
        return this.delaiPreemptionEcoule(g) ? 'master' : 'backup';
      }
      return 'backup';
    })();
    g.state = newState;
    if (newState === 'master' && (g.masterIp === null || g.masterIp !== myIp)) {
      g.masterIp = myIp;
      g.masterPriority = this.prioriteReelle(g, myIp);
    }
    if (oldState !== g.state) {
      g.lastTransitionMs = Date.now();
      this.getBus().publish({
        topic: 'vrrp.state.changed',
        payload: {
          ...this.deviceRef(),
          iface: g.iface, vrid: g.vrid,
          oldState, newState: g.state, reason,
        },
      });
      Logger.info(this.host.id, 'vrrp:state',
        `${this.host.name}: ${g.iface} vrid ${g.vrid} ${oldState} → ${g.state}`);
      // RFC 5798 §6.4.1: on becoming master, broadcast a gratuitous
      // ARP carrying the virtual router MAC.
      if (g.state === 'master') {
        this.gratuitousVipArp(g, vrrpVirtualMac(g.vrid));
      }
    }
  }

  // ── Data-plane hooks (FhrpDataPlane) ─────────────────────────────
  // RFC 5798 §8.1.2: the master answers ARP for the VIP with the
  // virtual router MAC (00-00-5E-00-01-{VRID}) and forwards frames
  // addressed to it.
  protected vipArpMac(g: VrrpGroupRuntime): string | null {
    return g.state === 'master' ? vrrpVirtualMac(g.vrid) : null;
  }

  protected ownedVirtualMacs(g: VrrpGroupRuntime): string[] {
    return g.state === 'master' ? [vrrpVirtualMac(g.vrid)] : [];
  }

  protected isVipOwner(g: VrrpGroupRuntime): boolean {
    return g.state === 'master';
  }

  protected override onLinkUp(portName: string): void {
    for (const g of this.config.groups.values()) {
      let touched = false;
      for (const t of g.tracks) {
        if (t.target === portName && t.down) { t.down = false; touched = true; }
      }
      if (g.iface === portName) {
        this.recompute(g, 'config');
        this.advertiseIfDue(g);
      } else if (touched) {
        this.recompute(g, 'priority');
        this.advertiseIfDue(g);
      }
    }
  }

  protected override onLinkDown(portName: string): void {
    for (const g of this.config.groups.values()) {
      let touched = false;
      for (const t of g.tracks) {
        if (t.target === portName && !t.down) { t.down = true; touched = true; }
      }
      if (g.iface === portName) {
        this.clearPeerState(g);
        this.recompute(g, 'timeout');
      } else if (touched) {
        this.recompute(g, 'priority');
        this.advertiseIfDue(g);
      }
    }
  }

  // ── Master-down expiry (RFC 5798 §6.1) ───────────────────────────
  protected expireDue(): void {
    const now = Date.now();
    for (const g of this.config.groups.values()) {
      if (g.state !== 'backup') continue;
      if (!g.masterIp) continue;
      const downMs = masterDownIntervalMs(g.advertiseSec, effectivePriority(g));
      if (now - g.lastHeardMasterMs > downMs) {
        g.masterIp = null;
        g.masterPriority = 0;
        this.recompute(g, 'timeout');
      }
    }
  }
}
