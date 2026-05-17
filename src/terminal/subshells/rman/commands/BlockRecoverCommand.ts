/**
 * BLOCKRECOVER / RECOVER COPY OF (12c+) — block-level recovery.
 *
 *   BLOCKRECOVER DATAFILE <n> BLOCK <b>
 *   BLOCKRECOVER CORRUPTION LIST
 *   RECOVER COPY OF DATABASE
 *   RECOVER COPY OF DATAFILE <n>
 *
 * The simulator doesn't track block-level corruption, so these are
 * accepted as no-ops that emit the canonical "Starting / Finished"
 * recovery lines for the right scope.
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
    // We re-use the regular recoverDatabase job and let the engine emit
    // the canonical lifecycle events; the scope label is recorded in
    // params.note so SubShell-side renderers can surface it.
    const fileNo = this.mode === 'BY_BLOCK' || this.mode === 'COPY_OF_DATAFILE'
      ? Number(args[0])
      : undefined;
    const note = this.mode === 'BY_BLOCK'         ? `BLOCK RECOVER datafile ${fileNo} block ${args[1] ?? '?'}`
              :  this.mode === 'CORRUPTION_LIST'  ? 'BLOCK RECOVER all corrupt blocks from V$DATABASE_BLOCK_CORRUPTION'
              :  this.mode === 'COPY_OF_DATABASE' ? 'RECOVER COPY OF DATABASE'
              :                                     `RECOVER COPY OF DATAFILE ${fileNo}`;
    return engine.run(JobBuilder.recoverDatabase({
      fileNo: Number.isFinite(fileNo) ? fileNo : undefined,
      untilTime: note, // re-purpose untilTime to surface the note via PROGRESS_UPDATED
    }));
  }
}
