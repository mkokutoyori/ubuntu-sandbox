/**
 * Oracle view registry — Open/Closed dispatcher.
 *
 * View files self-register at module-load time via `registerView(def)`.
 * Adding a new view is purely additive: create one file under
 * `src/database/oracle/views/` that calls `registerView` and add a line
 * in `views/index.ts` so it gets loaded. No existing dispatcher, catalog
 * or runtime-state code needs editing.
 *
 * Lookup is case-insensitive. `V_$` Oracle aliases are normalised onto
 * `V$` before lookup so e.g. `V_$LICENSE` and `V$LICENSE` resolve to the
 * same definition.
 */

import type { ResultSet } from '../../engine/executor/ResultSet';
import type { ViewContext, ViewDefinition } from './types';

const registry = new Map<string, ViewDefinition>();

export function registerView(def: ViewDefinition): void {
  const key = def.name.toUpperCase();
  if (registry.has(key)) {
    // Idempotent under HMR / repeated test runs.
    registry.set(key, def);
    return;
  }
  registry.set(key, def);
}

export function findView(name: string): ViewDefinition | undefined {
  const upper = name.toUpperCase().replace(/^V_\$/, 'V$');
  return registry.get(upper);
}

export function queryView(name: string, ctx: ViewContext): ResultSet | undefined {
  const def = findView(name);
  return def ? def.query(ctx) : undefined;
}

export function listRegisteredViews(): ViewDefinition[] {
  return [...registry.values()];
}
