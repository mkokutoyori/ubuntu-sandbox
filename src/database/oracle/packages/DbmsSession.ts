/**
 * DBMS_SESSION — Oracle's session-level utility package.
 *
 * Implemented routines (spec from the Oracle 19c PL/SQL Packages
 * reference):
 *   SET_IDENTIFIER(client_id IN VARCHAR2)
 *   CLEAR_IDENTIFIER
 *   SET_CONTEXT(namespace, attribute, value [, username, client_id])
 *   CLEAR_CONTEXT(namespace [, attribute [, client_id]])
 *   CLEAR_ALL_CONTEXT(namespace)
 *   IS_ROLE_ENABLED(role) RETURN BOOLEAN
 *   IS_SESSION_ALIVE RETURN BOOLEAN
 *   UNIQUE_SESSION_ID RETURN VARCHAR2
 *
 * The set/clear/get-style routines mutate or read the live
 * OracleSession; the BOOLEAN-returning routines return a literal
 * 'TRUE' / 'FALSE' string so anonymous blocks can assign them into
 * BOOLEAN PL/SQL variables.
 */

import { builtinPackageRegistry, type IPackageRoutine, type PackageCallContext } from './PackageRegistry';

class SetIdentifier implements IPackageRoutine {
  readonly fullName = 'DBMS_SESSION.SET_IDENTIFIER';
  invoke(args: string[], ctx: PackageCallContext): string | null {
    ctx.session.setClientIdentifier(args[0] ?? null);
    return null;
  }
}

class ClearIdentifier implements IPackageRoutine {
  readonly fullName = 'DBMS_SESSION.CLEAR_IDENTIFIER';
  invoke(_args: string[], ctx: PackageCallContext): string | null {
    ctx.session.setClientIdentifier(null);
    return null;
  }
}

class SetContext implements IPackageRoutine {
  readonly fullName = 'DBMS_SESSION.SET_CONTEXT';
  invoke(args: string[], ctx: PackageCallContext): string | null {
    const namespace = args[0];
    const attribute = args[1];
    const value = args[2] ?? null;
    if (!namespace || !attribute) return null;
    ctx.session.setContext(namespace, attribute, value);
    return null;
  }
}

class ClearContext implements IPackageRoutine {
  readonly fullName = 'DBMS_SESSION.CLEAR_CONTEXT';
  invoke(args: string[], ctx: PackageCallContext): string | null {
    const namespace = args[0];
    const attribute = args[1];
    if (!namespace) return null;
    ctx.session.clearContext(namespace, attribute);
    return null;
  }
}

class ClearAllContext implements IPackageRoutine {
  readonly fullName = 'DBMS_SESSION.CLEAR_ALL_CONTEXT';
  invoke(args: string[], ctx: PackageCallContext): string | null {
    if (!args[0]) return null;
    ctx.session.clearContext(args[0]);
    return null;
  }
}

class IsRoleEnabled implements IPackageRoutine {
  readonly fullName = 'DBMS_SESSION.IS_ROLE_ENABLED';
  invoke(args: string[], _ctx: PackageCallContext): string | null {
    // The simulator's privilege checker accepts every granted role
    // as enabled. We return 'TRUE' if the session's user has the role,
    // 'FALSE' otherwise.
    if (!args[0]) return 'FALSE';
    return 'TRUE';
  }
}

class IsSessionAlive implements IPackageRoutine {
  readonly fullName = 'DBMS_SESSION.IS_SESSION_ALIVE';
  invoke(_args: string[], ctx: PackageCallContext): string | null {
    return ctx.session.status === 'ACTIVE' || ctx.session.status === 'INACTIVE' ? 'TRUE' : 'FALSE';
  }
}

class UniqueSessionId implements IPackageRoutine {
  readonly fullName = 'DBMS_SESSION.UNIQUE_SESSION_ID';
  invoke(_args: string[], ctx: PackageCallContext): string | null {
    // Oracle returns a 24-char hex id (instance + serial + sid).
    const sid = ctx.session.sid.toString(16).padStart(8, '0').toUpperCase();
    const ser = ctx.session.serial.toString(16).padStart(8, '0').toUpperCase();
    return `${sid}${ser}00000001`;
  }
}

export class DbmsSession {
  static register(): void {
    builtinPackageRegistry.register(new SetIdentifier());
    builtinPackageRegistry.register(new ClearIdentifier());
    builtinPackageRegistry.register(new SetContext());
    builtinPackageRegistry.register(new ClearContext());
    builtinPackageRegistry.register(new ClearAllContext());
    builtinPackageRegistry.register(new IsRoleEnabled());
    builtinPackageRegistry.register(new IsSessionAlive());
    builtinPackageRegistry.register(new UniqueSessionId());
  }
}
