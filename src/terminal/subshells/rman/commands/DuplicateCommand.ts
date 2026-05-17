/**
 * DuplicateCommand — `DUPLICATE [TARGET] DATABASE TO <newdb>`.
 *
 * Args:
 *   args[0] = target database name (auxiliary instance)
 */

import { type Result } from '../core/Result';
import type { RmanError } from '../core/RmanError';
import type { IRmanCommand, RmanCommandContext } from './types';
import { JobBuilder } from '../job/JobBuilder';

export class DuplicateCommand implements IRmanCommand<void> {
  readonly name = 'DUPLICATE';

  execute(args: string[], { engine }: RmanCommandContext): Result<void, RmanError> {
    const name = (args[0] ?? 'AUX').trim();
    return engine.run(JobBuilder.duplicateDatabase(name));
  }
}
