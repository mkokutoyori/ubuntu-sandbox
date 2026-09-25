import { type Result } from '../core/Result';
import type { RmanError } from '../core/RmanError';
import type { IRmanCommand, RmanCommandContext } from './types';
import { JobBuilder } from '../job/JobBuilder';

export class DuplicateCommand implements IRmanCommand<void> {
  readonly name = 'DUPLICATE';

  constructor(private readonly variant: 'CLONE' | 'STANDBY' = 'CLONE') {}

  execute(args: string[], cmdCtx: RmanCommandContext): Result<void, RmanError> {
    const engine = cmdCtx.engine as unknown as {
      setAuxiliaryContext?(ctx: RmanCommandContext['auxiliary']): void;
    };
    engine.setAuxiliaryContext?.(cmdCtx.auxiliary ?? null);
    if (this.variant === 'STANDBY') {
      const clauses = (args[0] ?? '').toUpperCase();
      return cmdCtx.engine.run(JobBuilder.duplicateForStandby({
        fromActive:      /\bFROM\s+ACTIVE\s+DATABASE\b/.test(clauses),
        doRecover:       /\bDORECOVER\b/.test(clauses),
        noFilenameCheck: /\bNOFILENAMECHECK\b/.test(clauses),
      }));
    }
    const name = (args[0] ?? 'AUX').trim();
    return cmdCtx.engine.run(JobBuilder.duplicateDatabase(name));
  }
}
