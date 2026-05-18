/**
 * Oracle view registry — shared types.
 *
 * Each Oracle dynamic / dictionary view lives in its own file under
 * `src/database/oracle/views/` and exports a `ViewDefinition` describing
 * how to produce a `ResultSet` from the current instance state.
 *
 * Some views are pure projections of static metadata (`V$VERSION`,
 * `V$LICENSE`). Others are reactive — they read from an
 * `OracleRuntimeState` whose collections are kept current by event
 * subscribers (sessions, locks, latches, sql cache, wait history, …).
 * In the reactive case the view itself never mutates state; it only
 * snapshots whatever the actors have already maintained.
 */

import type { ResultSet } from '../../engine/executor/ResultSet';
import type { OracleInstance } from '../OracleInstance';
import type { OracleStorage } from '../OracleStorage';
import type { OracleCatalog } from '../OracleCatalog';
import type { OracleRuntimeState } from './OracleRuntimeState';

export interface ViewContext {
  readonly instance: OracleInstance;
  readonly storage: OracleStorage;
  readonly runtime: OracleRuntimeState;
  readonly catalog: OracleCatalog;
  readonly currentUser: string;
}

export interface ViewDefinition {
  /** Canonical Oracle name, e.g. `V$LICENSE`, `DBA_HIST_SNAPSHOT`. */
  readonly name: string;
  /** Optional shared comment surfaced via DICT / DICTIONARY. */
  readonly comment?: string;
  /** Materialise the view from current state. */
  query(ctx: ViewContext): ResultSet;
}
