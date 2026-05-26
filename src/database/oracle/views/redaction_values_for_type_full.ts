/**
 * REDACTION_VALUES_FOR_TYPE_FULL — per-data-type constants used when
 * `FUNCTION_TYPE='FULL'` in REDACTION_COLUMNS. Native to Oracle 12c+.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';
import { REDACTION_FULL_VALUES } from '../security/DataRedactionManager';

registerView({
  name: 'REDACTION_VALUES_FOR_TYPE_FULL',
  comment: 'Per-data-type FULL-redaction constants',
  query() {
    return queryResult(
      [
        col.str('OBJECT_TYPE', 30),
        col.str('CHAR_VALUE', 4000),
        col.num('NUMBER_VALUE'),
        col.date('DATE_VALUE'),
        col.str('BFLOAT_VALUE', 80),
        col.str('BDOUBLE_VALUE', 80),
      ],
      REDACTION_FULL_VALUES.map(v => [
        v.dataType, v.charValue, v.numberValue,
        v.dateValue ? new Date(v.dateValue).toISOString() : null,
        '', '',
      ]),
    );
  },
});
