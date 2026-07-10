/**
 * Utilisateurs, sessions et privilèges.
 *
 * Un `User` est une identité immuable (uid/gid/groupes/capacités).
 * Une `Session` est l'état vivant d'un shell attaché à un utilisateur :
 * environnement, variables de script, répertoire courant, dernier code
 * de sortie ($?).
 */

export enum PrivilegeLevel {
  ANY = 0, // tout le monde, même invité
  AUTHENTICATED = 1, // utilisateur connecté
  OPERATOR = 2, // membre d'un groupe privilégié (ex: sudoers)
  ROOT = 3, // superutilisateur uniquement
}

/** Capacités fines, à la manière des capabilities Linux. */
export enum Capability {
  FS_READ = "fs.read",
  FS_WRITE = "fs.write",
  FS_CHOWN = "fs.chown",
  PROC_KILL = "proc.kill",
  PROC_SPAWN = "proc.spawn",
  NET_ADMIN = "net.admin",
  USER_MANAGE = "user.manage",
  SYS_SHUTDOWN = "sys.shutdown",
}

export interface User {
  readonly uid: number;
  readonly gid: number;
  readonly name: string;
  readonly groups: ReadonlySet<string>;
  readonly capabilities: ReadonlySet<Capability>;
  /** Groupes supplémentaires, par gid numérique (pour les contrôles d'accès fichier). */
  readonly supplementaryGids?: readonly number[];
  isRoot(): boolean; // par convention : uid === 0
}

/** État vivant d'une session shell (environnement, cwd, variables de script…). */
export interface Session {
  readonly id: string;
  readonly user: User;
  readonly env: Map<string, string>;
  readonly variables: Map<string, string>; // variables locales de script ($x)
  cwd: string;
  lastExitCode: number; // $? du dernier appel
}

export interface AuthorizationResult {
  readonly granted: boolean;
  readonly reason?: string;
}

/** Implémentation minimale de `User`, utile pour les tests et l'amorçage. */
export class SimpleUser implements User {
  constructor(
    readonly uid: number,
    readonly gid: number,
    readonly name: string,
    readonly groups: ReadonlySet<string> = new Set(),
    readonly capabilities: ReadonlySet<Capability> = new Set(),
    readonly supplementaryGids: readonly number[] = [],
  ) {}

  isRoot(): boolean {
    return this.uid === 0;
  }
}

export interface CreateSessionOptions {
  readonly id: string;
  readonly user: User;
  readonly cwd?: string;
  readonly env?: Map<string, string>;
}

/** Fabrique une session neuve avec des collections isolées (pas de partage accidentel). */
export function createSession(options: CreateSessionOptions): Session {
  return {
    id: options.id,
    user: options.user,
    env: options.env ?? new Map<string, string>(),
    variables: new Map<string, string>(),
    cwd: options.cwd ?? "/",
    lastExitCode: 0,
  };
}
