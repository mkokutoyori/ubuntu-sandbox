import { Logger } from '@/network/core/Logger';
import { DuplicateEventFilter } from '@/events/DuplicateEventFilter';
import { isValidIPv4 } from '@/network/core/ip';
import { ospfHelloMismatchLines } from '@/network/ospf/events';

/**
 * LoggingConfig — config-driven syslog/logging state (Lot C).
 *
 * `logging …` commands mutate this real Repository instead of being
 * swallowed as no-ops; `show logging` projects it. Defaults match IOS.
 */
const SEVERITIES = [
  'emergencies', 'alerts', 'critical', 'errors', 'warnings',
  'notifications', 'informational', 'debugging',
] as const;
export type Severity = typeof SEVERITIES[number];

/**
 * Le mnémonique d'une ligne de `debug`, c'est-à-dire aucun : la sortie
 * de `debug` n'est PAS du syslog et ne porte pas de
 * `%FACILITÉ-N-MNÉMONIQUE`. Il vaut la chaîne vide plutôt que
 * `undefined` parce qu'`append` exige désormais un mnémonique — une
 * ligne verbatim est un choix qu'on écrit, pas un argument qu'on omet.
 */
export const DEBUG_VERBATIM = '';

/**
 * Le pont générique `log` porte un nom d'événement interne, pas un
 * mnémonique. Cette table dit lequel IOS écrirait, et `null` dit qu'il
 * n'écrirait rien du tout — un compteur de paquet malformé ou une
 * erreur d'émission interne ne produisent aucune ligne de syslog sur un
 * vrai équipement.
 */
const EVENT_MNEMONICS: Readonly<Record<string, string | null>> = {
  'cable:duplex-mismatch': 'DUPLEX_MISMATCH',
  'cable:loop-guard': 'LOOPGUARD_BLOCK',
  'dhcp:pool-exhausted': 'POOL_EXHAUSTED',
  'dhcpd:high-util': 'HIGH_UTIL',
  'dhcpd:low-util': 'LOW_UTIL',
  'eigrp:goodbye': 'NBRCHANGE',
  'eigrp:hold-expired': 'NBRCHANGE',
  'eigrp:iface-down': 'NBRCHANGE',
  'eigrp:k-mismatch': 'NBRCHANGE',
  'equipment:frame-dropped': null,
  'equipment:send-blocked': null,
  'equipment:send-error': null,
  'host:route-add-fail': null,
  'ipsec:anti-replay': 'PKT_REPLAY_ERR',
  'ipsec:cert-revoked': 'IKMP_INVAL_CERT',
  'ipsec:cert-verify-failed': 'IKMP_INVAL_CERT',
  'ipsec:mcast-invalid': 'RECVD_PKT_INV_SPI',
  'ipsec:mcast-no-sa': 'RECVD_PKT_INV_SPI',
  'ipsec:mcast-unknown-spi': 'RECVD_PKT_INV_SPI',
  'ipsec:overlap': 'IKMP_BAD_MESSAGE',
  'ipsec:unknown-spi': 'RECVD_PKT_INV_SPI',
  'ipv4:checksum-fail': null,
  'nat:debug': null,
  'ospf:auth-fail': 'ERRRCV',
  'pm:err-recover': 'ERR_RECOVER',
  'port:security-shutdown': 'ERR_DISABLE',
  'port:security-violation': 'PSECURE_VIOLATION',
  'radius:acct-timeout': 'RADIUS_DEAD',
  'radius:bad-accounting-authenticator': 'RESP_AUTHENTICATOR',
  'radius:bad-coa-authenticator': 'RESP_AUTHENTICATOR',
  'radius:bad-message-authenticator': 'RESP_AUTHENTICATOR',
  'radius:bad-response-authenticator': 'RESP_AUTHENTICATOR',
  'radius:missing-message-authenticator': 'RESP_AUTHENTICATOR',
  'radius:server-dead': 'RADIUS_DEAD',
  'router:checksum-fail': null,
  'router:ihl-fail': null,
  'router:length-fail': null,
  'router:routing-table-limit': 'ROUTELIMITWARNING',
  'router:version-fail': null,
  'stp:bpdu-guard': 'BLOCK_BPDUGUARD',
  'stp:bpduguard': 'BLOCK_BPDUGUARD',
  'stp:loop-guard': 'LOOPGUARD_BLOCK',
  'stp:portfast-lost': 'PORTFAST_BPDU_RX',
  'stp:root-guard': 'ROOTGUARD_BLOCK',
  'switch:arp-errdisable': 'ERR_DISABLE',
  'switch:arp-inspection': 'DHCP_SNOOPING_DENY',
  'switch:dhcp-snooping-drop': 'DHCP_SNOOPING_UNTRUSTED_PORT',
  'switch:dhcp-snooping-mac-mismatch': 'DHCP_SNOOPING_MATCH_MAC_FAIL',
  'switch:dhcp-snooping-rate-limit': 'DHCP_SNOOPING_RATE_LIMIT_EXCEEDED',
  'switch:mac-move': 'MACFLAP_NOTIF',
  'udp:checksum-fail': null,
  'vtp:orphan-mst-subset': null,
  'vtp:orphan-subset': null,
};

/**
 * Un événement absent de la table est inconnu, et un inconnu ne
 * s'invente pas : il ne produit pas de ligne. C'est la même règle que
 * pour les familles retirées des abonnements — mieux vaut le silence
 * qu'un mnémonique fabriqué.
 */
export function mnemonicFromEvent(event: string): string | null {
  return EVENT_MNEMONICS[event] ?? null;
}

/**
 * Une sévérité par son nom, son ABRÉGÉ ou son numéro.
 *
 * L'abrégé n'est pas une facilité : c'est la règle de toute la CLI d'IOS,
 * où un préfixe non ambigu vaut le mot entier. Sans lui, `logging
 * buffered 1000000 debug` — que tout le monde tape — était refusé alors
 * qu'un vrai équipement l'accepte. `e` reste refusé, puisqu'il désigne
 * aussi bien `emergencies` que `errors`.
 */
function normSeverity(tok: string): Severity | null {
  const t = tok.toLowerCase();
  if ((SEVERITIES as readonly string[]).includes(t)) return t as Severity;
  if (/^\d+$/.test(t)) {
    const n = parseInt(t, 10);
    return n >= 0 && n <= 7 ? SEVERITIES[n] : null;
  }
  const candidats = SEVERITIES.filter(s => s.startsWith(t));
  return t.length > 0 && candidats.length === 1 ? candidats[0] : null;
}

export const SEVERITY_NAMES: readonly Severity[] = SEVERITIES;

/**
 * Les facilités qu'IOS accepte derrière `logging facility`. C'est la
 * table du transport syslog lui-même : un nom absent d'ici n'a pas de
 * code RFC 3164 à écrire dans le paquet, donc l'accepter reviendrait à
 * en émettre un autre en silence.
 */
export const FACILITY_NAMES: readonly string[] = [
  'auth', 'authpriv', 'cron', 'daemon', 'ftp', 'kern', 'local0', 'local1',
  'local2', 'local3', 'local4', 'local5', 'local6', 'local7', 'lpr', 'mail',
  'news', 'syslog', 'user', 'uucp',
];

export const BUFFERED_SIZE_MIN = 4096;
export const BUFFERED_SIZE_MAX = 2147483647;
export const HISTORY_SIZE_MIN = 1;
export const HISTORY_SIZE_MAX = 500;
export const RATE_LIMIT_MIN = 1;
export const RATE_LIMIT_MAX = 10000;

/**
 * Un collecteur syslog, avec ce qui le distingue d'un autre : son
 * transport et son port. `logging host 10.0.0.1 transport tcp port 1470`
 * ne désigne pas la même destination que `logging host 10.0.0.1`.
 */
export interface SyslogHostConfig {
  ip: string;
  transport: 'udp' | 'tcp';
  port: number;
  logged: number;
  /** `logging host <ip> discriminator <name>` — un filtre par collecteur. */
  discriminator: string | null;
  droppedByMd: number;
}

export type OriginIdMode = 'hostname' | 'ip' | 'ipv6' | 'string';

export interface OriginIdConfig {
  mode: OriginIdMode;
  text?: string;
}

/**
 * Ce qu'une commande `logging` refusée doit dire, et sur quel mot poser
 * le curseur. Le rendu du message appartient à la coquille, qui seule
 * connaît la ligne brute ; ici on nomme la faute.
 */
export interface LoggingCommandError {
  kind: 'invalid' | 'incomplete';
  token?: string;
}

/**
 * Un discriminateur de messages (MD).
 *
 * `drops` laisse passer ce qui NE correspond PAS, `includes` ne laisse
 * passer que ce qui correspond. Les clauses posées sont toutes exigées
 * ensemble : un message doit satisfaire chacune pour survivre au filtre.
 */
export type MdMode = 'drops' | 'includes';

export interface MdRegexClause { mode: MdMode; pattern: string; }
export interface MdSeverityClause { mode: MdMode; levels: number[] }

export interface LogDiscriminator {
  name: string;
  severity?: MdSeverityClause;
  facility?: MdRegexClause;
  mnemonics?: MdRegexClause;
  msgBody?: MdRegexClause;
  /** `rate-limit <n>` : messages par seconde acceptés par CE filtre. */
  rateLimit?: number;
  windowStart: number;
  windowCount: number;
}

export type LoggingDestination = 'console' | 'monitor' | 'buffered';

/**
 * `logging persistent` : le journal écrit sur le système de fichiers de
 * l'équipement, celui-là même que `dir flash:` énumère.
 */
export interface PersistentLoggingConfig {
  enabled: boolean;
  url: string;
  size: number;
  filesize: number;
  immediate: boolean;
  threshold: number;
}

export const PERSISTENT_URL_DEFAUT = 'flash:/syslog';
export const PERSISTENT_SIZE_DEFAUT = 16384;
export const PERSISTENT_FILESIZE_DEFAUT = 8192;

/**
 * Ce qu'un journal persistant a besoin de savoir écrire. Port étroit
 * plutôt qu'une référence à l'équipement : `LoggingConfig` sert le
 * routeur ET le commutateur, et seul celui qui a un `flash:` en fournit
 * un.
 */
export interface LoggingFileStore {
  write(name: string, content: string): void;
  read(name: string): string | null;
  remove(name: string): boolean;
  list(prefix: string): string[];
}

interface HistoryEntry {
  severity: Severity;
  tag: string;
  mnemonic: string;
  text: string;
  ts: number;
}

export type SyslogLineListener = (line: string) => void;

export interface LoggingMonitorSource {
  subscribeMonitor(listener: SyslogLineListener): () => void;
  /**
   * `logging console`, which IOS has on by default. A console session gets
   * these without asking; `terminal monitor` is what a VTY needs to see the
   * same stream, and that one is `subscribeMonitor`.
   */
  subscribeConsole?(listener: SyslogLineListener): () => void;
}

/** IOS timestamps the two message families separately. */
export type TimestampChannel = 'debug' | 'log';

/**
 * One channel's `service timestamps` setting.
 *
 * `uptime` and `datetime` are mutually exclusive forms, not decorations:
 * the first counts from boot and needs no clock, the second reads one.
 * The remaining flags only apply to `datetime`, exactly as the IOS
 * grammar allows them.
 */
export interface TimestampSpec {
  enabled: boolean;
  format: 'uptime' | 'datetime';
  msec: boolean;
  localtime: boolean;
  showTimezone: boolean;
  year: boolean;
}

/**
 * La configuration d'usine d'IOS porte `service timestamps debug datetime
 * msec` et `service timestamps log datetime msec`. C'est ce que rend cette
 * fonction, et rien d'autre : elle décrit un routeur qui sort de sa boîte.
 */
/**
 * Ce qu'un IOS 15.x d'ISR journalise en mémoire sans qu'on lui demande
 * rien. La journalisation tampon EST active par défaut ; ce qu'IOS
 * n'écrit pas, c'est le DÉFAUT lui-même dans la running-config.
 */
export const BUFFERED_SIZE_DEFAUT = 4096;
export const BUFFERED_SEVERITE_DEFAUT: Severity = 'debugging';

export function defaultTimestampSpec(): TimestampSpec {
  return {
    enabled: true, format: 'datetime', msec: true,
    localtime: false, showTimezone: false, year: false,
  };
}

/** Ce que `no service timestamps` laisse derrière lui. */
export function disabledTimestampSpec(): TimestampSpec {
  return {
    enabled: false, format: 'uptime', msec: false,
    localtime: false, showTimezone: false, year: false,
  };
}

/**
 * La base de la GRAMMAIRE : `service timestamps [debug|log]` sans format
 * vaut `uptime`. C'est une question différente du défaut d'usine, et les
 * confondre faisait rendre `datetime msec` à une commande qui dit
 * `uptime`.
 */
export function bareTimestampSpec(): TimestampSpec {
  return {
    enabled: true, format: 'uptime', msec: false,
    localtime: false, showTimezone: false, year: false,
  };
}

/**
 * What a timestamp needs from the machine it is logged on.
 *
 * Kept as a narrow port rather than a device reference because
 * `LoggingConfig` is shared by routers and switches, and the switch has
 * neither a settable clock nor an NTP agent — it answers the defaults and
 * the timestamps stay truthful instead of the format silently changing
 * platform.
 */
/**
 * Ce que `login on-success log` / `login on-failure log` decident.
 *
 * Les deux messages `%SEC_LOGIN-*` etaient emis INCONDITIONNELLEMENT,
 * alors qu'un vrai IOS ne les produit QUE si l'operateur a demande ces
 * commandes — introduites en 12.3 precisement pour cela. Les drapeaux
 * existaient, etaient rendus par la configuration, et n'etaient LUS par
 * personne : la machine journalisait donc ce qu'une vraie tait, et la
 * commande qui gouverne la trace ne gouvernait rien.
 *
 * Le port est etroit a dessein : ce module ne doit pas connaitre
 * `CiscoSecurityConfig`, il doit connaitre la reponse a deux questions.
 */
/** Les sources qui designent un acces local plutot qu'une adresse. */
const LOGIN_LOCAL = new Set(['console', 'con', 'aux', 'local', '']);

export interface LoginLoggingPolicy {
  logSuccess(): boolean;
  logFailure(): boolean;
}

export interface LoggingClockSource {
  /** Milliseconds since this device booted — the `uptime` form. */
  uptimeMs(): number;
  /** The device's own system clock, which `clock set` can move. */
  epochMs(): number;
  /** `clock timezone` — what `localtime` and `show-timezone` read. */
  zone(): { name: string; offsetMin: number };
  /** True once NTP has synchronised; IOS drops the `*` marker then. */
  authoritative(): boolean;
}

/**
 * Built here rather than at each call site so the shell and the device
 * cannot hand the same logging config two different clocks.
 */
export function deviceClockSource(device: unknown): LoggingClockSource {
  const dev = device as {
    getUptimeMs?: () => number;
    getSystemClockMs?: () => number;
    getManagementService?: () => { getClock: () => { timezone: string; offsetMin: number } };
    getNtpAgent?: () => { isSynced?: () => boolean };
  };
  return {
    uptimeMs: () => dev.getUptimeMs?.() ?? 0,
    epochMs: () => dev.getSystemClockMs?.() ?? Date.now(),
    zone: () => {
      const c = dev.getManagementService?.().getClock();
      return { name: c?.timezone ?? 'UTC', offsetMin: c?.offsetMin ?? 0 };
    },
    authoritative: () => dev.getNtpAgent?.().isSynced?.() ?? false,
  };
}

export class LoggingConfig {
  enabled = true;                       // `logging on` (IOS default on)
  buffered = false;
  bufferedSize = BUFFERED_SIZE_DEFAUT;
  bufferedSeverity: Severity = BUFFERED_SEVERITE_DEFAUT;
  /** `logging console` — on out of the box, silenced by `no logging console`. */
  consoleEnabled = true;
  /** `logging rate-limit N` — null means the platform default applies. */
  rateLimit: number | null = null;
  /**
   * Sans mot-clé, IOS ne borne QUE la console — c'est le débit vers un
   * écran qu'il protège. `all` étend la borne à toutes les destinations,
   * tampon et relais syslog compris, ce qui n'est pas la même décision :
   * l'une préserve la lisibilité, l'autre sacrifie la trace.
   */
  rateLimitScope: 'console' | 'all' = 'console';
  /** `except <severity>` — cette sévérité et au-dessus ne sont pas bornées. */
  rateLimitExcept: Severity | null = null;
  /**
   * Le seau du limiteur : la seconde en cours et ce qu'on y a déjà servi.
   *
   * `rateLimit` était stocké et lu par personne — la commande promettait
   * un plafond qui n'existait pas. Le limiteur ne borne QUE les sorties
   * temps réel (console et monitor), jamais le tampon ni le relais
   * syslog : c'est le débit vers un écran qu'IOS protège, pas la trace.
   */
  private rateWindowStart = 0;
  private rateWindowCount = 0;
  private rateSuppressed = 0;

  /**
   * Vrai quand la ligne peut sortir en temps réel. Le premier message
   * refusé de la seconde n'est pas perdu en silence : le suivant qui
   * passe est précédé du compte des supprimés, comme IOS le fait.
   */
  private rateLimitAllows(nowMs: number): boolean {
    const limit = this.rateLimit;
    if (limit === null) return true;
    const second = Math.floor(nowMs / 1000);
    if (second !== this.rateWindowStart) {
      this.rateWindowStart = second;
      this.rateWindowCount = 0;
    }
    if (this.rateWindowCount >= limit) {
      this.rateSuppressed++;
      return false;
    }
    this.rateWindowCount++;
    return true;
  }

  private takeSuppressedNotice(): string | null {
    if (this.rateSuppressed === 0) return null;
    const n = this.rateSuppressed;
    this.rateSuppressed = 0;
    return `%LOGGING-4-RATELIMIT: ${n} message${n === 1 ? '' : 's'} rate-limited`;
  }
  consoleSeverity: Severity = 'debugging';
  /**
   * `logging monitor` — device-wide, and the only monitor gate that
   * belongs here. Who among the open sessions actually WANTS the stream
   * is a per-line question, answered by the subscriber: a session
   * subscribes because its own vty typed `terminal monitor`. A single
   * device-wide boolean cannot answer it for several sessions at once,
   * and while one existed a Huawei vty got nothing at all — VRP sets its
   * own per-session flag and never touched this one.
   */
  monitorEnabled = true;
  monitorSeverity: Severity = 'debugging';
  trapSeverity: Severity = 'informational';
  facility = 'local7';
  sourceInterface: string | null = null;
  sequenceNumbers = false;
  /** `logging count` — IOS tallies per mnemonic once it is on. */
  countEnabled = false;
  /** `logging exception <size>` — the crash-dump flush limit. */
  exceptionSize = BUFFERED_SIZE_MIN;
  /** `logging origin-id …` — what a collector sees in front of the message. */
  originId: OriginIdConfig | null = null;
  historySeverity: Severity = 'warnings';
  historySize = 1;
  private readonly historyEntries: HistoryEntry[] = [];
  private historyIgnored = 0;
  private historyFlushed = 0;
  /**
   * Ce que `show logging` lit en premier : une destination qui reçoit,
   * et une qui ne reçoit rien, ne se distinguent que par ce compteur.
   */
  private readonly logged = { console: 0, monitor: 0, buffer: 0, trap: 0 };
  private rateLimitedTotal = 0;
  private droppedTotal = 0;
  /** Les filtres définis, actifs ou non. */
  readonly discriminators = new Map<string, LogDiscriminator>();
  /** Le filtre attaché à chaque destination, s'il y en a un. */
  readonly attachedMd: Record<LoggingDestination, string | null> = {
    console: null, monitor: null, buffered: null,
  };
  private readonly droppedByMd: Record<LoggingDestination, number> = {
    console: 0, monitor: 0, buffered: 0,
  };
  persistent: PersistentLoggingConfig = {
    enabled: false,
    url: PERSISTENT_URL_DEFAUT,
    size: PERSISTENT_SIZE_DEFAUT,
    filesize: PERSISTENT_FILESIZE_DEFAUT,
    immediate: false,
    threshold: 0,
  };
  private fileStore: LoggingFileStore | null = null;
  /**
   * `logging snmp-trap <severity>` — le niveau à partir duquel un
   * message syslog produit une notification SNMP. C'est ce réglage que
   * la dernière ligne de `show logging history` annonce.
   */
  snmpTrapSeverity: Severity | null = null;
  /** `logging userinfo` — journalise qui passe en mode privilégié. */
  userInfo = false;
  /** `logging server-arp` — ARP vers le collecteur avant le premier message. */
  serverArp = false;
  /** `logging queue-limit [esm|trap] <n>` — la file du processus de journalisation. */
  queueLimit: { scope: 'default' | 'esm' | 'trap'; size: number } | null = null;
  /** `logging message-counter {log|debug|syslog}` — les classes comptées. */
  readonly messageCounters = new Set<'log' | 'debug' | 'syslog'>(['log']);
  /** `logging delimiter tcp` — délimiteur ajouté aux messages en TCP. */
  delimiterTcp = false;
  /** `logging reload [<severity>] [message-limit <n>]`. */
  reloadSeverity: Severity | null = null;
  reloadMessageLimit: number | null = null;
  private enRedemarrage = false;
  private messagesDuRedemarrage = 0;

  /**
   * Le début d'un redémarrage.
   *
   * **Le tampon part avec**, et c'est le vrai comportement : il est en
   * MÉMOIRE VIVE. Le garder faisait qu'un routeur relu montrait, après
   * son redémarrage, un historique daté d'avant le démarrage — une
   * machine ne peut pas se souvenir de ce qui a précédé sa mise sous
   * tension, et diagnostiquer sur cet historique-là est pire que de
   * n'en avoir aucun.
   *
   * `logging reload` prend son sens ici, et nulle part ailleurs : il
   * décide de ce qui est journalisé PENDANT cette fenêtre.
   */
  startReload(): void {
    this.messages.length = 0;
    this.enRedemarrage = true;
    this.messagesDuRedemarrage = 0;
  }

  /**
   * Le premier message d'une machine qui boote.
   *
   * Il traverse la fenêtre sans la consommer : c'est la bannière du
   * démarrage, pas un des « messages journalisés pendant le
   * redémarrage » que `logging reload` borne. Un `message-limit 1` qui
   * effacerait le `%SYS-5-RESTART` ne laisserait aucune trace du
   * redémarrage lui-même.
   */
  noteRestart(): void {
    const fenetre = this.enRedemarrage;
    this.enRedemarrage = false;
    this.append('notifications', 'sys', 'System restarted --', true, 'RESTART');
    this.enRedemarrage = fenetre;
  }

  /**
   * La fin de la fenêtre.
   *
   * Elle ne peut pas être la fin de `powerOn()` : les remontées
   * d'interface arrivent par le bus, donc après. La coquille la referme
   * à la commande suivante, ce qui est aussi le moment où l'opérateur
   * reprend la main.
   */
  endReloadWindow(): void {
    if (!this.enRedemarrage) return;
    this.enRedemarrage = false;
    this.messagesDuRedemarrage = 0;
  }

  /**
   * Ce que `logging reload` laisse passer pendant la fenêtre : la
   * sévérité demandée, et pas plus de `message-limit` messages.
   */
  private redemarrageAccepte(severity: Severity): boolean {
    if (!this.enRedemarrage) return true;
    if (this.reloadSeverity
      && this.SEVERITY_ORDER[severity] > this.SEVERITY_ORDER[this.reloadSeverity]) return false;
    if (this.reloadMessageLimit !== null
      && this.messagesDuRedemarrage >= this.reloadMessageLimit) return false;
    this.messagesDuRedemarrage++;
    return true;
  }
  /**
   * Le numéro de séquence compte les messages produits depuis le
   * démarrage, pas ceux que le tampon garde : `clear logging` ne le
   * remet pas à zéro, sans quoi deux lignes porteraient le même numéro.
   */
  private seqCounter = 0;
  private readonly horodatage: Record<TimestampChannel, TimestampSpec> = {
    debug: defaultTimestampSpec(),
    log: defaultTimestampSpec(),
  };
  private clock: LoggingClockSource | null = null;
  private loginPolicy: LoginLoggingPolicy | null = null;
  readonly hostConfigs: SyslogHostConfig[] = [];

  /** Les adresses seules, pour qui n'a que faire du transport. */
  get hosts(): string[] { return this.hostConfigs.map(h => h.ip); }
  /**
   * `rendu` is the line as it was written, stamp included, because that is
   * what the buffer holds on a real router. Formatting at render time
   * instead would rewrite history: changing `service timestamps` would
   * re-date every message already logged, and a message logged before the
   * clock was set would silently acquire the new date.
   */
  private readonly messages: Array<{
    ts: number; severity: Severity;
    tag: string; text: string; mnemonic: string; rendu: string;
  }> = [];

  attachClockSource(source: LoggingClockSource): void { this.clock = source; }

  /**
   * Sans politique attachee, rien n'est journalise — c'est le defaut
   * d'IOS, ou ces deux commandes sont absentes d'une configuration
   * neuve. Un commutateur qui n'attache rien se tait donc, comme il doit.
   */
  attachLoginLoggingPolicy(p: LoginLoggingPolicy): void { this.loginPolicy = p; }

  timestampSpec(channel: TimestampChannel): Readonly<TimestampSpec> {
    return this.horodatage[channel];
  }

  setTimestampSpec(channel: TimestampChannel, spec: TimestampSpec): void {
    this.horodatage[channel] = spec;
  }

  clearBuffer(): void { this.messages.length = 0; }
  private nextSeq = 0;
  private attachedBus: import('@/events/EventBus').IEventBus | null = null;
  private attachedDeviceId: string | null = null;
  private busUnsub: (() => void) | null = null;
  private readonly monitorListeners = new Set<SyslogLineListener>();
  private readonly consoleListeners = new Set<SyslogLineListener>();
  private readonly SEVERITY_ORDER: Record<Severity, number> = {
    emergencies: 0, alerts: 1, critical: 2, errors: 3,
    warnings: 4, notifications: 5, informational: 6, debugging: 7,
  };

  /**
   * Severity 7 is `debug` output, and IOS only ever produces it while the
   * matching `debug` command is on. The device hands over its debug
   * registry here so `undebug all` reaches these lines too — without the
   * gate they were emitted unconditionally, so a router with CDP running
   * printed neighbour chatter to a console nobody had asked to debug, and
   * no command could stop it.
   *
   * A device that never sets a gate keeps the old unconditional
   * behaviour, so nothing else in the tree changes shape.
   */
  private debugGate: ((tag: string) => boolean) | null = null;

  setDebugGate(gate: ((tag: string) => boolean) | null): void {
    this.debugGate = gate;
  }

  private debugAllowed(tag: string): boolean {
    return this.debugGate === null || this.debugGate(tag);
  }

  /** `event` like `bfd:state` → tag `bfd`. */
  private tagFromEvent(event: string): string {
    const colon = event.indexOf(':');
    if (colon === -1) return event.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
    return event.slice(0, colon).replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  }

  private formatEntry(
    severity: Severity, tag: string, text: string,
    ts: number, mnemonic: string, uptimeMs?: number, seq?: number,
  ): string {
    const spec = this.horodatage[severity === 'debugging' ? 'debug' : 'log'];
    // Le numéro précède l'horodatage : c'est l'ordre d'IOS, et celui qui
    // permet de trier un journal dont les dates sont douteuses.
    const numero = seq === undefined ? '' : `${String(seq).padStart(6, '0')}: `;
    const prefix = numero + (spec.enabled
      ? `${this.formatTimestamp(spec, ts, uptimeMs ?? this.uptimeNow())}: `
      : '');
    if (mnemonic === DEBUG_VERBATIM) return `${prefix}${text}`;
    const sevNum = this.SEVERITY_ORDER[severity];
    return `${prefix}%${tag.toUpperCase()}-${sevNum}-${mnemonic.toUpperCase()}: ${text}`;
  }

  private uptimeNow(): number { return this.clock?.uptimeMs() ?? 0; }

  private formatTimestamp(spec: TimestampSpec, ts: number, uptimeMs: number): string {
    return spec.format === 'uptime'
      ? this.formatUptimeStamp(spec, uptimeMs)
      : this.formatDatetimeStamp(spec, ts);
  }

  /**
   * IOS abbreviates a long uptime rather than letting the hour count grow:
   * `HH:MM:SS` for the first day, then `1d00h`, then `1w2d`. The short
   * forms carry no milliseconds — there is nowhere to put them, and a real
   * `1w2d.443` is not a thing anybody has seen in a log.
   *
   * No `*` marker either: an uptime is a counter this device owns, so it
   * is authoritative whatever the clock is doing.
   */
  private formatUptimeStamp(spec: TimestampSpec, uptimeMs: number): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    const totalSec = Math.max(0, Math.floor(uptimeMs / 1000));
    const jours = Math.floor(totalSec / 86400);
    if (jours >= 7) {
      const semaines = Math.floor(jours / 7);
      return `${semaines}w${jours - semaines * 7}d`;
    }
    if (jours >= 1) return `${jours}d${pad(Math.floor((totalSec % 86400) / 3600))}h`;
    const base = `${pad(Math.floor(totalSec / 3600))}:`
      + `${pad(Math.floor((totalSec % 3600) / 60))}:${pad(totalSec % 60)}`;
    if (!spec.msec) return base;
    return `${base}.${String(Math.floor(uptimeMs) % 1000).padStart(3, '0')}`;
  }

  /**
   * `*` means the clock is not authoritative — that is what the marker is
   * for on a real router, and why a freshly booted one stamps every line
   * with it until NTP answers.
   */
  private formatDatetimeStamp(spec: TimestampSpec, ts: number): string {
    const zone = this.clock?.zone() ?? { name: 'UTC', offsetMin: 0 };
    const d = new Date(ts + (spec.localtime ? zone.offsetMin * 60_000 : 0));
    const mois = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
    const pad = (n: number) => String(n).padStart(2, '0');
    const marque = (this.clock?.authoritative() ?? false) ? ' ' : '*';
    const annee = spec.year ? ` ${d.getUTCFullYear()}` : '';
    let stamp = `${marque}${mois} ${String(d.getUTCDate()).padStart(2, ' ')}${annee} `
      + `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
    if (spec.msec) stamp += `.${String(d.getUTCMilliseconds()).padStart(3, '0')}`;
    if (spec.showTimezone) {
      stamp += ` ${spec.localtime ? zone.name : 'UTC'}`;
    }
    return stamp;
  }

  subscribeMonitor(listener: SyslogLineListener): () => void {
    this.monitorListeners.add(listener);
    return () => { this.monitorListeners.delete(listener); };
  }

  private fanMonitor(line: string): void {
    for (const listener of this.monitorListeners) listener(line);
  }

  subscribeConsole(listener: SyslogLineListener): () => void {
    this.consoleListeners.add(listener);
    return () => { this.consoleListeners.delete(listener); };
  }

  private fanConsole(line: string): void {
    for (const listener of this.consoleListeners) listener(line);
  }

  /**
   * Append a log message into the buffered/console projection.
   *
   * `republish` is false only for the generic `log`-topic bridge below:
   * that bridge exists to keep `show logging`/`terminal monitor` in sync
   * with plain Logger.warn/error calls, but SyslogAgent already listens to
   * the same `log` topic directly for actual UDP forwarding — re-emitting
   * `device.syslog.entry` here as well would double-deliver every one of
   * those messages. Protocol-specific call sites (CDP/VRRP/GLBP/etc.,
   * which have no `log`-topic equivalent) keep the default `true` so
   * `device.syslog.entry` remains their only forwarding path.
   */
  attachFileStore(store: LoggingFileStore): void { this.fileStore = store; }

  /**
   * Le préfixe des fichiers du journal persistant, dérivé de l'URL
   * configurée. IOS écrit une suite de fichiers numérotés sous ce
   * chemin, et en ouvre un nouveau quand le courant atteint `filesize`.
   */
  private persistentPrefix(): string {
    const base = this.persistent.url.replace(/^[a-z]+:\/?/i, '').replace(/\/+$/, '');
    return `${base || 'syslog'}_`;
  }

  /**
   * Écrit la ligne sur le système de fichiers.
   *
   * Sans cela, `logging persistent` aurait été exactement le défaut que
   * ce lot corrige partout ailleurs : une commande acceptée, rendue dans
   * la configuration, et dont aucun `dir flash:` n'aurait jamais montré
   * la trace. `size` borne le journal entier, `filesize` chaque fichier
   * — les deux sont des bornes distinctes sur un vrai équipement, et
   * confondre l'une avec l'autre ferait tourner le journal au mauvais
   * moment.
   */
  private persistLine(rendu: string): void {
    if (!this.persistent.enabled || !this.fileStore) return;
    const prefix = this.persistentPrefix();
    const fichiers = this.fileStore.list(prefix).sort();
    let courant = fichiers[fichiers.length - 1];
    let contenu = courant ? (this.fileStore.read(courant) ?? '') : '';
    if (!courant || contenu.length + rendu.length + 1 > this.persistent.filesize) {
      courant = `${prefix}${String(fichiers.length + 1).padStart(5, '0')}`;
      contenu = '';
      fichiers.push(courant);
    }
    this.fileStore.write(courant, contenu ? `${contenu}\n${rendu}` : rendu);
    // `size` borne le journal ENTIER : le fichier le plus ancien part
    // quand le total le dépasse, sinon la borne ne bornerait rien.
    let total = fichiers.reduce((n, f) => n + (this.fileStore!.read(f)?.length ?? 0), 0);
    for (const f of fichiers) {
      if (total <= this.persistent.size) break;
      total -= this.fileStore.read(f)?.length ?? 0;
      this.fileStore.remove(f);
    }
  }

  /** `show logging persistent` — ce que les fichiers contiennent vraiment. */
  renderPersistent(): string {
    if (!this.persistent.enabled) return 'Persistent logging is disabled';
    const prefix = this.persistentPrefix();
    const fichiers = this.fileStore?.list(prefix).sort() ?? [];
    const lignes = [
      `Persistent logging url: ${this.persistent.url}`,
      `Persistent logging size: ${this.persistent.size} bytes`,
      `Persistent logging filesize: ${this.persistent.filesize} bytes`,
      `Persistent logging files: ${fichiers.length}`,
      '',
    ];
    for (const f of fichiers) {
      const c = this.fileStore?.read(f);
      if (c) lignes.push(c);
    }
    return lignes.join('\n');
  }

  /** `clear logging persistent` — les fichiers partent pour de bon. */
  clearPersistent(): void {
    const prefix = this.persistentPrefix();
    for (const f of this.fileStore?.list(prefix) ?? []) this.fileStore?.remove(f);
  }

  /**
   * Un discriminateur laisse-t-il passer ce message ?
   *
   * `includes` exige la correspondance, `drops` l'interdit, et toutes
   * les clauses posées comptent ensemble. Un filtre sans clause ne
   * filtre rien — ce qui est bien ce qu'un `logging discriminator MD1`
   * nu demande.
   */
  private mdAllows(md: LogDiscriminator, severity: Severity, tag: string,
                   mnemonic: string, text: string, nowMs: number): boolean {
    const clause = (c: MdRegexClause | undefined, valeur: string): boolean => {
      if (!c) return true;
      let correspond: boolean;
      try { correspond = new RegExp(c.pattern, 'i').test(valeur); }
      catch { correspond = valeur.toLowerCase().includes(c.pattern.toLowerCase()); }
      return c.mode === 'includes' ? correspond : !correspond;
    };
    if (md.severity) {
      const dedans = md.severity.levels.includes(this.SEVERITY_ORDER[severity]);
      if (md.severity.mode === 'includes' ? !dedans : dedans) return false;
    }
    if (!clause(md.facility, tag.toUpperCase())) return false;
    if (!clause(md.mnemonics, mnemonic.toUpperCase())) return false;
    if (!clause(md.msgBody, text)) return false;
    if (md.rateLimit !== undefined) {
      const seconde = Math.floor(nowMs / 1000);
      if (seconde !== md.windowStart) { md.windowStart = seconde; md.windowCount = 0; }
      if (md.windowCount >= md.rateLimit) return false;
      md.windowCount++;
    }
    return true;
  }

  /** Le filtre d'une destination laisse-t-il passer ce message ? */
  private destinationAllows(dest: LoggingDestination, severity: Severity, tag: string,
                            mnemonic: string, text: string, nowMs: number): boolean {
    const nom = this.attachedMd[dest];
    if (!nom) return true;
    const md = this.discriminators.get(nom);
    if (!md) return true;
    if (this.mdAllows(md, severity, tag, mnemonic, text, nowMs)) return true;
    this.droppedByMd[dest]++;
    return false;
  }

  /** Le numéro que portera la prochaine ligne, ou rien si l'option est éteinte. */
  private nextSequence(): number | undefined {
    if (!this.sequenceNumbers) return undefined;
    this.seqCounter++;
    return this.seqCounter % 1000000;
  }

  /**
   * La ligne est fabriquée UNE fois : celle que la console reçoit et
   * celle que le tampon garde sont la même chaîne, numéro de séquence
   * compris. Le numéro est consommé même quand la journalisation est
   * éteinte, parce que le message a bien été produit — c'est ce que
   * compte le compteur d'IOS.
   */
  recordDebugLine(text: string): string {
    const ts = this.clock?.epochMs() ?? Date.now();
    const rendu = this.formatEntry(
      'debugging', 'debug', text, ts, DEBUG_VERBATIM, this.uptimeNow(), this.nextSequence());
    if (!this.enabled) return rendu;
    this.messages.push({
      ts, severity: 'debugging', tag: 'debug', text, mnemonic: DEBUG_VERBATIM, rendu });
    this.logged.buffer++;
    const cap = Math.max(16, Math.floor(this.bufferedSize / 80));
    while (this.messages.length > cap) this.messages.shift();
    return rendu;
  }

  /**
   * La table d'historique n'est pas le tampon : elle ne garde que ce qui
   * atteint `logging history`, elle est bien plus courte, et c'est elle
   * que le SNMP relève.
   */
  private recordHistory(
    severity: Severity, tag: string, mnemonic: string, text: string, ts: number,
  ): void {
    if (this.SEVERITY_ORDER[severity] > this.SEVERITY_ORDER[this.historySeverity]) {
      this.historyIgnored++;
      return;
    }
    this.historyEntries.push({ severity, tag, mnemonic, text, ts });
    while (this.historyEntries.length > this.historySize) {
      this.historyEntries.shift();
      this.historyFlushed++;
    }
  }

  append(
    severity: Severity, tag: string, text: string,
    republish: boolean, mnemonic: string,
  ): void {
    if (!this.enabled) return;
    if (severity === 'debugging' && !this.debugAllowed(tag)) return;
    if (!this.redemarrageAccepte(severity)) return;
    // The device's own clock, not the host's: a router whose operator ran
    // `clock set` must date its messages with the date it was given.
    const ts = this.clock?.epochMs() ?? Date.now();
    const rendu = this.formatEntry(
      severity, tag, text, ts, mnemonic, this.uptimeNow(), this.nextSequence());
    const mnem = mnemonic.toUpperCase();
    const passeMd = (d: LoggingDestination): boolean =>
      this.destinationAllows(d, severity, tag, mnem, text, ts);
    const wantsMonitor = this.monitorEnabled
      && this.SEVERITY_ORDER[severity] <= this.SEVERITY_ORDER[this.monitorSeverity]
      && passeMd('monitor');
    const wantsConsole = this.consoleEnabled
      && this.SEVERITY_ORDER[severity] <= this.SEVERITY_ORDER[this.consoleSeverity]
      && passeMd('console');
    const tousBornes = this.rateLimitScope === 'all';
    const exempte = this.rateLimitExcept !== null
      && this.SEVERITY_ORDER[severity] <= this.SEVERITY_ORDER[this.rateLimitExcept];
    const borne = this.rateLimit !== null && !exempte && (tousBornes || wantsConsole);
    const passe = !borne || this.rateLimitAllows(ts);
    if (!passe) this.rateLimitedTotal++;
    if (passe || !tousBornes) {
      this.recordHistory(severity, tag, mnem, text, ts);
      if (this.SEVERITY_ORDER[severity] <= this.SEVERITY_ORDER[this.trapSeverity]) {
        this.logged.trap++;
        for (const h of this.hostConfigs) {
          const md = h.discriminator ? this.discriminators.get(h.discriminator) : undefined;
          if (md && !this.mdAllows(md, severity, tag, mnem, text, ts)) h.droppedByMd++;
          else h.logged++;
        }
      }
    }
    if (passe && (wantsMonitor || wantsConsole)) {
      const notice = this.takeSuppressedNotice();
      if (notice) {
        if (wantsMonitor) this.fanMonitor(notice);
        if (wantsConsole) this.fanConsole(notice);
      }
      if (wantsMonitor) { this.fanMonitor(rendu); this.logged.monitor++; }
      if (wantsConsole) { this.fanConsole(rendu); this.logged.console++; }
    }
    if (tousBornes && !passe) return;
    if (this.SEVERITY_ORDER[severity] > this.SEVERITY_ORDER[this.bufferedSeverity]) return;
    if (!passeMd('buffered')) return;
    this.messages.push({ ts, severity, tag, text, mnemonic, rendu });
    this.logged.buffer++;
    const cap = Math.max(16, Math.floor(this.bufferedSize / 80));
    while (this.messages.length > cap) this.messages.shift();
    this.nextSeq++;
    this.persistLine(rendu);
    if (republish && this.attachedBus && this.attachedDeviceId) {
      this.attachedBus.publish({
        topic: 'device.syslog.entry',
        payload: {
          deviceId: this.attachedDeviceId,
          severity, severityNum: this.SEVERITY_ORDER[severity],
          tag, mnemonic: mnem, message: text, ts,
        },
      });
    }
  }

  attachToBus(bus: import('@/events/EventBus').IEventBus, deviceId: string): () => void {
    if (this.attachedBus === bus && this.attachedDeviceId === deviceId && this.busUnsub) {
      return this.busUnsub;
    }
    if (this.busUnsub) { this.busUnsub(); this.busUnsub = null; }
    const isOurs = (e: unknown) => (e as { deviceId?: string }).deviceId === deviceId;
    this.buffered = true;
    this.attachedBus = bus;
    this.attachedDeviceId = deviceId;
    const unsubs = [
      bus.subscribeWhere('port.link.up', isOurs, (e) => {
        const p = e.payload;
        this.append('errors', 'link',
          `Interface ${p.portName}, changed state to up`, true, 'UPDOWN');
        this.append('notifications', 'lineproto',
          `Line protocol on Interface ${p.portName}, changed state to up`, true, 'UPDOWN');
      }),
      bus.subscribeWhere('port.link.down', isOurs, (e) => {
        const p = e.payload;
        // IOS distinguishes the two ways a link goes down: an operator
        // `shutdown` is %LINK-5-CHANGED "administratively down", a carrier
        // loss is %LINK-3-UPDOWN "down".
        if (p.adminDown) {
          this.append('notifications', 'link',
            `Interface ${p.portName}, changed state to administratively down`, true, 'CHANGED');
        } else {
          this.append('errors', 'link',
            `Interface ${p.portName}, changed state to down`, true, 'UPDOWN');
        }
        this.append('notifications', 'lineproto',
          `Line protocol on Interface ${p.portName}, changed state to down`, true, 'UPDOWN');
      }),
      bus.subscribeWhere('ospf.hello.mismatch', isOurs, (e) => {
        for (const ligne of ospfHelloMismatchLines(e.payload)) {
          this.append('debugging', 'ospf', ligne, true, DEBUG_VERBATIM);
        }
      }),
      bus.subscribeWhere('ospf.area.mismatch', isOurs, (e) => {
        const p = e.payload;
        this.append('warnings', 'ospf',
          `Received invalid packet: ${p.reason}, from ${p.from}, ${p.iface}`, true, 'ERRRCV');
      }),
      bus.subscribeWhere('ospf.neighbor.state-changed', isOurs, (e) => {
        const p = e.payload;
        const versFull = String(p.newState).toLowerCase() === 'full';
        const quitteFull = String(p.oldState).toLowerCase() === 'full';
        if (!versFull && !quitteFull) return;
        this.append('notifications', 'ospf',
          `Process ${p.processId}, Nbr ${p.neighborId} on ${p.iface} from ${p.oldState} to ${p.newState}, ${p.event}`,
          true, 'ADJCHG');
      }),
      bus.subscribeWhere('hsrp.active.changed', isOurs, (e) => {
        const p = e.payload as unknown as { iface?: string; group?: number; activeIp?: string; activePriority?: number };
        this.append('informational', 'hsrp',
          `${p.iface ?? 'iface'} Grp ${p.group ?? 0} Active router is ${p.activeIp ?? '?'} (priority ${p.activePriority ?? 0})`, true, 'STATECHANGE');
      }),
      bus.subscribeWhere('hsrp.state.changed', isOurs, (e) => {
        const p = e.payload as unknown as { iface?: string; group?: number; oldState?: string; newState?: string };
        this.append('notifications', 'hsrp',
          `${p.iface ?? '?'} Grp ${p.group ?? 0} state ${p.oldState ?? '?'} -> ${p.newState ?? '?'}`, true, 'STATECHANGE');
      }),
      bus.subscribeWhere('lacp.port.bundled', isOurs, (e) => {
        const p = e.payload as unknown as { port?: string; groupId?: number };
        this.append('notifications', 'etherchannel',
          `Interface ${p.port ?? '?'} joined port-channel Port-channel${p.groupId ?? 0}`, true, 'BUNDLE');
      }),
      bus.subscribeWhere('lacp.port.unbundled', isOurs, (e) => {
        const p = e.payload as unknown as { port?: string; groupId?: number; cause?: string };
        this.append('notifications', 'etherchannel',
          `Interface ${p.port ?? '?'} left port-channel Port-channel${p.groupId ?? 0}${p.cause ? ` (${p.cause})` : ''}`, true, 'UNBUNDLE');
      }),
      bus.subscribeWhere('bgp.neighbor.state-changed', isOurs, (e) => {
        const p = e.payload as unknown as { neighborIp?: string; oldState?: string; newState?: string };
        // IOS n'annonce QUE le franchissement d'Established, et il
        // l'annonce `Up`/`Down` — pas chaque pas de la machine à états.
        // Écrire tous les pas remplirait le tampon d'un bruit qu'aucun
        // équipement ne produit, et la même règle vaut déjà pour OSPF
        // juste au-dessus.
        const vers = String(p.newState ?? '') === 'Established';
        const depuis = String(p.oldState ?? '') === 'Established';
        if (!vers && !depuis) return;
        this.append('notifications', 'bgp',
          `neighbor ${p.neighborIp ?? '?'} ${vers ? 'Up' : 'Down'}`, true, 'ADJCHANGE');
      }),
      bus.subscribeWhere('eigrp.neighbor.state-changed', isOurs, (e) => {
        const p = e.payload as unknown as { neighbor?: string; iface?: string; oldState?: string; newState?: string; asn?: number };
        this.append('notifications', 'eigrp',
          `${p.asn ?? '?'}: Neighbor ${p.neighbor ?? '?'} (${p.iface ?? '?'}) is ${p.newState ?? '?'}`, true, 'NBRCHANGE');
      }),
      bus.subscribeWhere('port.security.violation', isOurs, (e) => {
        const p = e.payload;
        this.append('critical', 'port_security',
          `Security violation occurred, caused by MAC address ${p.mac} on port ${p.portName}.`, true, 'PSECURE_VIOLATION');
      }),
      bus.subscribeWhere('port.security.errdisable.set', isOurs, (e) => {
        const p = e.payload;
        this.append('critical', 'pm',
          `Interface ${p.portName} is err-disabled: psecure-violation`, true, 'ERR_DISABLE');
      }),
      bus.subscribeWhere('bfd.session.changed', isOurs, (e) => {
        const p = e.payload as unknown as { neighborIp?: string; iface?: string; oldState?: string; newState?: string };
        this.append('notifications', 'bfd',
          `Session to neighbor ${p.neighborIp ?? '?'} on ${p.iface ?? '?'} changed state from ${p.oldState ?? '?'} to ${p.newState ?? '?'}`, true, 'BFD_SESS_STATE');
      }),
      bus.subscribeWhere('arp.violation', isOurs, (e) => {
        const p = e.payload as unknown as { ingressPort?: string; senderIp?: string; senderMac?: string; reason?: string };
        this.append('warnings', 'dai',
          `DAI: ${p.ingressPort ?? '?'}: Invalid ARP ${p.reason ?? ''} from ${p.senderMac ?? '?'}/${p.senderIp ?? '?'}`, true, 'DHCP_SNOOPING_DENY');
      }),
      // Aucun abonnement ici sur `port.config.ip-changed`,
      // `mtu/speed/duplex-changed` ni `tcp.listener.changed` : IOS
      // n'émet AUCUN message sur ces événements. Les
      // `%IFMGR-6-INFORMATIONAL: … IPv4 address 10.0.0.1/255.255.255.0
      // assigned` et `%SYS-5-NOTIFICATIONS: TCP listener bound` qui s'y
      // trouvaient étaient inventés — et le premier mélangeait en plus
      // la notation CIDR et le masque pointé.
      bus.subscribeWhere('ipsec.ike.sa-installed', isOurs, (e) => {
        const p = e.payload as unknown as { peerIp?: string; spiInitiator?: number };
        this.append('notifications', 'crypto',
          `IKE SA installed with peer ${p.peerIp ?? '?'} (SPI 0x${(p.spiInitiator ?? 0).toString(16)})`, true, 'IKMP_SA_AUTH');
      }),
      bus.subscribeWhere('ipsec.ike.sa-deleted', isOurs, (e) => {
        const p = e.payload as unknown as { peerIp?: string; reason?: string };
        this.append('notifications', 'crypto',
          `IKE SA deleted with peer ${p.peerIp ?? '?'} (${p.reason ?? 'deleted'})`, true, 'IKMP_SA_NOT_AUTH');
      }),
      bus.subscribeWhere('ipsec.dpd.peer-down', isOurs, (e) => {
        const p = e.payload as unknown as { peerIp?: string };
        this.append('warnings', 'crypto',
          `DPD: peer ${p.peerIp ?? '?'} declared dead`, true, 'IKE_DPD_TIMEOUT');
      }),
      bus.subscribeWhere('ntp.synced', isOurs, (e) => {
        const p = e.payload as unknown as { serverIp?: string; newStratum?: number; offsetMs?: number };
        this.append('notifications', 'ntp',
          `System clock synchronized to ${p.serverIp ?? '?'} stratum ${p.newStratum ?? '?'} offset ${p.offsetMs ?? 0}ms`, true, 'PEERSYNC');
      }),
      bus.subscribeWhere('ntp.unsynced', isOurs, (e) => {
        const p = e.payload as unknown as { reason?: string };
        this.append('warnings', 'ntp',
          `System clock unsynchronized (${p.reason ?? 'no reachable server'})`, true, 'PEERUNSYNC');
      }),
      bus.subscribeWhere('snmp.auth.rejected', isOurs, (e) => {
        const p = e.payload as unknown as { fromIp?: string; community?: string; reason?: string };
        this.append('warnings', 'snmp',
          `Authentication failure for SNMP request from ${p.fromIp ?? '?'} (community '${p.community ?? '?'}', ${p.reason ?? '?'})`, true, 'AUTHFAIL');
      }),
      bus.subscribeWhere('stp.root.changed', isOurs, (e) => {
        const p = e.payload as unknown as { oldRootMac?: string; newRootMac?: string; rootPort?: string };
        this.append('notifications', 'spantree',
          `New root ${p.newRootMac ?? '?'} (was ${p.oldRootMac ?? '?'}), root port ${p.rootPort ?? 'none'}`, true, 'ROOTCHANGE');
      }),
      bus.subscribeWhere('stp.bpdu-guard.violation', isOurs, (e) => {
        const p = e.payload as unknown as { port?: string };
        const iface = p.port ?? '?';
        this.append('critical', 'spantree',
          `Received BPDU on port ${iface} with BPDU Guard enabled. Disabling port.`,
          true, 'BLOCK_BPDUGUARD');
        this.append('errors', 'pm',
          `Port ${iface} is err-disabled: bpduguard`, true, 'ERR_DISABLE');
      }),
      bus.subscribeWhere('stp.topology.change', isOurs, (e) => {
        const p = e.payload as unknown as { origin?: string; port?: string };
        this.append('notifications', 'spantree',
          `Topology change (${p.origin ?? '?'})${p.port ? ` on port ${p.port}` : ''}`, true, 'TOPOTRAP');
      }),
      bus.subscribeWhere('arp.rate-limit-exceeded', isOurs, (e) => {
        const p = e.payload as unknown as { ingressPort?: string; observedPps?: number };
        this.append('warnings', 'dai',
          `ARP rate-limit exceeded on ${p.ingressPort ?? '?'} (${p.observedPps ?? 0} pkts/s)`, true, 'PACKET_RATE_EXCEEDED');
      }),
      bus.subscribeWhere('dhcp.address-conflict', isOurs, (e) => {
        const p = e.payload as unknown as { ip?: string };
        this.append('warnings', 'dhcp',
          `Address conflict detected for ${p.ip ?? '?'} — sending DECLINE`, true, 'DECLINE_CONFLICT');
      }),
      bus.subscribeWhere('dhcp.lease.expired', isOurs, (e) => {
        const p = e.payload as unknown as { iface?: string; ip?: string };
        this.append('warnings', 'dhcp',
          `Lease on ${p.iface ?? '?'} expired (${p.ip ?? '?'})`, true, 'LEASE_EXPIRED');
      }),
      bus.subscribeWhere('cdp.native-vlan.mismatch', isOurs, (e) => {
        const p = e.payload as unknown as {
          port?: string; localVlan?: number; remoteHost?: string;
          remotePort?: string; remoteVlan?: number;
        };
        this.append('warnings', 'cdp',
          `Native VLAN mismatch discovered on ${p.port ?? '?'} (${p.localVlan ?? '?'}), ` +
          `with ${p.remoteHost ?? '?'} ${p.remotePort ?? '?'} (${p.remoteVlan ?? '?'}).`,
          true, 'NATIVE_VLAN_MISMATCH');
      }),
      bus.subscribeWhere('vrrp.state.changed', isOurs, (e) => {
        const p = e.payload as unknown as { iface?: string; vrid?: number; oldState?: string; newState?: string };
        this.append('notifications', 'vrrp',
          `${p.iface ?? '?'} VRID ${p.vrid ?? 0} state ${p.oldState ?? '?'} -> ${p.newState ?? '?'}`, true, 'STATECHANGE');
      }),
      bus.subscribeWhere('vrrp.master.changed', isOurs, (e) => {
        const p = e.payload as unknown as { iface?: string; vrid?: number; masterIp?: string };
        this.append('notifications', 'vrrp',
          `${p.iface ?? '?'} VRID ${p.vrid ?? 0} new master ${p.masterIp ?? '?'}`, true, 'STATECHANGE');
      }),
      bus.subscribeWhere('glbp.avg.changed', isOurs, (e) => {
        const p = e.payload as unknown as { iface?: string; group?: number; oldState?: string; newState?: string };
        this.append('notifications', 'glbp',
          `${p.iface ?? '?'} Grp ${p.group ?? 0} AVG state ${p.oldState ?? '?'} -> ${p.newState ?? '?'}`, true, 'STATECHANGE');
      }),
      // Formulation d'IOS, relevee sur des transcriptions reelles :
      // `[localport: N]` manquait aux deux, l'echec s'ecrit `Login
      // failed` en minuscule et porte son motif ENTRE CROCHETS
      // (`[Reason: ...]`) et non entre parentheses.
      bus.subscribeWhere('router.aaa.account.login.success', isOurs, (e) => {
        if (!this.loginPolicy?.logSuccess()) return;
        const p = e.payload as unknown as { account?: { name?: string }; from?: string; localPort?: number };
        // Un acces LOCAL n'a ni adresse d'origine ni port d'ecoute :
        // IOS ecrit `[Source: 0.0.0.0] [localport: 0]`. Recopier le mot
        // `console` dans un champ qui attend une adresse decrivait une
        // source qui n'en est pas une.
        const local = LOGIN_LOCAL.has((p.from ?? '').trim().toLowerCase());
        this.append('notifications', 'sec_login',
          `Login Success [user: ${p.account?.name ?? '?'}]`
          + ` [Source: ${local ? '0.0.0.0' : (p.from ?? '?')}]`
          + ` [localport: ${local ? 0 : (p.localPort ?? 22)}]`, true, 'LOGIN_SUCCESS');
      }),
      bus.subscribeWhere('router.aaa.account.login.failure', isOurs, (e) => {
        if (!this.loginPolicy?.logFailure()) return;
        const p = e.payload as unknown as {
          account?: { name?: string }; from?: string; reason?: string; localPort?: number;
        };
        const local = LOGIN_LOCAL.has((p.from ?? '').trim().toLowerCase());
        this.append('warnings', 'sec_login',
          `Login failed [user: ${p.account?.name ?? '?'}]`
          + ` [Source: ${local ? '0.0.0.0' : (p.from ?? '?')}]`
          + ` [localport: ${local ? 0 : (p.localPort ?? 22)}]`
          + ` [Reason: ${p.reason ?? 'Login Authentication Failed'}]`, true, 'LOGIN_FAILED');
      }),
      bus.subscribeWhere('router.aaa.account.locked', isOurs, (e) => {
        const p = e.payload as unknown as { account?: { name?: string; lockReason?: string | null } };
        this.append('critical', 'sec',
          `Account ${p.account?.name ?? '?'} locked (${p.account?.lockReason ?? 'repeated failures'})`, true, 'USER_LOCKED');
      }),
      // `%SSH-6-SSH2_SESSION` appartient au sous-systeme SSH et a lui
      // seul. Une session console passe par le meme registre — c'est le
      // bon endroit pour les tenir toutes — mais annoncer SSH pour elle
      // produisait `on vty 0 from console` : le protocole, le type de
      // ligne et la source y etaient tous les trois faux. Ce qu'une
      // vraie machine ecrit pour un login non-SSH est
      // `%SEC_LOGIN-5-LOGIN_SUCCESS`, et seulement si `login on-success
      // log` est configure — sinon elle n'ecrit rien du tout.
      bus.subscribeWhere('router.ssh.session.opened', isOurs, (e) => {
        const p = e.payload as unknown as {
          session?: {
            user?: string; line?: string; lineIndex?: number; fromIp?: string;
            transport?: string; localPort?: number; cipher?: string; hmac?: string;
          };
        };
        const s = p.session;
        // Une session non-SSH est deja annoncee par l'abonnement a
        // `login.success` ci-dessus (`%SEC_LOGIN-5-LOGIN_SUCCESS`) :
        // deux emetteurs pour un evenement ecriraient la ligne deux fois.
        if (s?.transport && s.transport !== 'ssh') return;
        // La formulation d'IOS, relevee sur des transcriptions reelles :
        // `SSH2 Session request from <ip> (tty = N) using crypto cipher
        // '<c>', hmac '<h>' Succeeded`, en severite 5. Le texte
        // precedent (« Session opened for 'x' on vty 0 from … ») n'etait
        // celui d'AUCUNE machine — ni IOS, ni VRP.
        this.append('notifications', 'ssh',
          `SSH2 Session request from ${s?.fromIp || '0.0.0.0'} (tty = ${s?.lineIndex ?? 0})`
          + ` using crypto cipher '${s?.cipher ?? 'aes256-ctr'}',`
          + ` hmac '${s?.hmac ?? 'hmac-sha2-256'}' Succeeded`, true, 'SSH2_SESSION');
      }),
      bus.subscribeWhere('router.ssh.session.closed', isOurs, (e) => {
        const p = e.payload as unknown as {
          session?: {
            user?: string; line?: string; lineIndex?: number; fromIp?: string;
            closeReason?: string | null; transport?: string;
            cipher?: string; hmac?: string;
          };
        };
        const s = p.session;
        if (!s?.transport || s.transport === 'ssh') {
          this.append('notifications', 'ssh',
            `SSH2 Session from ${s?.fromIp || '0.0.0.0'} (tty = ${s?.lineIndex ?? 0})`
            + ` for user '${s?.user ?? ''}' using crypto cipher '${s?.cipher ?? 'aes256-ctr'}',`
            + ` hmac '${s?.hmac ?? 'hmac-sha2-256'}' closed`, true, 'SSH2_CLOSE');
        }
        if (s?.user) {
          this.append('informational', 'sys',
            `User ${s.user} has exited tty session`
            + ` ${s.lineIndex ?? 0}(${s.fromIp ?? ''})`, true, 'LOGOUT');
        }
      }),
      bus.subscribeWhere('stp.root-guard.changed', isOurs, (e) => {
        const p = e.payload as unknown as { port?: string; state?: string };
        this.append('warnings', 'spantree',
          `Root-guard ${p.state ?? '?'} on ${p.port ?? '?'}`, true, 'ROOTGUARD_CONFIG_CHANGE');
      }),
      bus.subscribeWhere('pim.neighbor.added', isOurs, (e) => {
        const p = e.payload as unknown as { iface?: string; neighborIp?: string };
        this.append('notifications', 'pim',
          `Neighbor ${p.neighborIp ?? '?'} discovered on ${p.iface ?? '?'}`, true, 'NBRCHG');
      }),
      bus.subscribeWhere('pim.neighbor.lost', isOurs, (e) => {
        const p = e.payload as unknown as { iface?: string; neighborIp?: string };
        this.append('warnings', 'pim',
          `Neighbor ${p.neighborIp ?? '?'} on ${p.iface ?? '?'} timed out`, true, 'NBRCHG');
      }),
      bus.subscribeWhere('dot1x.auth.outcome', isOurs, (e) => {
        const p = e.payload as unknown as { port?: string; accepted?: boolean; identity?: string; reason?: string };
        const sev = p.accepted ? 'informational' : 'warnings';
        this.append(sev, 'dot1x',
          `Authentication ${p.accepted ? 'success' : 'failure'} on ${p.port ?? '?'} for ${p.identity ?? '?'}`,
          true, p.accepted ? 'SUCCESS' : 'FAIL');
      }),
      bus.subscribeWhere('udld.err-disable', isOurs, (e) => {
        const p = e.payload as unknown as { port?: string };
        this.append('errors', 'udld',
          `Port ${p.port ?? '?'} err-disabled by UDLD`, true, 'UDLD_PORT_DISABLED');
      }),
      bus.subscribeWhere('radius.auth.rejected', isOurs, (e) => {
        const p = e.payload as unknown as { username?: string; fromIp?: string; reason?: string };
        this.append('warnings', 'radius',
          `Authentication rejected for ${p.username ?? '?'} from ${p.fromIp ?? '?'} (${p.reason ?? '?'})`, true, 'AUTHFAIL');
      }),
      bus.subscribeWhere('port.security.errdisable.cleared', isOurs, (e) => {
        const p = e.payload as unknown as { portName?: string };
        this.append('informational', 'pm',
          `Interface ${p.portName ?? '?'} recovered from err-disabled state`, true, 'ERR_RECOVER');
      }),
      bus.subscribeWhere('arp.errdisable.set', isOurs, (e) => {
        const p = e.payload as unknown as { port?: string; cause?: string };
        this.append('errors', 'dai',
          `Port ${p.port ?? '?'} err-disabled (${p.cause ?? 'DAI violation'})`, true, 'ERR_DISABLE');
      }),
      bus.subscribeWhere('arp.errdisable.cleared', isOurs, (e) => {
        const p = e.payload as unknown as { port?: string };
        this.append('informational', 'dai',
          `Port ${p.port ?? '?'} cleared from err-disabled`, true, 'ERR_RECOVER');
      }),
      bus.subscribeWhere('pim.dr.changed', isOurs, (e) => {
        const p = e.payload as unknown as { iface?: string; newDrIp?: string };
        this.append('notifications', 'pim',
          `Designated Router on ${p.iface ?? '?'} is now ${p.newDrIp ?? '?'}`, true, 'DRCHG');
      }),
      bus.subscribe('cable.duplex-mismatch', (e) => {
        const p = e.payload as unknown as {
          portA?: { deviceId?: string; portName?: string };
          portB?: { deviceId?: string; portName?: string };
        };
        const sideA = p.portA?.deviceId === deviceId ? p.portA?.portName : null;
        const sideB = p.portB?.deviceId === deviceId ? p.portB?.portName : null;
        const ours = sideA ?? sideB;
        if (!ours) return;
        this.append('warnings', 'cdp', `Duplex mismatch detected on ${ours}`, true, 'DUPLEX_MISMATCH');
      }),
    ];
    const once = new DuplicateEventFilter();
    const logHandler = (e: { payload: unknown }): void => {
      if (!once.firstSight(e)) return;
      const p = e.payload as unknown as { source: string; level: string; event: string; message: string };
      if (p.source !== deviceId) return;
      // IOS n'ecrit un `%SEC-*-IPACCESSLOGP` que si l'ACE porte `log` ou
      // `log-input` ; un refus non marque ne journalise rien. L'ancien
      // mappage se declenchait sur TOUT refus, ce qui rendait le mot-cle
      // `log` sans effet observable : marque ou non, la ligne sortait.
      if (p.event === 'router:acl-log') {
        this.append('warnings', 'sec', p.message, true, 'IPACCESSLOGP');
        return;
      }
      if (p.event.startsWith('router:acl-deny')) return;
      if (p.event === 'cdp:native-vlan-mismatch') return;
      const mnemonic = mnemonicFromEvent(p.event);
      if (!mnemonic) return;
      if (p.level === 'error') {
        this.append('errors', this.tagFromEvent(p.event), p.message, true, mnemonic);
      } else if (p.level === 'warn') {
        this.append('warnings', this.tagFromEvent(p.event), p.message, true, mnemonic);
      } else if (p.level === 'info') {
        this.append('informational', this.tagFromEvent(p.event), p.message, true, mnemonic);
      }
    };
    unsubs.push(bus.subscribe('log', logHandler));
    const loggerSubscription = Logger.subscribe(
      (entry) => logHandler({ payload: entry }), { source: deviceId });
    unsubs.push(() => Logger.unsubscribe(loggerSubscription));
    this.busUnsub = () => {
      for (const u of unsubs) u();
      this.attachedBus = null;
      this.attachedDeviceId = null;
      this.busUnsub = null;
    };
    return this.busUnsub;
  }

  /** Apply `logging …` (negate=false) or `no logging …` (negate=true). */
  apply(args: string[], negate: boolean): void {
    this.applyLogging(args, negate);
  }

  private static readonly INVALID = (token?: string): LoggingCommandError =>
    ({ kind: 'invalid', token });

  private static readonly INCOMPLETE: LoggingCommandError = { kind: 'incomplete' };

  private parseSeverity(tok: string | undefined): Severity | null {
    return tok === undefined ? null : normSeverity(tok);
  }

  /**
   * Un entier ET ses bornes. IOS refuse une valeur hors plage plutôt que
   * de la ramener au plus proche : une configuration qui vaut autre chose
   * que ce qu'on a tapé est pire qu'une commande refusée.
   */
  private parseBounded(tok: string | undefined, min: number, max: number): number | null {
    if (tok === undefined || !/^\d+$/.test(tok)) return null;
    const n = parseInt(tok, 10);
    return n >= min && n <= max ? n : null;
  }

  private removeHost(ip: string): void {
    const i = this.hostConfigs.findIndex(h => h.ip === ip);
    if (i >= 0) this.hostConfigs.splice(i, 1);
  }

  /**
   * `logging host <ip> [transport {udp|tcp} [port <n>]]`.
   *
   * Le transport et le port sont LA raison de taper cette forme : un
   * collecteur en TCP/1470 n'est pas un collecteur en UDP/514.
   */
  private applyHost(ip: string, rest: string[], negate: boolean): LoggingCommandError | null {
    if (negate) { this.removeHost(ip); return null; }
    let transport: 'udp' | 'tcp' = 'udp';
    let port = 514;
    let discriminator: string | null = null;
    for (let i = 0; i < rest.length; i++) {
      const kw = rest[i].toLowerCase();
      if (kw === 'discriminator') {
        const nom = rest[++i];
        if (nom === undefined) return LoggingConfig.INCOMPLETE;
        if (!this.discriminators.has(nom)) return LoggingConfig.INVALID(nom);
        discriminator = nom;
        continue;
      }
      if (kw === 'transport') {
        const t = (rest[++i] ?? '').toLowerCase();
        if (t === '') return LoggingConfig.INCOMPLETE;
        if (t !== 'udp' && t !== 'tcp') return LoggingConfig.INVALID(rest[i]);
        transport = t;
        if ((rest[i + 1] ?? '').toLowerCase() === 'port') {
          i++;
          const p = this.parseBounded(rest[++i], 1, 65535);
          if (rest[i] === undefined) return LoggingConfig.INCOMPLETE;
          if (p === null) return LoggingConfig.INVALID(rest[i]);
          port = p;
        }
      } else {
        return LoggingConfig.INVALID(rest[i]);
      }
    }
    const existing = this.hostConfigs.find(h => h.ip === ip);
    if (existing) {
      existing.transport = transport;
      existing.port = port;
      if (discriminator) existing.discriminator = discriminator;
    } else {
      this.hostConfigs.push({ ip, transport, port, logged: 0, discriminator, droppedByMd: 0 });
    }
    return null;
  }

  /**
   * `logging buffered [<size>] [<severity>]`, dont l'argument numérique
   * est AMBIGU par conception et résolu par sa valeur : `0-7` est une
   * sévérité, `4096-2147483647` une taille. Un `logging buffered 6` règle
   * donc le niveau, jamais un tampon de six octets — qui ne pourrait
   * contenir aucun message.
   */
  private applyBuffered(rest: string[], negate: boolean): LoggingCommandError | null {
    if ((rest[0] ?? '').toLowerCase() === 'discriminator') {
      if (negate) { this.attachedMd.buffered = null; return null; }
      if (!rest[1]) return LoggingConfig.INCOMPLETE;
      if (!this.discriminators.has(rest[1])) return LoggingConfig.INVALID(rest[1]);
      this.attachedMd.buffered = rest[1];
      this.buffered = true;
      return this.applyBufferedValues(rest.slice(2));
    }
    if (negate) {
      this.buffered = false;
      this.bufferedSize = BUFFERED_SIZE_DEFAUT;
      this.bufferedSeverity = BUFFERED_SEVERITE_DEFAUT;
      return null;
    }
    this.buffered = true;
    return this.applyBufferedValues(rest);
  }

  private applyBufferedValues(rest: string[]): LoggingCommandError | null {
    let size: number | null = null;
    let severity: Severity | null = null;
    for (const tok of rest) {
      if (/^\d+$/.test(tok)) {
        const n = parseInt(tok, 10);
        if (n >= 0 && n <= 7) severity = SEVERITIES[n];
        else if (n >= BUFFERED_SIZE_MIN && n <= BUFFERED_SIZE_MAX) size = n;
        else return LoggingConfig.INVALID(tok);
      } else {
        const s = normSeverity(tok);
        if (!s) return LoggingConfig.INVALID(tok);
        severity = s;
      }
    }
    if (size !== null) this.bufferedSize = size;
    if (severity !== null) this.bufferedSeverity = severity;
    return null;
  }

  private applyOriginId(rest: string[], negate: boolean): LoggingCommandError | null {
    if (negate) { this.originId = null; return null; }
    const mode = (rest[0] ?? '').toLowerCase();
    if (mode === '') return LoggingConfig.INCOMPLETE;
    if (mode === 'hostname' || mode === 'ip' || mode === 'ipv6') {
      this.originId = { mode };
      return null;
    }
    if (mode === 'string') {
      const text = rest.slice(1).join(' ');
      if (!text) return LoggingConfig.INCOMPLETE;
      this.originId = { mode: 'string', text };
      return null;
    }
    return LoggingConfig.INVALID(rest[0]);
  }

  private applyHistory(rest: string[], negate: boolean): LoggingCommandError | null {
    if ((rest[0] ?? '').toLowerCase() === 'size') {
      if (negate) { this.historySize = 1; return null; }
      const n = this.parseBounded(rest[1], HISTORY_SIZE_MIN, HISTORY_SIZE_MAX);
      if (rest[1] === undefined) return LoggingConfig.INCOMPLETE;
      if (n === null) return LoggingConfig.INVALID(rest[1]);
      this.historySize = n;
      while (this.historyEntries.length > this.historySize) {
        this.historyEntries.shift();
        this.historyFlushed++;
      }
      return null;
    }
    if (negate) { this.historySeverity = 'warnings'; return null; }
    if (rest.length === 0) return LoggingConfig.INCOMPLETE;
    const s = this.parseSeverity(rest[0]);
    if (!s) return LoggingConfig.INVALID(rest[0]);
    this.historySeverity = s;
    return null;
  }

  /**
   * `logging rate-limit [console|all] <1-10000> [except <severity>]`.
   */
  private applyRateLimit(rest: string[], negate: boolean): LoggingCommandError | null {
    if (negate) {
      this.rateLimit = null;
      this.rateLimitScope = 'console';
      this.rateLimitExcept = null;
      return null;
    }
    let i = 0;
    const mot = (rest[0] ?? '').toLowerCase();
    const scope: 'console' | 'all' = mot === 'all' ? 'all' : 'console';
    if (mot === 'console' || mot === 'all') i = 1;
    const n = this.parseBounded(rest[i], RATE_LIMIT_MIN, RATE_LIMIT_MAX);
    if (rest[i] === undefined) return LoggingConfig.INCOMPLETE;
    if (n === null) return LoggingConfig.INVALID(rest[i]);
    i++;
    let except: Severity | null = null;
    if (i < rest.length) {
      if (rest[i].toLowerCase() !== 'except') return LoggingConfig.INVALID(rest[i]);
      if (rest[i + 1] === undefined) return LoggingConfig.INCOMPLETE;
      except = this.parseSeverity(rest[i + 1]);
      if (!except) return LoggingConfig.INVALID(rest[i + 1]);
      i += 2;
      if (i < rest.length) return LoggingConfig.INVALID(rest[i]);
    }
    this.rateLimit = n;
    this.rateLimitScope = scope;
    this.rateLimitExcept = except;
    return null;
  }

  /**
   * `logging discriminator <name> [severity {drops|includes} <list>]
   * [facility {drops|includes} <regex>] [mnemonics {drops|includes} <regex>]
   * [msg-body {drops|includes} <regex>] [rate-limit <n>]`
   *
   * Chaque appel COMPLÈTE le filtre existant plutôt que de le remplacer,
   * comme sur IOS : on pose les clauses l'une après l'autre.
   */
  private applyDiscriminator(rest: string[], negate: boolean): LoggingCommandError | null {
    const nom = rest[0];
    if (!nom) return LoggingConfig.INCOMPLETE;
    if (negate) { this.discriminators.delete(nom); return null; }
    const md: LogDiscriminator = this.discriminators.get(nom)
      ?? { name: nom, windowStart: 0, windowCount: 0 };
    for (let i = 1; i < rest.length; i++) {
      const clause = rest[i].toLowerCase();
      if (clause === 'rate-limit') {
        const n = this.parseBounded(rest[i + 1], 1, RATE_LIMIT_MAX);
        if (rest[i + 1] === undefined) return LoggingConfig.INCOMPLETE;
        if (n === null) return LoggingConfig.INVALID(rest[i + 1]);
        md.rateLimit = n;
        i++;
        continue;
      }
      if (!['severity', 'facility', 'mnemonics', 'msg-body'].includes(clause)) {
        return LoggingConfig.INVALID(rest[i]);
      }
      const mode = (rest[i + 1] ?? '').toLowerCase();
      if (mode === '') return LoggingConfig.INCOMPLETE;
      if (mode !== 'drops' && mode !== 'includes') return LoggingConfig.INVALID(rest[i + 1]);
      const valeur = rest[i + 2];
      if (valeur === undefined) return LoggingConfig.INCOMPLETE;
      if (clause === 'severity') {
        const niveaux: number[] = [];
        for (const part of valeur.split(',')) {
          const plage = part.match(/^(\d)-(\d)$/);
          if (plage) {
            for (let n = Number(plage[1]); n <= Number(plage[2]); n++) niveaux.push(n);
          } else {
            const s = normSeverity(part);
            if (!s) return LoggingConfig.INVALID(valeur);
            niveaux.push(this.SEVERITY_ORDER[s]);
          }
        }
        md.severity = { mode, levels: niveaux };
      } else if (clause === 'facility') {
        md.facility = { mode, pattern: valeur };
      } else if (clause === 'mnemonics') {
        md.mnemonics = { mode, pattern: valeur };
      } else {
        // `msg-body` porte sur le TEXTE, donc il prend tout ce qui reste :
        // un motif peut contenir des espaces, et le couper au premier en
        // ferait un autre motif.
        md.msgBody = { mode, pattern: rest.slice(i + 2).join(' ') };
        i = rest.length;
        break;
      }
      i += 2;
    }
    this.discriminators.set(nom, md);
    return null;
  }

  /**
   * `logging persistent [url <url>] [size <n>] [filesize <n>]
   * [immediate | batch <n>] [threshold <pct>]`.
   */
  private applyPersistent(rest: string[], negate: boolean): LoggingCommandError | null {
    if (negate) { this.persistent.enabled = false; return null; }
    const p: PersistentLoggingConfig = { ...this.persistent, enabled: true };
    for (let i = 0; i < rest.length; i++) {
      const kw = rest[i].toLowerCase();
      const suivant = rest[i + 1];
      if (kw === 'immediate') { p.immediate = true; continue; }
      if (kw === 'batch') {
        const n = this.parseBounded(suivant, 1, BUFFERED_SIZE_MAX);
        if (suivant === undefined) return LoggingConfig.INCOMPLETE;
        if (n === null) return LoggingConfig.INVALID(suivant);
        p.immediate = false;
        i++;
        continue;
      }
      if (suivant === undefined) return LoggingConfig.INCOMPLETE;
      if (kw === 'url') { p.url = suivant; i++; continue; }
      if (kw === 'size' || kw === 'filesize') {
        const n = this.parseBounded(suivant, 1024, BUFFERED_SIZE_MAX);
        if (n === null) return LoggingConfig.INVALID(suivant);
        if (kw === 'size') p.size = n; else p.filesize = n;
        i++;
        continue;
      }
      if (kw === 'threshold') {
        const n = this.parseBounded(suivant, 1, 99);
        if (n === null) return LoggingConfig.INVALID(suivant);
        p.threshold = n;
        i++;
        continue;
      }
      return LoggingConfig.INVALID(rest[i]);
    }
    // Un fichier plus grand que le journal entier ne pourrait jamais
    // être écrit en entier : la borne serait contradictoire.
    if (p.filesize > p.size) return LoggingConfig.INVALID(String(p.filesize));
    this.persistent = p;
    return null;
  }

  private applyQueueLimit(rest: string[], negate: boolean): LoggingCommandError | null {
    if (negate) { this.queueLimit = null; return null; }
    let i = 0;
    const mot = (rest[0] ?? '').toLowerCase();
    const scope: 'default' | 'esm' | 'trap' = mot === 'esm' ? 'esm' : mot === 'trap' ? 'trap' : 'default';
    if (mot === 'esm' || mot === 'trap') i = 1;
    if (rest[i] === undefined) return LoggingConfig.INCOMPLETE;
    const n = this.parseBounded(rest[i], 1, 2147483647);
    if (n === null) return LoggingConfig.INVALID(rest[i]);
    if (rest[i + 1] !== undefined) return LoggingConfig.INVALID(rest[i + 1]);
    this.queueLimit = { scope, size: n };
    return null;
  }

  private applyReload(rest: string[], negate: boolean): LoggingCommandError | null {
    if (negate) { this.reloadSeverity = null; this.reloadMessageLimit = null; return null; }
    let severity: Severity | null = null;
    let limit: number | null = null;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i].toLowerCase() === 'message-limit') {
        const n = this.parseBounded(rest[i + 1], 1, 4294967295);
        if (rest[i + 1] === undefined) return LoggingConfig.INCOMPLETE;
        if (n === null) return LoggingConfig.INVALID(rest[i + 1]);
        limit = n;
        i++;
        continue;
      }
      const s = this.parseSeverity(rest[i]);
      if (!s) return LoggingConfig.INVALID(rest[i]);
      severity = s;
    }
    this.reloadSeverity = severity ?? 'notifications';
    this.reloadMessageLimit = limit;
    return null;
  }

  /**
   * Apply `logging …` / `no logging …`, naming the faulty token rather
   * than swallowing it.
   *
   * Le `default` muet d'avant était la racine de tout : un mot-clé
   * inconnu ne changeait rien et ne disait rien, donc l'opérateur croyait
   * avoir agi. Ici tout ce qui n'est pas reconnu est refusé.
   */
  applyLogging(args: string[], negate: boolean): LoggingCommandError | null {
    const head = (args[0] ?? '').toLowerCase();
    const rest = args.slice(1);
    switch (head) {
      case '':
        // `logging` seul ne désigne aucune destination : IOS ne propose
        // pas `<cr>` derrière et refuse la ligne.
        return LoggingConfig.INCOMPLETE;
      case 'on':
        if (rest.length) return LoggingConfig.INVALID(rest[0]);
        this.enabled = !negate;
        return null;
      case 'rate-limit':
        return this.applyRateLimit(rest, negate);
      case 'buffered':
        return this.applyBuffered(rest, negate);
      case 'console':
      case 'monitor':
      case 'trap': {
        const cible = head as 'console' | 'monitor' | 'trap';
        // `logging {console|monitor} discriminator <name>` attache un
        // filtre à la destination sans toucher à sa sévérité.
        if ((rest[0] ?? '').toLowerCase() === 'discriminator' && cible !== 'trap') {
          if (negate) { this.attachedMd[cible] = null; return null; }
          if (!rest[1]) return LoggingConfig.INCOMPLETE;
          if (!this.discriminators.has(rest[1])) return LoggingConfig.INVALID(rest[1]);
          this.attachedMd[cible] = rest[1];
          return null;
        }
        if (negate) {
          if (cible === 'console') this.consoleEnabled = false;
          else if (cible === 'monitor') this.monitorEnabled = false;
          else this.trapSeverity = 'informational';
          return null;
        }
        if (rest.length > 1) return LoggingConfig.INVALID(rest[1]);
        if (rest.length === 1) {
          const s = this.parseSeverity(rest[0]);
          if (!s) return LoggingConfig.INVALID(rest[0]);
          if (cible === 'console') this.consoleSeverity = s;
          else if (cible === 'monitor') this.monitorSeverity = s;
          else this.trapSeverity = s;
        } else if (cible === 'trap') {
          this.trapSeverity = 'informational';
        }
        if (cible === 'console') this.consoleEnabled = true;
        else if (cible === 'monitor') this.monitorEnabled = true;
        return null;
      }
      case 'facility': {
        if (negate) { this.facility = 'local7'; return null; }
        if (rest.length === 0) return LoggingConfig.INCOMPLETE;
        const f = rest[0].toLowerCase();
        // Même règle d'abréviation que partout ailleurs dans IOS, et
        // `auth` l'emporte sur `authpriv` parce qu'il est exact.
        const exact = FACILITY_NAMES.includes(f);
        const candidats = FACILITY_NAMES.filter(n => n.startsWith(f));
        if (!exact && candidats.length !== 1) return LoggingConfig.INVALID(rest[0]);
        this.facility = exact ? f : candidats[0];
        return null;
      }
      case 'source-interface':
        if (negate) { this.sourceInterface = null; return null; }
        if (rest.length === 0) return LoggingConfig.INCOMPLETE;
        this.sourceInterface = rest.join(' ');
        return null;
      case 'host': {
        if (rest.length === 0) return LoggingConfig.INCOMPLETE;
        if (!isValidIPv4(rest[0])) return LoggingConfig.INVALID(rest[0]);
        return this.applyHost(rest[0], rest.slice(1), negate);
      }
      case 'origin-id':
        return this.applyOriginId(rest, negate);
      case 'count':
        if (rest.length) return LoggingConfig.INVALID(rest[0]);
        this.countEnabled = !negate;
        return null;
      case 'history':
        return this.applyHistory(rest, negate);
      case 'discriminator':
        return this.applyDiscriminator(rest, negate);
      case 'persistent':
        return this.applyPersistent(rest, negate);
      case 'queue-limit':
        return this.applyQueueLimit(rest, negate);
      case 'reload':
        return this.applyReload(rest, negate);
      case 'snmp-trap': {
        if (negate) { this.snmpTrapSeverity = null; return null; }
        if (rest.length === 0) { this.snmpTrapSeverity = 'informational'; return null; }
        const s = this.parseSeverity(rest[0]);
        if (!s) return LoggingConfig.INVALID(rest[0]);
        if (rest.length > 1) return LoggingConfig.INVALID(rest[1]);
        this.snmpTrapSeverity = s;
        return null;
      }
      case 'userinfo':
        if (rest.length) return LoggingConfig.INVALID(rest[0]);
        this.userInfo = !negate;
        return null;
      case 'server-arp':
        if (rest.length) return LoggingConfig.INVALID(rest[0]);
        this.serverArp = !negate;
        return null;
      case 'delimiter': {
        const kw = (rest[0] ?? '').toLowerCase();
        if (kw === '') return LoggingConfig.INCOMPLETE;
        if (kw !== 'tcp') return LoggingConfig.INVALID(rest[0]);
        this.delimiterTcp = !negate;
        return null;
      }
      case 'message-counter': {
        const kw = (rest[0] ?? '').toLowerCase();
        if (kw === '') return LoggingConfig.INCOMPLETE;
        if (kw !== 'log' && kw !== 'debug' && kw !== 'syslog') return LoggingConfig.INVALID(rest[0]);
        if (rest.length > 1) return LoggingConfig.INVALID(rest[1]);
        if (negate) this.messageCounters.delete(kw);
        else this.messageCounters.add(kw);
        return null;
      }
      case 'exception': {
        if (negate) { this.exceptionSize = BUFFERED_SIZE_MIN; return null; }
        const n = this.parseBounded(rest[0], BUFFERED_SIZE_MIN, BUFFERED_SIZE_MAX);
        if (rest[0] === undefined) return LoggingConfig.INCOMPLETE;
        if (n === null) return LoggingConfig.INVALID(rest[0]);
        this.exceptionSize = n;
        return null;
      }
      default:
        // `logging <ip>` — la forme héritée, qu'IOS normalise lui-même en
        // `logging host <ip>` dans la configuration.
        if (/^\d+\.\d+\.\d+\.\d+$/.test(head)) {
          if (!isValidIPv4(head)) return LoggingConfig.INVALID(args[0]);
          return this.applyHost(head, rest, negate);
        }
        return LoggingConfig.INVALID(args[0]);
    }
  }

  /**
   * Les classes de messages que `logging message-counter` compte.
   *
   * IOS en distingue trois : les messages ordinaires (`log`), ceux que
   * `debug` produit (`debug`), et ceux qui partent vers un serveur
   * syslog (`syslog`). Un message peut appartenir à deux d'entre elles —
   * un message ordinaire qui atteint le seuil du relais est à la fois
   * `log` et `syslog` — et il est compté dès qu'UNE de ses classes est
   * active. Par défaut seule `log` l'est, ce qui est le défaut d'IOS :
   * les lignes de debug ne gonflent pas la table.
   */
  private compteCeMessage(severity: Severity): boolean {
    if (severity === 'debugging') {
      if (this.messageCounters.has('debug')) return true;
    } else if (this.messageCounters.has('log')) {
      return true;
    }
    return this.messageCounters.has('syslog')
      && this.SEVERITY_ORDER[severity] <= this.SEVERITY_ORDER[this.trapSeverity];
  }

  /**
   * `show logging count` — la table des occurrences.
   *
   * Elle comptait tout, quelle que soit la configuration : ni
   * `logging count`, qui l'active, ni `logging message-counter`, qui
   * choisit les classes comptées, n'étaient lus. Une table qui ignore
   * les deux commandes censées la régler n'est pas une mesure.
   */
  renderCount(): string {
    // Réserve d'honnêteté, écrite ici plutôt que découverte : le libellé
    // exact d'IOS quand on demande la table sans avoir activé le comptage
    // n'a pas pu être vérifié contre un vrai équipement depuis cet
    // environnement. La forme retenue suit sa convention — préfixe `%`,
    // une phrase. Ce qui est sûr, et c'est le point, est qu'une table
    // pleine alors que la capacité est éteinte serait un mensonge.
    if (!this.countEnabled) return '% Logging count is not enabled';
    const tally = new Map<string, { count: number; last: number }>();
    for (const m of this.messages) {
      if (!this.compteCeMessage(m.severity)) continue;
      const sevNum = this.SEVERITY_ORDER[m.severity];
      const key = `${m.tag.toUpperCase()}-${sevNum}-${m.mnemonic.toUpperCase()}`;
      const prev = tally.get(key);
      if (prev) { prev.count++; prev.last = m.ts; }
      else tally.set(key, { count: 1, last: m.ts });
    }
    const lines = ['Facility           Message Name              Sev Occur   Last Time'];
    let total = 0;
    for (const [key, v] of [...tally.entries()].sort((a, b) => b[1].count - a[1].count)) {
      const [facility, sev, mnem] = key.split('-');
      total += v.count;
      const stamp = new Date(v.last).toISOString().slice(5, 19).replace('T', ' ');
      lines.push(
        `${facility.padEnd(19)}${mnem.padEnd(26)}${sev.padStart(3)}${String(v.count).padStart(6)}   ${stamp}`,
      );
    }
    lines.push('');
    lines.push(`Total: ${total}`);
    return lines.join('\n');
  }

  /**
   * `show logging` au format d'IOS 15.
   *
   * Ce qu'on lit en premier sur un vrai équipement, ce n'est pas le
   * niveau — c'est le NOMBRE de messages effectivement journalisés par
   * destination : une destination configurée qui ne reçoit rien ne se
   * distingue d'une destination qui travaille que par ce chiffre.
   *
   * `xml disabled, filtering disabled` sont des constantes : ce
   * simulateur n'a ni sortie XML ni modules de filtrage ESM. C'est la
   * valeur d'un équipement ordinaire, et l'afficher est plus fidèle que
   * de la taire.
   */
  /**
   * `options.last` ne coupe QUE la liste des messages, pas l'en-tête :
   * `show logging last 5` sur un vrai IOS affiche toujours les compteurs
   * et les niveaux, puis les cinq dernières lignes.
   */
  render(options?: { last?: number }): string {
    // IOS aligne les niveaux entre eux : « Buffer » est plus court que
    // « Console » et « Monitor », donc son deux-points est suivi de deux
    // espaces.
    const dest = (nom: string, actif: boolean, sev: Severity, compte: number): string[] => {
      const etiquette = `${nom} logging:`.padEnd(16);
      if (!actif) return [`    ${etiquette} disabled`];
      return [
        `    ${etiquette} level ${sev}, ${compte} messages logged, xml disabled,`,
        '                     filtering disabled',
      ];
    };
    const lines = [
      `Syslog logging: ${this.enabled ? 'enabled' : 'disabled'}` +
        ` (0 messages dropped, ${this.rateLimitedTotal} messages rate-limited,` +
        ' 0 flushes, 0 overruns, xml disabled, filtering disabled)',
      '',
      ...this.renderDiscriminatorSections(),
      ...dest('Console', this.consoleEnabled, this.consoleSeverity, this.logged.console),
      ...dest('Monitor', this.monitorEnabled, this.monitorSeverity, this.logged.monitor),
      ...dest('Buffer', this.buffered, this.bufferedSeverity, this.logged.buffer),
      `    Exception Logging: size (${this.exceptionSize} bytes)`,
      `    Count and timestamp logging messages: ${this.countEnabled ? 'enabled' : 'disabled'}`,
      this.persistent.enabled
        ? `    Persistent logging: enabled, url ${this.persistent.url}, `
          + `size ${this.persistent.size}, filesize ${this.persistent.filesize}`
        : '    Persistent logging: disabled',
      `    Timestamp logging: ${this.horodatageResume()}`,
      `    Sequence numbers: ${this.sequenceNumbers ? 'enabled' : 'disabled'}`,
      `    Facility: ${this.facility}`,
    ];
    if (this.originId) {
      lines.push(`    Origin ID: ${this.originId.mode}${this.originId.text ? ` ${this.originId.text}` : ''}`);
    }
    if (this.sourceInterface) {
      lines.push(`    Source interface: ${this.sourceInterface}`);
    }
    lines.push('');
    lines.push(`    Trap logging: level ${this.trapSeverity}, ${this.logged.trap} message lines logged`);
    if (this.hostConfigs.length) {
      for (const h of this.hostConfigs) {
        lines.push(`        Logging to ${h.ip}  (${h.transport} port ${h.port}, audit disabled,`);
        lines.push('              link up),');
        lines.push(`              ${h.logged} message lines logged, 0 message lines rate-limited,`);
        lines.push(`              ${h.droppedByMd} message lines dropped-by-MD, xml disabled,`);
        lines.push(`              sequence number ${this.sequenceNumbers ? 'enabled' : 'disabled'}`);
      }
    } else {
      lines.push('        No active syslog hosts');
    }
    if (this.buffered) {
      // La taille du tampon ne figure QUE sur cette ligne — c'est là
      // qu'IOS la met, et la taire quand le tampon est vide reviendrait
      // à ne jamais pouvoir vérifier ce que `logging buffered` a réglé.
      lines.push('');
      lines.push('Log Buffer (' + this.bufferedSize + ' bytes):');
      lines.push('');
      const derniers = options?.last !== undefined
        ? this.messages.slice(-options.last)
        : this.messages;
      for (const m of derniers) lines.push(m.rendu);
    }
    return lines.join('\n');
  }

  /**
   * Un discriminateur est ACTIF quand une destination l'utilise, INACTIF
   * quand il est défini et attaché à rien. La distinction est réelle et
   * c'est la première chose qu'on vérifie quand un filtre « ne marche
   * pas » : le plus souvent il n'a jamais été attaché.
   */
  private renderDiscriminatorSections(): string[] {
    const attaches = new Set(Object.values(this.attachedMd).filter((n): n is string => n !== null));
    const decrire = (md: LogDiscriminator): string[] => {
      const parts: string[] = [];
      if (md.severity) {
        parts.push(`severity ${md.severity.mode} ${md.severity.levels.join(',')}`);
      }
      if (md.facility) parts.push(`facility ${md.facility.mode} ${md.facility.pattern}`);
      if (md.mnemonics) parts.push(`mnemonics ${md.mnemonics.mode} ${md.mnemonics.pattern}`);
      if (md.msgBody) parts.push(`msg-body ${md.msgBody.mode} ${md.msgBody.pattern}`);
      if (md.rateLimit !== undefined) parts.push(`rate-limit ${md.rateLimit}`);
      if (parts.length === 0) return [`${md.name.padEnd(20)}(no filter clause)`];
      return parts.map((p, i) => `${(i === 0 ? md.name : '').padEnd(20)}${p}`);
    };
    const actifs = [...this.discriminators.values()].filter(m => attaches.has(m.name));
    const inactifs = [...this.discriminators.values()].filter(m => !attaches.has(m.name));
    const lignes: string[] = [];
    if (actifs.length === 0) lignes.push('No Active Message Discriminator.', '');
    else {
      lignes.push('Active Message Discriminator:');
      for (const m of actifs) lignes.push(...decrire(m));
      lignes.push('');
    }
    if (inactifs.length > 0) {
      lignes.push('Inactive Message Discriminator:');
      for (const m of inactifs) lignes.push(...decrire(m));
      lignes.push('');
    }
    return lignes;
  }

  /**
   * `show logging history` — une table à PART, celle qu'alimente
   * `logging history` et que le SNMP relève. La rendre identique à
   * `show logging` faisait croire à une seule vue là où IOS en a deux.
   */
  renderHistory(): string {
    const n = this.historySize;
    const lines = [
      `Syslog History Table:${n} maximum table ${n === 1 ? 'entry' : 'entries'},`,
      `  saving level ${this.historySeverity} or higher`,
      `  ${this.historyIgnored} messages ignored, 0 dropped, 0 recursive dropped`,
      `  ${this.historyFlushed} table entries flushed`,
      this.snmpTrapSeverity
        ? `  SNMP notifications enabled, severity ${this.snmpTrapSeverity} or higher`
        : '  SNMP notifications not enabled',
    ];
    this.historyEntries.forEach((e, i) => {
      lines.push(` entry number ${i + 1} : ${e.tag.toUpperCase()}-${this.SEVERITY_ORDER[e.severity]}-${e.mnemonic}`);
      lines.push(`  ${e.text}`);
      lines.push(` timestamp: ${Math.floor(e.ts / 1000)}`);
    });
    return lines.join('\n');
  }

  asRunningConfigLines(): string[] {
    const lines: string[] = [];
    if (!this.enabled) lines.push('no logging on');
    // Une configuration ne rend que ce qui s'écarte du défaut : le
    // tampon est actif d'usine, donc l'annoncer reviendrait à faire
    // apparaître une commande que personne n'a tapée.
    const tamponParDefaut = this.bufferedSize === BUFFERED_SIZE_DEFAUT
      && this.bufferedSeverity === BUFFERED_SEVERITE_DEFAUT;
    // Un tampon avec discriminateur est rendu plus bas, avec son filtre :
    // écrire les deux lignes referait le réglage deux fois à l'import.
    if (!this.buffered) lines.push('no logging buffered');
    else if (!tamponParDefaut && !this.attachedMd.buffered) {
      lines.push(`logging buffered ${this.bufferedSize} ${this.bufferedSeverity}`);
    }
    if (!this.consoleEnabled) lines.push('no logging console');
    else if (this.consoleSeverity !== 'debugging') lines.push(`logging console ${this.consoleSeverity}`);
    if (!this.monitorEnabled) lines.push('no logging monitor');
    else if (this.monitorSeverity !== 'debugging') lines.push(`logging monitor ${this.monitorSeverity}`);
    if (this.trapSeverity !== 'informational') lines.push(`logging trap ${this.trapSeverity}`);
    if (this.facility !== 'local7') lines.push(`logging facility ${this.facility}`);
    // Rendered from the spec rather than as a fixed string: a
    // running-config is replayed on topology import, so a `log uptime`
    // coming back as `log datetime msec` would remake a different router.
    for (const canal of ['debug', 'log'] as const) {
      const l = this.timestampConfigLine(canal);
      if (l) lines.push(l);
    }
    if (this.sequenceNumbers) lines.push('service sequence-numbers');
    // Les discriminateurs d'abord : une destination ne peut pas
    // référencer un filtre qui n'existe pas encore, et une
    // running-config est REJOUÉE telle quelle à l'import.
    for (const md of this.discriminators.values()) {
      const parts = [`logging discriminator ${md.name}`];
      if (md.severity) parts.push(`severity ${md.severity.mode} ${md.severity.levels.join(',')}`);
      if (md.facility) parts.push(`facility ${md.facility.mode} ${md.facility.pattern}`);
      if (md.mnemonics) parts.push(`mnemonics ${md.mnemonics.mode} ${md.mnemonics.pattern}`);
      if (md.rateLimit !== undefined) parts.push(`rate-limit ${md.rateLimit}`);
      // `msg-body` en dernier : son motif prend tout ce qui suit.
      if (md.msgBody) parts.push(`msg-body ${md.msgBody.mode} ${md.msgBody.pattern}`);
      lines.push(parts.join(' '));
    }
    if (this.attachedMd.console) lines.push(`logging console discriminator ${this.attachedMd.console}`);
    if (this.attachedMd.monitor) lines.push(`logging monitor discriminator ${this.attachedMd.monitor}`);
    if (this.attachedMd.buffered) {
      lines.push(`logging buffered discriminator ${this.attachedMd.buffered} `
        + `${this.bufferedSize} ${this.bufferedSeverity}`);
    }
    if (this.persistent.enabled) {
      lines.push(`logging persistent url ${this.persistent.url} `
        + `size ${this.persistent.size} filesize ${this.persistent.filesize}`
        + (this.persistent.immediate ? ' immediate' : '')
        + (this.persistent.threshold ? ` threshold ${this.persistent.threshold}` : ''));
    }
    if (this.snmpTrapSeverity) lines.push(`logging snmp-trap ${this.snmpTrapSeverity}`);
    if (this.userInfo) lines.push('logging userinfo');
    if (this.serverArp) lines.push('logging server-arp');
    if (this.delimiterTcp) lines.push('logging delimiter tcp');
    if (this.queueLimit) {
      const portee = this.queueLimit.scope === 'default' ? '' : `${this.queueLimit.scope} `;
      lines.push(`logging queue-limit ${portee}${this.queueLimit.size}`);
    }
    for (const c of ['log', 'debug', 'syslog'] as const) {
      const defaut = c === 'log';
      if (this.messageCounters.has(c) !== defaut) {
        lines.push(`${this.messageCounters.has(c) ? '' : 'no '}logging message-counter ${c}`);
      }
    }
    if (this.reloadSeverity) {
      lines.push(`logging reload ${this.reloadSeverity}`
        + (this.reloadMessageLimit ? ` message-limit ${this.reloadMessageLimit}` : ''));
    }
    if (this.countEnabled) lines.push('logging count');
    if (this.exceptionSize !== BUFFERED_SIZE_MIN) lines.push(`logging exception ${this.exceptionSize}`);
    if (this.rateLimit !== null) {
      const portee = this.rateLimitScope === 'all' ? 'all ' : '';
      const sauf = this.rateLimitExcept ? ` except ${this.rateLimitExcept}` : '';
      lines.push(`logging rate-limit ${portee}${this.rateLimit}${sauf}`);
    }
    if (this.originId) {
      lines.push(`logging origin-id ${this.originId.mode}${this.originId.text ? ` ${this.originId.text}` : ''}`);
    }
    if (this.historySeverity !== 'warnings') lines.push(`logging history ${this.historySeverity}`);
    if (this.historySize !== 1) lines.push(`logging history size ${this.historySize}`);
    if (this.sourceInterface) lines.push(`logging source-interface ${this.sourceInterface}`);
    // Le transport et le port sont rendus parce qu'une configuration
    // relue à l'import REFAIT le collecteur : les perdre remettrait le
    // routeur en UDP/514 sans le dire.
    for (const h of this.hostConfigs) {
      const suffix = h.transport === 'udp' && h.port === 514
        ? '' : ` transport ${h.transport} port ${h.port}`;
      const md = h.discriminator ? ` discriminator ${h.discriminator}` : '';
      lines.push(`logging host ${h.ip}${md}${suffix}`);
    }
    return lines;
  }

  /** `service timestamps …` as the operator would have had to type it. */
  timestampConfigLine(channel: TimestampChannel): string | null {
    const s = this.horodatage[channel];
    if (!s.enabled) return null;
    const mots = [`service timestamps ${channel}`, s.format];
    if (s.format === 'datetime') {
      if (s.msec) mots.push('msec');
      if (s.localtime) mots.push('localtime');
      if (s.showTimezone) mots.push('show-timezone');
      if (s.year) mots.push('year');
    } else if (s.msec) {
      mots.push('msec');
    }
    return mots.join(' ');
  }

  private horodatageResume(): string {
    const actifs = (['debug', 'log'] as const).filter(c => this.horodatage[c].enabled);
    if (actifs.length === 0) return 'disabled';
    return actifs.map(c => {
      const s = this.horodatage[c];
      const options = [
        s.format,
        ...(s.msec ? ['msec'] : []),
        ...(s.localtime ? ['localtime'] : []),
        ...(s.showTimezone ? ['show-timezone'] : []),
        ...(s.year ? ['year'] : []),
      ];
      return `${c} ${options.join(' ')}`;
    }).join(', ');
  }

  /**
   * `display logbuffer`.
   *
   * La taille et le canal viennent d'`info-center`, quand la machine en
   * a un : `info-center logbuffer size 512` était accepté et cette vue
   * continuait d'annoncer la taille du tampon d'IOS, qui n'a rien à voir.
   * Le numéro de canal était écrit en dur, donc juste par coïncidence —
   * un `info-center logbuffer channel 6` ne le changeait pas.
   */
  renderHuawei(
    vrp?: { size: number; channel: number; channelName: string },
    seuil?: number | null,
  ): string {
    const pad2 = (n: number) => String(n).padStart(2, '0');
    const taille = vrp?.size ?? this.bufferedSize;
    const canal = vrp?.channel ?? 4;
    const nomCanal = vrp?.channelName ?? 'logbuffer';
    const retenus = seuil === undefined || seuil === null
      ? this.messages
      : this.messages.filter((m) => this.SEVERITY_ORDER[m.severity] <= seuil);
    const lines = [
      `Logging buffer configuration and contents: ${this.enabled ? 'enabled' : 'disabled'}`,
      `Allowed max buffer size : ${taille}`,
      `Actual buffer size : ${taille}`,
      `Channel number : ${canal} , Channel name : ${nomCanal}`,
      'Dropped messages : 0',
      'Overwritten messages : 0',
      `Current messages : ${retenus.length}`,
    ];
    for (const m of retenus) {
      const d = new Date(m.ts);
      const stamp = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
        `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
      const sevNum = this.SEVERITY_ORDER[m.severity];
      const tag = m.tag.toUpperCase();
      lines.push(`${stamp} %01${tag}/${sevNum}/${m.severity.toUpperCase()}: ${m.text}`);
    }
    return lines.join('\n');
  }

  reset(): void {
    this.enabled = true;
    this.buffered = false;
    this.hostConfigs.length = 0;
    this.sourceInterface = null;
    this.sequenceNumbers = false;
    this.countEnabled = false;
    this.originId = null;
    this.exceptionSize = BUFFERED_SIZE_MIN;
    this.historySeverity = 'warnings';
    this.historySize = 1;
    this.historyEntries.length = 0;
    this.historyIgnored = 0;
    this.historyFlushed = 0;
    this.rateLimit = null;
    this.rateLimitScope = 'console';
    this.rateLimitExcept = null;
    this.discriminators.clear();
    this.attachedMd.console = null;
    this.attachedMd.monitor = null;
    this.attachedMd.buffered = null;
    this.persistent = {
      enabled: false, url: PERSISTENT_URL_DEFAUT, size: PERSISTENT_SIZE_DEFAUT,
      filesize: PERSISTENT_FILESIZE_DEFAUT, immediate: false, threshold: 0,
    };
    this.snmpTrapSeverity = null;
    this.userInfo = false;
    this.serverArp = false;
    this.queueLimit = null;
    this.messageCounters.clear();
    this.messageCounters.add('log');
    this.delimiterTcp = false;
    this.reloadSeverity = null;
    this.reloadMessageLimit = null;
    this.horodatage.debug = defaultTimestampSpec();
    this.horodatage.log = defaultTimestampSpec();
  }
}
