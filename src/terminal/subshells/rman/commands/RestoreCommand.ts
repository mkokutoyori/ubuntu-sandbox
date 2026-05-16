import { type Result } from '../core/Result';
import type { RmanError } from '../core/RmanError';
import type { IRmanCommand, RmanCommandContext } from './types';
import { JobBuilder } from '../job/JobBuilder';

export class RestoreCommand implements IRmanCommand<void> {
  readonly name = 'RESTORE';
  execute(_args: string[], { engine }: RmanCommandContext): Result<void, RmanError> {
    return engine.run(JobBuilder.restoreDatabase());
  }
}
