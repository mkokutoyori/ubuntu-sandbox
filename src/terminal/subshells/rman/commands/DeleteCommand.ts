import { type Result } from '../core/Result';
import type { RmanError } from '../core/RmanError';
import type { IRmanCommand, RmanCommandContext } from './types';
import { JobBuilder } from '../job/JobBuilder';

export class DeleteCommand implements IRmanCommand<void> {
  readonly name = 'DELETE';
  constructor(private readonly mode: 'EXPIRED' | 'OBSOLETE') {}

  execute(_args: string[], cmdCtx: RmanCommandContext): Result<void, RmanError> {
    if (this.mode === 'EXPIRED') return cmdCtx.engine.run(JobBuilder.deleteExpired());
    // OBSOLETE — apply the live retention policy ourselves
    const snap = cmdCtx.catalog.listAll();
    if (!snap.ok) return snap;
    const obsolete = cmdCtx.policy.findObsolete(snap.value.sets).map(s => s.bsKey);
    return cmdCtx.engine.run(JobBuilder.deleteObsolete(obsolete));
  }
}
