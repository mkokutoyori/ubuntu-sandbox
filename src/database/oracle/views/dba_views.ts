/**
 * DBA_VIEWS — every view (registered dictionary views + user-defined),
 * built from the catalog's shared view-row enumerator so DBA_VIEWS,
 * ALL_VIEWS and USER_VIEWS stay consistent.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';
import { VIEW_COLUMNS } from './_viewColumns';

registerView({
  name: 'DBA_VIEWS',
  comment: 'Views',
  query({ catalog }) {
    return queryResult(VIEW_COLUMNS, catalog.getCatalogViewRows());
  },
});
