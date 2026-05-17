import { type Result } from '../core/Result';
import type { RmanError } from '../core/RmanError';
import type { IRmanCommand, RmanCommandContext } from './types';
import { JobBuilder } from '../job/JobBuilder';

export type CrosscheckScope = 'BACKUP' | 'ARCHIVELOG';

export class CrosscheckCommand implements IRmanCommand<void> {
  readonly name = 'CROSSCHECK';
  constructor(private readonly scope: CrosscheckScope = 'BACKUP') {}

  execute(_args: string[], { engine }: RmanCommandContext): Result<void, RmanError> {
    return engine.run(JobBuilder.crosscheck(this.scope));
  }
}
