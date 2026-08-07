import type { IEventBus } from '@/events/EventBus';
import { getDefaultEventBus } from '@/events/EventBus';
import {
  type SyslogConfig, type SyslogServer, type SyslogPacket,
  type SyslogSeverityName, type SyslogFacilityName,
  createDefaultSyslogConfig, defaultServer,
  severityFromLogLevel, shouldForward, bsdTimestamp, syslogSeverityFromNum,
  SYSLOG_SEVERITY, SYSLOG_FACILITY,
} from './types';
import {
  MACAddress, IPAddress,
  type EthernetFrame, type IPv4Packet, type UDPPacket,
  IP_PROTO_UDP, ETHERTYPE_IPV4, nextIPv4Id, computeIPv4Checksum,
} from '../core/types';

export interface SyslogHost {
  readonly id: string;
  readonly name: string;
  getHostname(): string;
  getPort(name: string): import('../hardware/Port').Port | undefined;
  getPorts(): import('../hardware/Port').Port[];
  sendFrame(portName: string, frame: EthernetFrame): void;
  /** ARP-aware send (queues on a cold cache instead of broadcasting) — falls back to broadcast when absent (mirrors `TcpHost`). */
  sendIpv4FrameArpAware?(outPortName: string, ipPkt: IPv4Packet, nextHopIP: IPAddress): void;
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
}

export class SyslogAgent {
  private config: SyslogConfig = createDefaultSyslogConfig();
  private unsubscribers: Array<() => void> = [];
  private running = false;

  constructor(
    private readonly host: SyslogHost,
    private readonly getBus: () => IEventBus,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.installSubscribers();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
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
    const defaultBus = getDefaultEventBus();
    const seen = new Set<string>();
    const subscribeOn = (bus: IEventBus): void => {
      this.unsubscribers.push(bus.subscribeWhere(
        'log',
        (p) => p.source === this.host.id,
        (e) => {
          const key = `${e.payload.level}|${e.payload.event}|${e.payload.message}|${Date.now()}`;
          if (seen.has(key)) return;
          seen.add(key);
          if (seen.size > 256) {
            const first = seen.values().next().value;
            if (first !== undefined) seen.delete(first);
          }
          this.onLog(e.payload.level, e.payload.event, e.payload.message);
        },
      ));
    };
    subscribeOn(localBus);
    if (localBus !== defaultBus) subscribeOn(defaultBus);
    const subscribeEntryOn = (bus: IEventBus): void => {
      this.unsubscribers.push(bus.subscribeWhere(
        'device.syslog.entry',
        (p) => p.deviceId === this.host.id,
        (e) => this.onLoggingEntry({
          deviceId: e.payload.deviceId,
          severity: syslogSeverityFromNum(e.payload.severityNum),
          tag: e.payload.tag,
          mnemonic: e.payload.mnemonic,
          message: e.payload.message,
        }),
      ));
    };
    subscribeEntryOn(localBus);
    if (localBus !== defaultBus) subscribeEntryOn(defaultBus);
  }

  private onLoggingEntry(p: {
    deviceId: string; severity: SyslogSeverityName; tag: string;
    mnemonic?: string; message: string;
  }): void {
    if (!this.config.enabled) return;
    if (this.config.servers.size === 0) return;
    // Le MÊME `%TAG-SEV-MNEMONIQUE` que `show logging` affiche. Ce
    // chemin passait le tag NU (`SYS`), tandis que l'autre chemin de ce
    // même agent (`onLog`, via `tagFor`) en construisait un complet :
    // deux messages issus de la même machine arrivaient au collecteur
    // sous deux formes, selon le bus interne qui les avait portés.
    const tag = `%${p.tag.toUpperCase()}-${SYSLOG_SEVERITY[p.severity]}-`
      + (p.mnemonic ?? p.severity).toUpperCase();
    for (const s of this.config.servers.values()) {
      if (!shouldForward(s.severityThreshold, p.severity)) {
        this.dropped(s.ip, 'threshold');
        continue;
      }
      this.deliver(s, p.severity, tag, p.message);
    }
  }

  private onLog(level: 'debug' | 'info' | 'warn' | 'error', event: string, message: string): void {
    if (!this.config.enabled) return;
    if (this.config.servers.size === 0) return;
    const severity = severityFromLogLevel(level);
    const tag = this.tagFor(event);
    for (const s of this.config.servers.values()) {
      if (!shouldForward(s.severityThreshold, severity)) {
        this.dropped(s.ip, 'threshold');
        continue;
      }
      this.deliver(s, severity, tag, message);
    }
  }

  private tagFor(event: string): string {
    const m = /^([a-z][a-z0-9-]*?):([a-z][a-z0-9-]*)/i.exec(event);
    if (m) return `%${m[1].toUpperCase()}-6-${m[2].toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
    return `%${event.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
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
    if (!egress) { this.dropped(s.ip, 'no-route'); return; }
    if (!egress.port.getIsUp() || !egress.port.isConnected()) {
      this.dropped(s.ip, 'link-down'); return;
    }
    const srcIp = egress.port.getIPAddress();
    if (!srcIp) { this.dropped(s.ip, 'no-source-ip'); return; }
    const facilityNum = SYSLOG_FACILITY[s.facility];
    const severityNum = SYSLOG_SEVERITY[severity];
    const payload: SyslogPacket = {
      type: 'syslog',
      facility: facilityNum, severity: severityNum,
      hostname: this.host.getHostname(),
      tag, message,
      timestamp: bsdTimestamp(Date.now()),
    };
    const udp: UDPPacket = {
      type: 'udp',
      sourcePort: 49152 + ((s.count + 1) & 0x3fff),
      destinationPort: s.port,
      length: 8 + payload.message.length + payload.tag.length + 32,
      checksum: 0, payload,
    };
    const ipPkt: IPv4Packet = {
      type: 'ipv4', version: 4, ihl: 5, tos: 0,
      totalLength: 20 + udp.length,
      identification: nextIPv4Id(), flags: 0, fragmentOffset: 0,
      ttl: 64, protocol: IP_PROTO_UDP, headerChecksum: 0,
      sourceIP: srcIp, destinationIP: new IPAddress(s.ip),
      payload: udp,
    };
    ipPkt.headerChecksum = computeIPv4Checksum(ipPkt);
    if (this.host.sendIpv4FrameArpAware) {
      this.host.sendIpv4FrameArpAware(egress.name, ipPkt, new IPAddress(s.ip));
    } else {
      const eth: EthernetFrame = {
        srcMAC: egress.port.getMAC(),
        dstMAC: MACAddress.broadcast(),
        etherType: ETHERTYPE_IPV4,
        payload: ipPkt,
      };
      this.host.sendFrame(egress.name, eth);
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
      lien = { socket: null, attente: [], ouverture: false, enPanne: false };
      this.liens.set(s.ip, lien);
    }
    if (lien.enPanne) { this.dropped(s.ip, 'no-route'); return; }
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
        if (l) { l.socket = null; l.enPanne = true; l.attente.length = 0; }
      },
    });
    if (!socket) {
      lien.socket = null;
      lien.ouverture = false;
      lien.enPanne = true;
      lien.attente.length = 0;
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
    lien.socket?.close();
    this.liens.delete(ip);
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

  private resolveEgress(targetIp: string): { name: string; port: import('../hardware/Port').Port } | null {
    if (this.config.sourceInterface) {
      const p = this.host.getPort(this.config.sourceInterface);
      if (p) return { name: this.config.sourceInterface, port: p };
    }
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
