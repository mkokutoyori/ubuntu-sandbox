/**
 * BLOCKRECOVER / RECOVER — recuperation au niveau bloc.
 *
 *   BLOCKRECOVER DATAFILE <n> BLOCK <b>   RECOVER DATAFILE <n> BLOCK <b>
 *   BLOCKRECOVER CORRUPTION LIST          RECOVER CORRUPTION LIST
 *   RECOVER COPY OF DATABASE
 *   RECOVER COPY OF DATAFILE <n>
 */

import { ok, type Result } from '../core/Result';
import type { RmanError } from '../core/RmanError';
import type { IRmanCommand, RmanCommandContext } from './types';
import { JobBuilder } from '../job/JobBuilder';

export type BlockRecoverMode = 'BY_BLOCK' | 'CORRUPTION_LIST' | 'COPY_OF_DATABASE' | 'COPY_OF_DATAFILE';

export class BlockRecoverCommand implements IRmanCommand<void> {
  readonly name = 'BLOCKRECOVER';
  constructor(private readonly mode: BlockRecoverMode) {}

  execute(args: string[], { engine }: RmanCommandContext): Result<void, RmanError> {
    if (this.mode === 'CORRUPTION_LIST') {
      return engine.run(JobBuilder.blockRecover({ scope: 'CORRUPTION_LIST' }));
    }
    if (this.mode === 'BY_BLOCK') {
      return engine.run(JobBuilder.blockRecover({
        scope: 'DATAFILE', fileNo: Number(args[0]), block: Number(args[1]),
      }));
    }
    const fileNo = this.mode === 'COPY_OF_DATAFILE' ? Number(args[0]) : undefined;
    return engine.run(JobBuilder.recoverDatabase({
      fileNo: Number.isFinite(fileNo) ? fileNo : undefined,
    }));
  }
}
