import type { IEventBus } from '@/events/EventBus';
import { getDefaultScheduler, type IScheduler, type TimerHandle } from '@/events/Scheduler';
import { DuplicateEventFilter } from '@/events/DuplicateEventFilter';
import {
  type SyslogConfig, type SyslogServer, type SyslogPacket,
  type SyslogSeverityName, type SyslogFacilityName,
  createDefaultSyslogConfig, defaultServer,
  shouldForward, bsdTimestamp, syslogSeverityFromNum,
  SYSLOG_SEVERITY, SYSLOG_FACILITY, syslogTagOf,
} from './types';
import {
  IPAddress,
  type EthernetFrame, type IPv4Packet,
} from '../core/types';
import {
  buildUdpOverIpv4, type UdpSendRequest,
} from '../layers/transport/UdpEgress';

export interface SyslogHost {
  readonly id: string;
  readonly name: string;
  getHostname(): string;
  getPort(name: string): import('../hardware/Port').Port | undefined;
  getPorts(): import('../hardware/Port').Port[];
  sendFrame(portName: string, frame: EthernetFrame): void;
  /** ARP-aware send (queues on a cold cache instead of broadcasting) — falls back to broadcast when absent (mirrors `TcpHost`). */
  sendIpv4FrameArpAware?(outPortName: string, ipPkt: IPv4Packet, nextHopIP: IPAddress): void;
  /** Transport-layer egress (BRD-Modele-TCP-IP.md phase 5) — the agent hands over a datagram and knows nothing of MAC, TTL or checksum. */
  sendUdpDatagram?(request: UdpSendRequest): boolean;
  /** `logging server-arp` : resoudre le collecteur des sa configuration. */
  sendArpRequestFor?(ifaceName: string, targetIP: IPAddress): boolean;
  /**
   * `logging host <ip> transport tcp` : une VRAIE connexion, ouverte une
   * fois et gardee. Absente, le transport TCP ne peut pas etre honore et
   * l'agent le dit plutot que de retomber en UDP en silence.
   */
  tcpConnect?(ip: string, port: number, opts: {
    onOpen?: () => void; onClose?: () => void;
  }): { send(data: unknown): void; close(): void; readonly state: string } | null;
}

/**
 * L'intervalle de reconnexion vers un collecteur TCP tombe. C'est celui
 * d'IOS, et il est long expres : un collecteur qui ne repond pas ne doit
 * pas couter une tentative par message.
 */
const RECONNEXION_MS = 60_000;

/** Une connexion TCP vers un collecteur, et ce qui attend qu'elle s'ouvre. */
interface TcpLien {
  socket: { send(data: unknown): void; close(): void; readonly state: string } | null;
  attente: string[];
  ouverture: boolean;
  /**
   * Vrai quand la derniere tentative a echoue.
   *
   * Sans ce drapeau, la commande se mord la queue : ouvrir la connexion
   * echoue, l'echec produit un message (« Segment dropped … »), et ce
   * message tente d'ouvrir la connexion. Le bus etant asynchrone, ce
   * n'est pas une recursion qu'un verrou de reentrance arreterait —
   * c'est un aller-retour qui ne s'arrete jamais. Un vrai IOS ne
   * retente pas non plus a chaque message : il retente sur minuterie.
   * Ici la tentative reprend quand l'operateur touche a la
   * configuration du collecteur, ce qui est le moment ou il attend
   * qu'elle reprenne.
   */
  enPanne: boolean;
  /** La minuterie de reconnexion, quand une est armee. */
  retente: TimerHandle | null;
}

export class SyslogAgent {
  private config: SyslogConfig = createDefaultSyslogConfig();
  private unsubscribers: Array<() => void> = [];
  private running = false;

  constructor(
    private readonly host: SyslogHost,
    private readonly getBus: () => IEventBus,
    private readonly getScheduler: () => IScheduler = () => getDefaultScheduler(),
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.installSubscribers();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    for (const ip of [...this.liens.keys()]) this.fermerLien(ip);
    for (const u of this.unsubscribers) u();
    this.unsubscribers = [];
  }

  getConfig(): Readonly<SyslogConfig> { return this.config; }

  setEnabled(on: boolean): void { this.config.enabled = on; }

  setDefaultFacility(facility: SyslogFacilityName): void {
    this.config.defaultFacility = facility;
  }

  setDefaultSeverityThreshold(severity: SyslogSeverityName): void {
    this.config.defaultSeverityThreshold = severity;
    for (const s of this.config.servers.values()) {
      s.severityThreshold = severity;
    }
  }

  /**
   * `logging server-arp` — ARP vers chaque collecteur MAINTENANT, sans
   * attendre le premier message. Sans le mot-cle, la resolution a bien
   * lieu, mais seulement quand un datagramme est deja pret a partir.
   */
  arpForServers(): number {
    if (!this.host.sendArpRequestFor) return 0;
    let envoyees = 0;
    for (const s of this.config.servers.values()) {
      const egress = this.resolveEgress(s.ip);
      if (!egress) continue;
      if (this.host.sendArpRequestFor(egress.name, new IPAddress(s.ip))) envoyees++;
    }
    return envoyees;
  }

  /** `logging queue-limit [trap] <n>`. */
  setQueueLimit(n: number): void { this.config.queueLimit = Math.max(1, n); }

  setSourceInterface(iface: string | null): void {
    this.config.sourceInterface = iface;
  }

  addServer(ip: string, opts: {
    facility?: SyslogFacilityName; severityThreshold?: SyslogSeverityName;
    port?: number; transport?: 'udp' | 'tcp'; delimiter?: boolean;
  } = {}): void {
    if (this.config.servers.has(ip)) {
      const s = this.config.servers.get(ip)!;
      if (opts.facility) s.facility = opts.facility;
      if (opts.severityThreshold) s.severityThreshold = opts.severityThreshold;
      if (opts.port !== undefined) s.port = opts.port;
      if (opts.delimiter !== undefined) s.delimiter = opts.delimiter;
      // Toucher a la configuration du collecteur, c'est demander qu'on
      // reessaie : le lien en panne repart de zero.
      const lien = this.liens.get(ip);
      if (lien?.enPanne) this.liens.delete(ip);
      if (opts.transport !== undefined && opts.transport !== s.transport) {
        // Changer de transport ferme la connexion en cours : elle allait
        // vers l'autre protocole, et la garder ouverte enverrait les
        // messages suivants la ou personne ne les attend plus.
        this.fermerLien(ip);
        s.transport = opts.transport;
      }
      return;
    }
    const s = defaultServer(ip, opts.facility ?? this.config.defaultFacility,
                                opts.severityThreshold ?? this.config.defaultSeverityThreshold,
                                opts.port, opts.transport, opts.delimiter);
    this.config.servers.set(ip, s);
    this.getBus().publish({
      topic: 'syslog.server.changed',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        serverIp: ip, added: true,
      },
    });
  }

  removeServer(ip: string): void {
    if (!this.config.servers.delete(ip)) return;
    this.fermerLien(ip);
    this.getBus().publish({
      topic: 'syslog.server.changed',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        serverIp: ip, added: false,
      },
    });
  }

  listServers(): SyslogServer[] {
    return Array.from(this.config.servers.values()).sort((a, b) => a.ip.localeCompare(b.ip));
  }

  sendImmediate(severity: SyslogSeverityName, tag: string, message: string): void {
    for (const s of this.config.servers.values()) {
      if (!shouldForward(s.severityThreshold, severity)) {
        this.dropped(s.ip, 'threshold');
        continue;
      }
      this.deliver(s, severity, tag, message);
    }
  }

  private installSubscribers(): void {
    const localBus = this.getBus();
    const once = new DuplicateEventFilter();
    const subscribeEntryOn = (bus: IEventBus): void => {
      this.unsubscribers.push(bus.subscribeWhere(
        'device.syslog.entry',
        (p) => p.deviceId === this.host.id,
        (e) => {
          if (!once.firstSight(e)) return;
          this.onLoggingEntry({
            deviceId: e.payload.deviceId,
            severity: syslogSeverityFromNum(e.payload.severityNum),
            tag: e.payload.tag,
            mnemonic: e.payload.mnemonic,
            message: e.payload.message,
          });
        },
      ));
    };
    subscribeEntryOn(localBus);
  }

  private onLoggingEntry(p: {
    deviceId: string; severity: SyslogSeverityName; tag: string;
    mnemonic?: string; message: string;
  }): void {
    if (!this.config.enabled) return;
    if (this.config.servers.size === 0) return;
    const tag = syslogTagOf({
      tag: p.tag, severityNum: SYSLOG_SEVERITY[p.severity], mnemonic: p.mnemonic, message: p.message,
    });
    for (const s of this.config.servers.values()) {
      if (!shouldForward(s.severityThreshold, p.severity)) {
        this.dropped(s.ip, 'threshold');
        continue;
      }
      this.deliver(s, p.severity, tag, p.message);
    }
  }

  /**
   * Vrai pendant qu'un message part vers un collecteur.
   *
   * Émettre un message PRODUIT de l'activité réseau — et cette activité
   * produit des messages : une connexion refusée, un segment perdu. En
   * TCP la boucle se referme tout de suite (connexion refusée → message
   * → nouvelle connexion → refusée…) et bloque la machine. Un vrai
   * équipement ne journalise pas le transport de son propre journal ;
   * ce drapeau est cette règle, et il vaut pour les deux transports.
   */
  private enLivraison = false;

  private deliver(s: SyslogServer, severity: SyslogSeverityName, tag: string, message: string): void {
    if (this.enLivraison) return;
    this.enLivraison = true;
    try {
      this.deliverInterne(s, severity, tag, message);
    } finally {
      this.enLivraison = false;
    }
  }

  private deliverInterne(s: SyslogServer, severity: SyslogSeverityName, tag: string, message: string): void {
    if (s.transport === 'tcp') { this.deliverTcp(s, severity, tag, message); return; }
    const egress = this.resolveEgress(s.ip);
    if (egress && (!egress.port.getIsUp() || !egress.port.isConnected())) {
      this.dropped(s.ip, 'link-down'); return;
    }
    const srcIp = egress ? this.sourceIpFor(egress.port) : this.configuredSourceIp();
    if (!egress && !this.host.sendUdpDatagram) { this.dropped(s.ip, 'no-route'); return; }
    if (egress && !srcIp) { this.dropped(s.ip, 'no-source-ip'); return; }
    const facilityNum = SYSLOG_FACILITY[s.facility];
    const severityNum = SYSLOG_SEVERITY[severity];
    const payload: SyslogPacket = {
      type: 'syslog',
      facility: facilityNum, severity: severityNum,
      hostname: this.host.getHostname(),
      tag, message,
      timestamp: bsdTimestamp(Date.now()),
    };
    const request: UdpSendRequest = {
      destination: new IPAddress(s.ip),
      destinationPort: s.port,
      sourcePort: 49152 + ((s.count + 1) & 0x3fff),
      payload,
      payloadBytes: payload.message.length + payload.tag.length + 32,
      ...(srcIp ? { source: srcIp } : {}),
    };
    if (this.host.sendUdpDatagram) {
      if (!this.host.sendUdpDatagram(request)) { this.dropped(s.ip, 'no-route'); return; }
    } else if (egress && srcIp && this.host.sendIpv4FrameArpAware) {
      this.host.sendIpv4FrameArpAware(
        egress.name, buildUdpOverIpv4(srcIp, request), request.destination);
    } else {
      this.dropped(s.ip, 'no-route');
      return;
    }
    this.compter(s, severity, tag, message);
  }

  private readonly liens = new Map<string, TcpLien>();

  /**
   * La ligne telle qu'elle part sur le fil, au format RFC 3164 :
   * `<PRI>timestamp hostname tag: message`. En UDP chaque datagramme EST
   * un message et rien ne les sépare ; en TCP ils se suivent sur une
   * seule connexion, d'où le délimiteur.
   */
  private ligneRfc3164(s: SyslogServer, severity: SyslogSeverityName,
                       tag: string, message: string): string {
    const pri = SYSLOG_FACILITY[s.facility] * 8 + SYSLOG_SEVERITY[severity];
    return `<${pri}>${bsdTimestamp(Date.now())} ${this.host.getHostname()} ${tag} ${message}`;
  }

  /**
   * RFC 6587 « non-transparent framing », qui est ce que fait IOS : une
   * connexion tenue ouverte, les messages à la queue leu leu.
   *
   * Ce qui manquait n'était pas le format mais la CONNEXION : le
   * transport était stocké, rendu dans la configuration, et le datagramme
   * partait en UDP quand même. Les messages produits avant que la
   * connexion soit établie sont mis en attente plutôt que perdus — sinon
   * le premier message de chaque session, celui qui dit précisément ce
   * qui vient d'arriver, serait le seul à manquer.
   */
  private deliverTcp(s: SyslogServer, severity: SyslogSeverityName,
                     tag: string, message: string): void {
    if (!this.host.tcpConnect) { this.dropped(s.ip, 'no-tcp'); return; }
    const ligne = this.ligneRfc3164(s, severity, tag, message) + (s.delimiter ? '\n' : '');
    let lien = this.liens.get(s.ip);
    if (!lien) {
      lien = { socket: null, attente: [], ouverture: false, enPanne: false, retente: null };
      this.liens.set(s.ip, lien);
    }
    if (lien.enPanne) { this.armerRetente(s.ip); this.dropped(s.ip, 'no-route'); return; }
    if (lien.socket && lien.socket.state === 'established') {
      lien.socket.send(ligne);
      this.compter(s, severity, tag, message);
      return;
    }
    lien.attente.push(ligne);
    // `logging queue-limit [trap] <n>` borne CETTE file : un collecteur
    // injoignable ne doit pas faire grossir la memoire sans fin. Le plus
    // ancien part en premier, comme sur un vrai equipement.
    while (lien.attente.length > this.config.queueLimit) {
      lien.attente.shift();
      this.dropped(s.ip, 'queue-full');
    }
    if (lien.ouverture) return;
    lien.ouverture = true;
    const socket = this.host.tcpConnect(s.ip, s.port, {
      onOpen: () => {
        const l = this.liens.get(s.ip);
        if (!l?.socket) return;
        for (const ligneEnAttente of l.attente) l.socket.send(ligneEnAttente);
        l.attente.length = 0;
      },
      onClose: () => {
        const l = this.liens.get(s.ip);
        if (l) {
          l.socket = null; l.enPanne = true; l.attente.length = 0;
          this.armerRetente(s.ip);
        }
      },
    });
    if (!socket) {
      lien.socket = null;
      lien.ouverture = false;
      lien.enPanne = true;
      lien.attente.length = 0;
      this.armerRetente(s.ip);
      this.dropped(s.ip, 'no-route');
      return;
    }
    lien.socket = socket;
    lien.ouverture = false;
    if (socket.state === 'established') {
      for (const l of lien.attente) socket.send(l);
      lien.attente.length = 0;
    }
    this.compter(s, severity, tag, message);
  }

  private fermerLien(ip: string): void {
    const lien = this.liens.get(ip);
    if (!lien) return;
    if (lien.retente !== null) this.getScheduler().clear(lien.retente);
    lien.socket?.close();
    this.liens.delete(ip);
  }

  /**
   * Un collecteur revenu a la vie se rejoint tout seul.
   *
   * Retenter a CHAQUE message est la boucle que `enPanne` empeche :
   * echouer produit un message, qui retenterait, qui echouerait. Un vrai
   * IOS retente sur minuterie, et c'est ce que fait cette methode — une
   * seule tentative armee a la fois, annulee des qu'elle aboutit.
   */
  private armerRetente(ip: string): void {
    const lien = this.liens.get(ip);
    if (!lien || lien.retente !== null) return;
    lien.retente = this.getScheduler().setTimeout(() => {
      const l = this.liens.get(ip);
      if (!l) return;
      l.retente = null;
      // On repart de zero : le prochain message rouvrira la connexion.
      // Rien n'est reemis, car ces messages-la sont dans le tampon et
      // les rejouer les daterait de maintenant.
      this.liens.delete(ip);
    }, RECONNEXION_MS);
  }

  private compter(s: SyslogServer, severity: SyslogSeverityName,
                  tag: string, message: string): void {
    s.count++;
    s.lastSentMs = Date.now();
    this.getBus().publish({
      topic: 'syslog.packet.sent',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        serverIp: s.ip, facility: s.facility, severity, tag, message,
      },
    });
  }

  private dropped(serverIp: string, reason: 'no-route' | 'no-source-ip' | 'threshold' | 'disabled' | 'link-down' | 'no-tcp' | 'queue-full'): void {
    this.getBus().publish({
      topic: 'syslog.packet.dropped',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        serverIp, reason,
      },
    });
  }

  /**
   * The source address to stamp on a management datagram.
   *
   * The egress interface and the source address are two different
   * decisions: routing picks the first, `source-interface` picks the
   * second. Returning the source interface AS the egress port sent the
   * datagram out of a loopback, which has no cable, so nothing left the
   * machine at all — the command silenced the very feature it
   * configures.
   */
  private sourceIpFor(egressPort: import('../hardware/Port').Port): import('../core/types').IPAddress | null {
    const named = this.config.sourceInterface
      ? this.host.getPort(this.config.sourceInterface)?.getIPAddress() ?? null
      : null;
    return named ?? egressPort.getIPAddress();
  }

  private configuredSourceIp(): import('../core/types').IPAddress | null {
    return this.config.sourceInterface
      ? this.host.getPort(this.config.sourceInterface)?.getIPAddress() ?? null
      : null;
  }

  private resolveEgress(targetIp: string): { name: string; port: import('../hardware/Port').Port } | null {
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
}
