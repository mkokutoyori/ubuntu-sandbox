/**
 * Oracle built-in PL/SQL package surface.
 *
 * Real Oracle ships hundreds of built-in packages (DBMS_SESSION,
 * DBMS_APPLICATION_INFO, DBMS_OUTPUT, …) — each is a PL/SQL specification
 * + body in the SYS schema. The simulator does not run PL/SQL natively,
 * so we model each built-in package as a TypeScript class whose
 * methods are dispatched by name when an anonymous block invokes
 * `BEGIN package.proc(args); END;`.
 *
 * The IPackageRoutine interface is the Strategy seam: every routine
 * — DBMS_SESSION.SET_IDENTIFIER, DBMS_APPLICATION_INFO.SET_MODULE,
 * … — is one strategy object, registered by `package.routine` name.
 *
 * Routing rules (mirror Oracle's case-insensitive identifier handling):
 *   - Names are case-folded to UPPER for lookup.
 *   - A routine returning `null` is a no-op (matches "package exists
 *     but call swallowed" used by stubs).
 *   - A routine returning a string surfaces as the routine's output;
 *     callers (executor) inject it into the result row when the call
 *     was made through a SELECT.
 */

import type { OracleSession } from '../security/OracleSession';
import type { AwrSnapshotManager } from '../awr/AwrSnapshotManager';
import type { ResourceManager } from '../resource/ResourceManager';
import type { StatisticsManager } from '../statistics/StatisticsManager';
import type { SchedulerManager } from '../scheduler/SchedulerManager';
import type { OracleStorage } from '../OracleStorage';

/**
 * Per-instance managers a routine may dispatch into (DBMS_STATS → the
 * statistics manager, DBMS_WORKLOAD_REPOSITORY → AWR, …). Supplied by the
 * invoking OracleDatabase; every member is optional so routines degrade to
 * a no-op when their backing manager is absent (engine-direct test setups).
 */
export interface PackageServices {
  readonly awr?: AwrSnapshotManager;
  readonly resourceManager?: ResourceManager;
  readonly statistics?: StatisticsManager;
  readonly scheduler?: SchedulerManager;
  readonly storage?: OracleStorage;
}

/** Runtime context passed to every routine call. */
export interface PackageCallContext {
  /** The OracleSession of the caller — used by every DBMS_SESSION /
   *  DBMS_APPLICATION_INFO call. */
  readonly session: OracleSession;
  /** Original SQL text after the package.proc(...) — used by callers
   *  that need to do extra parsing (rare). */
  readonly rawCall: string;
  /** Typed access to the instance's managers — replaces the former
   *  hidden `_xxxManager` fields smuggled onto the session object. */
  readonly services: PackageServices;
}

/** Function-style strategy backing one PL/SQL routine. */
export interface IPackageRoutine {
  readonly fullName: string;          // e.g. "DBMS_SESSION.SET_IDENTIFIER"
  invoke(args: string[], ctx: PackageCallContext): string | null;
}

/**
 * In-process registry. Built-in package classes register their
 * routines at module-load time; later instances of OracleDatabase
 * share the same registry (Oracle behaves the same way — built-in
 * packages are common to every database).
 */
export class PackageRegistry {
  private readonly routines = new Map<string, IPackageRoutine>();

  register(routine: IPackageRoutine): void {
    this.routines.set(routine.fullName.toUpperCase(), routine);
  }

  /** Look up a routine by its full `package.proc` name. */
  resolve(fullName: string): IPackageRoutine | undefined {
    return this.routines.get(fullName.toUpperCase());
  }

  /** List every routine (used by DBA_PROCEDURES augmentation). */
  list(): IPackageRoutine[] { return [...this.routines.values()]; }
}

/** Shared singleton — same lifecycle as Oracle's catalog. */
export const builtinPackageRegistry = new PackageRegistry();
