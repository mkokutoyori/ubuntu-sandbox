/**
 * V$PGA_TARGET_ADVICE — PGA sizing advisory, scaled off the live
 * pga_aggregate_target parameter.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'V$PGA_TARGET_ADVICE',
  comment: 'PGA target advice',
  query({ instance }) {
    const pgaTarget = parseInt(instance.getParameter('pga_aggregate_target') ?? '256') * 1024 * 1024;
    return queryResult(
      [
        { name: 'PGA_TARGET_FOR_ESTIMATE', dataType: oracleNumber(20) },
        { name: 'PGA_TARGET_FACTOR', dataType: oracleNumber(10, 2) },
        { name: 'ESTD_PGA_CACHE_HIT_PERCENTAGE', dataType: oracleNumber(10) },
        { name: 'ESTD_OVERALLOC_COUNT', dataType: oracleNumber(10) },
      ],
      [
        [pgaTarget * 0.25, 0.25, 55, 5],
        [pgaTarget * 0.5, 0.5, 72, 2],
        [pgaTarget * 0.75, 0.75, 89, 0],
        [pgaTarget, 1.0, 100, 0],
        [pgaTarget * 1.5, 1.5, 100, 0],
        [pgaTarget * 2.0, 2.0, 100, 0],
      ]
    );
  },
});
