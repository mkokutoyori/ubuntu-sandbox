/**
 * DBMS_WORKLOAD_REPOSITORY — Oracle's AWR control package.
 *
 * Implemented routines:
 *   CREATE_SNAPSHOT([flush_level])      → INT  (snap_id)
 *   DROP_SNAPSHOT_RANGE(low, high)
 *   MODIFY_SNAPSHOT_SETTINGS(retention, interval, topnsql)
 *
 * The routines dispatch into the active OracleInstance's
 * AwrSnapshotManager. AwrSnapshotManager is exposed via the instance
 * itself, which is reachable through the live OracleSession's
 * `instance` reference (set on session construction).
 */

import { builtinPackageRegistry, type IPackageRoutine, type PackageCallContext } from './PackageRegistry';
import type { AwrSnapshotManager } from '../awr/AwrSnapshotManager';

/** Resolve the AwrSnapshotManager from a session context.
 *  The session does not carry the manager directly; we follow the
 *  conventional path session → instance → snapshot manager. The
 *  instance handle is injected via OracleSession.instance reference,
 *  set by OracleDatabase. */
function manager(ctx: PackageCallContext): AwrSnapshotManager | null {
  const s = ctx.session as unknown as { _awrManager?: AwrSnapshotManager };
  return s._awrManager ?? null;
}

class CreateSnapshot implements IPackageRoutine {
  readonly fullName = 'DBMS_WORKLOAD_REPOSITORY.CREATE_SNAPSHOT';
  invoke(args: string[], ctx: PackageCallContext): string | null {
    const mgr = manager(ctx);
    if (!mgr) return null;
    const flush = (args[0] ?? 'TYPICAL').toUpperCase() as 'TYPICAL' | 'ALL' | 'BASIC';
    const id = mgr.createSnapshot({ flushLevel: flush, manual: true });
    return `Snapshot ${id} created`;
  }
}

class DropSnapshotRange implements IPackageRoutine {
  readonly fullName = 'DBMS_WORKLOAD_REPOSITORY.DROP_SNAPSHOT_RANGE';
  invoke(args: string[], ctx: PackageCallContext): string | null {
    const mgr = manager(ctx);
    if (!mgr) return null;
    const lo = parseInt(args[0] ?? '0', 10);
    const hi = parseInt(args[1] ?? '0', 10);
    const n = mgr.dropSnapshotRange(lo, hi);
    return `${n} snapshots dropped`;
  }
}

class ModifySnapshotSettings implements IPackageRoutine {
  readonly fullName = 'DBMS_WORKLOAD_REPOSITORY.MODIFY_SNAPSHOT_SETTINGS';
  invoke(args: string[], ctx: PackageCallContext): string | null {
    const mgr = manager(ctx);
    if (!mgr) return null;
    const retention = args[0] ? parseInt(args[0], 10) : undefined;
    const interval  = args[1] ? parseInt(args[1], 10) : undefined;
    const topnsql   = args[2] ? parseInt(args[2], 10) : undefined;
    mgr.modifySettings({
      ...(retention !== undefined ? { retentionMinutes: retention } : {}),
      ...(interval !== undefined  ? { intervalMinutes: interval } : {}),
      ...(topnsql !== undefined   ? { topnSql: topnsql } : {}),
    });
    return 'Snapshot settings modified';
  }
}

export class DbmsWorkloadRepository {
  static register(): void {
    builtinPackageRegistry.register(new CreateSnapshot());
    builtinPackageRegistry.register(new DropSnapshotRange());
    builtinPackageRegistry.register(new ModifySnapshotSettings());
  }
}
