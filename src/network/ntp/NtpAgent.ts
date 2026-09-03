import type { IEventBus } from '@/events/EventBus';
import { getDefaultScheduler, type IScheduler, type TimerHandle } from '@/events/Scheduler';
import {
  type NtpAssociation, type NtpConfig, type NtpPacket, type NtpMode,
  type NtpCounters, type NtpVersion, createNtpCounters,
  createDefaultNtpConfig, defaultAssociation, computeOffsetMs,
  UDP_PORT_NTP, NTP_VERSION,
} from './types';
import {
  IPAddress,
  type EthernetFrame, type IPv4Packet, type UDPPacket,
} from '../core/types';
import { Logger } from '../core/Logger';
import { calculerMacNtp, verifierMacNtp } from './auth';
import { verdictAccesNtp, type ActionNtp } from './accessGroups';
import {
  type NtpControlPacket, OPCODES_SERVIS, ERREURS_CONTROLE,
  motEtatSysteme, motEtatPair, SELECT,
  formaterVariables, formaterListeAssociations,
} from './control';
import {
  disciplinerHorloge, appliquerDecision, creerEtatHorloge,
  type EtatHorloge, type DecisionDiscipline, type ReglagesDiscipline,
} from './discipline';
import { buildUdpOverIpv4 } from '../layers/transport/UdpEgress';

export interface NtpHost {
  readonly id: string;
  readonly name: string;
  getHostname(): string;
  getPort(name: string): import('../hardware/Port').Port | undefined;
  getPorts(): import('../hardware/Port').Port[];
  sendFrame(portName: string, frame: EthernetFrame): void;
  /** ARP-aware send (queues on a cold cache instead of broadcasting) — falls back to broadcast when absent (mirrors `TcpHost`). */
  sendIpv4FrameArpAware(outPortName: string, ipPkt: IPv4Packet, nextHopIP: IPAddress): void;
}

export interface NtpAssociationOptions {
  readonly version?: NtpVersion;
  readonly sourceInterface?: string;
}

function applyAssociationOptions(
  association: NtpAssociation, options: NtpAssociationOptions,
): void {
  if (options.version !== undefined) association.version = options.version;
  if (options.sourceInterface !== undefined) {
    association.sourceInterface = options.sourceInterface;
  }
}

export class NtpAgent {
  private config: NtpConfig = createDefaultNtpConfig();
  private readonly emitting = new Set<string>();
  private pollTimer: TimerHandle | null = null;
  private scheduler: IScheduler | null = null;
  private running = false;

  constructor(
    private readonly host: NtpHost,
    private readonly getBus: () => IEventBus,
    private readonly getScheduler: () => IScheduler = () => getDefaultScheduler(),
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    if (this.config.enabled) this.startTimer();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.stopTimer();
  }

  getConfig(): Readonly<NtpConfig> { return this.config; }

  setEnabled(on: boolean): void {
    if (this.config.enabled === on) return;
    this.config.enabled = on;
    if (on) this.startTimer();
    else this.stopTimer();
    if (!on) {
      this.getBus().publish({
        topic: 'ntp.unsynced',
        payload: { deviceId: this.host.id, hostname: this.host.getHostname(), reason: 'admin-disabled' },
      });
      this.config.localStratum = 16;
      this.config.lastSyncMs = 0;
    }
  }

  setServerMode(on: boolean): void {
    this.config.serverMode = on;
    if (on && this.config.localStratum === 16) {
      this.config.localStratum = 8;
      this.config.refIdentifier = 'LOCL';
    }
  }

  addServer(
    serverIp: string, prefer = false, keyId?: number,
    configuredAs: 'ntp' | 'sntp' = 'ntp', options: NtpAssociationOptions = {},
  ): void {
    if (!this.config.associations.has(serverIp)) {
      const a = defaultAssociation(serverIp, prefer);
      if (keyId !== undefined) a.keyId = keyId;
      a.configuredAs = configuredAs;
      applyAssociationOptions(a, options);
      this.config.associations.set(serverIp, a);
    } else {
      const a = this.config.associations.get(serverIp)!;
      if (prefer) a.prefer = true;
      if (keyId !== undefined) a.keyId = keyId;
      a.configuredAs = configuredAs;
      applyAssociationOptions(a, options);
    }
    if (this.config.enabled) {
      try { this.poll(serverIp); } catch { /* invalid target — keep the configuration entry, polling will retry once reachable */ }
    }
  }

  removeServer(serverIp: string): void {
    this.config.associations.delete(serverIp);
  }

  addPeer(
    peerIp: string, prefer = false, keyId?: number,
    options: NtpAssociationOptions = {},
  ): void {
    if (!this.config.associations.has(peerIp)) {
      const a = defaultAssociation(peerIp, prefer, 'symmetric-active');
      if (keyId !== undefined) a.keyId = keyId;
      applyAssociationOptions(a, options);
      this.config.associations.set(peerIp, a);
    } else {
      const a = this.config.associations.get(peerIp)!;
      a.mode = 'symmetric-active';
      if (prefer) a.prefer = true;
      if (keyId !== undefined) a.keyId = keyId;
      applyAssociationOptions(a, options);
    }
    if (this.config.enabled) {
      try { this.poll(peerIp); } catch { /* invalid target — keep the configuration entry, polling will retry once reachable */ }
    }
  }

  setSourceInterface(name: string): void { this.config.sourceInterface = name; }

  /**
   * Comment cette machine evalue une liste d'acces (lot N6).
   *
   * L'agent ne connait pas les ACL — elles vivent sur l'equipement — et
   * ce port etroit est le meme motif que `NATEngine.setACLMatchFn`.
   * Sans lui, `ntp access-group` restait une commande rangee que rien
   * ne consultait.
   */
  private aclMatch: ((acl: string, srcIp: string) => boolean) | null = null;
  setAclMatchFn(fn: (acl: string, srcIp: string) => boolean): void {
    this.aclMatch = fn;
  }

  /**
   * Ce paquet a-t-il le droit de faire ce qu'il demande ?
   *
   * Sans evaluateur d'ACL branche, tout passe : une machine sans notion
   * de liste d'acces ne peut pas filtrer, et refuser par defaut
   * couperait NTP sur tout equipement qui n'en a pas.
   */
  private accesAutorise(action: ActionNtp, srcIp: string): boolean {
    if (this.config.accessGroups.size === 0) return true;
    const fn = this.aclMatch;
    if (!fn) return true;
    return verdictAccesNtp(this.config.accessGroups, action, (acl) => fn(acl, srcIp));
  }
  setAllowModeControl(on: boolean): void { this.config.allowModeControl = on; }
  /** La plateforme sait-elle repondre au mode 6 ? Voir `NtpConfig`. */
  setModeControlResponder(on: boolean): void { this.config.modeControlResponder = on; }
  setUpdateCalendar(on: boolean): void { this.config.updateCalendar = on; }
  setInterfaceDisabled(iface: string, off: boolean): void {
    if (off) this.config.disabledInterfaces.add(iface);
    else this.config.disabledInterfaces.delete(iface);
  }
  isInterfaceDisabled(iface: string): boolean {
    return this.config.disabledInterfaces.has(iface);
  }
  /**
   * L'etat de la discipline d'horloge (lot N9).
   *
   * Il vit a cote de la configuration plutot que dedans : c'est un etat
   * de FONCTIONNEMENT, pas un reglage, et `show running-config` n'a
   * aucune raison de le rendre.
   */
  private horloge: {
    etat: EtatHorloge;
    dernierReglageMs: number;
    derniereDecision: DecisionDiscipline['quoi'] | null;
  } = { etat: creerEtatHorloge(), dernierReglageMs: 0, derniereDecision: null };

  private reglagesDiscipline: ReglagesDiscipline = {};

  /** `makestep <seuil> <limite>` de chrony, et l'equivalent d'un `-g`. */
  setReglagesDiscipline(r: ReglagesDiscipline): void { this.reglagesDiscipline = r; }
  getEtatHorloge(): Readonly<EtatHorloge> { return this.horloge.etat; }
  getDerniereDecision(): DecisionDiscipline['quoi'] | null {
    return this.horloge.derniereDecision;
  }

  /**
   * Forcer un saut : `chronyc makestep`, `w32tm /resync /force`.
   *
   * Elle existe parce qu'un operateur doit pouvoir passer outre la
   * discipline — c'est tout l'objet de la commande — et elle n'a d'effet
   * que s'il y a un ecart a rattraper.
   */
  forcerSaut(): boolean {
    const best = [...this.config.associations.values()].find((a) => a.preferred);
    if (!best) return false;
    this.horloge.etat = appliquerDecision(
      this.horloge.etat, { quoi: 'step', nouvelOffset: best.offsetMs }, 0);
    this.horloge.derniereDecision = 'step';
    this.config.offsetMs = this.horloge.etat.offsetApplique;
    return true;
  }

  /** Les compteurs, en lecture — ce que les trois vues lisent. */
  getCounters(): Readonly<NtpCounters> { return this.config.counters; }

  /** `clear ntp statistics` / `reset ntp-service statistics packet`. */
  clearCounters(): void { this.config.counters = createNtpCounters(); }

  getUptimeSec(): number {
    return Math.max(0, Math.floor((Date.now() - this.config.startedAtMs) / 1000));
  }
  removeAuthKey(id: number): void { this.config.authKeys.delete(id); }
  removeTrustedKey(id: number): void { this.config.trustedKeys.delete(id); }
  removeAccessGroup(kind: string): void { this.config.accessGroups.delete(kind); }
  getAssociation(ip: string): NtpAssociation | undefined {
    return this.config.associations.get(ip);
  }
  /**
   * L'ecart de frequence mesure, en parties par million. Il se DEDUIT de
   * l'offset et de l'intervalle de scrutation plutot que d'etre invente :
   * corriger un offset de 64 ms sur une periode de 64 s demande 1000 ppm.
   * Sans synchronisation il n'y a rien a mesurer, donc zero.
   */
  getDriftPpm(): number {
    if (!this.isSynced()) return 0;
    const best = [...this.config.associations.values()].find((a) => a.preferred);
    if (!best || best.pollSec <= 0) return 0;
    return (best.offsetMs / 1000 / best.pollSec) * 1e6;
  }
  setAuthenticate(on: boolean): void { this.config.authenticate = on; }
  addAuthKey(id: number, algo: string, key: string): void { this.config.authKeys.set(id, { id, algo, key }); }
  addTrustedKey(id: number): void { this.config.trustedKeys.add(id); }
  setAccessGroup(kind: string, acl: string): void { this.config.accessGroups.set(kind, acl); }
  setLogging(on: boolean, spelling: 'ntp' | 'sntp' = 'ntp'): void {
    this.config.logging = on;
    if (on) this.config.loggingSpelling = spelling;
  }
  isLogging(): boolean { return this.config.logging; }
  setSntpBroadcastClient(on: boolean): void { this.config.sntpBroadcastClient = on; }

  asRunningConfigLines(): string[] {
    const lines: string[] = [];
    if (this.config.serverMode) {
      lines.push(`ntp master${this.config.localStratum !== 8 ? ' ' + this.config.localStratum : ''}`);
    }
    for (const [ip, a] of this.config.associations) {
      const kind = a.mode === 'symmetric-active' ? 'peer' : 'server';
      // `sntp server` est une AUTRE commande, pas un synonyme
      // d'affichage : la rendre en `ntp server` decrit une machine
      // qu'on n'a pas configuree, et la configuration est rejouee.
      const famille = a.configuredAs === 'sntp' ? 'sntp' : 'ntp';
      const options = [
        a.version !== undefined ? ` version ${a.version}` : '',
        a.sourceInterface ? ` source ${a.sourceInterface}` : '',
        a.keyId !== undefined ? ` key ${a.keyId}` : '',
        a.prefer ? ' prefer' : '',
      ].join('');
      lines.push(`${famille} ${kind} ${ip}${options}`);
    }
    if (this.config.sntpBroadcastClient) lines.push('sntp broadcast client');
    if (this.config.logging) lines.push(`${this.config.loggingSpelling} logging`);
    if (this.config.sourceInterface) lines.push(`ntp source ${this.config.sourceInterface}`);
    if (this.config.updateCalendar) lines.push('ntp update-calendar');
    if (!this.config.allowModeControl) lines.push('no ntp allow mode control');
    if (this.config.authenticate) lines.push('ntp authenticate');
    for (const k of this.config.authKeys.values()) {
      lines.push(`ntp authentication-key ${k.id} ${k.algo} ${k.key}`);
    }
    for (const id of this.config.trustedKeys) lines.push(`ntp trusted-key ${id}`);
    for (const [kind, acl] of this.config.accessGroups) {
      lines.push(`ntp access-group ${kind} ${acl}`);
    }
    return lines;
  }

  setLocalStratum(stratum: number): void {
    if (stratum < 0 || stratum > 16) return;
    this.config.localStratum = stratum;
  }

  getOffsetMs(): number { return this.config.offsetMs; }
  getStratum(): number { return this.config.localStratum; }
  isSynced(): boolean { return this.config.localStratum < 16; }

  now(): number {
    return Date.now() + this.config.offsetMs;
  }

  handleUdp(inPort: string, srcIp: IPAddress, udp: UDPPacket): void {
    if (!this.config.enabled) return;
    if (udp.destinationPort !== UDP_PORT_NTP && udp.sourcePort !== UDP_PORT_NTP) return;
    const brut = udp.payload as { type?: string } | undefined;
    // Le mode 6 partage le port 123 avec le temps lui-meme (RFC 9327),
    // donc l'aiguillage se fait sur la charge utile et non sur le port.
    if (brut && brut.type === 'ntp-control') {
      this.handleControl(inPort, srcIp, brut as NtpControlPacket);
      return;
    }
    const payload = udp.payload as NtpPacket | undefined;
    // Un datagramme sur le port 123 dont la charge utile n'est pas un
    // paquet NTP est une erreur de protocole, et c'est bien ce que le
    // compteur d'IOS nomme.
    if (!payload || payload.type !== 'ntp') {
      this.config.counters.protocolError++;
      return;
    }
    const c = this.config.counters;
    c.received++;
    if (payload.mode in c.receivedByMode) c.receivedByMode[payload.mode]++;
    // NTPv4 lit les versions 1 a 4 ; au-dela, le paquet est compte et
    // ecarte plutot que devine.
    if (payload.version < 1 || payload.version > 4) {
      c.badVersion++;
      c.dropped++;
      return;
    }

    this.getBus().publish({
      topic: 'ntp.packet.received',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        fromIp: srcIp.toString(), mode: payload.mode, stratum: payload.stratum,
      },
    });

    // ── Ce qu'un serveur verifie, et ce qu'il ne verifie pas ─────────
    //
    // Cette porte lisait `config.authenticate` et s'appliquait a TOUS les
    // paquets, donc une machine armee refusait de servir un client
    // ordinaire. **C'est l'inverse de ce que fait la commande.** La
    // documentation Cisco est explicite dans les deux sens : `ntp
    // authenticate` fait que « the system will not synchronize to a
    // device unless the device carries one of the specified
    // authentication keys » — elle gouverne ce que la machine CROIT, pas
    // ce qu'elle SERT ; et elle « does not ensure authentication of peer
    // associations », d'ou le `key N` par association. Un routeur
    // authentifiant continue donc de donner l'heure a qui la demande,
    // et c'est `ntp access-group` — non l'authentification — qui
    // restreint la clientele.
    //
    // Ce qui est verifie est donc ce qui PRESENTE une cle : une requete
    // portant un identifiant de cle est controlee, une requete nue est
    // servie. Le cote client, lui, est decide plus bas par
    // `authRequise`/`replyIsAuthentic`, ou il l'etait deja.
    if ((payload.mode === 'client' || payload.mode === 'symmetric-active')
        && payload.keyId !== undefined && payload.keyId !== 0) {
      const auth = this.checkAuthentication(payload);
      if (!auth.ok) {
        // Un serveur ne se TAIT pas devant une requete mal
        // authentifiee : il repond par un crypto-NAK. La documentation
        // de reference le dit mot pour mot — « If the client sends
        // authenticated packets, the server responds with authenticated
        // packets if correct, or a crypto-NAK packet if not ». C'est
        // aussi le comportement le plus instructif : le client apprend
        // que son authentification a echoue, au lieu d'un silence
        // indiscernable d'un serveur en panne.
        if (this.config.serverMode) this.envoyerCryptoNak(inPort, srcIp, payload);
        c.authFailures++;
        c.dropped++;
        this.getBus().publish({
          topic: 'ntp.auth.rejected',
          payload: {
            deviceId: this.host.id, hostname: this.host.getHostname(),
            fromIp: srcIp.toString(), reason: auth.reason,
          },
        });
        return;
      }
      c.authOk++;
    }

    // `processed` compte les paquets qui atteignent leur traitement. Il
    // est pose ICI, apres les portes de version et d'authentification,
    // et REPRIS par les deux motifs de rejet qui ne peuvent se decider
    // qu'apres l'aiguillage — un refus d'acces et un crypto-NAK. Le
    // comptage vit donc a un endroit par motif plutot qu'a trois points
    // de reussite, et `recus = traites + ecartes` reste une identite
    // verifiable plutot qu'une coincidence.
    c.processed++;

    if (payload.mode === 'client') {
      // `serve`, `serve-only` et `peer` autorisent une requete de temps ;
      // `query-only` ne l'autorise pas, et une source qu'aucun groupe ne
      // reconnait est ecartee.
      if (!this.accesAutorise('serve-time', srcIp.toString())) {
        this.refuserAcces(srcIp, 'serve-time');
        return;
      }
      if (this.config.serverMode) this.respondAsServer(inPort, srcIp, payload);
      return;
    }
    if (payload.mode === 'symmetric-active') {
      // Un pair symetrique demande a la fois a servir et a se
      // synchroniser : seul `peer` le permet.
      if (!this.accesAutorise('sync-from', srcIp.toString())) {
        this.refuserAcces(srcIp, 'sync-from');
        return;
      }
      this.handleSymmetricActive(inPort, srcIp, payload);
      return;
    }
    if (payload.mode === 'server' || payload.mode === 'symmetric-passive') {
      this.acceptServerReply(srcIp.toString(), payload);
    }
  }

  private handleSymmetricActive(inPort: string, peerIp: IPAddress, request: NtpPacket): void {
    const ip = peerIp.toString();
    let a = this.config.associations.get(ip);
    let responseMode: NtpMode;
    if (a && a.mode === 'symmetric-active') {
      responseMode = 'symmetric-active';
    } else {
      if (!a) {
        a = defaultAssociation(ip, false, 'symmetric-passive');
        this.config.associations.set(ip, a);
      }
      responseMode = 'symmetric-passive';
    }
    if (request.origTimestampMs !== 0) this.acceptServerReply(ip, request);
    this.respondSymmetric(inPort, peerIp, request, responseMode);
  }

  private respondSymmetric(inPort: string, peerIp: IPAddress, request: NtpPacket, mode: NtpMode): void {
    const port = this.host.getPort(inPort);
    if (!port) return;
    const srcIp = port.getIPAddress();
    if (!srcIp) return;
    const now = this.now();
    const reply: NtpPacket = {
      type: 'ntp', leapIndicator: 0, version: NTP_VERSION, mode,
      stratum: this.config.localStratum, poll: 6, precision: -20,
      rootDelay: 0, rootDispersion: 0,
      refIdentifier: this.config.refIdentifier,
      refTimestampMs: this.config.lastSyncMs || now,
      origTimestampMs: request.txTimestampMs,
      rxTimestampMs: now, txTimestampMs: now,
      keyId: request.keyId,
    };
    this.sendNtp(inPort, srcIp, peerIp, reply);
    this.getBus().publish({
      topic: 'ntp.peer.responded',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        peerIp: peerIp.toString(), mode, stratum: this.config.localStratum,
      },
    });
  }

  private respondAsServer(inPort: string, clientIp: IPAddress, request: NtpPacket): void {
    const port = this.host.getPort(inPort);
    if (!port) return;
    const srcIp = port.getIPAddress();
    if (!srcIp) return;
    const now = this.now();
    const reply: NtpPacket = {
      type: 'ntp', leapIndicator: 0, version: NTP_VERSION, mode: 'server',
      stratum: this.config.localStratum, poll: 6, precision: -20,
      rootDelay: 0, rootDispersion: 0,
      refIdentifier: this.config.refIdentifier,
      refTimestampMs: this.config.lastSyncMs || now,
      origTimestampMs: request.txTimestampMs,
      rxTimestampMs: now, txTimestampMs: now,
      keyId: request.keyId,
    };
    this.sendNtp(inPort, srcIp, clientIp, reply);
    this.getBus().publish({
      topic: 'ntp.server.responded',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        clientIp: clientIp.toString(), stratum: this.config.localStratum,
      },
    });
  }

  /**
   * Authentifier un paquet recu (lot N5).
   *
   * Elle ne regardait que le NUMERO de clé : nommer `key 1` suffisait a
   * etre accepte, sans jamais connaitre le secret. Elle verifie
   * desormais le condensé, qui est la seule chose qu'un usurpateur ne
   * peut pas fabriquer.
   *
   * Les quatre refus sont DISTINCTS parce qu'ils envoient l'operateur a
   * quatre endroits differents : pas de clé du tout (le pair n'est pas
   * configure), une clé inconnue (le numero ne correspond a rien ici),
   * une clé connue mais non declaree fiable (`trusted-key` manque), et
   * un condensé faux (les secrets different) — le seul qui denonce une
   * usurpation plutot qu'une faute de configuration.
   */
  /**
   * Le crypto-NAK : une reponse dont l'identifiant de cle vaut ZERO et
   * qui ne porte aucun condensé.
   *
   * Zero est reserve a cet usage — RFC 5905 autorise 65 535 cles « a
   * l'exclusion de zero » — ce qui rend le message reconnaissable sans
   * ambiguite : aucune cle legitime ne peut porter ce numero.
   */
  private envoyerCryptoNak(inPort: string, clientIp: IPAddress, request: NtpPacket): void {
    const srcIp = this.host.getPort(inPort)?.getIPAddress();
    if (!srcIp) return;
    const now = this.now();
    const nak: NtpPacket = {
      type: 'ntp', leapIndicator: 0, version: NTP_VERSION, mode: 'server',
      stratum: this.config.localStratum, poll: 6, precision: -20,
      rootDelay: 0, rootDispersion: 0,
      refIdentifier: this.config.refIdentifier,
      refTimestampMs: this.config.lastSyncMs || now,
      origTimestampMs: request.txTimestampMs,
      rxTimestampMs: now, txTimestampMs: now,
      keyId: 0,
    };
    // Il part SANS passer par la signature : `signer` ne trouverait
    // aucune cle numero zero, mais l'ecrire ici rend l'intention
    // explicite — un crypto-NAK non signe est ce qui le definit.
    this.sendNtp(inPort, srcIp, clientIp, nak);
  }

  /**
   * Un paquet ecarte par une liste d'acces.
   *
   * Le refus est SILENCIEUX sur le fil — un routeur qui repondrait
   * « tu n'as pas le droit » confirmerait son existence a qui le sonde,
   * ce qui est l'inverse d'un durcissement. L'evenement, lui, est
   * publie : c'est ce qui rend le refus observable depuis un test ou une
   * capture, sans rien emettre vers l'exterieur.
   */
  private refuserAcces(srcIp: IPAddress, action: ActionNtp): void {
    // Le paquet avait ete compte TRAITE — les portes d'acces sont
    // franchies apres l'aiguillage, une fois le mode connu — donc le
    // comptage est repris ici pour que l'identite
    // `recus = traites + ecartes` reste vraie. C'est le meme geste que
    // pour le crypto-NAK, et il vit a un seul endroit par motif.
    this.config.counters.processed--;
    this.config.counters.accessDenied++;
    this.config.counters.dropped++;
    this.getBus().publish({
      topic: 'ntp.access.denied',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        fromIp: srcIp.toString(), action,
      },
    });
  }

  /** Un paquet est-il un crypto-NAK ? */
  private estCryptoNak(pkt: NtpPacket): boolean {
    return pkt.keyId === 0 && !pkt.mac;
  }

  private checkAuthentication(
    payload: NtpPacket,
  ): { ok: boolean; reason: 'no-key' | 'untrusted-key' | 'unconfigured' | 'bad-mac' } {
    if (payload.keyId === undefined) return { ok: false, reason: 'no-key' };
    const cle = this.config.authKeys.get(payload.keyId);
    if (!cle) return { ok: false, reason: 'unconfigured' };
    if (!this.config.trustedKeys.has(payload.keyId)) return { ok: false, reason: 'untrusted-key' };
    if (!verifierMacNtp(cle.key, payload, payload.mac, cle.algo)) return { ok: false, reason: 'bad-mac' };
    return { ok: true, reason: 'no-key' };
  }

  /**
   * Signer un paquet sortant, quand l'association nomme une clé que
   * cette machine connait.
   *
   * Le condensé est pose EN DERNIER, une fois tous les champs remplis :
   * il couvre l'en-tete, donc tout champ ecrit apres lui l'invaliderait.
   */
  private signer(pkt: NtpPacket): NtpPacket {
    if (pkt.keyId === undefined) return pkt;
    const cle = this.config.authKeys.get(pkt.keyId);
    if (!cle) return pkt;
    return { ...pkt, mac: calculerMacNtp(cle.key, pkt, cle.algo) };
  }

  /**
   * Le verdict d'authentification sur une REPONSE de serveur.
   *
   * Il est separe du precedent parce que la question n'est pas la meme :
   * un serveur decide s'il ACCEPTE une requete, un client decide s'il
   * CROIT une reponse. Le client ne verifiait rien du tout — donc une
   * machine configuree pour n'accepter que des serveurs authentifies
   * acceptait n'importe quelle reponse, ce que la commande existe
   * precisement pour empecher.
   */
  private replyIsAuthentic(a: NtpAssociation, reply: NtpPacket): boolean {
    const cle = a.keyId !== undefined ? this.config.authKeys.get(a.keyId) : undefined;
    if (!cle) return false;
    if (!this.config.trustedKeys.has(a.keyId!)) return false;
    return verifierMacNtp(cle.key, reply, reply.mac, cle.algo);
  }

  /**
   * Cette association exige-t-elle une authentification ?
   *
   * Elle l'exige quand `ntp authenticate` arme le mecanisme ET que
   * `ntp server X key N` le rattache a ce serveur : les deux commandes
   * sont necessaires, ce que toutes les sources consultees soulignent
   * comme la premiere cause de « je croyais authentifier » — des cles
   * declarees mais aucun `ntp authenticate`.
   */
  private authRequise(a: NtpAssociation): boolean {
    return this.config.authenticate && a.keyId !== undefined;
  }

  private acceptServerReply(serverIp: string, reply: NtpPacket): void {
    const a = this.config.associations.get(serverIp);
    if (!a) return;
    // Se SYNCHRONISER sur une source demande `peer` — c'est le piege du
    // §3.7 : poser un `serve-only` seul empeche le routeur lui-meme de
    // se synchroniser, alors qu'il continue de servir l'heure.
    if (!this.accesAutorise('sync-from', serverIp)) {
      this.refuserAcces(new IPAddress(serverIp), 'sync-from');
      return;
    }
    // Le verdict est ENREGISTRE meme quand il est negatif : c'est lui que
    // `show ntp associations detail` rend par `authenticated`, et sans
    // trace un operateur n'aurait aucun moyen de distinguer « cle
    // refusee » de « serveur muet ».
    // Un crypto-NAK n'est PAS une mesure : c'est un refus. Le prendre
    // pour une source ferait regler l'horloge sur le paquet qui dit
    // « je te refuse » — defaut introduit puis attrape par le cas
    // « client sans aucune cle », qui se synchronisait sur le NAK.
    if (this.estCryptoNak(reply)) {
      // Un NAK a bien ete TRAITE — c'est ainsi qu'on sait que c'en est
      // un — mais il n'est pas une mesure : il compte comme ecarte, et
      // le traitement est repris pour que l'identite tienne.
      this.config.counters.processed--;
      this.config.counters.dropped++;
      this.config.counters.authFailures++;
      if (a.keyId !== undefined) a.authenticated = false;
      this.getBus().publish({
        topic: 'ntp.auth.rejected',
        payload: {
          deviceId: this.host.id, hostname: this.host.getHostname(),
          fromIp: serverIp, reason: 'bad-mac',
        },
      });
      return;
    }
    // `authenticated` ne se pose que si une authentification a ete
    // TENTEE : une association sans clé n'est ni authentifiee ni non
    // authentifiee, et l'annoncer dans un sens ou dans l'autre serait
    // affirmer une verification qui n'a pas eu lieu.
    if (!this.authRequise(a)) {
      a.authenticated = undefined;
    } else {
      const authentique = this.replyIsAuthentic(a, reply);
      a.authenticated = authentique;
      if (authentique) this.config.counters.authOk++;
      if (!authentique) {
      // Aucun message n'est journalise ici, et c'est DELIBERE : aucune
      // source consultee ne confirme qu'IOS emette un syslog sur echec
      // d'authentification NTP — le comportement rapporte est un rejet
      // SILENCIEUX, diagnostique par `show ntp associations detail` et
      // par `debug ntp validity`. Inventer un `%NTP-4-...` apprendrait a
      // chercher une ligne qu'un vrai routeur n'ecrit pas.
        this.getBus().publish({
          topic: 'ntp.auth.rejected',
          payload: {
            deviceId: this.host.id, hostname: this.host.getHostname(),
            fromIp: serverIp, reason: 'bad-mac',
          },
        });
        return;
      }
    }
    const t1 = reply.origTimestampMs;
    const t2 = reply.rxTimestampMs;
    const t3 = reply.txTimestampMs;
    const t4 = Date.now();
    if (t1 === 0) return;
    const { offset, delay } = computeOffsetMs(t1, t2, t3, t4);
    a.lastReplyMs = t4;
    a.reach = (a.reach >>> 1) | 0x80;
    a.stratum = reply.stratum;
    a.offsetMs = offset;
    a.delayMs = delay;
    a.dispersionMs = Math.abs(delay) * 0.5 + 1;
    a.synced = reply.stratum < 16;
    if (a.synced) this.selectAndSync();
  }

  private intersect(candidates: NtpAssociation[]): NtpAssociation[] {
    if (candidates.length <= 2) return candidates;
    type Edge = { time: number; lower: boolean };
    const edges: Edge[] = [];
    for (const c of candidates) {
      edges.push({ time: c.offsetMs - c.dispersionMs, lower: true });
      edges.push({ time: c.offsetMs + c.dispersionMs, lower: false });
    }
    edges.sort((x, y) => x.time - y.time || (x.lower === y.lower ? 0 : x.lower ? -1 : 1));
    let count = 0;
    let bestCount = 0;
    let bestLow = -Infinity;
    let bestHigh = Infinity;
    for (const e of edges) {
      if (e.lower) {
        count++;
        if (count > bestCount) { bestCount = count; bestLow = e.time; bestHigh = Infinity; }
      } else {
        if (count === bestCount && e.time < bestHigh) bestHigh = e.time;
        count--;
      }
    }
    const majority = Math.floor(candidates.length / 2) + 1;
    if (bestCount < majority) return candidates;
    return candidates.filter((c) => c.offsetMs >= bestLow && c.offsetMs <= bestHigh);
  }

  private selectAndSync(): void {
    const synced = [...this.config.associations.values()].filter((a) => a.synced);
    const truechimers = this.intersect(synced);
    let best: NtpAssociation | null = null;
    for (const a of truechimers) {
      if (!best) { best = a; continue; }
      if (a.prefer && !best.prefer) { best = a; continue; }
      if (a.prefer === best.prefer) {
        if (a.stratum < best.stratum) { best = a; continue; }
        if (a.stratum === best.stratum && a.dispersionMs < best.dispersionMs) best = a;
      }
    }
    if (!best) return;
    for (const a of this.config.associations.values()) a.preferred = a === best;
    // L'ecart n'est plus applique d'un coup : il traverse la discipline,
    // qui decide de glisser, de sauter, d'ecarter une aberration ou de
    // paniquer (lot N9). C'est le §2 du tutoriel, rendu observable.
    const maintenant = Date.now();
    const ecoule = this.horloge.dernierReglageMs
      ? maintenant - this.horloge.dernierReglageMs
      : (best.pollSec || 64) * 1000;
    const decision = disciplinerHorloge(
      this.horloge.etat, best.offsetMs, ecoule, this.reglagesDiscipline);
    this.horloge.etat = appliquerDecision(this.horloge.etat, decision, ecoule);
    this.horloge.dernierReglageMs = maintenant;
    this.horloge.derniereDecision = decision.quoi;
    // Une aberration ou une panique ne synchronise PAS : l'horloge garde
    // ce qu'elle avait, et la strate ne descend pas.
    if (decision.quoi === 'spike' || decision.quoi === 'panic') return;
    this.config.offsetMs = this.horloge.etat.offsetApplique;
    this.config.localStratum = best.stratum + 1;
    this.config.refIdentifier = best.serverIp;
    this.config.lastSyncMs = Date.now();
    this.getBus().publish({
      topic: 'ntp.synced',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        serverIp: best.serverIp, offsetMs: best.offsetMs, delayMs: best.delayMs,
        newStratum: this.config.localStratum,
      },
    });
    Logger.info(this.host.id, 'ntp:synced',
      `${this.host.name}: NTP synced with ${best.serverIp} stratum ${this.config.localStratum} offset ${best.offsetMs}ms`);
  }

  pollAll(): void {
    if (!this.config.enabled) return;
    for (const serverIp of this.config.associations.keys()) this.poll(serverIp);
  }

  private poll(serverIp: string): void {
    const a = this.config.associations.get(serverIp);
    if (!a) return;
    const sourcePort = this.findEgressPort(serverIp);
    if (!sourcePort) return;
    const srcIp = this.sourceIpFor(a, sourcePort.port);
    if (!srcIp) return;
    const now = Date.now();
    a.lastPollMs = now;
    const mode: NtpMode = a.mode === 'symmetric-active' ? 'symmetric-active' : 'client';
    const request: NtpPacket = {
      type: 'ntp', leapIndicator: 0, version: a.version ?? NTP_VERSION, mode,
      stratum: this.config.localStratum, poll: 6, precision: -20,
      rootDelay: 0, rootDispersion: 0, refIdentifier: this.config.refIdentifier,
      refTimestampMs: this.config.lastSyncMs,
      origTimestampMs: 0, rxTimestampMs: 0, txTimestampMs: now,
      keyId: a.keyId,
    };
    this.sendNtp(sourcePort.name, srcIp, new IPAddress(serverIp), request);
    this.getBus().publish({
      topic: 'ntp.packet.sent',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        serverIp, mode,
      },
    });
  }

  private sourceIpFor(
    association: NtpAssociation, egressPort: import('../hardware/Port').Port,
  ): IPAddress | null {
    const declaree = association.sourceInterface || this.config.sourceInterface;
    const nommee = declaree
      ? this.host.getPort(declaree)?.getIPAddress() ?? null
      : null;
    return nommee ?? egressPort.getIPAddress();
  }

  private findEgressPort(targetIp: string): { name: string; port: import('../hardware/Port').Port } | null {
    const target = targetIp.split('.').map(Number);
    for (const port of this.host.getPorts()) {
      const ip = port.getIPAddress();
      const mask = port.getSubnetMask();
      if (!ip || !mask) continue;
      const local = ip.toString().split('.').map(Number);
      const maskBits = mask.toString().split('.').map(Number);
      let same = true;
      for (let i = 0; i < 4; i++) {
        if ((local[i] & maskBits[i]) !== (target[i] & maskBits[i])) { same = false; break; }
      }
      if (same) return { name: port.getName(), port };
    }
    for (const port of this.host.getPorts()) {
      if (port.getIPAddress() && port.getIsUp() && port.isConnected()) {
        return { name: port.getName(), port };
      }
    }
    return null;
  }

  private sendNtp(portName: string, srcIp: IPAddress, dstIp: IPAddress, brut: NtpPacket): void {
    const port = this.host.getPort(portName);
    if (!port) return;
    this.config.counters.sent++;
    if (brut.mode in this.config.counters.sentByMode) {
      this.config.counters.sentByMode[brut.mode]++;
    }
    // La signature vit ICI plutot qu'a chacun des trois appelants :
    // requete, reponse de serveur et reponse symetrique doivent porter
    // le meme condensé, et trois endroits finiraient par diverger.
    const payload = this.signer(brut);
    this.emettreUdp(portName, port, srcIp, dstIp, payload, 48,
      `${portName}|${dstIp.toString()}`);
  }

  private emettreUdp(
    portName: string, port: import('../hardware/Port').Port,
    srcIp: IPAddress, dstIp: IPAddress,
    payload: unknown, payloadBytes: number, key: string,
  ): void {
    const ipPkt = buildUdpOverIpv4(srcIp, {
      destination: dstIp,
      destinationPort: UDP_PORT_NTP, sourcePort: UDP_PORT_NTP,
      payload, payloadBytes, source: srcIp,
    });
    if (this.emitting.has(key)) return;
    this.emitting.add(key);
    try {
      this.host.sendIpv4FrameArpAware(portName, ipPkt, dstIp);
    } finally { this.emitting.delete(key); }
  }

  private startTimer(): void {
    if (this.pollTimer !== null) return;
    const s = this.getScheduler();
    this.scheduler = s;
    this.pollTimer = s.setInterval(() => this.pollAll(), 64_000);
  }

  private stopTimer(): void {
    const s = this.scheduler ?? this.getScheduler();
    if (this.pollTimer !== null) { s.clear(this.pollTimer); this.pollTimer = null; }
  }

  // ── Mode 6 : les messages de controle (lot N11) ───────────────────

  /**
   * Un identifiant d'association est un entier de 16 bits que le serveur
   * attribue, pas une adresse : c'est ce que `ntpq -p` affiche et ce
   * qu'on repasse a `rv <id>`. Il est stable pour la duree de vie de
   * l'association, et jamais zero — zero designe la machine elle-meme.
   */
  private prochainIdAssoc = 1;
  private idsAssoc = new Map<string, number>();

  private idAssoc(serverIp: string): number {
    let id = this.idsAssoc.get(serverIp);
    if (id === undefined) { id = ++this.prochainIdAssoc; this.idsAssoc.set(serverIp, id); }
    return id;
  }

  private assocParId(id: number): NtpAssociation | undefined {
    for (const [ip, n] of this.idsAssoc) {
      if (n === id) return this.config.associations.get(ip);
    }
    return undefined;
  }

  /** Le champ `select` d'un pair, d'ou decoule le pointage de `ntpq -p`. */
  private selectDe(a: NtpAssociation): number {
    if (a.reach === 0) return SELECT.REJECT;
    if (a.preferred) return SELECT.SYSPEER;
    return a.synced ? SELECT.CANDIDATE : SELECT.OUTLIER;
  }

  /** Les variables systeme, celles que rend `rv 0`. */
  private variablesSysteme(): Record<string, string> {
    const cfg = this.config;
    const best = [...cfg.associations.values()].find((a) => a.preferred);
    return {
      version: 'ntpd 4.2.8p15',
      leap: String(cfg.localStratum < 16 ? 0 : 3),
      stratum: String(cfg.localStratum),
      precision: '-20',
      rootdelay: (best ? Math.abs(best.delayMs) : 0).toFixed(3),
      rootdisp: (best ? best.dispersionMs : 0).toFixed(3),
      refid: cfg.refIdentifier,
      offset: cfg.offsetMs.toFixed(3),
      frequency: this.getDriftPpm().toFixed(3),
      sys_jitter: '0.000',
      clk_jitter: '0.000',
      clk_wander: '0.000',
    };
  }

  /** Les variables d'un pair, celles que rend `rv <id>`. */
  private variablesPair(a: NtpAssociation): Record<string, string> {
    return {
      srcadr: a.serverIp,
      srcport: String(UDP_PORT_NTP),
      stratum: String(a.stratum),
      precision: '-20',
      reach: a.reach.toString(8).padStart(3, '0'),
      hpoll: String(Math.max(0, Math.round(Math.log2(a.pollSec)))),
      ppoll: String(Math.max(0, Math.round(Math.log2(a.pollSec)))),
      delay: a.delayMs.toFixed(3),
      offset: a.offsetMs.toFixed(3),
      jitter: a.dispersionMs.toFixed(3),
      dispersion: a.dispersionMs.toFixed(3),
    };
  }

  /**
   * Repondre — ou refuser — une requete de controle.
   *
   * Trois portes, dans cet ordre, et l'ordre est celui du sens :
   *
   * 1. **`no ntp allow mode control`** ferme la fonction entiere. Le
   *    refus est SILENCIEUX, comme celui d'une liste d'acces : une
   *    machine qui repondrait « je ne reponds pas aux requetes de
   *    controle » confirmerait son existence a qui la sonde, l'inverse
   *    d'un durcissement. C'est le reglage que CVE-2013-5211 a rendu
   *    obligatoire.
   * 2. **La liste d'acces**, action `control-query` — donc `peer`,
   *    `serve` et `query-only` l'autorisent, `serve-only` non. C'est
   *    exactement ce que `query-only` existe pour dire, et ce qui etait
   *    jusqu'ici inobservable.
   * 3. **L'opcode**, refuse par le bit E et le code de la RFC quand il
   *    n'est pas servi — nommer le refus vaut mieux que se taire, et
   *    c'est ce qui distingue « cette machine ne sait pas » de « cette
   *    machine ne repond pas ».
   */
  private handleControl(inPort: string, srcIp: IPAddress, req: NtpControlPacket): void {
    const c = this.config.counters;
    c.received++;
    c.receivedControl++;
    // Une REPONSE qui nous revient est pour le client, pas pour le
    // serveur : sans ce partage, une machine repondrait a sa propre
    // reponse, les deux portant le meme opcode.
    if (req.response) { this.derniereReponseControle = req; c.processed++; return; }
    // Une plateforme qui n'implemente pas le mode 6 ne le refuse pas :
    // elle ne le connait pas. Le paquet est compte et abandonne, sans
    // etre porte au compteur du DURCISSEMENT — confondre « la machine
    // ne sait pas » et « l'operateur a ferme » enverrait un diagnostic
    // au mauvais endroit.
    if (!this.config.modeControlResponder) { c.dropped++; return; }
    if (!this.config.allowModeControl) { c.dropped++; c.controlDenied++; return; }
    if (!this.accesAutorise('control-query', srcIp.toString())) {
      c.dropped++;
      this.getBus().publish({
        topic: 'ntp.access.denied',
        payload: {
          deviceId: this.host.id, hostname: this.host.getHostname(),
          fromIp: srcIp.toString(), action: 'control-query',
        },
      });
      c.accessDenied++;
      return;
    }
    c.processed++;
    if (!OPCODES_SERVIS.includes(req.opcode)) {
      this.repondreControle(inPort, srcIp, req, '', 0, ERREURS_CONTROLE.INVALID_OPCODE);
      return;
    }
    if (req.opcode === 1) {
      const entrees = [...this.config.associations.entries()].map(([ip, a]) => ({
        id: this.idAssoc(ip),
        status: motEtatPair(true, a.reach !== 0, this.selectDe(a), 0, 0),
      }));
      this.repondreControle(
        inPort, srcIp, req, formaterListeAssociations(entrees), this.motSysteme());
      return;
    }
    // Opcode 2. L'association 0 designe la machine elle-meme.
    if (req.associationId === 0) {
      this.repondreControle(
        inPort, srcIp, req, formaterVariables(this.variablesSysteme()), this.motSysteme());
      return;
    }
    const a = this.assocParId(req.associationId);
    if (!a) {
      this.repondreControle(
        inPort, srcIp, req, '', 0, ERREURS_CONTROLE.INVALID_ASSOCIATION);
      return;
    }
    this.repondreControle(
      inPort, srcIp, req, formaterVariables(this.variablesPair(a)),
      motEtatPair(true, a.reach !== 0, this.selectDe(a), 0, 0));
  }

  private motSysteme(): number {
    // La source d'horloge : 0 quand rien ne la discipline, 6 quand c'est
    // NTP — les deux seules valeurs que cette machine puisse atteindre.
    return motEtatSysteme(
      this.config.localStratum < 16 ? 0 : 3,
      this.config.localStratum < 16 ? 6 : 0, 0, 0);
  }

  private repondreControle(
    inPort: string, dstIp: IPAddress, req: NtpControlPacket,
    data: string, status = 0, erreur?: number,
  ): void {
    const srcIp = this.host.getPort(inPort)?.getIPAddress();
    if (!srcIp) return;
    const reponse: NtpControlPacket = {
      type: 'ntp-control', leapIndicator: 0, version: req.version,
      response: true, error: erreur !== undefined, more: false,
      opcode: req.opcode, sequence: req.sequence,
      // Le code d'erreur occupe l'octet de POIDS FORT du champ d'etat
      // (RFC 9327 §3.2) : c'est le meme champ que l'etat normal, ce qui
      // est precisement pourquoi le bit E doit exister pour les separer.
      status: erreur !== undefined ? (erreur & 0xff) << 8 : status,
      associationId: req.associationId, offset: 0,
      count: data.length, data,
    };
    this.envoyerControle(inPort, srcIp, dstIp, reponse);
  }

  /** La derniere reponse de controle recue — ce que lit `ntpq`. */
  private derniereReponseControle: NtpControlPacket | null = null;

  /**
   * Emettre une requete de controle et rendre la reponse.
   *
   * La livraison des trames est SYNCHRONE dans ce simulateur, donc la
   * reponse est deja arrivee quand l'emission rend la main. C'est la
   * meme hypothese que tout le reste du moteur NTP, et elle est ecrite
   * ici plutot que supposee.
   */
  controlQuery(
    cibleIp: string, opcode: number, associationId = 0,
  ): NtpControlPacket | null {
    const sortie = this.findEgressPort(cibleIp);
    if (!sortie) return null;
    const srcIp = sortie.port.getIPAddress();
    if (!srcIp) return null;
    this.derniereReponseControle = null;
    const req: NtpControlPacket = {
      type: 'ntp-control', leapIndicator: 0, version: 4,
      response: false, error: false, more: false,
      opcode, sequence: ++this.sequenceControle, status: 0,
      associationId, offset: 0, count: 0, data: '',
    };
    this.envoyerControle(sortie.name, srcIp, new IPAddress(cibleIp), req);
    const rep = this.derniereReponseControle;
    // Une reponse qui ne repond pas a CETTE requete n'en est pas une :
    // sans ce controle, une reponse en retard serait prise pour celle-ci.
    if (rep && rep.sequence !== req.sequence) return null;
    return rep;
  }

  private sequenceControle = 0;

  private envoyerControle(
    portName: string, srcIp: IPAddress, dstIp: IPAddress, pkt: NtpControlPacket,
  ): void {
    const port = this.host.getPort(portName);
    if (!port) return;
    this.config.counters.sent++;
    this.config.counters.sentControl++;
    this.emettreUdp(portName, port, srcIp, dstIp, pkt, 12 + pkt.data.length,
      `ctl|${portName}|${dstIp.toString()}`);
  }

  /** L'identifiant qu'une vue doit afficher pour une association. */
  associationId(serverIp: string): number { return this.idAssoc(serverIp); }
  /** Le mot d'etat d'une association, pour la vue locale. */
  peerStatus(a: NtpAssociation): number {
    return motEtatPair(true, a.reach !== 0, this.selectDe(a), 0, 0);
  }
}

