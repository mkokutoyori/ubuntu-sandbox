/**
 * SqlPlusMachineApi — façade command-kernel pour le sous-shell SQL*Plus.
 *
 * Wave 1 (voir CHANGELOG) : ne couvre que les commandes de session/réglages
 * (SET, SHOW, HELP, CLEAR, EXIT/QUIT, DISCONNECT) — l'exécution SQL/PL-SQL,
 * CONNECT, SPOOL et les scripts (`@`/START) restent portés par
 * `SQLPlusSession`/`SqlPlusSubShell` (legacy) pour cette vague. Cette
 * MachineApi lit et mute l'état réel via les accesseurs publics de
 * `SQLPlusSession` (`getSettingsSnapshot`, `applySetOption`, `getConName`…)
 * — jamais d'état parallèle.
 */
import {
  FileSystemApi,
  FileStat,
  GroupManagementApi,
  MachineApi,
  NetworkApi,
  PowerApi,
  ProcessApi,
  UserManagementApi,
} from '@/command-kernel/machine/types';
import { FileSystemError } from '@/command-kernel/errors';
import type { SetOptionResult, SQLPlusSession, SQLPlusSettings } from '../commands/SQLPlusSession';

const UNSUPPORTED = (path: string): never => {
  throw new FileSystemError(path, 'EACCES', `${path}: opération non prise en charge par le shell sqlplus`);
};

/**
 * Wave 1 : aucune commande migrée ne touche le système de fichiers (SPOOL/
 * @script restent legacy) — toutes les opérations rejettent explicitement,
 * comme `SftpLocalFileSystemApi` le fait déjà pour ses opérations hors
 * périmètre. `resolve` reste une pure concaténation, jamais en échec.
 */
class SqlPlusUnsupportedFileSystemApi implements FileSystemApi {
  resolve(cwd: string, path: string): string {
    if (path.startsWith('/')) return path;
    return `${cwd.replace(/\/$/, '')}/${path}`;
  }
  async readFile(path: string): Promise<string> { return UNSUPPORTED(path); }
  async writeFile(path: string): Promise<void> { UNSUPPORTED(path); }
  async touch(path: string): Promise<void> { UNSUPPORTED(path); }
  async list(path: string): Promise<FileStat[]> { return UNSUPPORTED(path); }
  async stat(path: string): Promise<FileStat> { return UNSUPPORTED(path); }
  async lstat(path: string): Promise<FileStat> { return UNSUPPORTED(path); }
  async exists(): Promise<boolean> { return false; }
  async remove(path: string): Promise<void> { UNSUPPORTED(path); }
  async mkdir(path: string): Promise<void> { UNSUPPORTED(path); }
  async rmdir(path: string): Promise<void> { UNSUPPORTED(path); }
  async chmod(path: string): Promise<void> { UNSUPPORTED(path); }
  async chown(path: string): Promise<void> { UNSUPPORTED(path); }
  async copy(source: string): Promise<void> { UNSUPPORTED(source); }
  async rename(source: string): Promise<void> { UNSUPPORTED(source); }
  async symlink(_target: string, path: string): Promise<void> { UNSUPPORTED(path); }
  async readlink(path: string): Promise<string> { return UNSUPPORTED(path); }
  async link(_target: string, path: string): Promise<void> { UNSUPPORTED(path); }
}

const EMPTY_PROC: ProcessApi = {
  async list() { return []; },
} as unknown as ProcessApi;

const EMPTY_NET: NetworkApi = {
  async interfaces() { return []; },
  async setInterfaceState() { /* pas d'interface réseau dans un shell sqlplus */ },
};

const EMPTY_USERS: UserManagementApi = {
  async findByName() { return undefined; },
  async findByUid() { return undefined; },
} as unknown as UserManagementApi;

const EMPTY_GROUPS: GroupManagementApi = {
  async findByGid() { return undefined; },
  async findByName() { return undefined; },
} as unknown as GroupManagementApi;

const EMPTY_POWER: PowerApi = {
  async shutdown() { /* pas de cycle de vie machine dans un shell sqlplus */ },
  async reboot() { /* idem */ },
};

/** SGA telle que lue par `SHOW SGA` — sous-ensemble utilisé par le rendu vendeur. */
export interface OracleSgaView {
  readonly totalSize: string;
  readonly bufferCache: string;
  readonly redoLogBuffer: string;
}

/**
 * Capacité dédiée aux commandes SQL*Plus migrées (Wave 1). Chaque méthode
 * lit ou mute l'état RÉEL de la session Oracle via les accesseurs publics
 * de `SQLPlusSession` — jamais d'état parallèle, jamais l'objet legacy
 * importé directement par une commande.
 */
export interface OracleSqlPlusApi {
  isConnected(): boolean;
  currentUser(): string;
  isSysdba(): boolean;
  settings(): Readonly<SQLPlusSettings>;
  /** SET <option> <value> — mutation réelle, déléguée à `SQLPlusSession.applySetOption`. */
  applySetOption(option: string | undefined, value: string): SetOptionResult;
  conName(): string;
  conId(): number;
  sgaInfo(): OracleSgaView | null;
  allParameters(): ReadonlyMap<string, string> | null;
  spfileParameters(): ReadonlyMap<string, string> | null;
  /** Termine la connexion courante (EXIT/QUIT/DISCONNECT). */
  disconnect(): void;
}

class SqlPlusOracleFacade implements OracleSqlPlusApi {
  constructor(private readonly session: SQLPlusSession) {}

  isConnected(): boolean { return this.session.isConnected(); }
  currentUser(): string { return this.session.getCurrentUser(); }
  isSysdba(): boolean { return this.session.isSysdba(); }
  settings(): Readonly<SQLPlusSettings> { return this.session.getSettingsSnapshot(); }

  applySetOption(option: string | undefined, value: string): SetOptionResult {
    return this.session.applySetOption(option, value);
  }

  conName(): string { return this.session.getConName(); }
  conId(): number { return this.session.getConId(); }

  sgaInfo(): OracleSgaView | null {
    const sga = this.session.getSgaInfoSnapshot();
    if (!sga) return null;
    return { totalSize: sga.totalSize, bufferCache: sga.bufferCache, redoLogBuffer: sga.redoLogBuffer };
  }

  allParameters(): ReadonlyMap<string, string> | null {
    return this.session.getAllParametersSnapshot();
  }

  spfileParameters(): ReadonlyMap<string, string> | null {
    return this.session.getSpfileParametersSnapshot();
  }

  disconnect(): void {
    this.session.disconnect();
  }
}

export class SqlPlusMachineApi implements MachineApi {
  readonly fs: FileSystemApi = new SqlPlusUnsupportedFileSystemApi();
  readonly proc = EMPTY_PROC;
  readonly net = EMPTY_NET;
  readonly users = EMPTY_USERS;
  readonly groups = EMPTY_GROUPS;
  readonly power = EMPTY_POWER;
  readonly hostname: string;
  readonly oracle: OracleSqlPlusApi;

  constructor(session: SQLPlusSession, hostname: string = 'localhost') {
    this.oracle = new SqlPlusOracleFacade(session);
    this.hostname = hostname;
  }

  now(): Date {
    return new Date();
  }
}
