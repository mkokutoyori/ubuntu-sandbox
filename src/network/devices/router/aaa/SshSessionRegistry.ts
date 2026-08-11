import type { IEventBus, Unsubscribe } from '@/events/EventBus';
import type { NetworkOsAccountEventEnvelope, SshAuthMethod } from './NetworkOsAccount';
import { renderTable } from '../../shells/cli/TextTable';
import {
  SHOW_USERS_HEADER, SHOW_USERS_COLUMNS, SHOW_USERS_STYLE,
} from '../../shells/cisco/ciscoTableLayouts';
import { rendreDisplayUsers } from '../../shells/huawei/huaweiTableLayouts';

export type VtySessionState = 'active' | 'idle' | 'closed';

/**
 * Le PROTOCOLE par lequel la session est arrivee. Distinct du TYPE DE
 * LIGNE qu'elle occupe et de la SOURCE d'ou elle vient : une session SSH
 * arrive par SSH, prend une vty et vient d'une adresse ; une session
 * console arrive par le port console, prend `con 0` et ne vient de nulle
 * part. Les confondre produisait `%SSH-6-SSH2_SESSION: … on vty 0 from
 * console`, trois faits contradictoires dans une ligne.
 */
export type SessionTransport = 'console' | 'ssh' | 'telnet' | 'aux';

export type LineKind = 'con' | 'vty' | 'aux';

const LIGNE_DE: Record<SessionTransport, LineKind> = {
  console: 'con', aux: 'aux', ssh: 'vty', telnet: 'vty',
};

/**
 * Un chassis a UN port console et UN port auxiliaire. Le nombre de vty
 * est configurable et vient de `capacity()`.
 */
const LIGNES_PHYSIQUES: Record<LineKind, number | null> = { con: 1, aux: 1, vty: null };

/**
 * `localport` d'IOS dans `%SEC_LOGIN-*` : le port TCP par lequel la
 * session est arrivee, et **0 pour une connexion locale** — la console
 * n'ecoute sur aucun port.
 */
const PORT_DE: Record<SessionTransport, number> = { console: 0, aux: 0, ssh: 22, telnet: 23 };

/**
 * Une source qui n'est pas une adresse designe un acces LOCAL. Le champ
 * `from` de `recordLoginSuccess` porte deja `'console'` depuis toujours
 * — l'information existait et etait jetee.
 */
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
}

export interface SshSessionRegistryOptions {
  deviceId: string;
  bus: IEventBus;
  maxLines?: number;
  capacity?: () => number;
  historyLimit?: number;
  now?: () => number;
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
}

export class SshSessionRegistry {
  private readonly deviceId: string;
  private readonly bus: IEventBus;
  private readonly maxLines: number;
  private readonly capacity: (() => number) | null;
  private readonly historyLimit: number;
  private readonly now: () => number;
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

  /**
   * Une ligne se choisit DANS SON PROPRE ESPACE. `con 0` et `vty 0` sont
   * deux lignes differentes qui portent toutes deux le rang 0, donc le
   * jeu des rangs pris est filtre par type — sans quoi une console
   * occupait la premiere vty et la vty suivante se numerotait 1.
   *
   * Le nombre de lignes physiques ne se configure pas : un chassis a un
   * port console et un port auxiliaire, et `line con 1` n'existe pas.
   * Seules les vty ont une capacite reglable.
   */
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

  /**
   * Quelle session execute la commande en cours. C'est ce que `show
   * users` marque d'une etoile, et cela ne peut pas se deduire de la
   * table : la premiere ligne de la liste est la plus BASSE, pas celle
   * qui pose la question.
   */
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

  /**
   * The client's announced terminal type, learned after the line was
   * claimed — telnet negotiates it in parallel with the login dialog, so
   * it is not always known when `open()` runs.
   */
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
    // `from` porte deja le mot `console` quand la connexion est locale :
    // le transport se LIT ici au lieu d'etre suppose SSH pour tout le
    // monde. Sans cette lecture, un operateur assis devant le port
    // console ouvrait une vty et la machine annoncait une session SSH.
    this.open({
      user: env.payload.account.name,
      privilege: env.payload.account.privilege,
      fromIp: env.payload.from ?? 'unknown',
      authMethod: env.payload.method ?? 'password',
      at: env.payload.at,
    });
  };

  private onSessionClosed = () => { /* placeholder for external close hook */ };

  // ── `send` : porter un message a une session vivante ───────────────
  //
  // Un terminal s'inscrit pour SA ligne ; `send` pousse le texte a qui
  // s'est inscrit. Le canal est keye par le NUMERO DE LIGNE et non par
  // l'enregistrement de session, pour une raison mesuree : la console
  // n'a pas d'enregistrement ici (`show users` la synthetise quand la
  // table est vide), et un `send *` qui sauterait la console laisserait
  // hors du message la seule ligne dont on est sur qu'elle est occupee.
  private readonly canaux: Map<number, Set<(texte: string) => void>> = new Map();

  // ── `Uses` : combien de fois la ligne a servi depuis le demarrage ──
  //
  // La colonne existait dans `show line` et valait 0 pour toujours :
  // aucun compteur ne vivait derriere, sur aucune ligne. C'est pourtant
  // ce chiffre qui distingue une ligne QU'ON N'A JAMAIS UTILISEE d'une
  // ligne libre en ce moment — la question que le tableau sert a poser.
  //
  // Le compte est CUMULATIF et ne redescend pas a la fermeture : c'est
  // « combien de connexions depuis le dernier redemarrage », pas
  // « combien maintenant », que la table des sessions dit deja.
  //
  // La cle porte le TYPE en plus du rang (`con:0`, `vty:0`) et non le
  // rang seul : `con 0` et `vty 0` valent tous deux zero dans leur
  // propre numerotation, donc une cle numerique les aurait confondus et
  // la console aurait compte pour la premiere vty.
  private readonly uses: Map<string, number> = new Map();

  /**
   * Compter une ouverture. Public parce que la CONSOLE n'a pas
   * d'enregistrement de session ici — elle n'est pas une connexion
   * reseau — et que son compteur doit pourtant exister : sur une vraie
   * machine `con 0` est la ligne au plus gros `Uses`.
   */
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

  /**
   * Rend le nombre de lignes REELLEMENT touchees. Ce compte est ce qui
   * distingue un message livre d'un message tombe dans le vide, donc la
   * commande peut dire la verite au lieu d'annoncer un succes constant.
   */
  deliverMessage(cible: 'all' | number, texte: string): number {
    let n = 0;
    for (const [ligne, abonnes] of this.canaux) {
      if (cible !== 'all' && cible !== ligne) continue;
      for (const cb of abonnes) { cb(texte); n += 1; }
    }
    return n;
  }

  /**
   * Le RANG ABSOLU de la ligne dans la colonne `Line`, distinct du rang
   * dans son propre type : IOS numerote `con 0` a 0, puis les vty a
   * partir de 1. C'est ce qui fait que `show users` sur un chassis
   * occupe par la console et une session SSH rend `0 con 0` et `1 vty 0`
   * — deux nombres differents pour deux lignes dont le rang propre est
   * le meme.
   */
  private rangAbsolu(s: SshSessionRecord): number {
    if (s.lineKind === 'con') return s.lineIndex;
    if (s.lineKind === 'aux') return 1 + s.lineIndex;
    return 1 + s.lineIndex;
  }

  formatShowUsers(now: number = this.now()): string {
    // Une console est toujours physiquement la, meme sans authentifica-
    // tion : sans session enregistree, `show users` la decrit libre.
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

  /**
   * Le NUMERO d'interface utilisateur de VRP, distinct du rang de la
   * ligne dans son type : la console est l'interface 0, les vty
   * commencent a 129. Deux espaces de numerotation, un seul champ
   * affiche.
   */
  private interfaceUtilisateur(s: SshSessionRecord): number {
    if (s.lineKind === 'con') return s.lineIndex;
    if (s.lineKind === 'aux') return 1 + s.lineIndex;
    return 129 + s.lineIndex;
  }

  private static readonly TYPE_VRP: Record<SessionTransport, string> = {
    console: 'CON', aux: 'AUX', telnet: 'TEL', ssh: 'SSH',
  };

  /**
   * `display users`. Une console PHYSIQUE existe meme sans personne
   * dessus — c'est ce que decrit la ligne de repli — mais des qu'une
   * session est ouverte la vue doit la LIRE plutot que d'affirmer un
   * etat que rien ne mesure.
   */
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
