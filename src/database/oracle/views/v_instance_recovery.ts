/**
 * V$INSTANCE_RECOVERY — current instance-recovery targets.
 *
 * Reactive sourcing: the row reflects the instance's redo-log
 * configuration. Counters maintained by `OracleRuntimeStateActor` on
 * `oracle.instance.redo-log-switched` and `oracle.archive-log.created`
 * events influence estimated cache redo & estimated recovery work.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$INSTANCE_RECOVERY',
  comment: 'Instance recovery target information',
  query({ instance, runtime }) {
    const redoGroup = instance.getRedoLogGroups().find(g => g.status === 'CURRENT');
    const redoBlocks = redoGroup ? Math.floor(redoGroup.sizeBytes / 512) : 0;
    const switches = runtime.counters.redoSwitches;
    return queryResult(
      [
        col.num('RECOVERY_ESTIMATED_IOS'),
        col.num('ACTUAL_REDO_BLKS'),
        col.num('TARGET_REDO_BLKS'),
        col.num('LOG_FILE_SIZE_REDO_BLKS'),
        col.num('LOG_CHKPT_TIMEOUT_REDO_BLKS'),
        col.num('LOG_CHKPT_INTERVAL_REDO_BLKS'),
        col.num('FAST_START_IO_TARGET_REDO_BLKS'),
        col.num('TARGET_MTTR'),
        col.num('ESTIMATED_MTTR'),
        col.num('CKPT_BLOCK_WRITES'),
        col.str('OPTIMAL_LOGFILE_SIZE', 20),
        col.num('ESTD_CLUSTER_AVAILABLE_TIME'),
        col.str('WRITES_MTTR', 20),
        col.str('WRITES_LOGFILE_SIZE', 20),
        col.str('WRITES_LOG_CHECKPOINT_SETTINGS', 20),
        col.str('WRITES_OTHER_SETTINGS', 20),
        col.str('WRITES_AUTOTUNE', 20),
        col.str('WRITES_FULL_THREAD_CKPT', 20),
        col.str('CON_ID', 20),
      ],
      [[
        switches * 10,
        Math.floor(redoBlocks * 0.05),
        redoBlocks,
        redoBlocks,
        redoBlocks,
        0,
        0,
        0,
        15,
        switches,
        '50M',
        0,
        '0', '0', '0', '0', '0', '0', '0',
      ]]
    );
  },
});
