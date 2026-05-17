/**
 * ResyncCatalogCommand — `RESYNC CATALOG`.
 *
 * In a real RMAN session this synchronises the recovery catalog DB with
 * the target's control file. The in-memory catalog needs no such sync,
 * so we just emit the canonical "full resync complete" line.
 */

import { ok, type Result } from '../core/Result';
import type { RmanError } from '../core/RmanError';
import type { IRmanCommand } from './types';

export class ResyncCatalogCommand implements IRmanCommand<string[]> {
  readonly name = 'RESYNC CATALOG';

  execute(): Result<string[], RmanError> {
    return ok(['starting full resync of recovery catalog', 'full resync complete']);
  }
}
