/**
 * V$NLS_PARAMETERS — session NLS parameter values.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2 } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'V$NLS_PARAMETERS',
  comment: 'NLS parameters',
  query() {
    return queryResult(
      [
        { name: 'PARAMETER', dataType: oracleVarchar2(64) },
        { name: 'VALUE', dataType: oracleVarchar2(64) },
      ],
      [
        ['NLS_LANGUAGE', 'AMERICAN'],
        ['NLS_TERRITORY', 'AMERICA'],
        ['NLS_CURRENCY', '$'],
        ['NLS_ISO_CURRENCY', 'AMERICA'],
        ['NLS_NUMERIC_CHARACTERS', '.,'],
        ['NLS_CHARACTERSET', 'AL32UTF8'],
        ['NLS_CALENDAR', 'GREGORIAN'],
        ['NLS_DATE_FORMAT', 'DD-MON-RR'],
        ['NLS_DATE_LANGUAGE', 'AMERICAN'],
        ['NLS_SORT', 'BINARY'],
        ['NLS_COMP', 'BINARY'],
        ['NLS_TIMESTAMP_FORMAT', 'DD-MON-RR HH.MI.SSXFF AM'],
        ['NLS_TIME_FORMAT', 'HH.MI.SSXFF AM'],
        ['NLS_NCHAR_CHARACTERSET', 'AL16UTF16'],
        ['NLS_LENGTH_SEMANTICS', 'BYTE'],
      ]
    );
  },
});
