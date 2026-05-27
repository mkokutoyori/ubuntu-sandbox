/**
 * DBMS_STATS — Oracle's statistics-gathering package.
 *
 * Implemented routines (spec from Oracle 19c PL/SQL Packages
 * reference; arg shape mirrors the production signature):
 *
 *   GATHER_TABLE_STATS(ownname, tabname [, partname, estimate_percent, …])
 *   GATHER_SCHEMA_STATS(ownname [, estimate_percent, …])
 *   GATHER_DATABASE_STATS([estimate_percent, …])
 *   DELETE_TABLE_STATS(ownname, tabname)
 *   DELETE_SCHEMA_STATS(ownname)
 *   SET_TABLE_STATS(ownname, tabname, numrows, …)
 *
 * Each call dispatches into the active instance's StatisticsManager.
 */

import { builtinPackageRegistry, type IPackageRoutine, type PackageCallContext } from './PackageRegistry';
import type { StatisticsManager } from '../statistics/StatisticsManager';

function stats(ctx: PackageCallContext): StatisticsManager | null {
  const s = ctx.session as unknown as { _statisticsManager?: StatisticsManager };
  return s._statisticsManager ?? null;
}

class GatherTableStats implements IPackageRoutine {
  readonly fullName = 'DBMS_STATS.GATHER_TABLE_STATS';
  invoke(args: string[], ctx: PackageCallContext): string | null {
    const m = stats(ctx); if (!m) return null;
    const ok = m.gatherTableStats(args[0] ?? '', args[1] ?? '');
    return ok ? 'PL/SQL procedure successfully completed.' : null;
  }
}

class GatherSchemaStats implements IPackageRoutine {
  readonly fullName = 'DBMS_STATS.GATHER_SCHEMA_STATS';
  invoke(args: string[], ctx: PackageCallContext): string | null {
    const m = stats(ctx); if (!m) return null;
    const n = m.gatherSchemaStats(args[0] ?? '');
    return `Schema stats gathered for ${n} table(s).`;
  }
}

class GatherDatabaseStats implements IPackageRoutine {
  readonly fullName = 'DBMS_STATS.GATHER_DATABASE_STATS';
  invoke(_args: string[], ctx: PackageCallContext): string | null {
    const m = stats(ctx); if (!m) return null;
    const storage = (ctx.session as unknown as { _statisticsManagerStorage?: import('../OracleStorage').OracleStorage })
      ._statisticsManagerStorage;
    if (!storage) return null;
    const schemas = new Set(storage.getAllTables().map(t => t.schema));
    let total = 0;
    for (const s of schemas) total += m.gatherSchemaStats(s);
    return `Database stats gathered for ${total} table(s).`;
  }
}

class DeleteTableStats implements IPackageRoutine {
  readonly fullName = 'DBMS_STATS.DELETE_TABLE_STATS';
  invoke(args: string[], ctx: PackageCallContext): string | null {
    const m = stats(ctx); if (!m) return null;
    m.deleteTableStats(args[0] ?? '', args[1] ?? '');
    return null;
  }
}

class SetTableStats implements IPackageRoutine {
  readonly fullName = 'DBMS_STATS.SET_TABLE_STATS';
  invoke(args: string[], ctx: PackageCallContext): string | null {
    const m = stats(ctx); if (!m) return null;
    const owner = args[0] ?? '', table = args[1] ?? '';
    const numrows = args[2] ? parseInt(args[2], 10) : 0;
    // Easiest path — gather, then overwrite NUM_ROWS via a fresh stats row.
    m.gatherTableStats(owner, table);
    const tab = m.getTableStats(owner, table);
    if (tab) (tab as { numRows: number }).numRows = numrows;
    return null;
  }
}

export class DbmsStats {
  static register(): void {
    builtinPackageRegistry.register(new GatherTableStats());
    builtinPackageRegistry.register(new GatherSchemaStats());
    builtinPackageRegistry.register(new GatherDatabaseStats());
    builtinPackageRegistry.register(new DeleteTableStats());
    builtinPackageRegistry.register(new SetTableStats());
  }
}
