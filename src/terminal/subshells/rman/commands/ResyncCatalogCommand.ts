/**
 * ResyncCatalogCommand — `RESYNC CATALOG`.
 *
 * Copies the control-file repository into the recovery catalog database
 * that `CONNECT CATALOG` resolved over Oracle Net.
 */

import { ok, err, type Result } from '../core/Result';
import type { RmanError } from '../core/RmanError';
import type { IRmanCommand, RmanCommandContext } from './types';

export class ResyncCatalogCommand implements IRmanCommand<string[]> {
  readonly name = 'RESYNC CATALOG';

  execute(
    _args: string[], { catalog, recoveryCatalog }: RmanCommandContext,
  ): Result<string[], RmanError> {
    if (!recoveryCatalog) {
      return err({ code: 'RMAN_06171', message: 'not connected to recovery catalog' });
    }
    const snapshot = catalog.listAll();
    if (snapshot.ok === false) return snapshot;
    const written = recoveryCatalog.resyncFrom(snapshot.value);
    if (written.ok === false) return err(written.error);
    return ok(['starting full resync of recovery catalog', 'full resync complete']);
  }
}
