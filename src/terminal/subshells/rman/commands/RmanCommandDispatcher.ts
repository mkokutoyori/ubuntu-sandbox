/**
 * RmanCommandDispatcher — pattern-matching invoker for IRmanCommand.
 *
 * First registered regex that matches wins. registerCommand() is the
 * Open/Closed extension point.
 */

import { ok, err, type Result } from '../core/Result';
import type { RmanError } from '../core/RmanError';
import type { IRmanCommand, RmanCommandContext } from './types';
import { BackupCommand } from './BackupCommand';
import { RestoreCommand } from './RestoreCommand';
import { RecoverCommand } from './RecoverCommand';
import { CrosscheckCommand } from './CrosscheckCommand';
import { DeleteCommand } from './DeleteCommand';
import { ListBackupCommand } from './ListBackupCommand';
import { ReportCommand } from './ReportCommand';
import { ShowCommand } from './ShowCommand';
import { ConnectCommand } from './ConnectCommand';
import { HelpCommand } from './HelpCommand';
import { ConfigureCommand } from './ConfigureCommand';
import { AllocateChannelCommand } from './AllocateChannelCommand';
import { ReleaseChannelCommand } from './ReleaseChannelCommand';
import { CatalogCommand } from './CatalogCommand';
import { DuplicateCommand } from './DuplicateCommand';

interface DispatchEntry {
  pattern: RegExp;
  command: IRmanCommand<unknown>;
}

export class RmanCommandDispatcher {
  private readonly _entries: DispatchEntry[] = [];

  constructor() { this._registerDefaults(); }

  registerCommand(pattern: RegExp, command: IRmanCommand<unknown>): void {
    this._entries.push({ pattern, command });
  }

  dispatch(line: string, cmdCtx: RmanCommandContext): Result<string[], RmanError> {
    const trimmed = line.trim();
    for (const { pattern, command } of this._entries) {
      // Test the upper-cased line so command keywords are case-insensitive,
      // but if there are capture groups, re-run against the original line
      // to preserve user-typed argument case.
      const m = trimmed.toUpperCase().match(pattern);
      if (m) {
        const capturedRaw = trimmed.match(pattern);
        const args = (capturedRaw ?? m).slice(1).filter((x): x is string => x !== undefined);
        const r = command.execute(args, cmdCtx);
        if (!r.ok) return r as Result<string[], RmanError>;
        const value = r.value;
        return ok(Array.isArray(value) ? (value as string[]) : []);
      }
    }
    return err({ code: 'RMAN_01009', message: `syntax error: found: unknown command: ${trimmed}` });
  }

  private _registerDefaults(): void {
    this._entries.push(
      { pattern: /^CONNECT TARGET(.*)$/i,                          command: new ConnectCommand() },
      // VALIDATE / CONTROLFILE / INCREMENTAL — match before plain "BACKUP DATABASE"
      { pattern: /^BACKUP VALIDATE DATABASE$/i,                    command: new BackupCommand('validate') },
      { pattern: /^BACKUP CURRENT CONTROLFILE(.*)$/i,              command: new BackupCommand('controlfile') },
      { pattern: /^BACKUP INCREMENTAL LEVEL (\d) DATABASE(.*)$/i,  command: new BackupCommand('incremental') },
      { pattern: /^BACKUP DATABASE(.*)$/i,                         command: new BackupCommand('database') },
      { pattern: /^BACKUP ARCHIVELOG ALL(.*)$/i,                   command: new BackupCommand('archivelog') },
      { pattern: /^BACKUP TABLESPACE (\S+)(.*)$/i,                 command: new BackupCommand('tablespace') },
      { pattern: /^RESTORE (DATABASE)(?:\s+(.*))?$/i,     command: new RestoreCommand() },
      { pattern: /^RESTORE (TABLESPACE) (\S+)(?:\s+(.*))?$/i, command: new RestoreCommand() },
      { pattern: /^RESTORE (DATAFILE) (\d+)(?:\s+(.*))?$/i,   command: new RestoreCommand() },
      { pattern: /^RECOVER (DATABASE)(?:\s+(.*))?$/i,        command: new RecoverCommand() },
      { pattern: /^RECOVER (TABLESPACE) (\S+)(?:\s+(.*))?$/i, command: new RecoverCommand() },
      { pattern: /^RECOVER (DATAFILE) (\d+)(?:\s+(.*))?$/i,   command: new RecoverCommand() },
      { pattern: /^LIST BACKUP SUMMARY$/i,       command: new ListBackupCommand('SUMMARY') },
      { pattern: /^LIST BACKUP$/i,               command: new ListBackupCommand('DETAIL') },
      { pattern: /^REPORT SCHEMA$/i,             command: new ReportCommand('SCHEMA') },
      { pattern: /^REPORT NEED BACKUP$/i,        command: new ReportCommand('NEED_BACKUP') },
      { pattern: /^CROSSCHECK BACKUP$/i,         command: new CrosscheckCommand() },
      { pattern: /^DELETE EXPIRED BACKUP$/i,     command: new DeleteCommand('EXPIRED') },
      { pattern: /^DELETE OBSOLETE$/i,           command: new DeleteCommand('OBSOLETE') },
      { pattern: /^SHOW ALL$/i,                  command: new ShowCommand() },
      { pattern: /^HELP$/i,                      command: new HelpCommand() },
      // CONFIGURE — capture the everything after the keyword in args[0]
      { pattern: /^CONFIGURE (.+)$/i,            command: new ConfigureCommand() },
      // Explicit channels (inside RUN blocks)
      { pattern: /^ALLOCATE CHANNEL (\S+) DEVICE TYPE (DISK|SBT)$/i, command: new AllocateChannelCommand() },
      { pattern: /^RELEASE CHANNEL (\S+)$/i,                          command: new ReleaseChannelCommand() },
      // Manual catalog registration (DEF-RMAN-16)
      { pattern: /^CATALOG DATAFILECOPY (.+)$/i, command: new CatalogCommand('DATAFILECOPY') },
      { pattern: /^CATALOG BACKUPPIECE (.+)$/i,  command: new CatalogCommand('BACKUPPIECE')  },
      // DUPLICATE DATABASE (DEF-RMAN-17)
      { pattern: /^DUPLICATE TARGET DATABASE TO (\S+)$/i, command: new DuplicateCommand() },
      { pattern: /^DUPLICATE DATABASE TO (\S+)$/i,        command: new DuplicateCommand() },
    );
  }
}
