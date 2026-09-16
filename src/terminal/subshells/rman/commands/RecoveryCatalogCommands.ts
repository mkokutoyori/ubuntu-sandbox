/**
 * Recovery-catalog DDL, against the recovery catalog database that
 * `CONNECT CATALOG` resolved over Oracle Net.
 *
 *   CREATE CATALOG
 *   CREATE VIRTUAL CATALOG <name>
 *   GRANT CATALOG FOR DATABASE <name> TO <user>
 *   REGISTER DATABASE
 *   UNREGISTER DATABASE [<name>] [NOPROMPT]
 *   CONNECT CATALOG <user>/<pwd>@<svc>
 *   LIST DB_UNIQUE_NAME OF DATABASE
 *   ALTER DATABASE OPEN RESETLOGS
 */

import { ok, err, type Result } from '../core/Result';
import type { RmanError } from '../core/RmanError';
import type { IRmanCommand, RmanCommandContext } from './types';

const NOT_CONNECTED: RmanError = {
  code: 'RMAN_06171',
  message: 'not connected to recovery catalog',
};

export class CreateCatalogCommand implements IRmanCommand<string[]> {
  readonly name = 'CREATE CATALOG';
  execute(_args: string[], { recoveryCatalog }: RmanCommandContext): Result<string[], RmanError> {
    if (!recoveryCatalog) return err(NOT_CONNECTED);
    const created = recoveryCatalog.createSchema();
    if (created.ok === false) return created;
    return ok(['recovery catalog created']);
  }
}

export class CreateVirtualCatalogCommand implements IRmanCommand<string[]> {
  readonly name = 'CREATE VIRTUAL CATALOG';
  execute(args: string[]): Result<string[], RmanError> {
    const name = (args[0] ?? 'vcat').toUpperCase();
    return ok([`virtual recovery catalog ${name} created`]);
  }
}

export class GrantCatalogCommand implements IRmanCommand<string[]> {
  readonly name = 'GRANT CATALOG';
  execute(args: string[]): Result<string[], RmanError> {
    const dbName = (args[0] ?? '').toUpperCase();
    const user   = (args[1] ?? '').toLowerCase();
    return ok([`Grant succeeded for database ${dbName} to ${user}`]);
  }
}

export class RegisterDatabaseCommand implements IRmanCommand<string[]> {
  readonly name = 'REGISTER DATABASE';
  execute(
    _args: string[], { ctx, catalog, recoveryCatalog }: RmanCommandContext,
  ): Result<string[], RmanError> {
    if (!recoveryCatalog) return err(NOT_CONNECTED);
    const registered = recoveryCatalog.registerDatabase();
    if (registered.ok === false) return registered;
    const snapshot = catalog.listAll();
    if (snapshot.ok) recoveryCatalog.resyncFrom(snapshot.value);
    return ok([
      'database registered in recovery catalog',
      'starting full resync of recovery catalog',
      'full resync complete',
      `database ${ctx.dbName} registered`,
    ]);
  }
}

export class UnregisterDatabaseCommand implements IRmanCommand<string[]> {
  readonly name = 'UNREGISTER DATABASE';
  execute(args: string[], { ctx, recoveryCatalog }: RmanCommandContext): Result<string[], RmanError> {
    if (!recoveryCatalog) return err(NOT_CONNECTED);
    const name = (args[0] ?? ctx.dbName).toUpperCase();
    if (!recoveryCatalog.isRegistered()) {
      return err({
        code: 'RMAN_06004',
        message: `database ${name} not found in the recovery catalog`,
      });
    }
    const removed = recoveryCatalog.unregisterDatabase();
    if (removed.ok === false) return removed;
    return ok([
      `database name is "${name}" and DBID is ${ctx.dbId.value}`,
      'database unregistered from the recovery catalog',
    ]);
  }
}

export class ConnectCatalogCommand implements IRmanCommand<string[]> {
  readonly name = 'CONNECT CATALOG';
  execute(_args: string[], { recoveryCatalog }: RmanCommandContext): Result<string[], RmanError> {
    if (!recoveryCatalog) return err(NOT_CONNECTED);
    return ok(['connected to recovery catalog database']);
  }
}

export class ListDbUniqueNameCommand implements IRmanCommand<string[]> {
  readonly name = 'LIST DB_UNIQUE_NAME';
  execute(_args: string[], { ctx, recoveryCatalog }: RmanCommandContext): Result<string[], RmanError> {
    if (!recoveryCatalog) return err(NOT_CONNECTED);
    if (!recoveryCatalog.isRegistered()) return ok(['', 'List of Databases', '=================', '']);
    return ok([
      '',
      'List of Databases',
      '=================',
      'DB Key  DB Name  DB ID            Database Role    Db_unique_name',
      '------- -------- ---------------- ---------------- ----------------',
      `1       ${ctx.dbName.padEnd(8)} ${String(ctx.dbId.value).padEnd(16)} PRIMARY          ${ctx.dbName}`,
      '',
    ]);
  }
}

export class AlterDatabaseOpenResetlogsCommand implements IRmanCommand<string[]> {
  readonly name = 'ALTER DATABASE OPEN RESETLOGS';
  execute(): Result<string[], RmanError> {
    return ok([
      'Statement processed',
      'database opened',
      'new database incarnation registered',
    ]);
  }
}

export class SwitchDatafileCommand implements IRmanCommand<string[]> {
  readonly name = 'SWITCH DATAFILE';
  execute(args: string[]): Result<string[], RmanError> {
    const target = (args[0] ?? 'ALL').toUpperCase();
    if (target === 'ALL') return ok(['datafile names switched to current image copies']);
    return ok([`datafile ${target} switched to current image copy`]);
  }
}

export class ResetDatabaseCommand implements IRmanCommand<string[]> {
  readonly name = 'RESET DATABASE';
  execute(args: string[]): Result<string[], RmanError> {
    const inc = args[0] ?? '';
    if (inc) return ok([`database reset to incarnation ${inc}`]);
    return ok(['database reset to current incarnation']);
  }
}

export class SqlMacroCommand implements IRmanCommand<string[]> {
  readonly name = 'SQL';
  execute(args: string[], ctx: RmanCommandContext): Result<string[], RmanError> {
    const stmt = (args[0] ?? '').replace(/^["']|["']$/g, '');
    const outcome = ctx.ctx.runSqlStatement?.(stmt);
    if (outcome?.ok === false) {
      return ok([
        'RMAN-00571: ===========================================================',
        'RMAN-00569: =============== ERROR MESSAGE STACK FOLLOWS ===============',
        'RMAN-00571: ===========================================================',
        'RMAN-03002: failure during compilation of command',
        outcome.error,
      ]);
    }
    const failed = (outcome?.lines ?? []).find(l => /^ORA-/.test(l));
    if (failed) return ok(['sql statement: ' + stmt, failed]);
    return ok(['sql statement: ' + stmt, 'Statement processed']);
  }
}
