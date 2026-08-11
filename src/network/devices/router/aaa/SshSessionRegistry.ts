import type { IEventBus, Unsubscribe } from '@/events/EventBus';
import type { NetworkOsAccountEventEnvelope, SshAuthMethod } from './NetworkOsAccount';
import { renderTable } from '../../shells/cli/TextTable';
import {
  SHOW_USERS_HEADER, SHOW_USERS_COLUMNS, SHOW_USERS_STYLE,
} from '../../shells/cisco/ciscoTableLayouts';
import { rendreDisplayUsers } from '../../shells/huawei/huaweiTableLayouts';

export type VtySessionState = 'active' | 'idle' | 'closed';

export type SessionTransport = 'console' | 'ssh' | 'telnet' | 'aux';

export type LineKind = 'con' | 'vty' | 'aux';

const LIGNE_DE: Record<SessionTransport, LineKind> = {
  console: 'con', aux: 'aux', ssh: 'vty', telnet: 'vty',
};

const LIGNES_PHYSIQUES: Record<LineKind, number | null> = { con: 1, aux: 1, vty: null };

const PORT_DE: Record<SessionTransport, number> = { console: 0, aux: 0, ssh: 22, telnet: 23 };

function transportDepuisSource(from: string, localPort?: number): SessionTransport {
  const s = (from ?? '').trim().toLowerCase();
  if (s === 'console' || s === 'con' || s === 'local' || s === '') return 'console';
  if (s === 'aux') return 'aux';
  if (localPort === 23) return 'telnet';
  return 'ssh';
}

export interface SshSessionRecord {
  readonly id: string;
  readonly line: string;
  readonly lineIndex: number;
  readonly lineKind: LineKind;
  readonly transport: SessionTransport;
  readonly user: string;
  readonly privilege: number;
  readonly fromIp: string;
  readonly fromHost: string | null;
  readonly authMethod: SshAuthMethod;
  readonly loginAt: number;
  readonly lastActivityAt: number;
  readonly closedAt: number | null;
  readonly closeReason: string | null;
  readonly state: VtySessionState;
  readonly idleSeconds: number;
  readonly bytesIn: number;
  readonly bytesOut: number;
  readonly terminalType: string | null;
  readonly localPort: number;
  readonly peerPort: number;
  readonly cipher: string;
  readonly hmac: string;
}

export interface SshSessionRegistryOptions {
  deviceId: string;
  bus: IEventBus;
  maxLines?: number;
  capacity?: () => number;
  historyLimit?: number;
  now?: () => number;
  algorithms?: () => { chiffrement: string; hmac: string };
}

interface MutableSession {
  id: string;
  line: string;
  lineIndex: number;
  lineKind: LineKind;
  transport: SessionTransport;
  user: string;
  privilege: number;
  fromIp: string;
  fromHost: string | null;
  authMethod: SshAuthMethod;
  loginAt: number;
  lastActivityAt: number;
  closedAt: number | null;
  closeReason: string | null;
  bytesIn: number;
  bytesOut: number;
  terminalType: string | null;
  localPort: number;
  peerPort: number;
  cipher: string;
  hmac: string;
}

export class SshSessionRegistry {
  private readonly deviceId: string;
  private readonly bus: IEventBus;
  private readonly maxLines: number;
  private readonly capacity: (() => number) | null;
  private readonly historyLimit: number;
  private readonly now: () => number;
  private readonly algorithms: (() => { chiffrement: string; hmac: string }) | null;
  private readonly subs: Unsubscribe[] = [];

  private readonly active: Map<string, MutableSession> = new Map();
  private readonly closed: MutableSession[] = [];
  private nextSessionSeq = 1;
  private courante: string | null = null;

  constructor(opts: SshSessionRegistryOptions) {
    this.deviceId = opts.deviceId;
    this.bus = opts.bus;
    this.maxLines = opts.maxLines ?? 16;
    this.capacity = opts.capacity ?? null;
    this.historyLimit = opts.historyLimit ?? 256;
    this.now = opts.now ?? Date.now;
    this.algorithms = opts.algorithms ?? null;
    this.subs.push(this.bus.subscribe('router.aaa.account.login.success', this.onLoginSuccess));
    this.subs.push(this.bus.subscribe('router.ssh.session.closed', this.onSessionClosed));
  }

  detach(): void { for (const s of this.subs) s(); this.subs.length = 0; }

  private snapshot(s: MutableSession, now: number): SshSessionRecord {
    return {
      id: s.id, line: s.line, lineIndex: s.lineIndex,
      lineKind: s.lineKind, transport: s.transport, user: s.user,
      privilege: s.privilege, fromIp: s.fromIp, fromHost: s.fromHost,
      authMethod: s.authMethod, loginAt: s.loginAt,
      lastActivityAt: s.lastActivityAt, closedAt: s.closedAt,
      closeReason: s.closeReason,
      state: s.closedAt ? 'closed' : (now - s.lastActivityAt > 300_000 ? 'idle' : 'active'),
      idleSeconds: Math.max(0, Math.floor(((s.closedAt ?? now) - s.lastActivityAt) / 1000)),
      bytesIn: s.bytesIn, bytesOut: s.bytesOut, terminalType: s.terminalType,
      localPort: s.localPort, peerPort: s.peerPort,
      cipher: s.cipher, hmac: s.hmac,
    };
  }

  list(now: number = this.now()): readonly SshSessionRecord[] {
    const rang = (s: MutableSession) => (s.lineKind === 'con' ? 0 : 1) * 1000 + s.lineIndex;
    return Array.from(this.active.values())
      .sort((a, b) => rang(a) - rang(b))
      .map(s => this.snapshot(s, now));
  }

  history(): readonly SshSessionRecord[] {
    const now = this.now();
    return this.closed.map(s => this.snapshot(s, now));
  }

  find(id: string): SshSessionRecord | null {
    const s = this.active.get(id);
    return s ? this.snapshot(s, this.now()) : null;
  }

  private allocateLine(kind: LineKind): { line: string; index: number } | null {
    const taken = new Set(Array.from(this.active.values())
      .filter(s => s.lineKind === kind)
      .map(s => s.lineIndex));
    const limit = LIGNES_PHYSIQUES[kind] ?? (this.capacity ? this.capacity() : this.maxLines);
    for (let i = 0; i < limit; i++) {
      if (!taken.has(i)) return { line: `${kind} ${i}`, index: i };
    }
    return null;
  }

  hasFreeLine(kind: LineKind = 'vty'): boolean {
    return this.allocateLine(kind) !== null;
  }

  setCurrentSession(id: string | null): void { this.courante = id; }

  currentSession(): string | null { return this.courante; }

  open(input: {
    user: string;
    privilege?: number;
    fromIp: string;
    fromHost?: string;
    authMethod?: SshAuthMethod;
    at?: number;
    terminalType?: string;
    localPort?: number;
    peerPort?: number;
    transport?: SessionTransport;
  }): SshSessionRecord | null {
    const transport = input.transport ?? transportDepuisSource(input.fromIp, input.localPort);
    const kind = LIGNE_DE[transport];
    const algos = this.algorithms?.() ?? { chiffrement: 'aes256-ctr', hmac: 'hmac-sha2-256' };
    const slot = this.allocateLine(kind);
    if (!slot) return null;
    const at = input.at ?? this.now();
    const session: MutableSession = {
      id: `${kind}-${this.nextSessionSeq++}`,
      line: slot.line,
      lineIndex: slot.index,
      lineKind: kind,
      transport,
      user: input.user,
      privilege: input.privilege ?? 1,
      fromIp: transport === 'console' || transport === 'aux' ? '' : input.fromIp,
      fromHost: input.fromHost ?? null,
      authMethod: input.authMethod ?? 'password',
      loginAt: at,
      lastActivityAt: at,
      closedAt: null,
      closeReason: null,
      bytesIn: 0,
      bytesOut: 0,
      terminalType: input.terminalType ?? null,
      localPort: input.localPort ?? PORT_DE[transport],
      peerPort: input.peerPort ?? 0,
      cipher: algos.chiffrement,
      hmac: algos.hmac,
    };
    this.active.set(session.id, session);
    this.noteLineUse(kind, slot.index);
    this.courante = session.id;
    this.bus.publish({
      topic: 'router.ssh.session.opened',
      payload: { deviceId: this.deviceId, session: this.snapshot(session, at) },
    });
    return this.snapshot(session, at);
  }

  setTerminalType(id: string, terminalType: string): void {
    const s = this.active.get(id);
    if (s) s.terminalType = terminalType;
  }

  touch(id: string, at: number = this.now(), bytesIn = 0, bytesOut = 0): void {
    const s = this.active.get(id);
    if (!s) return;
    s.lastActivityAt = at;
    s.bytesIn += bytesIn;
    s.bytesOut += bytesOut;
  }

  close(id: string, reason: string = 'logout', at: number = this.now()): SshSessionRecord | null {
    const s = this.active.get(id);
    if (!s) return null;
    s.closedAt = at;
    s.closeReason = reason;
    this.active.delete(id);
    if (this.courante === id) this.courante = null;
    this.closed.push(s);
    while (this.closed.length > this.historyLimit) this.closed.shift();
    const snap = this.snapshot(s, at);
    this.bus.publish({
      topic: 'router.ssh.session.closed',
      payload: { deviceId: this.deviceId, session: snap, reason },
    });
    return snap;
  }

  closeWhere(predicate: (s: SshSessionRecord) => boolean, reason = 'admin'): number {
    let count = 0;
    for (const s of [...this.active.values()]) {
      if (predicate(this.snapshot(s, this.now()))) {
        this.close(s.id, reason);
        count++;
      }
    }
    return count;
  }

  private onLoginSuccess = (e: { topic: string; payload: unknown }) => {
    const env = e as unknown as NetworkOsAccountEventEnvelope;
    if (env.payload.deviceId !== this.deviceId) return;
    this.open({
      user: env.payload.account.name,
      privilege: env.payload.account.privilege,
      fromIp: env.payload.from ?? 'unknown',
      authMethod: env.payload.method ?? 'password',
      at: env.payload.at,
    });
  };

  private onSessionClosed = () => { /* placeholder for external close hook */ };

  private readonly canaux: Map<number, Set<(texte: string) => void>> = new Map();

  private readonly uses: Map<string, number> = new Map();

  noteLineUse(kind: 'con' | 'vty' | 'aux', index: number): void {
    const k = `${kind}:${index}`;
    this.uses.set(k, (this.uses.get(k) ?? 0) + 1);
  }

  usesFor(kind: 'con' | 'vty' | 'aux', index: number): number {
    return this.uses.get(`${kind}:${index}`) ?? 0;
  }

  subscribeMessages(lineIndex: number, cb: (texte: string) => void): () => void {
    let set = this.canaux.get(lineIndex);
    if (!set) { set = new Set(); this.canaux.set(lineIndex, set); }
    set.add(cb);
    return () => {
      const s = this.canaux.get(lineIndex);
      if (!s) return;
      s.delete(cb);
      if (s.size === 0) this.canaux.delete(lineIndex);
    };
  }

  deliverMessage(cible: 'all' | number, texte: string): number {
    let n = 0;
    for (const [ligne, abonnes] of this.canaux) {
      if (cible !== 'all' && cible !== ligne) continue;
      for (const cb of abonnes) { cb(texte); n += 1; }
    }
    return n;
  }

  private rangAbsolu(s: SshSessionRecord): number {
    if (s.lineKind === 'con') return s.lineIndex;
    if (s.lineKind === 'aux') return 1 + s.lineIndex;
    return 1 + s.lineIndex;
  }

  formatShowUsers(now: number = this.now()): string {
    if (this.active.size === 0) {
      return `${SHOW_USERS_HEADER}\n*  0 con 0                idle                 00:00:00`;
    }
    const lignes = renderTable(
      this.list(now).map((s) => ({
        marker: s.id === this.courante ? '*' : ' ',
        line: String(this.rangAbsolu(s)),
        lineName: s.line,
        user: s.user,
        idle: secondsToHms(s.idleSeconds),
        location: s.fromIp,
      })),
      SHOW_USERS_COLUMNS,
      SHOW_USERS_STYLE,
    ).slice(1);
    return [SHOW_USERS_HEADER, ...lignes].join('\n');
  }

  private interfaceUtilisateur(s: SshSessionRecord): number {
    if (s.lineKind === 'con') return s.lineIndex;
    if (s.lineKind === 'aux') return 1 + s.lineIndex;
    return 129 + s.lineIndex;
  }

  private static readonly TYPE_VRP: Record<SessionTransport, string> = {
    console: 'CON', aux: 'AUX', telnet: 'TEL', ssh: 'SSH',
  };

  formatDisplayUsers(now: number = this.now()): string {
    const sessions = this.list(now);
    if (sessions.length === 0) {
      return rendreDisplayUsers([{
        courante: true, interfaceUtilisateur: '0', nomLigne: 'CON 0',
        delai: '00:00:00', type: '', adresse: '',
        authentification: 'pass', autorisation: 'no',
      }], ['']);
    }
    return rendreDisplayUsers(
      sessions.map((s) => ({
        courante: s.id === this.courante,
        interfaceUtilisateur: String(this.interfaceUtilisateur(s)),
        nomLigne: `${s.lineKind === 'con' ? 'CON' : s.lineKind === 'aux' ? 'AUX' : 'VTY'} ${s.lineIndex}`,
        delai: secondsToHms(s.idleSeconds),
        type: s.lineKind === 'con' ? '' : SshSessionRegistry.TYPE_VRP[s.transport],
        adresse: s.fromIp,
        authentification: 'pass',
        autorisation: 'no',
      })),
      sessions.map((s) => s.user),
    );
  }
}

function secondsToHms(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function pad(n: number): string { return n.toString().padStart(2, '0'); }
