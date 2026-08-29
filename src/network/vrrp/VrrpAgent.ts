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
  type VrrpStats, type VrrpGlobalStats, type VrrpAuthMode,
  createVrrpStats, createVrrpGlobalStats,
  IP_PROTO_VRRP, VRRP_MULTICAST_IP,
} from './types';
import {
  IPAddress,
  type IPv4Packet,
} from '../core/types';
import { Logger } from '../core/Logger';
import { FhrpAgentBase } from '../fhrp/FhrpAgentBase';
import type { FhrpHost, FhrpRecomputeReason } from '../fhrp/types';

export type VrrpHost = FhrpHost;

export class VrrpAgent extends FhrpAgentBase<VrrpGroupRuntime> {
  getConfig(): Readonly<VrrpConfig> { return this.config; }

  // ── Compteurs (`display vrrp statistics`) ─────────────────────────
  //
  // Ils etaient tous a zero ET sous des intitules INVENTES : la vue
  // annoncait `Advertisement sent`, `Become master` et `Track
  // interfaces`, dont aucun ne figure dans la sortie d'une vraie
  // machine. Ce qui suit compte au point ou l'evenement a lieu.
  //
  // Six compteurs restent structurellement nuls, et c'est un FAIT et
  // non un manque : ce simulateur ne SERIALISE pas ses paquets VRRP —
  // ils voyagent comme objets — donc il n'existe ni somme de controle a
  // fausser (`Checksum errors`), ni longueur a tronquer (`Packet length
  // errors`), ni octet de version a corrompre (`Version errors`), ni
  // VRID hors bornes (`Vrid errors`), ni type invalide (`Received
  // invalid type packets`) : `handleIp` n'accepte qu'une charge utile
  // deja typee `vrrp`. `Discarded packets since track admin-vrrp` l'est
  // pour une autre raison, ecrite ailleurs : le VRRP administratif est
  // refuse en nommant sa brique absente (lot V15).
  private globalStats: VrrpGlobalStats = createVrrpGlobalStats();

  getGlobalStats(): Readonly<VrrpGlobalStats> { return this.globalStats; }

  /** Les compteurs d'un groupe, crees a la demande. */
  stats(g: VrrpGroupRuntime): VrrpStats {
    return g.stats ?? (g.stats = createVrrpStats());
  }

  /** `reset vrrp statistics` : une commande qui promet de remettre a zero doit le faire. */
  resetStats(iface?: string, vrid?: number): void {
    this.globalStats = createVrrpGlobalStats();
    for (const g of this.config.groups.values()) {
      if (iface !== undefined && g.iface !== iface) continue;
      if (vrid !== undefined && g.vrid !== vrid) continue;
      g.stats = createVrrpStats();
    }
  }

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
    const c = this.stats(g);
    // RFC 5798 §5.1.1.3 : le TTL d'une annonce VRRP DOIT valoir 255, et
    // le recepteur DOIT ecarter le paquet sinon. C'est ce qui garantit
    // qu'elle n'a traverse aucun routeur — donc qu'elle vient bien du
    // lien local. Le controle n'existait pas ; son compteur, lui,
    // figure dans la vue depuis toujours.
    if (ipPkt.ttl !== 255) { c.receivedIpTtlErrors++; return; }
    // Une annonce emise par nous-memes et qui nous revient (un pont qui
    // boucle) n'est pas une preuve qu'un autre maitre existe.
    if (payload.senderIp === this.linkContext(g).myIp) { c.receivedSelfsend++; return; }
    if (g.vip && payload.vips.length > 0 && !payload.vips.includes(g.vip)) {
      c.receivedUnmatchedAddressList++;
      return;
    }
    // L'authentification s'applique AVANT que l'annonce ne serve a quoi
    // que ce soit : une annonce qui echoue est ECARTEE, elle ne devient
    // ni un maitre ni une preuve de vie. La poser d'abord et verifier
    // ensuite laisserait un imposteur remettre le minuteur a zero, donc
    // empecher le basculement — exactement ce que la commande existe
    // pour empecher.
    if (!this.annonceAuthentique(g, payload)) {
      const motif = (payload.authType ?? 0) !== this.numeroAuth(g) ? 'type' : 'key';
      // Les deux motifs ont leur PROPRE compteur sur une vraie machine,
      // et c'est ce qui rend le diagnostic possible : un type qui differe
      // veut dire que les deux routeurs n'ont pas la meme commande, une
      // cle qui differe qu'ils ne partagent pas le secret.
      if (motif === 'type') c.mismatchedAuthType++;
      else c.failedAuthCheck++;
      this.getBus().publish({
        topic: 'vrrp.auth.rejected',
        payload: {
          ...this.deviceRef(), iface: inPort, vrid: g.vrid,
          fromIp: payload.senderIp, reason: motif,
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

    c.receivedAdvertisements++;
    // Une annonce de priorite ZERO est une demission (RFC 5798 §6.4.3) :
    // elle est comptee a part parce qu'elle ne dit pas « je suis
    // maitre » mais « je cesse de l'etre ».
    if (payload.priority === 0) {
      c.receivedPriorityZero++;
      this.clearPeerState(g);
      this.recompute(g, 'timeout');
      this.advertiseIfDue(g);
      return;
    }
    // L'intervalle annonce doit correspondre au notre : un desaccord
    // ferait basculer les deux routeurs a tour de role.
    if (payload.advertiseSec !== g.advertiseSec) c.advertisementIntervalErrors++;
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
  protected advertise(g: VrrpGroupRuntime, prioriteForcee?: number): void {
    const port = this.host.getPort(g.iface);
    if (!port) return;
    const srcIp = port.getIPAddress();
    if (!srcIp) return;
    const payload: VrrpPacket = {
      type: 'vrrp', version: 2, vrid: g.vrid,
      priority: prioriteForcee ?? this.prioriteReelle(g, srcIp.toString()),
      advertiseSec: g.advertiseSec,
      vips: g.vip ? [g.vip] : [],
      senderIp: srcIp.toString(),
      // Le type de VRRPv2 : 0 aucune, 1 mot de passe simple. `md5` n'a
      // pas de numero dans la RFC — c'est une extension de constructeur
      // — et prend donc le 2, celui de l'authentification forte.
      authType: g.authMode === 'simple' ? 1 : g.authMode === 'md5' ? 2 : 0,
      authData: g.authMode && g.authMode !== 'none' ? (g.authKey ?? '') : undefined,
    };
    this.sendGuarded(g, {
      destination: new IPAddress(VRRP_MULTICAST_IP), source: srcIp,
      protocol: IP_PROTO_VRRP, ttl: 255,
      payload, payloadBytes: 8 + (g.vip ? 4 : 0),
      tos: 0xc0, flags: 0,
    });
    const c = this.stats(g);
    c.sentAdvertisements++;
    if (payload.priority === 0) c.sentPriorityZero++;
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

  protected groupIdOf(g: VrrpGroupRuntime): number { return g.vrid; }

  /**
   * `authentication-mode` (VRP) / `vrrp <n> authentication md5
   * key-string` (IOS) : un seul point d'entree pour les deux CLI.
   *
   * Cote Huawei la vue ecrivait directement sur le groupe ; cote Cisco
   * la commande ecrivait sur une facade que l'agent ne lit pas, donc
   * l'authentification VRRP etait inerte sur IOS alors qu'elle
   * fonctionnait sur VRP — deux magasins pour un fait, et un seul
   * constructeur servi.
   */
  setAuth(iface: string, vrid: number, mode: VrrpAuthMode, key?: string): void {
    const g = this.ensureGroup(iface, vrid);
    g.authMode = mode;
    g.authKey = key;
    this.recompute(g, 'config');
  }

  /**
   * La DEMISSION d'un maitre : une annonce de priorite zero.
   *
   * RFC 5798 §6.4.3 : un maitre qui s'arrete emet une annonce de
   * priorite 0 avant de partir. Ce n'est pas une politesse — c'est ce
   * qui fait basculer le secours **tout de suite** au lieu de lui faire
   * attendre l'intervalle de maitre absent (environ trois secondes).
   * Un laboratoire ou l'on coupe proprement un maitre et ou le
   * basculement prend trois secondes enseignerait que VRRP est lent
   * alors qu'il ne l'est que sur une PANNE.
   *
   * Sans cette emission, `Sent packets with priority zero` aurait ete un
   * compteur nul faute de fonction — et non par fait, ce qui est la
   * distinction que ce lot tient partout ailleurs.
   */
  private demissionner(g: VrrpGroupRuntime): void {
    if (g.state !== 'master') return;
    this.advertise(g, 0);
  }

  /**
   * `undo vrrp vrid <n>` : le groupe disparait, et il previent.
   */
  removeGroup(iface: string, id: number): void {
    const g = this.getGroup(iface, id);
    if (g) this.demissionner(g);
    super.removeGroup(iface, id);
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
        // Le proprietaire n'attend jamais (traite plus haut) ; pour
        // les autres, la regle est celle de la base, commune aux trois
        // familles.
        return this.preemptDelayElapsed(g) ? 'master' : 'backup';
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
      const c = this.stats(g);
      if (g.state === 'master') c.transitedToMaster++;
      else if (g.state === 'backup') c.transitedToBackup++;
      else c.transitedToInitialize++;
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
        this.stats(g).sentGratuitousArp++;
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
