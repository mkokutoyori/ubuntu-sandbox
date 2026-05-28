/**
 * DBMS_APPLICATION_INFO — Oracle's session annotation package.
 *
 * The package lets an application stamp MODULE / ACTION / CLIENT_INFO
 * on its session so DBAs can correlate workload with business
 * operations through V$SESSION, V$SQL, ASH, and AWR. The simulator
 * implements every public routine the Oracle 19c reference lists.
 *
 * Spec (Oracle 19c PL/SQL Packages reference):
 *   SET_MODULE(module_name IN VARCHAR2, action_name IN VARCHAR2)
 *   SET_ACTION(action_name IN VARCHAR2)
 *   SET_CLIENT_INFO(client_info IN VARCHAR2)
 *   READ_MODULE(module_name OUT, action_name OUT)
 *   READ_CLIENT_INFO(client_info OUT)
 *   SET_SESSION_LONGOPS(...) — long operation hint
 *
 * Every setter mutates the live OracleSession. The OUT-returning
 * READ_* routines surface the current value back as a string.
 */

import { builtinPackageRegistry, type IPackageRoutine, type PackageCallContext } from './PackageRegistry';

class SetModule implements IPackageRoutine {
  readonly fullName = 'DBMS_APPLICATION_INFO.SET_MODULE';
  invoke(args: string[], ctx: PackageCallContext): string | null {
    const moduleName = args[0] ?? null;
    const actionName = args[1] ?? null;
    ctx.session.setModule(moduleName, actionName);
    return null;
  }
}

class SetAction implements IPackageRoutine {
  readonly fullName = 'DBMS_APPLICATION_INFO.SET_ACTION';
  invoke(args: string[], ctx: PackageCallContext): string | null {
    ctx.session.setAction(args[0] ?? null);
    return null;
  }
}

class SetClientInfo implements IPackageRoutine {
  readonly fullName = 'DBMS_APPLICATION_INFO.SET_CLIENT_INFO';
  invoke(args: string[], ctx: PackageCallContext): string | null {
    ctx.session.setClientInfo(args[0] ?? null);
    return null;
  }
}

class ReadModule implements IPackageRoutine {
  readonly fullName = 'DBMS_APPLICATION_INFO.READ_MODULE';
  invoke(_args: string[], ctx: PackageCallContext): string | null {
    return `MODULE=${ctx.session.module ?? ''} ACTION=${ctx.session.action ?? ''}`;
  }
}

class ReadClientInfo implements IPackageRoutine {
  readonly fullName = 'DBMS_APPLICATION_INFO.READ_CLIENT_INFO';
  invoke(_args: string[], ctx: PackageCallContext): string | null {
    return ctx.session.clientInfo ?? '';
  }
}

class SetSessionLongops implements IPackageRoutine {
  readonly fullName = 'DBMS_APPLICATION_INFO.SET_SESSION_LONGOPS';
  invoke(_args: string[], _ctx: PackageCallContext): string | null {
    // Real Oracle pushes a row into V$SESSION_LONGOPS; the simulator
    // already maintains that view from oracle.session.longops events.
    // Accept the call so DBA scripts using it don't blow up.
    return null;
  }
}

/** Bundles every DBMS_APPLICATION_INFO routine for registration. */
export class DbmsApplicationInfo {
  static register(): void {
    builtinPackageRegistry.register(new SetModule());
    builtinPackageRegistry.register(new SetAction());
    builtinPackageRegistry.register(new SetClientInfo());
    builtinPackageRegistry.register(new ReadModule());
    builtinPackageRegistry.register(new ReadClientInfo());
    builtinPackageRegistry.register(new SetSessionLongops());
  }
}
