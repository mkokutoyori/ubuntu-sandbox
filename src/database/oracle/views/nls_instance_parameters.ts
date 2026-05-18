/**
 * NLS_INSTANCE_PARAMETERS — instance-level NLS parameters.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'NLS_INSTANCE_PARAMETERS',
  comment: 'Instance-level NLS parameters',
  query({ instance }) {
    const rows: (string | null)[][] = [
      ['NLS_LANGUAGE', instance.getParameter('nls_language') ?? 'AMERICAN'],
      ['NLS_TERRITORY', instance.getParameter('nls_territory') ?? 'AMERICA'],
      ['NLS_SORT', null],
      ['NLS_DATE_LANGUAGE', null],
      ['NLS_DATE_FORMAT', instance.getParameter('nls_date_format') ?? null],
      ['NLS_CURRENCY', null],
      ['NLS_NUMERIC_CHARACTERS', null],
      ['NLS_ISO_CURRENCY', null],
      ['NLS_CALENDAR', null],
      ['NLS_TIME_FORMAT', null],
      ['NLS_TIMESTAMP_FORMAT', null],
      ['NLS_TIME_TZ_FORMAT', null],
      ['NLS_TIMESTAMP_TZ_FORMAT', null],
      ['NLS_DUAL_CURRENCY', null],
      ['NLS_COMP', null],
      ['NLS_LENGTH_SEMANTICS', null],
      ['NLS_NCHAR_CONV_EXCP', null],
    ];
    return queryResult(
      [col.str('PARAMETER', 30), col.str('VALUE', 64)],
      rows
    );
  },
});
