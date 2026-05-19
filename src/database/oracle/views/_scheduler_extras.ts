/**
 * Scheduler dictionary views beyond the core DBA_SCHEDULER_JOBS set.
 * The simulator does not implement Oracle Scheduler chains / job
 * classes / destinations / file watchers, so every view here is
 * empty (truthful) until that machinery lands.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber, oracleDate } from '../../engine/catalog/DataType';
import { registerView } from './registry';

const str = (name: string, len: number) => ({ name, dataType: oracleVarchar2(len) });
const num = (name: string) => ({ name, dataType: oracleNumber(20) });
const dt  = (name: string) => ({ name, dataType: oracleDate() });

registerView({
  name: 'DBA_SCHEDULER_CHAINS',
  comment: 'Scheduler chains',
  query() {
    return queryResult(
      [str('OWNER', 30), str('CHAIN_NAME', 30), str('RULE_SET_OWNER', 30),
       str('RULE_SET_NAME', 30), num('NUMBER_OF_RULES'),
       num('NUMBER_OF_STEPS'), str('ENABLED', 5), str('EVALUATION_INTERVAL', 30),
       str('COMMENTS', 240)],
      []
    );
  },
});

registerView({
  name: 'DBA_SCHEDULER_CHAIN_STEPS',
  comment: 'Steps within scheduler chains',
  query() {
    return queryResult(
      [str('OWNER', 30), str('CHAIN_NAME', 30), str('STEP_NAME', 30),
       str('PROGRAM_OWNER', 30), str('PROGRAM_NAME', 30),
       str('STEP_TYPE', 20), str('SKIP', 5)],
      []
    );
  },
});

registerView({
  name: 'DBA_SCHEDULER_DESTINATIONS',
  comment: 'Scheduler destinations (remote agents)',
  query() {
    return queryResult(
      [str('DESTINATION_NAME', 261), str('DESTINATION_TYPE', 20),
       str('AGENT', 30), str('HOST', 256), str('OS_USERNAME', 30),
       str('ENABLED', 5), str('REFUSING_NEW_JOBS', 5)],
      []
    );
  },
});

registerView({
  name: 'DBA_SCHEDULER_FILES',
  comment: 'Scheduler-tracked files',
  query() {
    return queryResult(
      [str('OWNER', 30), str('FILE_NAME', 30), str('DESTINATION', 261),
       num('FILE_SIZE'), dt('LAST_MODIFIED'), str('COMMENTS', 240)],
      []
    );
  },
});

registerView({
  name: 'DBA_SCHEDULER_JOB_CLASSES',
  comment: 'Scheduler job classes',
  query() {
    return queryResult(
      [str('JOB_CLASS_NAME', 30), str('RESOURCE_CONSUMER_GROUP', 30),
       str('SERVICE', 64), str('LOGGING_LEVEL', 20),
       num('LOG_HISTORY'), str('COMMENTS', 240)],
      [
        ['DEFAULT_JOB_CLASS', 'DEFAULT_CONSUMER_GROUP', null, 'RUNS', 30, 'Default job class'],
      ]
    );
  },
});

registerView({
  name: 'DBA_SCHEDULER_WINDOW_GROUPS',
  comment: 'Scheduler window groups',
  query() {
    return queryResult(
      [str('WINDOW_GROUP_NAME', 30), str('ENABLED', 5),
       num('NUMBER_OF_WINDOWS'), str('NEXT_START_DATE', 30),
       str('COMMENTS', 240)],
      []
    );
  },
});

registerView({
  name: 'DBA_SCHEDULER_GLOBAL_ATTRIBUTE',
  comment: 'Global scheduler attributes',
  query() {
    return queryResult(
      [str('ATTRIBUTE_NAME', 30), str('VALUE', 4000)],
      [
        ['DEFAULT_TIMEZONE',     'UTC'],
        ['LOG_HISTORY',          '30'],
        ['MAX_JOB_SLAVE_PROCESSES', '0'],
        ['EMAIL_SERVER',         null],
        ['EVENT_EXPIRY_TIME',    '86400'],
      ]
    );
  },
});
