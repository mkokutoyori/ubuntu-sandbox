/**
 * DBMS_MVIEW — materialized-view maintenance.
 *
 * Implemented routine:
 *
 *   REFRESH(list [, method])
 *     Complete refresh of one materialized view ('MV' or 'OWNER.MV').
 *     The method argument is accepted ('C'/'F'/'?') but the simulator
 *     always performs a complete refresh — the only kind its container
 *     tables support.
 *
 * Dispatches into the owning OracleDatabase through the
 * `materializedViews` service so the refresh re-executes the defining
 * query with the MV owner's name resolution (definer-style), exactly
 * like the real package.
 */

import { builtinPackageRegistry, type IPackageRoutine, type PackageCallContext } from './PackageRegistry';

class MviewRefresh implements IPackageRoutine {
  readonly fullName = 'DBMS_MVIEW.REFRESH';
  invoke(args: string[], ctx: PackageCallContext): string | null {
    const svc = ctx.services.materializedViews;
    if (!svc) return null;
    const target = (args[0] ?? '').replace(/['"]/g, '').trim();
    if (!target) return null;
    const [first, second] = target.split('.');
    const owner = second ? first : ctx.session.currentSchema;
    const name = second ?? first;
    svc.refresh(owner, name); // throws ORA-12003 on unknown MV
    return 'PL/SQL procedure successfully completed.';
  }
}

export class DbmsMview {
  static register(): void {
    builtinPackageRegistry.register(new MviewRefresh());
  }
}
