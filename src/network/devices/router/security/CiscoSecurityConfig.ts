import type { IPAddress } from '../../../core/types';

export type AaaMethodList = 'default' | string;
export type AaaServiceKind = 'login' | 'enable' | 'ppp' | 'exec' | 'commands' | 'network';
export type AaaPhase = 'authentication' | 'authorization' | 'accounting';

export interface AaaMethodEntry {
  phase: AaaPhase;
  service: AaaServiceKind;
  listName: AaaMethodList;
  privilegeLevel?: number;
  recordType?: 'start-stop' | 'stop-only' | 'wait-start' | 'none';
  methods: string[];
}

export interface RadiusServerStats {
  upSinceMs: number;
  authRequests: number;
  authAccepts: number;
  authRejects: number;
  authTimeouts: number;
  authRetransmits: number;
  acctRequests: number;
  acctResponses: number;
  acctTimeouts: number;
  acctRetransmits: number;
}

export interface TacacsServerStats {
  upSinceMs: number;
  socketOpens: number;
  socketCloses: number;
  socketAborts: number;
  socketErrors: number;
  authRequests: number;
  authAccepts: number;
  authRejects: number;
}

export interface RadiusServer {
  name: string;
  address?: string;
  authPort: number;
  acctPort: number;
  key?: string;
  retransmit: number;
  timeoutSec: number;
  stats: RadiusServerStats;
}

export interface TacacsServer {
  name: string;
  address?: string;
  key?: string;
  port: number;
  timeoutSec: number;
  singleConnection: boolean;
  stats: TacacsServerStats;
}

export function newRadiusServerStats(): RadiusServerStats {
  return {
    upSinceMs: Date.now(),
    authRequests: 0, authAccepts: 0, authRejects: 0,
    authTimeouts: 0, authRetransmits: 0,
    acctRequests: 0, acctResponses: 0,
    acctTimeouts: 0, acctRetransmits: 0,
  };
}

export function newTacacsServerStats(): TacacsServerStats {
  return {
    upSinceMs: Date.now(),
    socketOpens: 0, socketCloses: 0, socketAborts: 0, socketErrors: 0,
    authRequests: 0, authAccepts: 0, authRejects: 0,
  };
}

export interface AaaServerGroup {
  name: string;
  kind: 'radius' | 'tacacs+';
  members: string[];
}

export interface AaaLegacyServerHost {
  kind: 'radius' | 'tacacs';
  host: string;
  key?: string;
  authPort?: number;
  acctPort?: number;
  port?: number;
}

export interface SshConfig {
  version: number;
  timeoutSec: number;
  authRetries: number;
  sourceInterface?: string;
  dhMinBits: number;
  loggingEvents: boolean;
}

export interface LoginControl {
  blockFor?: { seconds: number; attempts: number; withinSeconds: number };
  quietModeAcl?: string;
  delay?: number;
  onFailureLog?: boolean;
  onSuccessLog?: boolean;
}

export interface CryptoRsaKey {
  label: string;
  modulus: number;
  general: boolean;
  generatedAtMs: number;
}

export interface PasswordPolicy {
  minLength?: number;
  encrypted: boolean;
}

export interface UsernameEntry {
  name: string;
  privilege: number;
  secret?: string;
  password?: string;
  view?: string;
}

export interface ClassMap {
  name: string;
  matchAll: boolean;
  kind: 'qos' | 'inspect';
  matches: ClassMapMatch[];
}

export interface ClassMapMatch {
  kind: 'access-group-name' | 'access-group-num' | 'protocol' | 'any';
  value?: string;
}

export interface PolicyMap {
  name: string;
  kind: 'qos' | 'inspect';
  classes: PolicyMapClass[];
}

export interface PolicyMapClass {
  className: string;
  kind: 'class-default' | 'named' | 'inspect';
  actions: PolicyMapAction[];
}

export interface PolicyMapAction {
  kind: 'police' | 'inspect' | 'drop' | 'pass' | 'set-dscp' | 'set-precedence';
  args: string[];
}

export interface ControlPlane {
  servicePolicyInput?: string;
  servicePolicyOutput?: string;
}

export interface Zone {
  name: string;
}

export interface ZonePair {
  name: string;
  source: string;
  destination: string;
  servicePolicy?: string;
}

export interface InterfaceUrpf {
  mode: 'strict' | 'loose' | null;
  allowDefault?: boolean;
}

export interface InterfaceSecurityFlags {
  noUnreachables: boolean;
  noRedirects: boolean;
  noProxyArp: boolean;
  zoneMember?: string;
  ipv6TrafficFilter?: { name: string; direction: 'in' | 'out' };
  urpf?: InterfaceUrpf;
}

export interface TimeRangeAbsolute {
  start?: { year: number; month: number; day: number; hour: number; minute: number };
  end?: { year: number; month: number; day: number; hour: number; minute: number };
}

export interface TimeRangePeriodic {
  days: string;
  startHour: number;
  startMinute: number;
  endHour: number;
  endMinute: number;
}

export interface TimeRange {
  name: string;
  absolute?: TimeRangeAbsolute;
  periodic: TimeRangePeriodic[];
}

/** Cisco day-keyword → JS getDay() (0=Sunday..6=Saturday) set. */
const TIME_RANGE_DAY_SETS: Record<string, ReadonlySet<number>> = {
  monday:    new Set([1]),
  tuesday:   new Set([2]),
  wednesday: new Set([3]),
  thursday:  new Set([4]),
  friday:    new Set([5]),
  saturday:  new Set([6]),
  sunday:    new Set([0]),
  weekdays:  new Set([1, 2, 3, 4, 5]),
  weekend:   new Set([0, 6]),
  daily:     new Set([0, 1, 2, 3, 4, 5, 6]),
};

/**
 * Decide whether a Cisco time-range is "active" at the given instant.
 * An ACE tagged `time-range NAME` only matches when this returns true.
 *
 * - absolute start/end (if set) gate the whole range — outside the
 *   window every periodic clause is inactive.
 * - inside the absolute window, the range is active if AT LEAST ONE
 *   periodic clause covers `now`'s weekday + time of day. A range
 *   with no periodic clauses is treated as "always-active inside the
 *   absolute window" (matches IOS).
 *
 * `now` is interpreted in the device's local timezone (the simulator
 * does not model timezones, so JS `Date.getHours()` / `getDay()` give
 * "device-local"). Cisco's time-range also runs in device-local time
 * by default — fidelity is exact for the educational scenarios.
 */
export function isTimeRangeActive(tr: TimeRange, now: Date): boolean {
  if (tr.absolute) {
    const ts = now.getTime();
    if (tr.absolute.start) {
      const s = Date.UTC(
        tr.absolute.start.year, tr.absolute.start.month - 1,
        tr.absolute.start.day, tr.absolute.start.hour, tr.absolute.start.minute,
      );
      if (ts < s) return false;
    }
    if (tr.absolute.end) {
      const e = Date.UTC(
        tr.absolute.end.year, tr.absolute.end.month - 1,
        tr.absolute.end.day, tr.absolute.end.hour, tr.absolute.end.minute,
      );
      if (ts > e) return false;
    }
  }
  if (tr.periodic.length === 0) return true;
  const day = now.getDay();
  const minOfDay = now.getHours() * 60 + now.getMinutes();
  for (const p of tr.periodic) {
    const set = TIME_RANGE_DAY_SETS[p.days.toLowerCase()];
    if (!set || !set.has(day)) continue;
    const start = p.startHour * 60 + p.startMinute;
    const end   = p.endHour   * 60 + p.endMinute;
    if (minOfDay >= start && minOfDay <= end) return true;
  }
  return false;
}

export interface PkiTrustpoint {
  name: string;
  enrollmentUrl?: string;
  subjectName?: string;
  revocationCheck?: 'crl' | 'none' | 'ocsp' | 'crl-or-ocsp' | 'crl-then-ocsp';
  rsaKeypair?: string;
  fingerprint?: string;
  fqdn?: string;
  ipAddress?: 'none' | string;
  serialNumber?: 'none' | string;
  autoEnroll?: { percent?: number; regenerate?: boolean };
  source?: 'self-signed' | 'scep' | 'terminal';
}

export interface ParameterMapInspect {
  name: string;
  auditTrail?: boolean;
  alert?: boolean;
  maxIncompleteLow?: number;
  maxIncompleteHigh?: number;
  tcpIdleTimeSec?: number;
  udpIdleTimeSec?: number;
  dnsTimeoutSec?: number;
  oneMinuteLow?: number;
  oneMinuteHigh?: number;
}

export class CiscoSecurityConfig {
  aaaNewModel = false;
  aaaSessionId?: string;
  aaaMethods: AaaMethodEntry[] = [];
  radiusServers: Map<string, RadiusServer> = new Map();
  tacacsServers: Map<string, TacacsServer> = new Map();
  aaaGroups: Map<string, AaaServerGroup> = new Map();
  legacyHosts: AaaLegacyServerHost[] = [];

  ssh: SshConfig = { version: 1, timeoutSec: 120, authRetries: 3, dhMinBits: 1024, loggingEvents: false };
  cryptoKeys: CryptoRsaKey[] = [];
  enableSecret?: string;
  servicePasswordEncryption = false;
  passwords: PasswordPolicy = { encrypted: false };
  usernames: Map<string, UsernameEntry> = new Map();
  login: LoginControl = {};
  ipCef = true;
  ipCefDistributed = false;

  classMaps: Map<string, ClassMap> = new Map();
  policyMaps: Map<string, PolicyMap> = new Map();
  controlPlane: ControlPlane = {};

  zones: Map<string, Zone> = new Map();
  zonePairs: Map<string, ZonePair> = new Map();
  interfaceFlags: Map<string, InterfaceSecurityFlags> = new Map();

  timeRanges: Map<string, TimeRange> = new Map();
  parameterMapsInspect: Map<string, ParameterMapInspect> = new Map();
  pkiTrustpoints: Map<string, PkiTrustpoint> = new Map();

  ensurePkiTrustpoint(name: string): PkiTrustpoint {
    let tp = this.pkiTrustpoints.get(name);
    if (!tp) {
      tp = { name };
      this.pkiTrustpoints.set(name, tp);
    }
    return tp;
  }

  ensureParameterMapInspect(name: string): ParameterMapInspect {
    let pm = this.parameterMapsInspect.get(name);
    if (!pm) {
      pm = { name };
      this.parameterMapsInspect.set(name, pm);
    }
    return pm;
  }

  ifaceFlags(ifName: string): InterfaceSecurityFlags {
    let f = this.interfaceFlags.get(ifName);
    if (!f) {
      f = { noUnreachables: false, noRedirects: false, noProxyArp: false };
      this.interfaceFlags.set(ifName, f);
    }
    return f;
  }

  ensureClassMap(name: string, kind: 'qos' | 'inspect', matchAll: boolean): ClassMap {
    let cm = this.classMaps.get(name);
    if (!cm) {
      cm = { name, matchAll, kind, matches: [] };
      this.classMaps.set(name, cm);
    }
    return cm;
  }

  ensurePolicyMap(name: string, kind: 'qos' | 'inspect'): PolicyMap {
    let pm = this.policyMaps.get(name);
    if (!pm) {
      pm = { name, kind, classes: [] };
      this.policyMaps.set(name, pm);
    }
    return pm;
  }

  ensureTimeRange(name: string): TimeRange {
    let tr = this.timeRanges.get(name);
    if (!tr) {
      tr = { name, periodic: [] };
      this.timeRanges.set(name, tr);
    }
    return tr;
  }

  asRunningConfigLines(): string[] {
    const lines: string[] = [];
    if (this.aaaNewModel) {
      lines.push('aaa new-model');
      for (const m of this.aaaMethods) {
        lines.push(this.renderAaaMethod(m));
      }
      if (this.aaaSessionId) lines.push(`aaa session-id ${this.aaaSessionId}`);
    }
    // Local usernames are rendered (and password-encoded) by the credential
    // store path in CiscoShowCommands (_listLocalUsers). Rendering them here
    // too would duplicate the line and leak the plaintext secret.
    void this.usernames;
    void this.enableSecret;
    void this.servicePasswordEncryption;
    if (this.passwords.minLength) lines.push(`security passwords min-length ${this.passwords.minLength}`);
    if (this.login.blockFor) lines.push(`login block-for ${this.login.blockFor.seconds} attempts ${this.login.blockFor.attempts} within ${this.login.blockFor.withinSeconds}`);
    if (this.login.quietModeAcl) lines.push(`login quiet-mode access-class ${this.login.quietModeAcl}`);
    if (this.login.delay) lines.push(`login delay ${this.login.delay}`);
    if (this.login.onFailureLog) lines.push('login on-failure log');
    if (this.login.onSuccessLog) lines.push('login on-success log');
    if (!this.ipCef) lines.push('no ip cef');
    if (this.ssh.version !== 1) lines.push(`ip ssh version ${this.ssh.version}`);
    if (this.ssh.timeoutSec !== 120) lines.push(`ip ssh time-out ${this.ssh.timeoutSec}`);
    if (this.ssh.authRetries !== 3) lines.push(`ip ssh authentication-retries ${this.ssh.authRetries}`);
    if (this.ssh.sourceInterface) lines.push(`ip ssh source-interface ${this.ssh.sourceInterface}`);
    if (this.ssh.dhMinBits !== 1024) lines.push(`ip ssh dh min size ${this.ssh.dhMinBits}`);
    if (this.ssh.loggingEvents) lines.push('ip ssh logging events');
    for (const k of this.cryptoKeys) {
      if (k.general) lines.push(`crypto key generate rsa general-keys modulus ${k.modulus} label ${k.label}`);
      else lines.push(`crypto key generate rsa modulus ${k.modulus}`);
    }
    for (const r of this.radiusServers.values()) {
      lines.push(`radius server ${r.name}`);
      if (r.address) lines.push(` address ipv4 ${r.address} auth-port ${r.authPort} acct-port ${r.acctPort}`);
      if (r.key) lines.push(` key ${r.key}`);
    }
    for (const t of this.tacacsServers.values()) {
      lines.push(`tacacs server ${t.name}`);
      if (t.address) lines.push(` address ipv4 ${t.address}`);
      if (t.key) lines.push(` key ${t.key}`);
    }
    for (const g of this.aaaGroups.values()) {
      lines.push(`aaa group server ${g.kind} ${g.name}`);
      for (const m of g.members) lines.push(` server name ${m}`);
    }
    for (const lh of this.legacyHosts) {
      if (lh.kind === 'radius') {
        lines.push(`radius-server host ${lh.host}${lh.key ? ' key ' + lh.key : ''}`);
      } else {
        lines.push(`tacacs-server host ${lh.host}${lh.key ? ' key ' + lh.key : ''}`);
      }
    }
    for (const tr of this.timeRanges.values()) {
      lines.push(`time-range ${tr.name}`);
      if (tr.absolute) {
        const a = tr.absolute;
        if (a.start) lines.push(` absolute start ${a.start.hour}:${a.start.minute < 10 ? '0' : ''}${a.start.minute} ${a.start.day} ${this.monthName(a.start.month)} ${a.start.year}${a.end ? ' end ' + a.end.hour + ':' + (a.end.minute < 10 ? '0' : '') + a.end.minute + ' ' + a.end.day + ' ' + this.monthName(a.end.month) + ' ' + a.end.year : ''}`);
      }
      for (const p of tr.periodic) {
        lines.push(` periodic ${p.days} ${p.startHour}:${this.pad2(p.startMinute)} to ${p.endHour}:${this.pad2(p.endMinute)}`);
      }
    }
    for (const cm of this.classMaps.values()) {
      const typ = cm.kind === 'inspect' ? ' type inspect' : '';
      const mode = cm.matchAll ? 'match-all' : 'match-any';
      lines.push(`class-map${typ} ${mode} ${cm.name}`);
      for (const mt of cm.matches) {
        if (mt.kind === 'access-group-name') lines.push(` match access-group name ${mt.value}`);
        else if (mt.kind === 'access-group-num') lines.push(` match access-group ${mt.value}`);
        else if (mt.kind === 'protocol') lines.push(` match protocol ${mt.value}`);
        else if (mt.kind === 'any') lines.push(' match any');
      }
    }
    for (const pm of this.policyMaps.values()) {
      const typ = pm.kind === 'inspect' ? ' type inspect' : '';
      lines.push(`policy-map${typ} ${pm.name}`);
      for (const cls of pm.classes) {
        const cprefix = cls.kind === 'inspect' ? 'class type inspect' : 'class';
        lines.push(` ${cprefix} ${cls.className}`);
        for (const a of cls.actions) {
          if (a.kind === 'police') lines.push(`  police ${a.args.join(' ')}`);
          else if (a.kind === 'inspect') lines.push('  inspect');
          else if (a.kind === 'drop') lines.push(`  drop${a.args.includes('log') ? ' log' : ''}`);
          else if (a.kind === 'pass') lines.push('  pass');
          else if (a.kind === 'set-dscp') lines.push(`  set dscp ${a.args[0]}`);
          else if (a.kind === 'set-precedence') lines.push(`  set precedence ${a.args[0]}`);
        }
      }
    }
    for (const tp of this.pkiTrustpoints.values()) {
      lines.push(`crypto pki trustpoint ${tp.name}`);
      if (tp.enrollmentUrl) lines.push(` enrollment url ${tp.enrollmentUrl}`);
      if (tp.subjectName) lines.push(` subject-name ${tp.subjectName}`);
      if (tp.revocationCheck) lines.push(` revocation-check ${tp.revocationCheck}`);
      if (tp.rsaKeypair) lines.push(` rsakeypair ${tp.rsaKeypair}`);
      if (tp.fqdn) lines.push(` fqdn ${tp.fqdn}`);
      if (tp.ipAddress) lines.push(` ip-address ${tp.ipAddress}`);
      if (tp.serialNumber) lines.push(` serial-number ${tp.serialNumber}`);
      if (tp.autoEnroll) lines.push(` auto-enroll${tp.autoEnroll.percent ? ` ${tp.autoEnroll.percent}` : ''}${tp.autoEnroll.regenerate ? ' regenerate' : ''}`);
      if (tp.fingerprint) lines.push(` fingerprint ${tp.fingerprint}`);
      if (tp.source) lines.push(` enrollment ${tp.source}`);
    }
    if (this.controlPlane.servicePolicyInput || this.controlPlane.servicePolicyOutput) {
      lines.push('control-plane');
      if (this.controlPlane.servicePolicyInput) lines.push(` service-policy input ${this.controlPlane.servicePolicyInput}`);
      if (this.controlPlane.servicePolicyOutput) lines.push(` service-policy output ${this.controlPlane.servicePolicyOutput}`);
    }
    for (const z of this.zones.values()) lines.push(`zone security ${z.name}`);
    for (const zp of this.zonePairs.values()) {
      lines.push(`zone-pair security ${zp.name} source ${zp.source} destination ${zp.destination}`);
      if (zp.servicePolicy) lines.push(` service-policy type inspect ${zp.servicePolicy}`);
    }
    return lines;
  }

  asInterfaceRunningConfigLines(ifName: string): string[] {
    const lines: string[] = [];
    const f = this.interfaceFlags.get(ifName);
    if (!f) return lines;
    if (f.noUnreachables) lines.push(' no ip unreachables');
    if (f.noRedirects) lines.push(' no ip redirects');
    if (f.noProxyArp) lines.push(' no ip proxy-arp');
    if (f.urpf?.mode === 'strict') lines.push(' ip verify unicast source reachable-via rx');
    if (f.urpf?.mode === 'loose') lines.push(' ip verify unicast source reachable-via any');
    if (f.zoneMember) lines.push(` zone-member security ${f.zoneMember}`);
    if (f.ipv6TrafficFilter) lines.push(` ipv6 traffic-filter ${f.ipv6TrafficFilter.name} ${f.ipv6TrafficFilter.direction}`);
    return lines;
  }

  private renderAaaMethod(m: AaaMethodEntry): string {
    const parts: string[] = ['aaa', m.phase, m.service];
    if (m.service === 'commands' && m.privilegeLevel !== undefined) parts.push(String(m.privilegeLevel));
    parts.push(m.listName);
    if (m.phase === 'accounting' && m.recordType) parts.push(m.recordType);
    parts.push(...m.methods);
    return parts.join(' ');
  }

  private monthName(m: number): string {
    return ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][m - 1] || '';
  }

  private pad2(n: number): string { return n < 10 ? '0' + n : '' + n; }
}

void (null as IPAddress | null);
