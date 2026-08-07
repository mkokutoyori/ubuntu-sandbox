/**
 * `info-center` — le journal de VRP.
 *
 * Ce fichier existe parce que le sous-système n'avait pas d'état : un
 * `if/else` empilait trois listes sans rien valider, et sa branche
 * finale rangeait la ligne brute. Trois conséquences, toutes mesurées
 * (`docs/PRD-Info-Center-Huawei.md` §1) : tout était accepté, l'aide
 * n'avait rien à descendre, et la configuration rendue — celle qui est
 * REJOUÉE à l'import — refabriquait un autre routeur.
 *
 * L'ossature est le CANAL, qui n'a pas d'équivalent chez Cisco : VRP
 * route chaque message vers un canal numéroté de 0 à 9, et les
 * destinations (console, terminal, serveurs, tampons, agent SNMP) sont
 * des ABONNÉS de canaux, pas des destinations en soi.
 */

/** Les sévérités de VRP, dans l'ordre. VRP les écrit au singulier là où IOS met le pluriel. */
export const VRP_SEVERITIES = [
  'emergencies', 'alert', 'critical', 'error',
  'warning', 'notification', 'informational', 'debugging',
] as const;

export type VrpSeverity = typeof VRP_SEVERITIES[number];

/** Les trois familles de messages que VRP règle séparément. */
export const VRP_RECORD_TYPES = ['log', 'trap', 'debug'] as const;
export type VrpRecordType = typeof VRP_RECORD_TYPES[number];

/**
 * Les dix canaux d'usine. Un équipement neuf les possède TOUS —
 * `display channel` prétendait qu'il n'y en avait aucun.
 */
export const DEFAULT_CHANNEL_NAMES: readonly string[] = [
  'console', 'monitor', 'loghost', 'trapbuffer', 'logbuffer',
  'snmpagent', 'channel6', 'channel7', 'channel8', 'channel9',
];

/** Les destinations, et le canal auquel chacune est abonnée d'usine. */
export const DEFAULT_DESTINATION_CHANNEL: Readonly<Record<string, number>> = {
  console: 0, monitor: 1, loghost: 2, trapbuffer: 3, logbuffer: 4, snmpagent: 5,
};

export const LOGBUFFER_SIZE_DEFAUT = 512;
export const LOGBUFFER_SIZE_MAX = 10240;
export const TRAPBUFFER_SIZE_DEFAUT = 256;
export const TRAPBUFFER_SIZE_MAX = 1024;

export const VRP_FACILITIES: readonly string[] = [
  'local0', 'local1', 'local2', 'local3', 'local4', 'local5', 'local6', 'local7',
];

/**
 * Les modules dont ce simulateur produit réellement des messages, plus
 * `default`. Accepter n'importe quel mot ferait croire à un filtre qui
 * ne filtrera jamais rien.
 */
export const VRP_MODULES: readonly string[] = [
  'default', 'IFNET', 'OSPF', 'BGP', 'RIP', 'ISIS', 'LDP', 'VRRP', 'DHCP',
  'SSH', 'FTPS', 'TELNET', 'SNMP', 'NTP', 'SYSTEM', 'SECE', 'ARP', 'STP', 'LLDP',
];

export type VrpTimestampFormat =
  | 'boot' | 'date' | 'short-date' | 'format-date' | 'none';

export const VRP_TIMESTAMP_FORMATS: readonly VrpTimestampFormat[] = [
  'boot', 'date', 'short-date', 'format-date', 'none',
];

export type VrpPrecision = 'tenth-second' | 'millisecond' | 'second';

export interface VrpTimestampSpec {
  format: VrpTimestampFormat;
  precision: VrpPrecision | null;
}

/** Un collecteur syslog, identifié par SON ADRESSE — jamais dupliqué. */
export interface VrpLoghost {
  ip: string;
  channel: number;
  facility: string;
  port: number;
  transport: 'udp' | 'tcp';
}

/** `info-center source <module> channel <n> {log|trap|debug} …`. */
export interface VrpSourceRule {
  module: string;
  channel: number;
  record: VrpRecordType;
  state: boolean;
  severity: VrpSeverity;
}

/** Ce qu'une commande refusée doit dire, et sur quel mot poser le curseur. */
export interface InfoCenterError {
  kind: 'wrong-parameter' | 'unrecognized' | 'incomplete';
  token?: string;
}

const WRONG = (token?: string): InfoCenterError => ({ kind: 'wrong-parameter', token });
const UNKNOWN = (token?: string): InfoCenterError => ({ kind: 'unrecognized', token });
const INCOMPLETE: InfoCenterError = { kind: 'incomplete' };

function isValidIPv4(ip: string): boolean {
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  return parts.every(p => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

function parseBounded(tok: string | undefined, min: number, max: number): number | null {
  if (tok === undefined || !/^\d+$/.test(tok)) return null;
  const n = parseInt(tok, 10);
  return n >= min && n <= max ? n : null;
}

/**
 * Une sévérité par son nom ou son abrégé non ambigu — la règle de toute
 * la CLI de VRP, comme celle d'IOS.
 */
export function normVrpSeverity(tok: string): VrpSeverity | null {
  const t = tok.toLowerCase();
  if ((VRP_SEVERITIES as readonly string[]).includes(t)) return t as VrpSeverity;
  const candidats = VRP_SEVERITIES.filter(s => s.startsWith(t));
  return t.length > 0 && candidats.length === 1 ? candidats[0] : null;
}

export class InfoCenterConfig {
  enabled = true;
  /** Le nom de chaque canal, par numéro. */
  readonly channelNames: string[] = [...DEFAULT_CHANNEL_NAMES];
  /** Le canal auquel chaque destination est abonnée. */
  readonly destinationChannel: Record<string, number> = { ...DEFAULT_DESTINATION_CHANNEL };
  readonly loghosts: VrpLoghost[] = [];
  loghostSource: string | null = null;
  readonly sources: VrpSourceRule[] = [];
  logbufferSize = LOGBUFFER_SIZE_DEFAUT;
  trapbufferSize = TRAPBUFFER_SIZE_DEFAUT;
  readonly timestamps: Record<VrpRecordType, VrpTimestampSpec> = {
    log: { format: 'date', precision: null },
    trap: { format: 'date', precision: null },
    debug: { format: 'date', precision: null },
  };

  /** Le numéro d'un canal, qu'on l'ait désigné par son numéro ou son nom. */
  resolveChannel(tok: string): number | null {
    if (/^\d+$/.test(tok)) {
      const n = parseInt(tok, 10);
      return n >= 0 && n <= 9 ? n : null;
    }
    const i = this.channelNames.findIndex(n => n.toLowerCase() === tok.toLowerCase());
    return i === -1 ? null : i;
  }

  private applyLoghost(rest: string[], undo: boolean): InfoCenterError | null {
    const premier = rest[0];
    if (premier === undefined) return INCOMPLETE;
    // `source` désigne l'INTERFACE source des paquets syslog. Le prendre
    // pour un nom d'hôte fabriquait un collecteur fantôme, qui revenait
    // ensuite dans une configuration rejouée à l'import.
    if (premier.toLowerCase() === 'source') {
      if (undo) { this.loghostSource = null; return null; }
      if (!rest[1]) return INCOMPLETE;
      if (rest.length > 2) return UNKNOWN(rest[2]);
      this.loghostSource = rest[1];
      return null;
    }
    if (!isValidIPv4(premier)) return WRONG(premier);
    if (undo) {
      const i = this.loghosts.findIndex(h => h.ip === premier);
      if (i >= 0) this.loghosts.splice(i, 1);
      return null;
    }
    let channel = this.destinationChannel.loghost;
    let facility = 'local7';
    let port = 514;
    let transport: 'udp' | 'tcp' = 'udp';
    for (let i = 1; i < rest.length; i++) {
      const kw = rest[i].toLowerCase();
      const val = rest[i + 1];
      if (val === undefined) return INCOMPLETE;
      if (kw === 'channel') {
        const c = this.resolveChannel(val);
        if (c === null) return WRONG(val);
        channel = c;
      } else if (kw === 'facility') {
        if (!VRP_FACILITIES.includes(val.toLowerCase())) return WRONG(val);
        facility = val.toLowerCase();
      } else if (kw === 'port') {
        const p = parseBounded(val, 1, 65535);
        if (p === null) return WRONG(val);
        port = p;
      } else if (kw === 'transport') {
        if (val !== 'udp' && val !== 'tcp') return WRONG(val);
        transport = val;
      } else {
        return UNKNOWN(rest[i]);
      }
      i++;
    }
    // Un collecteur est identifié par son ADRESSE : redéclarer la même
    // la MODIFIE, comme sur un vrai VRP. L'empiler donnait deux lignes
    // pour un seul serveur.
    const existant = this.loghosts.find(h => h.ip === premier);
    if (existant) Object.assign(existant, { channel, facility, port, transport });
    else this.loghosts.push({ ip: premier, channel, facility, port, transport });
    return null;
  }

  private applySource(rest: string[], undo: boolean): InfoCenterError | null {
    const module = rest[0];
    if (module === undefined) return INCOMPLETE;
    const connu = VRP_MODULES.find(m => m.toLowerCase() === module.toLowerCase());
    if (!connu) return WRONG(module);
    let channel: number | null = null;
    let record: VrpRecordType | null = null;
    let state: boolean | null = null;
    let severity: VrpSeverity | null = null;
    for (let i = 1; i < rest.length; i++) {
      const kw = rest[i].toLowerCase();
      if ((VRP_RECORD_TYPES as readonly string[]).includes(kw)) {
        record = kw as VrpRecordType;
        continue;
      }
      const val = rest[i + 1];
      if (val === undefined) return INCOMPLETE;
      if (kw === 'channel') {
        const c = this.resolveChannel(val);
        if (c === null) return WRONG(val);
        channel = c;
      } else if (kw === 'level') {
        const s = normVrpSeverity(val);
        if (!s) return WRONG(val);
        severity = s;
      } else if (kw === 'state') {
        if (val !== 'on' && val !== 'off') return WRONG(val);
        state = val === 'on';
      } else {
        return UNKNOWN(rest[i]);
      }
      i++;
    }
    if (channel === null || record === null) return INCOMPLETE;
    const cle = (r: VrpSourceRule) =>
      r.module === connu && r.channel === channel && r.record === record;
    if (undo) {
      const i = this.sources.findIndex(cle);
      if (i >= 0) this.sources.splice(i, 1);
      return null;
    }
    const existant = this.sources.find(cle);
    const regle: VrpSourceRule = existant ?? {
      module: connu, channel, record, state: true, severity: 'debugging',
    };
    if (state !== null) regle.state = state;
    if (severity !== null) regle.severity = severity;
    if (!existant) this.sources.push(regle);
    return null;
  }

  private applyTimestamp(rest: string[], undo: boolean): InfoCenterError | null {
    const record = (rest[0] ?? '').toLowerCase();
    if (record === '') return INCOMPLETE;
    if (!(VRP_RECORD_TYPES as readonly string[]).includes(record)) return WRONG(rest[0]);
    const cible = this.timestamps[record as VrpRecordType];
    if (undo) { cible.format = 'date'; cible.precision = null; return null; }
    const format = (rest[1] ?? '').toLowerCase();
    if (format === '') return INCOMPLETE;
    if (!(VRP_TIMESTAMP_FORMATS as readonly string[]).includes(format)) return WRONG(rest[1]);
    let precision: VrpPrecision | null = null;
    if (rest[2] !== undefined) {
      if (rest[2].toLowerCase() !== 'precision-time') return UNKNOWN(rest[2]);
      const p = (rest[3] ?? '').toLowerCase();
      if (p === '') return INCOMPLETE;
      if (p !== 'tenth-second' && p !== 'millisecond' && p !== 'second') return WRONG(rest[3]);
      // `boot` compte depuis le démarrage et `none` n'imprime rien :
      // ni l'un ni l'autre n'a de place où mettre une précision.
      if (format === 'boot' || format === 'none') return UNKNOWN(rest[2]);
      precision = p;
      if (rest[4] !== undefined) return UNKNOWN(rest[4]);
    }
    cible.format = format as VrpTimestampFormat;
    cible.precision = precision;
    return null;
  }

  /**
   * `info-center {console|monitor|loghost|trapbuffer|logbuffer|snmpagent}
   * channel <n|nom>` — et pour les deux tampons, `size <n>`.
   */
  private applyDestination(dest: string, rest: string[], undo: boolean): InfoCenterError | null {
    const kw = (rest[0] ?? '').toLowerCase();
    if (kw === 'size' && (dest === 'logbuffer' || dest === 'trapbuffer')) {
      const max = dest === 'logbuffer' ? LOGBUFFER_SIZE_MAX : TRAPBUFFER_SIZE_MAX;
      const defaut = dest === 'logbuffer' ? LOGBUFFER_SIZE_DEFAUT : TRAPBUFFER_SIZE_DEFAUT;
      if (undo) {
        if (dest === 'logbuffer') this.logbufferSize = defaut;
        else this.trapbufferSize = defaut;
        return null;
      }
      const n = parseBounded(rest[1], 0, max);
      if (rest[1] === undefined) return INCOMPLETE;
      if (n === null) return WRONG(rest[1]);
      if (rest[2] !== undefined) return UNKNOWN(rest[2]);
      if (dest === 'logbuffer') this.logbufferSize = n;
      else this.trapbufferSize = n;
      return null;
    }
    if (kw === 'channel') {
      if (undo) { this.destinationChannel[dest] = DEFAULT_DESTINATION_CHANNEL[dest]; return null; }
      if (rest[1] === undefined) return INCOMPLETE;
      const c = this.resolveChannel(rest[1]);
      if (c === null) return WRONG(rest[1]);
      if (rest[2] !== undefined) return UNKNOWN(rest[2]);
      this.destinationChannel[dest] = c;
      return null;
    }
    if (kw === '') {
      // `info-center logbuffer` seul active le tampon, ce qu'il est déjà.
      return dest === 'logbuffer' || dest === 'trapbuffer' ? null : INCOMPLETE;
    }
    return UNKNOWN(rest[0]);
  }

  /**
   * Applique `info-center …` / `undo info-center …` en nommant la faute
   * plutôt qu'en l'avalant.
   */
  apply(args: string[], undo: boolean): InfoCenterError | null {
    const head = (args[0] ?? '').toLowerCase();
    const rest = args.slice(1);
    switch (head) {
      case '':
        return INCOMPLETE;
      case 'enable':
        if (rest.length) return UNKNOWN(rest[0]);
        this.enabled = !undo;
        return null;
      case 'loghost':
        return this.applyLoghost(rest, undo);
      case 'source':
        return this.applySource(rest, undo);
      case 'timestamp':
        return this.applyTimestamp(rest, undo);
      case 'channel': {
        if (rest[0] === undefined) return INCOMPLETE;
        const c = this.resolveChannel(rest[0]);
        if (c === null) return WRONG(rest[0]);
        if (undo) { this.channelNames[c] = DEFAULT_CHANNEL_NAMES[c]; return null; }
        if ((rest[1] ?? '').toLowerCase() !== 'name') {
          return rest[1] === undefined ? INCOMPLETE : UNKNOWN(rest[1]);
        }
        if (!rest[2]) return INCOMPLETE;
        if (!/^[A-Za-z][\w-]{0,29}$/.test(rest[2])) return WRONG(rest[2]);
        this.channelNames[c] = rest[2];
        return null;
      }
      case 'console':
      case 'monitor':
      case 'loghost-channel':
      case 'trapbuffer':
      case 'logbuffer':
      case 'snmpagent':
        return this.applyDestination(head, rest, undo);
      // Ces familles-là supposent un système de fichiers de journaux et
      // un moteur de filtrage par alias de module, dont aucun n'existe
      // ici. Refusées en le nommant plutôt qu'acceptées en silence.
      case 'filter-id':
      case 'logfile':
      case 'max-logfile-number':
      case 'logbuffer-file':
        return UNKNOWN(args[0]);
      default:
        return UNKNOWN(args[0]);
    }
  }

  /** `display current-configuration` — ce qui s'écarte de l'usine, et rien d'autre. */
  toRunningConfig(): string[] {
    const lines: string[] = [];
    if (!this.enabled) lines.push('undo info-center enable');
    for (const [i, nom] of this.channelNames.entries()) {
      if (nom !== DEFAULT_CHANNEL_NAMES[i]) lines.push(`info-center channel ${i} name ${nom}`);
    }
    for (const [dest, ch] of Object.entries(this.destinationChannel)) {
      if (ch !== DEFAULT_DESTINATION_CHANNEL[dest]) {
        lines.push(`info-center ${dest} channel ${ch}`);
      }
    }
    for (const r of ['log', 'trap', 'debug'] as const) {
      const t = this.timestamps[r];
      if (t.format === 'date' && t.precision === null) continue;
      lines.push(`info-center timestamp ${r} ${t.format}`
        + (t.precision ? ` precision-time ${t.precision}` : ''));
    }
    for (const s of this.sources) {
      lines.push(`info-center source ${s.module} channel ${s.channel} ${s.record}`
        + ` state ${s.state ? 'on' : 'off'} level ${s.severity}`);
    }
    if (this.loghostSource) lines.push(`info-center loghost source ${this.loghostSource}`);
    for (const h of this.loghosts) {
      const port = h.port === 514 ? '' : ` port ${h.port}`;
      const transport = h.transport === 'udp' ? '' : ` transport ${h.transport}`;
      lines.push(`info-center loghost ${h.ip}${port} channel ${h.channel}`
        + ` facility ${h.facility}${transport}`);
    }
    if (this.logbufferSize !== LOGBUFFER_SIZE_DEFAUT) {
      lines.push(`info-center logbuffer size ${this.logbufferSize}`);
    }
    if (this.trapbufferSize !== TRAPBUFFER_SIZE_DEFAUT) {
      lines.push(`info-center trapbuffer size ${this.trapbufferSize}`);
    }
    return lines;
  }

  /** `display channel` — les dix canaux, ceux qu'un équipement neuf a déjà. */
  renderChannels(which?: string): string[] {
    const lines = ['channel number:channel name, dest:destination, mod:module, level:severity'];
    const abonnes = new Map<number, string[]>();
    for (const [dest, ch] of Object.entries(this.destinationChannel)) {
      abonnes.set(ch, [...(abonnes.get(ch) ?? []), dest]);
    }
    const numeros = which === undefined
      ? this.channelNames.map((_, i) => i)
      : [this.resolveChannel(which)].filter((n): n is number => n !== null);
    for (const i of numeros) {
      lines.push('');
      lines.push(`channel number:${i}, channel name:${this.channelNames[i]}`);
      const dests = abonnes.get(i) ?? [];
      lines.push(`  dest: ${dests.length ? dests.join(', ') : '(none)'}`);
      const regles = this.sources.filter(s => s.channel === i);
      if (regles.length === 0) {
        lines.push('  default    log     state:on    level:debugging');
      } else {
        for (const s of regles) {
          lines.push(`  ${s.module.padEnd(10)} ${s.record.padEnd(7)}`
            + ` state:${s.state ? 'on ' : 'off'}   level:${s.severity}`);
        }
      }
    }
    return lines;
  }
}
