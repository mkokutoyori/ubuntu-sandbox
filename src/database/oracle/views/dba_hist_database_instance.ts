/**
 * DBA_HIST_DATABASE_INSTANCE — historical instance metadata.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_HIST_DATABASE_INSTANCE',
  comment: 'Historical database instance metadata',
  query({ instance }) {
    return queryResult(
      [
        col.num('DBID'),
        col.num('INSTANCE_NUMBER'),
        col.date('STARTUP_TIME'),
        col.num('PARALLEL'),
        col.str('VERSION', 17),
        col.str('DB_NAME', 9),
        col.str('INSTANCE_NAME', 16),
        col.str('HOST_NAME', 64),
        col.str('PLATFORM_NAME', 101),
      ],
      [[
        instance.getDbId(), 1,
        instance.startupTime ? instance.startupTime.toISOString() : null as unknown as string,
        0, '19.3.0.0.0', instance.config.sid, instance.config.sid,
        'localhost', 'Linux x86 64-bit',
      ]]
    );
  },
});
