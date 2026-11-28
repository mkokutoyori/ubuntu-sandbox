import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$FLASHBACK_DATABASE_LOG',
  comment: 'Flashback log usage',
  query({ instance }) {
    const logs = instance.getFlashbackLogs();
    const used = logs.reduce((total, log) => total + log.bytes, 0);
    return queryResult(
      [
        col.num('OLDEST_FLASHBACK_SCN'),
        col.date('OLDEST_FLASHBACK_TIME'),
        col.num('RETENTION_TARGET'),
        col.num('FLASHBACK_SIZE'),
        col.num('ESTIMATED_FLASHBACK_SIZE'),
      ],
      logs.length === 0 ? [] : [[
        logs[0].scn,
        new Date(logs[0].timeMs).toISOString(),
        Number(instance.getParameter('db_flashback_retention_target') ?? '1440'),
        used,
        used,
      ]],
    );
  },
});
