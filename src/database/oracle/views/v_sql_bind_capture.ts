/**
 * V$SQL_BIND_CAPTURE — peeked bind values.
 *
 * Our executor doesn't currently capture binds, so the view returns one
 * placeholder row per cached cursor with NULL value_string — the schema
 * is correct and the data set grows as the SQL cache grows.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$SQL_BIND_CAPTURE',
  comment: 'Captured bind variable values for each cursor',
  query({ runtime }) {
    return queryResult(
      [
        col.str('SQL_ID', 13),
        col.num('CHILD_NUMBER'),
        col.str('NAME', 30),
        col.num('POSITION'),
        col.str('DATATYPE_STRING', 15),
        col.str('VALUE_STRING', 4000),
      ],
      [...runtime.sqlCache.values()]
        .filter(s => s.text.includes(':'))
        .map(s => [s.sqlId, 0, ':1', 1, 'VARCHAR2', null as unknown as string])
    );
  },
});
