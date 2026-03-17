/**
 * BaseExecutor — Abstract SQL statement executor.
 *
 * Takes a parsed AST and executes it against a storage/catalog layer.
 * Subclasses implement dialect-specific execution behaviour.
 */

import type { Statement } from '../parser/ASTNode';
import type { ResultSet } from './ResultSet';
import type { BaseStorage } from '../storage/BaseStorage';
import type { BaseCatalog } from '../catalog/BaseCatalog';

export interface ExecutionContext {
  /** Current authenticated user */
  currentUser: string;
  /** Current schema (defaults to current user's schema in Oracle) */
  currentSchema: string;
  /** Auto-commit mode */
  autoCommit: boolean;
  /** Server output enabled (DBMS_OUTPUT) */
  serverOutput: boolean;
  /** Feedback (show row count) */
  feedback: boolean;
  /** Timing (show execution time) */
  timing: boolean;
}

export abstract class BaseExecutor {
  protected storage: BaseStorage;
  protected catalog: BaseCatalog;
  protected context: ExecutionContext;

  constructor(storage: BaseStorage, catalog: BaseCatalog, context: ExecutionContext) {
    this.storage = storage;
    this.catalog = catalog;
    this.context = context;
  }

  /**
   * Execute a parsed SQL statement and return the result.
   */
  abstract execute(statement: Statement): ResultSet;

  /**
   * Get the current execution context.
   */
  getContext(): ExecutionContext {
    return this.context;
  }

  /**
   * Update the current execution context.
   */
  updateContext(updates: Partial<ExecutionContext>): void {
    Object.assign(this.context, updates);
  }
}
