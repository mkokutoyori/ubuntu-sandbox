import { type Result } from '../core/Result';
import type { RmanError } from '../core/RmanError';
import type { IRmanCommand, RmanCommandContext } from './types';
import { JobBuilder } from '../job/JobBuilder';

export class DeleteCommand implements IRmanCommand<void> {
  readonly name = 'DELETE';
  constructor(private readonly mode: 'EXPIRED' | 'OBSOLETE') {}

  execute(_args: string[], { engine }: RmanCommandContext): Result<void, RmanError> {
    const job = this.mode === 'EXPIRED' ? JobBuilder.deleteExpired() : JobBuilder.deleteObsolete();
    return engine.run(job);
  }
}
