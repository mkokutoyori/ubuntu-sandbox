/**
 * DBA_SCHEDULER_WINDOWS — scheduler maintenance windows.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_SCHEDULER_WINDOWS',
  comment: 'Scheduler maintenance windows',
  query() {
    return queryResult(
      [
        col.str('OWNER', 30),
        col.str('WINDOW_NAME', 30),
        col.str('RESOURCE_PLAN', 30),
        col.str('ENABLED', 5),
        col.str('ACTIVE', 5),
        col.date('NEXT_START_DATE'),
        col.str('DURATION', 30),
      ],
      [
        ['SYS', 'MONDAY_WINDOW', 'DEFAULT_MAINTENANCE_PLAN', 'TRUE', 'FALSE', null as unknown as string, '+000 04:00:00'],
        ['SYS', 'TUESDAY_WINDOW', 'DEFAULT_MAINTENANCE_PLAN', 'TRUE', 'FALSE', null as unknown as string, '+000 04:00:00'],
        ['SYS', 'WEEKEND_WINDOW', 'DEFAULT_MAINTENANCE_PLAN', 'TRUE', 'FALSE', null as unknown as string, '+002 00:00:00'],
      ]
    );
  },
});
