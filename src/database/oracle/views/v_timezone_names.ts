/**
 * V$TIMEZONE_NAMES — recognised time zone names.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2 } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'V$TIMEZONE_NAMES',
  comment: 'Time zone names',
  query() {
    return queryResult(
      [
        { name: 'TZNAME', dataType: oracleVarchar2(64) },
        { name: 'TZABBREV', dataType: oracleVarchar2(10) },
      ],
      [
        ['US/Eastern', 'EST'], ['US/Central', 'CST'], ['US/Mountain', 'MST'],
        ['US/Pacific', 'PST'], ['Europe/London', 'GMT'], ['Europe/Paris', 'CET'],
        ['Asia/Tokyo', 'JST'], ['Australia/Sydney', 'AEST'], ['UTC', 'UTC'],
      ]
    );
  },
});
