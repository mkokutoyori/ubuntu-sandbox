/**
 * NLS_SESSION_PARAMETERS — session-level NLS parameters.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'NLS_SESSION_PARAMETERS',
  comment: 'Session-level NLS parameters',
  query({ instance }) {
    const rows: (string | null)[][] = [
      ['NLS_LANGUAGE', instance.getParameter('nls_language') ?? 'AMERICAN'],
      ['NLS_TERRITORY', instance.getParameter('nls_territory') ?? 'AMERICA'],
      ['NLS_CURRENCY', '$'],
      ['NLS_ISO_CURRENCY', 'AMERICA'],
      ['NLS_NUMERIC_CHARACTERS', '.,'],
      ['NLS_CALENDAR', 'GREGORIAN'],
      ['NLS_DATE_FORMAT', instance.getParameter('nls_date_format') ?? 'DD-MON-RR'],
      ['NLS_DATE_LANGUAGE', 'AMERICAN'],
      ['NLS_SORT', 'BINARY'],
      ['NLS_TIME_FORMAT', 'HH.MI.SSXFF AM'],
      ['NLS_TIMESTAMP_FORMAT', 'DD-MON-RR HH.MI.SSXFF AM'],
      ['NLS_TIME_TZ_FORMAT', 'HH.MI.SSXFF AM TZR'],
      ['NLS_TIMESTAMP_TZ_FORMAT', 'DD-MON-RR HH.MI.SSXFF AM TZR'],
      ['NLS_DUAL_CURRENCY', '$'],
      ['NLS_COMP', 'BINARY'],
      ['NLS_LENGTH_SEMANTICS', 'BYTE'],
      ['NLS_NCHAR_CONV_EXCP', 'FALSE'],
    ];
    return queryResult(
      [col.str('PARAMETER', 30), col.str('VALUE', 64)],
      rows
    );
  },
});
