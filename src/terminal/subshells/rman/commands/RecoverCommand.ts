import { type Result } from '../core/Result';
import type { RmanError } from '../core/RmanError';
import type { IRmanCommand, RmanCommandContext } from './types';
import { JobBuilder } from '../job/JobBuilder';

export class RecoverCommand implements IRmanCommand<void> {
  readonly name = 'RECOVER';
  execute(_args: string[], { engine }: RmanCommandContext): Result<void, RmanError> {
    return engine.run(JobBuilder.recoverDatabase());
  }
}
