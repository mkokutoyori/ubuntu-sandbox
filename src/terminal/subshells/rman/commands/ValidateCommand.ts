/**
 * ValidateCommand — VALIDATE without writing a piece.
 *
 *   VALIDATE DATABASE
 *   VALIDATE TABLESPACE <name>
 *   VALIDATE DATAFILE  <n>
 *   VALIDATE BACKUPSET <bsKey>
 *
 * Uses the engine's BACKUP_VALIDATED path so the channel allocation,
 * progress messages and JOB_COMPLETED emit pipeline are exercised — the
 * only difference from BACKUP VALIDATE is the scoping (whole DB vs one
 * tablespace / datafile / explicit backupset).
 *
 * VALIDATE BACKUPSET checks that the catalog actually has the key; on
 * miss it returns RMAN_06004 (piece not found) without spawning a job.
 */

import { ok, err, type Result } from '../core/Result';
import type { RmanError } from '../core/RmanError';
import type { IRmanCommand, RmanCommandContext } from './types';
import { JobBuilder } from '../job/JobBuilder';

export type ValidateScope = 'DATABASE' | 'TABLESPACE' | 'DATAFILE' | 'BACKUPSET';

export class ValidateCommand implements IRmanCommand<void> {
  readonly name = 'VALIDATE';

  constructor(private readonly scope: ValidateScope) {}

  execute(args: string[], cmdCtx: RmanCommandContext): Result<void, RmanError> {
    const { engine, catalog } = cmdCtx;
    switch (this.scope) {
      case 'DATABASE':
        return engine.run(JobBuilder.validate({ scope: 'DATABASE' }));
      case 'TABLESPACE': {
        const ts = (args[0] ?? '').toUpperCase();
        if (!ts) return err({ code: 'RMAN_01009', message: 'VALIDATE TABLESPACE requires a name' });
        return engine.run(JobBuilder.validate({ scope: 'TABLESPACE', tablespace: ts }));
      }
      case 'DATAFILE': {
        const n = Number(args[0]);
        if (!Number.isFinite(n)) {
          return err({ code: 'RMAN_01009', message: 'VALIDATE DATAFILE requires a file number' });
        }
        return engine.run(JobBuilder.validate({ scope: 'DATAFILE', fileNo: n }));
      }
      case 'BACKUPSET': {
        const n = Number(args[0]);
        if (!Number.isFinite(n)) {
          return err({ code: 'RMAN_01009', message: 'VALIDATE BACKUPSET requires a key' });
        }
        // Confirm the set exists in the catalog before launching a job.
        const snap = catalog.listAll();
        if (!snap.ok) return snap;
        const found = snap.value.sets.find(s => s.bsKey === n);
        if (!found) {
          return err({ code: 'RMAN_06004', message: `RMAN-06004: backupset ${n} not found in catalog` });
        }
        return engine.run(JobBuilder.validate({ scope: 'BACKUPSET', bsKey: n }));
      }
    }
  }
}
