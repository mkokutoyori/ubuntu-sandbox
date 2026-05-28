/**
 * DBA_TAB_HISTOGRAMS — column value histograms.
 * Backed by StatisticsManager.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_TAB_HISTOGRAMS',
  comment: 'Column value histograms',
  query({ instance }) {
    const buckets = instance.statistics?.getAllHistogramBuckets() ?? [];
    return queryResult(
      [
        col.str('OWNER', 128),
        col.str('TABLE_NAME', 128),
        col.str('COLUMN_NAME', 128),
        col.num('ENDPOINT_NUMBER'),
        col.str('ENDPOINT_VALUE', 100),
        col.str('ENDPOINT_ACTUAL_VALUE', 1000),
      ],
      buckets.map(b => [
        b.owner, b.tableName, b.columnName,
        b.endpointNumber, b.endpointValue, b.endpointActualValue,
      ]),
    );
  },
});
