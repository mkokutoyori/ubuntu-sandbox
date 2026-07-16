/**
 * SqlPlusSubShell — Interactive SQL*Plus sub-shell.
 *
 * Wraps the existing SQLPlusSession into the ISubShell interface,
 * decoupling Oracle database concerns from LinuxTerminalSession.
 */

import type { Equipment, HostCapableDevice } from '@/network';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import type { ISubShell, SubShellResult } from './ISubShell';
import type { SQLPlusSession } from '@/database/oracle/commands/SQLPlusSession';
import type { HostCommandRunner } from '@/database/oracle/commands/HostCommandRunner';
import type { OsSecurityContext } from '@/database/oracle/security/types';
import { createSQLPlusSession, initOracleFilesystem } from '@/terminal/commands/database';
import { createSqlPlusKernel, recognizeSqlPlusKernelVerb } from '@/database/oracle/command-kernel/createSqlPlusKernel';
import { PipeBuffer } from '@/command-kernel/io/pipe-buffer';
import type { CommandIO } from '@/command-kernel/io/types';
import type { Interpreter } from '@/command-kernel/interpreter';
import type { Session as KernelSession } from '@/command-kernel/session/types';

interface SyncShellHost {
  runOracleHostCommandSync(command: string): { output: string; exitCode: number } | null;
}

function asSyncShellHost(device: Equipment): SyncShellHost | null {
  const d = device as unknown as Partial<SyncShellHost>;
  return typeof d.runOracleHostCommandSync === 'function' ? (d as SyncShellHost) : null;
}

function runSync(host: SyncShellHost | null, command: string): string {
  return host?.runOracleHostCommandSync(command)?.output ?? '';
}

/**
 * Snapshot the launching shell's OS identity — like a real sqlplus
 * process inherits the uid/groups of the shell that exec'd it. The dba
 * group membership read here is what gates `/ AS SYSDBA` (bequeath
 * authentication); OSUSER/MACHINE/TERMINAL feed V$SESSION and the audit
 * trail. Returns undefined on devices without a POSIX identity surface,
 * letting the engine fall back to its default context.
 */
function captureOsContext(device: Equipment, host: SyncShellHost | null): OsSecurityContext | undefined {
  const capable = device as HostCapableDevice;
  const osUser = capable.getCurrentUser?.() ?? runSync(host, 'whoami').trim();
  if (!osUser) return undefined;

  const groups = runSync(host, `id -Gn ${osUser}`).trim().split(/\s+/).filter(Boolean);
  const hostname = runSync(host, 'hostname').trim() || 'localhost';
  return {
    osUser,
    osGroup: groups[0] ?? osUser,
    isDbaGroup: groups.includes('dba'),
    hostname,
    terminal: 'pts/0',
    program: `sqlplus@${hostname}`,
  };
}

const STATEMENT_KEYWORDS: readonly string[] = [
  'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'CREATE', 'DROP', 'ALTER',
  'TRUNCATE', 'GRANT', 'REVOKE', 'COMMIT', 'ROLLBACK', 'SAVEPOINT',
  'BEGIN', 'DECLARE', 'EXPLAIN', 'DESC', 'DESCRIBE', 'SET', 'SHOW',
  'SPOOL', 'HOST', 'CONNECT', 'DISCONNECT', 'EXIT', 'QUIT', 'CLEAR',
];

const CLAUSE_KEYWORDS: readonly string[] = [
  'FROM', 'WHERE', 'ORDER', 'GROUP', 'BY', 'HAVING', 'AND', 'OR', 'NOT',
  'NULL', 'LIKE', 'IN', 'BETWEEN', 'VALUES', 'INTO', 'JOIN', 'ON', 'AS',
  'DISTINCT', 'UNION', 'ALL',
];

const TABLE_CONTEXT_WORDS: ReadonlySet<string> = new Set([
  'from', 'into', 'update', 'table', 'desc', 'describe', 'join',
]);

export class SqlPlusSubShell implements ISubShell {
  readonly kind = 'sqlplus';
  readonly connection = 'subshell' as const;
  private session: SQLPlusSession;
  private prompt: string;
  private readonly hostname: string;
  /** Socle command-kernel (Wave 2) — construit paresseusement, lié à `this.session`. */
  private kernel: { interpreter: Interpreter; session: KernelSession } | null = null;

  private constructor(session: SQLPlusSession, prompt: string, hostname: string) {
    this.session = session;
    this.prompt = prompt;
    this.hostname = hostname;
  }

  /** Construit le socle command-kernel au premier besoin (une seule fois par sous-shell). */
  private getKernel(): { interpreter: Interpreter; session: KernelSession } {
    if (!this.kernel) {
      const { interpreter, session } = createSqlPlusKernel(this.session, this.hostname);
      this.kernel = { interpreter, session };
    }
    return this.kernel;
  }

  /**
   * Factory: create a SQL*Plus sub-shell for a device.
   * Initialises the Oracle filesystem and creates the session.
   *
   * @returns The sub-shell, banner lines, and login output.
   * @throws If the session cannot be created (bad credentials, etc.).
   */
  static create(
    device: Equipment,
    args: string[],
  ): { subShell: SqlPlusSubShell; banner: string[]; loginOutput: string[] } {
    initOracleFilesystem(device);
    const deviceId = device.getId();
    const host = asSyncShellHost(device);
    const osCtx = captureOsContext(device, host);
    const { session, banner, loginOutput } = createSQLPlusSession(deviceId, args, osCtx);
    if (host) {
      const runner: HostCommandRunner = {
        execute(cmd: string): string[] {
          const out = runSync(host, cmd);
          return out === '' ? [] : out.split('\n');
        },
      };
      session.setHostCommandRunner(runner);
    }

    // SPOOL / @script filesystem surface. Relative paths resolve against
    // the launching shell's cwd (like a real sqlplus process); reads and
    // writes go through the device's stable editor file surface.
    const fsDevice = device as unknown as {
      writeFileFromEditor?: (p: string, c: string) => boolean;
      readFileForEditor?: (p: string) => string | null;
    };
    session.setFileIO({
      resolve: (path: string): string => {
        if (path.startsWith('/')) return path;
        const pwd = runSync(host, 'pwd').trim();
        const baseDir = pwd.startsWith('/') ? pwd : '/root';
        return `${baseDir}/${path}`.replace(/\/{2,}/g, '/');
      },
      read: (path: string): string | null =>
        fsDevice.readFileForEditor?.(path) ?? null,
      write: (path: string, content: string): boolean =>
        fsDevice.writeFileFromEditor?.(path, content) ?? false,
    });

    return {
      subShell: new SqlPlusSubShell(session, session.getPrompt(), osCtx?.hostname ?? 'localhost'),
      banner,
      loginOutput,
    };
  }

  getPrompt(): string {
    return this.prompt;
  }

  handleKey(e: KeyEvent): boolean {
    // Ctrl+D → exit
    if (e.key === 'd' && e.ctrlKey) return true; // signal handled by session
    // Ctrl+C → cancel current input (handled at session level)
    if (e.key === 'c' && e.ctrlKey) return true;
    // All other keys go to the view's text input
    return false;
  }

  /**
   * Single-gate pour les 6 verbes de session/réglages migrés (Wave 2,
   * `src/database/oracle/command-kernel/`) : `SET`/`SHOW`/`HELP`/`CLEAR`/
   * `EXIT`/`QUIT`/`DISCONNECT`/`DISC`, reconnus via `recognizeSqlPlusKernelVerb`
   * — jamais atteints en dehors d'un tampon SQL/PL-SQL en cours
   * (`session.isAwaitingMoreInput()`). Toute autre ligne (instructions SQL,
   * PL/SQL, `CONNECT`, `SPOOL`, `@`/`START`…) reste portée par le legacy
   * `SQLPlusSession.processLine` — pas encore migrée.
   *
   * `ISubShell.processLine` autorise `SubShellResult | Promise<SubShellResult>`
   * (l'appelant terminal gère déjà les deux) : seule la branche kernel est
   * async ; la branche legacy (l'immense majorité des appels — toute
   * instruction SQL/PL-SQL, `CONNECT`, `SPOOL`, `HOST`…) reste strictement
   * synchrone, à l'identique d'avant cette vague — aucun des ~70 fichiers de
   * tests qui appellent `subShell.processLine(sql)` de façon synchrone n'a
   * besoin d'être touché.
   */
  processLine(line: string): SubShellResult | Promise<SubShellResult> {
    const trimmed = line.trim();
    const recognized = this.session.isAwaitingMoreInput() ? null : recognizeSqlPlusKernelVerb(trimmed);

    if (recognized) {
      return this.processKernelVerb(recognized, line, trimmed);
    }

    const result = this.session.processLine(line);
    this.prompt = result.prompt;

    // Phase 7c: the OracleFilesystemSync adapter (auto-attached by
    // getOracleDatabase) now materialises alert log, spfile, datafiles
    // and processes by subscribing to oracle.* bus events. No manual
    // post-execute sync needed.

    const isClear = /^CLEAR\s+SCR/i.test(trimmed);
    return {
      output: result.output,
      exit: result.exit,
      prompt: result.prompt,
      clearScreen: isClear,
    };
  }

  private async processKernelVerb(
    recognized: { name: string; argv: string[] },
    line: string,
    trimmed: string,
  ): Promise<SubShellResult> {
    const kernel = this.getKernel();
    const stdout = new PipeBuffer();
    const io: CommandIO = { stdin: new PipeBuffer(), stdout, stderr: stdout };
    const code = await kernel.interpreter.runResolved(recognized.name, recognized.argv, kernel.session, io);
    await stdout.close();
    if (code === null) {
      // Ne doit jamais arriver : `recognizeSqlPlusKernelVerb` ne reconnaît
      // que des verbes réellement enregistrés par `createSqlPlusKernel`.
      throw new Error(`sqlplus command-kernel: verbe reconnu mais non enregistré : ${recognized.name}`);
    }
    const text = (await stdout.readAll()).replace(/\n$/, '');
    const output = text ? text.split('\n') : [];
    const prompt = this.session.getPrompt();
    this.session.recordExternalLine(line, output, prompt);
    this.prompt = prompt;

    const exit = recognized.name === 'EXIT' || recognized.name === 'QUIT';
    const isClear = /^CLEAR\s+SCR/i.test(trimmed);
    return { output, exit, prompt, clearScreen: isClear };
  }

  getCompletions(line: string): string[] {
    const match = /(\S*)$/.exec(line);
    const partial = match?.[1] ?? '';
    const partialUpper = partial.toUpperCase();
    const before = line.slice(0, line.length - partial.length).trim();
    const tokens = before.length > 0 ? before.split(/\s+/) : [];
    const prev = (tokens[tokens.length - 1] ?? '').replace(/,+$/, '').toLowerCase();

    if (tokens.length === 0) {
      return filterByPrefix(STATEMENT_KEYWORDS, partialUpper);
    }
    if (TABLE_CONTEXT_WORDS.has(prev)) {
      return filterByPrefix(this.tableNames(), partialUpper);
    }
    return filterByPrefix(
      [...this.columnCandidates(line), ...CLAUSE_KEYWORDS],
      partialUpper,
    );
  }

  private tableNames(): string[] {
    const db = this.session.getDatabase();
    if (!db) return [];
    const schema = this.session.getCurrentUser().toUpperCase();
    const names = db.storage.getAllTables()
      .filter((t) => t.schema === schema)
      .map((t) => t.name);
    if (!names.includes('DUAL')) names.push('DUAL');
    return names.sort();
  }

  private columnCandidates(line: string): string[] {
    const db = this.session.getDatabase();
    if (!db) return [];
    const fromMatch = /\bFROM\s+(?:([A-Za-z0-9_$#]+)\.)?([A-Za-z0-9_$#]+)/i.exec(line);
    if (!fromMatch) return [];
    const schema = (fromMatch[1] ?? this.session.getCurrentUser()).toUpperCase();
    const tableName = (fromMatch[2] ?? '').toUpperCase();
    const table = db.storage.getAllTables()
      .find((t) => t.schema === schema && t.name === tableName);
    if (!table) return [];
    return table.columns.map((c) => c.name).sort();
  }

  dispose(): void {
    this.session.disconnect();
  }
}

function filterByPrefix(candidates: readonly string[], partialUpper: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of candidates) {
    const upper = candidate.toUpperCase();
    if (!upper.startsWith(partialUpper) || seen.has(upper)) continue;
    seen.add(upper);
    out.push(candidate);
  }
  return out;
}
