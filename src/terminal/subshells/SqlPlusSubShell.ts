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

  private constructor(session: SQLPlusSession, prompt: string) {
    this.session = session;
    this.prompt = prompt;
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
      subShell: new SqlPlusSubShell(session, session.getPrompt()),
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

  processLine(line: string): SubShellResult {
    const result = this.session.processLine(line);
    this.prompt = result.prompt;

    // Phase 7c: the OracleFilesystemSync adapter (auto-attached by
    // getOracleDatabase) now materialises alert log, spfile, datafiles
    // and processes by subscribing to oracle.* bus events. No manual
    // post-execute sync needed.

    const isClear = /^CLEAR\s+SCR/i.test(line.trim());
    return {
      output: result.output,
      exit: result.exit,
      prompt: result.prompt,
      clearScreen: isClear,
    };
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
